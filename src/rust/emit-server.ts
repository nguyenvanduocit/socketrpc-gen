/**
 * Writes `server.rs`: a socketioxide binding that answers the client's calls
 * through a `ServerHandler` and calls the client back through `Client`.
 *
 * Every identifier the generated bodies declare is a fixed word (`binding`,
 * `handler`, `ctx`, `args`, `arg0`…), and every helper is reached through a
 * path (`rpc_runtime::`, `super::types::`) or a method on `self`, so no name a
 * contract can produce shadows one the bodies rely on.
 */

import type { RpcMethod, RpcSchema } from "../schema";
import { callMethodName, handlerMethodName, rustTypeName, rustValueIdentifier } from "./names";
import {
  inboundMethods,
  outboundMethods,
  referencedDeclarations,
  renderParamType,
  renderRustType,
  resultRustType,
  usesJsonValue,
  type DeclarationScope,
} from "./project";
import { header } from "./emit-types";

/** Lines of a method's doc comment naming the wire event it maps to. */
function methodDoc(method: RpcMethod, verb: string): string {
  const kind = method.returnType.kind === "void" ? "fire-and-forget" : "acknowledged";
  return `    /// ${verb} \`${method.name}\` (${kind}).`;
}

/** The `ServerHandler` / `ClientHandler` trait a side implements. */
export function emitHandlerTrait(name: string, methods: readonly RpcMethod[], doc: string): string[] {
  const body = methods.flatMap((method, index) => [
    ...(index > 0 ? [""] : []),
    methodDoc(method, "Answers"),
    `    fn ${handlerMethodName(method.name)}(`,
    "        &self,",
    "        ctx: Context,",
    ...method.params.map((param) => `        ${rustValueIdentifier(param.name)}: ${renderRustType(param.type)},`),
    `    ) -> impl Future<Output = Result<${resultRustType(method)}, RpcError>> + Send;`,
  ]);
  return [
    doc,
    `pub trait ${name}: Send + Sync + 'static {`,
    ...body,
    "}",
  ];
}

/**
 * The registration of one inbound method: decodes the positional arguments,
 * calls the handler, encodes its result. `listen` is the runtime function of
 * the side being generated.
 */
export function emitListen(method: RpcMethod, declarations: DeclarationScope, target: string): string[] {
  const acked = method.returnType.kind !== "void";
  const decodes = method.params.map((param, index) => {
    const decodeFn = usesJsonValue(param.type, declarations) ? "rpc_decode_json_arg" : "rpc_decode_arg";
    return `                let arg${index}: ${renderRustType(param.type)} = super::types::${decodeFn}(&mut args, ${JSON.stringify(param.name)})?;`;
  });
  const encodeFn = usesJsonValue(method.returnType, declarations) ? "rpc_encode_json_result" : "rpc_encode_result";
  const call = `handler.${handlerMethodName(method.name)}(${["ctx", ...method.params.map((_, index) => `arg${index}`)].join(", ")}).await?`;
  return [
    "    {",
    "        let handler = Arc::clone(&handler);",
    `        rpc_runtime::listen(${target}, ${JSON.stringify(method.name)}, ${method.params.length}, ${acked}, move |ctx, args| {`,
    "            let handler = Arc::clone(&handler);",
    "            Box::pin(async move {",
    ...(method.params.length > 0 ? ["                let mut args = args.into_iter();"] : ["                drop(args);"]),
    ...decodes,
    `                super::types::${encodeFn}(${call})`,
    "            })",
    "        });",
    "    }",
  ];
}

/** One `call_*` method on the type that calls the peer. */
export function emitCallMethod(method: RpcMethod, declarations: DeclarationScope, target: string): string[] {
  const params = method.params.map(
    (param) => `${rustValueIdentifier(param.name)}: ${renderParamType(param.type, declarations)}`,
  );
  const args = `vec![${method.params
    .map((param) => {
      const encodeFn = usesJsonValue(param.type, declarations) ? "rpc_encode_json_arg" : "rpc_encode_arg";
      return `super::types::${encodeFn}(&${rustValueIdentifier(param.name)})`;
    })
    .join(", ")}]`;
  const signature = ["&self", ...params].join(", ");
  if (method.returnType.kind === "void") {
    return [
      methodDoc(method, "Calls"),
      `    pub fn ${callMethodName(method.name)}(${signature}) -> Result<(), RpcError> {`,
      `        rpc_runtime::emit(${target}, ${JSON.stringify(method.name)}, ${args})`,
      "    }",
    ];
  }
  const requestFn = usesJsonValue(method.returnType, declarations) ? "request_json" : "request";
  return [
    methodDoc(method, "Calls"),
    `    pub async fn ${callMethodName(method.name)}(${signature}) -> Result<${resultRustType(method)}, RpcError> {`,
    `        rpc_runtime::${requestFn}(${target}, self.timeout, ${JSON.stringify(method.name)}, ${args}).await`,
    "    }",
  ];
}

/** The `use super::types::{…}` line: the runtime names plus every contract type the file spells. */
export function typesImport(schema: RpcSchema, declarations: DeclarationScope): string {
  const refs = schema.methods.flatMap((method) => [...method.params.map((param) => param.type), method.returnType]);
  const names = referencedDeclarations(refs, declarations).map(rustTypeName);
  return `use super::types::{${["RpcError", "Unsubscribe", ...names].join(", ")}};`;
}

const SERVER_RUNTIME = (timeoutMs: number) => String.raw`
mod rpc_runtime {
    use ::std::collections::VecDeque;
    use ::std::future::Future;
    use ::std::panic::AssertUnwindSafe;
    use ::std::pin::Pin;
    use ::std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
    use ::std::time::Duration;

    use ::serde_json::Value;
    use ::socketioxide::adapter::Adapter;
    use ::socketioxide::extract::{AckSender, SocketRef};
    use ::socketioxide::handler::{FromMessageParts, Value as PacketValue};
    use ::socketioxide::socket::{DisconnectReason, Socket};
    use ::socketioxide::{AckError, SendError, SocketError};
    use ::tokio::sync::{mpsc, watch};

    use super::super::types::{
        rpc_decode_error, rpc_decode_json_result, rpc_decode_result, rpc_encode_args, rpc_encode_error,
        rpc_encode_error_result, rpc_json, rpc_panic_message, RpcError, RpcErrorCode, Unsubscribe, RPC_ERROR_EVENT,
    };

    pub(super) const DEFAULT_TIMEOUT: Duration = Duration::from_millis(${timeoutMs});

    pub(super) type BoxedCall = Pin<Box<dyn Future<Output = Result<Vec<u8>, RpcError>> + Send>>;

    type Observer<T> = Arc<dyn Fn(&T) + Send + Sync>;

    struct Observers<T: ?Sized> {
        next: u64,
        list: Vec<(u64, Observer<T>)>,
    }

    impl<T: ?Sized> Observers<T> {
        fn new() -> Self {
            Self { next: 0, list: Vec::new() }
        }
    }

    struct State {
        disposed: bool,
        disconnected: bool,
        errors: Observers<RpcError>,
        disconnects: Observers<str>,
    }

    pub(super) struct Binding {
        pub(super) socket: SocketRef,
        state: Mutex<State>,
        cancel: watch::Sender<bool>,
    }

    impl Binding {
        pub(super) fn new(socket: SocketRef) -> Arc<Self> {
            Arc::new(Self {
                socket,
                state: Mutex::new(State {
                    disposed: false,
                    disconnected: false,
                    errors: Observers::new(),
                    disconnects: Observers::new(),
                }),
                cancel: watch::channel(false).0,
            })
        }

        fn lock(&self) -> MutexGuard<'_, State> {
            // No critical section can panic halfway, so a poisoned lock still guards valid data.
            self.state.lock().unwrap_or_else(PoisonError::into_inner)
        }

        pub(super) fn disposed(&self) -> bool {
            self.lock().disposed
        }

        pub(super) fn is_cancelled(&self) -> bool {
            *self.cancel.borrow()
        }

        pub(super) async fn cancelled(&self) {
            let mut receiver = self.cancel.subscribe();
            let _ = receiver.wait_for(|cancelled| *cancelled).await;
        }

        /// DISCONNECTED once the socket has gone, DISPOSED when the binding was disposed while connected.
        pub(super) fn closed_error(&self) -> RpcError {
            if self.lock().disconnected {
                RpcError::new(RpcErrorCode::Disconnected, "socket is disconnected")
            } else {
                RpcError::new(RpcErrorCode::Disposed, "server binding is disposed")
            }
        }

        pub(super) fn dispose(&self) {
            {
                let mut state = self.lock();
                if state.disposed {
                    return;
                }
                state.disposed = true;
                // Release every closure the caller handed over.
                state.errors.list.clear();
                state.disconnects.list.clear();
            }
            self.cancel.send_replace(true);
        }

        fn emit_error(&self, error: &RpcError) {
            if self.disposed() {
                return;
            }
            let _ = self.socket.emit(RPC_ERROR_EVENT, &Payload(rpc_encode_error(error)));
        }

        pub(super) fn subscribe_errors(self: &Arc<Self>, observer: Observer<RpcError>) -> Unsubscribe {
            subscribe(self, observer, |state| &mut state.errors)
        }

        pub(super) fn subscribe_disconnects(self: &Arc<Self>, observer: Observer<str>) -> Unsubscribe {
            subscribe(self, observer, |state| &mut state.disconnects)
        }
    }

    fn subscribe<T: ?Sized + 'static>(
        binding: &Arc<Binding>,
        observer: Observer<T>,
        select: fn(&mut State) -> &mut Observers<T>,
    ) -> Unsubscribe {
        let id = {
            let mut state = binding.lock();
            if state.disposed {
                return Unsubscribe::new(|| {});
            }
            let observers = select(&mut state);
            observers.next += 1;
            let id = observers.next;
            observers.list.push((id, observer));
            id
        };
        let binding: Weak<Binding> = Arc::downgrade(binding);
        Unsubscribe::new(move || {
            if let Some(binding) = binding.upgrade() {
                select(&mut binding.lock()).list.retain(|(entry, _)| *entry != id);
            }
        })
    }

    /// Runs observers in registration order; one that panics stops neither the rest nor the caller.
    fn notify<T: ?Sized>(observers: Vec<Observer<T>>, value: &T) {
        for observer in observers {
            let _ = ::std::panic::catch_unwind(AssertUnwindSafe(|| observer(value)));
        }
    }

    /// Binary payload wrapper that serializes and deserializes through
    /// socketioxide's binary attachment channel (serialize_bytes / deserialize_byte_buf).
    struct Payload(Vec<u8>);

    impl ::serde::Serialize for Payload {
        fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_bytes(&self.0)
        }
    }

    impl<'de> ::serde::Deserialize<'de> for Payload {
        fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct BytesVisitor;
            impl ::serde::de::Visitor<'_> for BytesVisitor {
                type Value = Payload;

                fn expecting(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                    f.write_str("a binary postcard payload")
                }

                fn visit_bytes<E: ::serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                    Ok(Payload(v.to_vec()))
                }

                fn visit_byte_buf<E: ::serde::de::Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
                    Ok(Payload(v))
                }
            }
            deserializer.deserialize_byte_buf(BytesVisitor)
        }
    }

    /// The raw argument list of an event and whether the peer awaits an acknowledgement.
    pub(super) struct Inbound {
        args: Result<Vec<Result<Vec<u8>, String>>, String>,
        acked: bool,
    }

    impl<A: Adapter> FromMessageParts<A> for Inbound {
        type Error = ::std::convert::Infallible;

        fn from_message_parts(
            _: &Arc<Socket<A>>,
            value: &mut PacketValue,
            ack_id: &Option<i64>,
        ) -> Result<Self, Self::Error> {
            let args = match value {
                PacketValue::Str(text, bins) => match ::serde_json::from_str::<Vec<Value>>(text) {
                    Ok(mut items) if !items.is_empty() => {
                        items.remove(0);
                        let mut empty = VecDeque::new();
                        let bins = bins.as_mut().unwrap_or(&mut empty);
                        Ok(items
                            .into_iter()
                            .map(|item| {
                                let Some(num) = item
                                    .as_object()
                                    .filter(|obj| obj.get("_placeholder") == Some(&Value::Bool(true)))
                                    .and_then(|obj| obj.get("num"))
                                    .and_then(Value::as_u64)
                                    .and_then(|n| usize::try_from(n).ok())
                                else {
                                    return Err("expected binary postcard payload".to_string());
                                };
                                bins.get(num)
                                    .map(|bytes| bytes.to_vec())
                                    .ok_or_else(|| "missing binary attachment".to_string())
                            })
                            .collect())
                    }
                    Ok(_) => Err("event packet carries no event name".to_string()),
                    Err(err) => Err(format!("malformed event packet: {err}")),
                },
                _ => Err("malformed event packet".to_string()),
            };
            Ok(Self { args, acked: ack_id.is_some() })
        }
    }

    struct Call {
        args: Result<Vec<Result<Vec<u8>, String>>, String>,
        ack: Option<AckSender>,
    }

    /// Registers one inbound method with its own queue: socketioxide runs the
    /// listener synchronously in arrival order, the listener only enqueues, and
    /// one task per method drains the queue — so same-method calls keep their
    /// order and a slow handler stalls only its own method.
    pub(super) fn listen<F>(binding: &Arc<Binding>, method: &'static str, arity: usize, acked: bool, run: F)
    where
        F: Fn(super::Context, Vec<Result<Vec<u8>, String>>) -> BoxedCall + Send + Sync + 'static,
    {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Call>();
        binding.socket.on(method, move |inbound: Inbound, ack: AckSender| {
            let call = Call { args: inbound.args, ack: inbound.acked.then_some(ack) };
            if let Err(mpsc::error::SendError(call)) = sender.send(call) {
                // The binding is gone: answer rather than leave the caller to time out.
                if let (true, Some(ack)) = (acked, call.ack) {
                    let error = RpcError::new(RpcErrorCode::Disposed, "server binding is disposed").in_method(method);
                    let _ = ack.send(&Payload(rpc_encode_error_result(&error)));
                }
            }
            ::std::future::ready(())
        });

        let binding = Arc::clone(binding);
        ::tokio::spawn(async move {
            let mut cancel = binding.cancel.subscribe();
            loop {
                let call = ::tokio::select! {
                    biased;
                    _ = cancel.wait_for(|cancelled| *cancelled) => break,
                    call = receiver.recv() => match call {
                        Some(call) => call,
                        None => break,
                    },
                };
                serve(&binding, method, arity, acked, &run, call).await;
            }
            receiver.close();
            while let Ok(call) = receiver.try_recv() {
                if let (true, Some(ack)) = (acked, call.ack) {
                    let error = binding.closed_error().in_method(method);
                    let _ = ack.send(&Payload(rpc_encode_error_result(&error)));
                }
            }
        });
    }

    async fn serve<F>(binding: &Arc<Binding>, method: &'static str, arity: usize, acked: bool, run: &F, call: Call)
    where
        F: Fn(super::Context, Vec<Result<Vec<u8>, String>>) -> BoxedCall + Send + Sync + 'static,
    {
        if acked && call.ack.is_none() {
            binding.emit_error(&RpcError::invalid_argument("missing acknowledgement callback").in_method(method));
            return;
        }
        let result = match call.args {
            Err(message) => Err(RpcError::invalid_argument(message)),
            Ok(args) if args.len() != arity => {
                Err(RpcError::invalid_argument(format!("expected {arity} arguments, got {}", args.len())))
            }
            Ok(_) if binding.disposed() => Err(binding.closed_error()),
            Ok(args) => {
                let ctx = super::Context { binding: Arc::clone(binding) };
                // Its own task, so a panicking handler answers INTERNAL_ERROR instead of killing the queue.
                match ::tokio::spawn(run(ctx, args)).await {
                    Ok(result) => result,
                    Err(join) if join.is_panic() => Err(RpcError::internal(rpc_panic_message(join.into_panic()))),
                    Err(join) => Err(RpcError::internal(join)),
                }
            }
        }
        .map_err(|error| error.in_method(method));

        match (acked, call.ack) {
            (true, Some(ack)) => {
                let payload = match result {
                    Ok(bytes) => bytes,
                    Err(error) => rpc_encode_error_result(&error),
                };
                let _ = ack.send(&Payload(payload));
            }
            // A fire-and-forget call has no acknowledgement slot, so its failure travels out of band.
            _ => {
                if let Err(error) = result {
                    binding.emit_error(&error);
                }
            }
        }
    }

    /// Observes the failures the peer reports for fire-and-forget calls it handled.
    pub(super) fn listen_errors(binding: &Arc<Binding>) {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Option<Result<Vec<u8>, String>>>();
        binding.socket.on(RPC_ERROR_EVENT, move |inbound: Inbound| {
            let _ = sender.send(inbound.args.ok().and_then(|args| args.into_iter().next()));
            ::std::future::ready(())
        });
        let binding = Arc::clone(binding);
        ::tokio::spawn(async move {
            let mut cancel = binding.cancel.subscribe();
            loop {
                let report = ::tokio::select! {
                    biased;
                    _ = cancel.wait_for(|cancelled| *cancelled) => break,
                    report = receiver.recv() => match report {
                        Some(report) => report,
                        None => break,
                    },
                };
                let error = match report {
                    Some(Ok(bytes)) => rpc_decode_error(&bytes)
                        .unwrap_or_else(|err| RpcError::internal(err).with_method(RPC_ERROR_EVENT)),
                    Some(Err(err)) => RpcError::internal(err).with_method(RPC_ERROR_EVENT),
                    None => RpcError::internal("missing error payload").with_method(RPC_ERROR_EVENT),
                };
                let observers: Vec<_> = binding.lock().errors.list.iter().map(|(_, observer)| Arc::clone(observer)).collect();
                notify(observers, &error);
            }
        });
    }

    /// socketioxide keeps one disconnect handler per socket; the binding owns it
    /// and fans it out through ${"`"}ServerBinding::on_disconnect${"`"}.
    pub(super) fn listen_disconnect(binding: &Arc<Binding>) {
        let binding: Weak<Binding> = Arc::downgrade(binding);
        let socket = match binding.upgrade() {
            Some(binding) => binding.socket.clone(),
            None => return,
        };
        socket.on_disconnect(move |reason: DisconnectReason| {
            if let Some(binding) = binding.upgrade() {
                let observers: Vec<_> = {
                    let mut state = binding.lock();
                    state.disconnected = true;
                    state.disconnects.list.iter().map(|(_, observer)| Arc::clone(observer)).collect()
                };
                notify(observers, reason.to_string().as_str());
                binding.dispose();
            }
            ::std::future::ready(())
        });
    }

    /// Spreads call arguments into separate Socket.IO arguments: socketioxide
    /// treats a tuple as an argument list and anything else as one argument.
    struct Args<'a>(&'a [Payload]);

    impl ::serde::Serialize for Args<'_> {
        fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use ::serde::ser::SerializeTuple;
            let mut tuple = serializer.serialize_tuple(self.0.len())?;
            for value in self.0 {
                tuple.serialize_element(value)?;
            }
            tuple.end()
        }
    }

    fn send_error(error: SendError, method: &str) -> RpcError {
        match error {
            SendError::Socket(SocketError::Closed) => RpcError::new(RpcErrorCode::Disconnected, "socket is disconnected"),
            other => RpcError::internal(other),
        }
        .in_method(method)
    }

    fn ack_error(error: AckError, method: &str) -> RpcError {
        match error {
            AckError::Timeout => RpcError::new(RpcErrorCode::Timeout, "operation has timed out"),
            AckError::Socket(SocketError::Closed) => RpcError::new(RpcErrorCode::Disconnected, "socket is disconnected"),
            AckError::Decode(err) => RpcError::invalid_argument(format!("invalid acknowledgement payload: {err}")),
            other => RpcError::internal(other),
        }
        .in_method(method)
    }

    #[allow(dead_code)]
    pub(super) fn emit(
        binding: &Binding,
        method: &str,
        args: Vec<Result<Vec<u8>, String>>,
    ) -> Result<(), RpcError> {
        let args: Vec<Payload> = rpc_encode_args(method, args)?.into_iter().map(Payload).collect();
        if binding.disposed() {
            return Err(binding.closed_error().in_method(method));
        }
        binding.socket.emit(method, &Args(&args)).map_err(|err| send_error(err, method))
    }

    async fn request_raw(
        binding: &Binding,
        timeout: Duration,
        method: &str,
        args: Vec<Result<Vec<u8>, String>>,
    ) -> Result<Vec<u8>, RpcError> {
        let args: Vec<Payload> = rpc_encode_args(method, args)?.into_iter().map(Payload).collect();
        if binding.disposed() {
            return Err(binding.closed_error().in_method(method));
        }
        let ack = binding
            .socket
            .timeout(timeout)
            .emit_with_ack::<_, Payload>(method, &Args(&args))
            .map_err(|err| send_error(err, method))?;
        // A call in flight fails the moment its connection drops or the binding is disposed.
        let payload = ::tokio::select! {
            result = ack => result.map_err(|err| ack_error(err, method))?,
            () = binding.cancelled() => return Err(binding.closed_error().in_method(method)),
        };
        Ok(payload.0)
    }

    #[allow(dead_code)]
    pub(super) async fn request<T: ::serde::de::DeserializeOwned>(
        binding: &Binding,
        timeout: Duration,
        method: &str,
        args: Vec<Result<Vec<u8>, String>>,
    ) -> Result<T, RpcError> {
        let bytes = request_raw(binding, timeout, method, args).await?;
        rpc_decode_result(method, &bytes)
    }

    #[allow(dead_code)]
    pub(super) async fn request_json<T: rpc_json::WireOwned>(
        binding: &Binding,
        timeout: Duration,
        method: &str,
        args: Vec<Result<Vec<u8>, String>>,
    ) -> Result<T, RpcError> {
        let bytes = request_raw(binding, timeout, method, args).await?;
        rpc_decode_json_result(method, &bytes)
    }
}
`;

export function emitServerFile(
  schema: RpcSchema,
  declarations: DeclarationScope,
  timeoutMs: number,
): string {
  const inbound = inboundMethods(schema);
  const outbound = outboundMethods(schema);
  const lines = [
    ...header("Rust server: answers the client's calls and calls the client, over socketioxide."),
    "#![allow(clippy::too_many_arguments)]",
    "",
    ...(inbound.length > 0 ? ["use ::std::future::Future;"] : []),
    "use ::std::sync::Arc;",
    "use ::std::time::Duration;",
    "",
    "use ::socketioxide::extract::SocketRef;",
    "",
    typesImport(schema, declarations),
    "",
    ...emitHandlerTrait(
      "ServerHandler",
      inbound,
      "/// Answers the calls the client makes. One handler may be bound to any number of sockets.\n///\n/// Return `Err(RpcError)` to fail a call; a panic answers `INTERNAL_ERROR`.",
    ),
    "",
    "/// Binds `handler` to `socket` and returns the binding. Call it in the namespace's",
    "/// connect handler, before the first `.await`, so no event can arrive before the",
    "/// listeners are registered:",
    "///",
    "/// ```ignore",
    "/// io.ns(\"/\", move |socket: SocketRef| {",
    "///     bind_server(&socket, Arc::clone(&handler));",
    "///     async {}",
    "/// });",
    "/// ```",
    "///",
    "/// The binding owns the socket's disconnect handler (socketioxide keeps one per",
    "/// socket); observe disconnects with [`ServerBinding::on_disconnect`]. It disposes",
    "/// itself when the socket disconnects.",
    "pub fn bind_server<H: ServerHandler>(socket: &SocketRef, handler: Arc<H>) -> ServerBinding {",
    "    let binding = rpc_runtime::Binding::new(socket.clone());",
    ...(inbound.length === 0
      ? ["    drop(handler);"]
      : inbound.flatMap((method) => emitListen(method, declarations, "&binding"))),
    "    rpc_runtime::listen_errors(&binding);",
    "    rpc_runtime::listen_disconnect(&binding);",
    "    ServerBinding { binding }",
    "}",
    "",
    "/// One socket's binding. Cheap to clone; every clone is the same binding.",
    "#[derive(Clone)]",
    "pub struct ServerBinding {",
    "    binding: Arc<rpc_runtime::Binding>,",
    "}",
    "",
    "impl ServerBinding {",
    "    /// Calls the client on this socket, with the default timeout.",
    "    pub fn client(&self) -> Client {",
    "        Client { binding: Arc::clone(&self.binding), timeout: rpc_runtime::DEFAULT_TIMEOUT }",
    "    }",
    "",
    "    /// The context handlers receive: cancelled when the binding is disposed.",
    "    pub fn context(&self) -> Context {",
    "        Context { binding: Arc::clone(&self.binding) }",
    "    }",
    "",
    "    pub fn socket(&self) -> &SocketRef {",
    "        &self.binding.socket",
    "    }",
    "",
    "    /// Observes failures the client reports for fire-and-forget calls it handled.",
    "    /// Observers are additive and run in registration order.",
    "    pub fn on_rpc_error(&self, observer: impl Fn(&RpcError) + Send + Sync + 'static) -> Unsubscribe {",
    "        self.binding.subscribe_errors(Arc::new(observer))",
    "    }",
    "",
    "    /// Observes the socket disconnecting, with socketioxide's reason.",
    "    /// Observers are additive and run in registration order.",
    "    pub fn on_disconnect(&self, observer: impl Fn(&str) + Send + Sync + 'static) -> Unsubscribe {",
    "        self.binding.subscribe_disconnects(Arc::new(observer))",
    "    }",
    "",
    "    pub fn disposed(&self) -> bool {",
    "        self.binding.disposed()",
    "    }",
    "",
    "    /// Stops answering calls (later ones get `DISPOSED`), fails calls in flight,",
    "    /// cancels every handler's context and drops the observers. Idempotent.",
    "    pub fn dispose(&self) {",
    "        self.binding.dispose()",
    "    }",
    "}",
    "",
    "/// What a handler receives about the call's connection.",
    "#[derive(Clone)]",
    "pub struct Context {",
    "    binding: Arc<rpc_runtime::Binding>,",
    "}",
    "",
    "impl Context {",
    "    pub fn socket(&self) -> &SocketRef {",
    "        &self.binding.socket",
    "    }",
    "",
    "    /// Calls the client this call came from.",
    "    pub fn client(&self) -> Client {",
    "        Client { binding: Arc::clone(&self.binding), timeout: rpc_runtime::DEFAULT_TIMEOUT }",
    "    }",
    "",
    "    /// Whether the binding was disposed or the socket disconnected.",
    "    pub fn is_cancelled(&self) -> bool {",
    "        self.binding.is_cancelled()",
    "    }",
    "",
    "    /// Resolves once the binding is disposed or the socket disconnects.",
    "    pub async fn cancelled(&self) {",
    "        self.binding.cancelled().await",
    "    }",
    "}",
    "",
    "/// Calls the client of one socket. Cheap to clone.",
    "#[derive(Clone)]",
    "pub struct Client {",
    "    binding: Arc<rpc_runtime::Binding>,",
    "    timeout: Duration,",
    "}",
    "",
    "impl Client {",
    "    /// A client whose acknowledged calls wait `timeout` instead of the default.",
    "    pub fn with_timeout(&self, timeout: Duration) -> Self {",
    "        Self { binding: Arc::clone(&self.binding), timeout }",
    "    }",
    "",
    "    pub fn connected(&self) -> bool {",
    "        !self.binding.disposed() && self.binding.socket.connected()",
    "    }",
    ...outbound.flatMap((method) => ["", ...emitCallMethod(method, declarations, "&self.binding")]),
    "}",
    SERVER_RUNTIME(timeoutMs),
  ];
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
