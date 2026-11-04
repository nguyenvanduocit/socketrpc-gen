/**
 * The Go client: a reconnecting connection to a SocketRPC server.
 *
 * Everything the client shares with the server — the per-method queues, the
 * binding inbound calls are dispatched through, the caller outbound calls are
 * made through — comes from the shared writers in `emitter.ts`, parameterized
 * by the client's `GoSide`. This module writes only what a server has no
 * counterpart for: `Dial`, and the `Conn` lifecycle a socket that reconnects
 * needs.
 *
 * The two differences from the server's `Client` that a reader should know:
 *
 * - A call made while the connection is down fails at once with DISCONNECTED,
 *   like the server's `Client`, rather than waiting for a reconnect the way the
 *   TypeScript client buffers: every emit refuses the socket's send buffer
 *   (`NoBuffer`), so nothing is sent on a later connection. A call in flight
 *   when the connection drops fails the same way, through the connection's
 *   session: a context cancelled on every live-to-down transition, so the
 *   caller never depends on the socket clearing its acknowledgements.
 * - An inbound call runs under the session context of the connection it
 *   arrived on, so a handler still running when that connection drops is told
 *   to stop and frees its method's queue for the next connection. Its answer
 *   is dropped by the socket, which ties an acknowledgement to the engine
 *   session the call arrived on.
 *
 * A client in its own package names the types package only in the import, in
 * the aliases `writeTypesBridge` declares and in exported signatures. Function
 * bodies spell `rpc_X`, so no local a body declares can shadow the package.
 */

import type { RpcSchema } from "../schema";
import {
  GENERATED_HEADER,
  GoWriter,
  generateGoTypes,
  writeAckResult,
  writeBinding,
  writeCaller,
  writeEventQueue,
  writeHandlerInterface,
  writeImports,
  writeInboundCall,
  writeInboundHandlers,
  writeRuntimeHelpers,
  writeSocketEmitState,
  type GoSide,
} from "./emitter";
import { GENERATED_PREFIX, generated, padGoColumn } from "./names";
import {
  GO_CLIENT_FILENAME,
  GO_TYPES_FILENAME,
  resolveGoBackendOptions,
  type GeneratedGoClientFiles,
  type GoBackendOptions,
  type ResolvedGoBackendOptions,
} from "./options";
import { declarationsByName, goTypeName, inboundMethods, outboundMethods } from "./project";
import { validateGoSchema } from "./validate";

/** The import alias of the Socket.IO client package. */
const SOCKET_ALIAS = "sioclient";

function clientSide(typesPackage: string | undefined): GoSide {
  return {
    q: typesPackage ? GENERATED_PREFIX : "",
    apiQ: typesPackage ? `${typesPackage}.` : "",
    handlerType: "ClientHandler",
    bindingType: generated("clientBinding"),
    bindFunction: generated("bindClient"),
    entryPoint: "Dial",
    callerType: "Conn",
    socketType: `*${SOCKET_ALIAS}.Socket`,
    // clients/socket exports no Ack type; the callback it hands a listener is
    // the server package's alias for this function type.
    ackType: "func([]any, error)",
    peer: "server",
    disposedMessage: "connection is disposed",
    disposeOnDisconnect: false,
    reconnects: true,
    payloadCheck: true,
  };
}

function writeFields(writer: GoWriter, fields: readonly (readonly [string, string])[]): void {
  const width = Math.max(...fields.map(([name]) => name.length));
  for (const [name, type] of fields) writer.line(`${padGoColumn(name, width)}${type}`);
}

/**
 * Declares, at file scope, the `rpc_` aliases a separate client's bodies reach
 * the types package through: its error API and every contract type.
 *
 * A local or parameter a body declares — `method`, `conn`, `handler`, `b` —
 * would shadow the package name for the rest of that body, and any lower-case
 * Go identifier is a legal `--go-package`. Moving every body reference out to
 * file scope makes the two meet nowhere: file scope holds only the imports,
 * the exported API and the `rpc_` namespace, which validation keeps the types
 * package's name out of. The aliases cannot meet each other or the emitter's
 * other `rpc_` names either: every one is `rpc_` followed by an exported name,
 * the contract's declarations may not reuse the error API's, and every other
 * `rpc_` name continues in lower case.
 */
function writeTypesBridge(writer: GoWriter, schema: RpcSchema, typesPackage: string): void {
  const types = ["RpcError", "RpcErrorCode", ...schema.declarations.map((declaration) => goTypeName(declaration.name))];
  const constants = [
    "RPCErrorEvent",
    "CodeTimeout",
    "CodeDisposed",
    "CodeDisconnected",
    "CodeAborted",
    "CodeInternalError",
    "CodeInvalidArgument",
  ];
  const writeGroup = (keyword: string, names: readonly string[]): void => {
    const width = Math.max(...names.map((name) => generated(name).length));
    writer.line(`${keyword} (`);
    for (const name of names) writer.line(`\t${padGoColumn(generated(name), width)}= ${typesPackage}.${name}`);
    writer.line(")");
  };

  writer.line(`// Function bodies reach the ${typesPackage} package only through these aliases, so`);
  writer.line("// no local a body declares can shadow the package's name.");
  writeGroup("type", types);
  writer.line();
  writeGroup("const", constants);
  writer.line();
  writer.line(`var ${generated("NewRpcError")} = ${typesPackage}.NewRpcError`);
}

/**
 * Emits the listener every inbound method is registered through: the
 * per-method queue of `queuedListener`, with each call carrying the session
 * context of the connection it arrived on, captured before it is queued.
 */
function writeSessionListener(writer: GoWriter): void {
  writer.line("// sessionListener gives one event its own queue and hands each call the");
  writer.line("// context of the connection it arrived on, captured on arrival: a call that");
  writer.line("// waits in the queue across a reconnect still belongs to the old connection.");
  writer.block(
    `func ${generated("sessionListener")}(conn *Conn, run func(context.Context, []any)) func(...any)`,
    () => {
      writer.block(`queue := ${generated("newEventQueue")}(func(event []any)`, () => {
        writer.line("ctx, _ := event[0].(context.Context)");
        writer.line("args, _ := event[1].([]any)");
        writer.line("run(ctx, args)");
      }, "})");
      writer.block("return func(rawArgs ...any)", () => {
        writer.line("queue.push([]any{conn.sessionContext(), append([]any(nil), rawArgs...)})");
      });
    },
  );
}

function writeDialOptions(writer: GoWriter): void {
  writer.line("// DialOptions configures one connection. The zero value joins the default");
  writer.line("// namespace with no auth payload and the generated default call timeout.");
  writer.block("type DialOptions struct", () => {
    writer.line('// Namespace is the Socket.IO namespace to join, "/" when empty. The address');
    writer.line("// passed to Dial carries no path of its own.");
    writer.line("Namespace string");
    writer.line("// Auth is sent in the CONNECT packet of every attempt, reconnects included.");
    writer.line("// Dial copies the map, so later changes to it are not seen.");
    writer.line("Auth map[string]any");
    writer.line("// Timeout bounds each acknowledged call; zero means the generated default.");
    writer.line("Timeout time.Duration");
    writer.line("// Manager configures the transport: transports, TLS, headers, path and the");
    writer.line("// reconnection backoff. Dial copies it and always turns AutoConnect off.");
    writer.line("// Without transports set here, Dial connects over WebSocket alone.");
    writer.line(`Manager ${SOCKET_ALIAS}.ManagerOptionsInterface`);
  });
}

function writeConnType(writer: GoWriter, side: GoSide): void {
  const subscription = generated("lifecycleSubscription");

  writer.line("// lifecycleSubscription is one OnConnect or OnDisconnect registration. The");
  writer.line("// id is what unsubscribe removes by, as for OnRpcError.");
  writer.block(`type ${subscription} struct`, () => {
    writeFields(writer, [
      ["id", "uint64"],
      ["connect", "func()"],
      ["disconnect", "func(string)"],
    ]);
  });
  writer.line();
  writer.line("// Conn is one connection to the server: the calls this side makes, the");
  writer.line("// handler that answers the server's calls, and the reconnecting socket both");
  writer.line("// travel over. Dial creates it and Dispose ends it.");
  writer.block("type Conn struct", () => {
    writeFields(writer, [
      ["socket", side.socketType],
      ["emitState", `*${generated("socketEmitState")}`],
      ["binding", `*${side.bindingType}`],
      ["namespace", "string"],
      ["timeout", "time.Duration"],
      ["lifecycle", `*${generated("eventQueue")}`],
    ]);
    writer.line();
    writer.line("mu sync.RWMutex");
    writer.line();
    writer.line("// live is true between a connect and the next disconnect. session is the");
    writer.line("// context of the latest connection, derived from Context(); endSession");
    writer.line("// cancels it when that connection drops.");
    writeFields(writer, [
      ["disposed", "bool"],
      ["live", "bool"],
      ["session", "context.Context"],
      ["endSession", "context.CancelFunc"],
      ["err", `*${side.q}RpcError`],
      ["lastError", "string"],
      ["observers", `[]${subscription}`],
      ["observerSeq", "uint64"],
      ["done", "chan struct{}"],
      ["doneOnce", "sync.Once"],
      ["dialed", "chan struct{}"],
      ["dialOnce", "sync.Once"],
      ["disposeOnce", "sync.Once"],
    ]);
    writer.line();
    writeFields(writer, [
      ["listenConnect", "func(...any)"],
      ["listenDisconnect", "func(...any)"],
      ["listenConnectError", "func(...any)"],
      ["listenReconnectFailed", "func(...any)"],
    ]);
  });
}

function writeDial(writer: GoWriter, side: GoSide, defaultTimeoutMs: number): void {
  const { q } = side;
  const invalid = (message: string): string =>
    `return nil, ${q}NewRpcError(${q}CodeInvalidArgument, ${message}, "Dial", nil)`;

  writer.line("// Dial connects to the server at address, an http, https, ws or wss URL, and");
  writer.line("// returns once the namespace has accepted the connection. It keeps retrying");
  writer.line("// an unreachable server until ctx ends, so a worker may start before the");
  writer.line("// server it serves.");
  writer.line("//");
  writer.line("// A handshake the server refuses returns at once, as a DISCONNECTED *RpcError");
  writer.line("// carrying the server's message. A ctx that ends first returns TIMEOUT or");
  writer.line("// ABORTED, naming the last connect error seen.");
  writer.line("//");
  writer.line("// Once connected the socket reconnects by itself, sending Auth again each");
  writer.line("// time; handler keeps answering throughout. Use OnConnect to repeat whatever");
  writer.line("// the server should hear after each reconnect.");
  writer.block(
    "func Dial(ctx context.Context, address string, handler ClientHandler, options *DialOptions) (*Conn, error)",
    () => {
      writer.block(`if err := ${generated("errorFromContext")}(ctx, "Dial"); err != nil`, () =>
        writer.line("return nil, err"),
      );
      writer.block("if options == nil", () => writer.line("options = &DialOptions{}"));
      writer.block("if options.Timeout < 0", () => writer.line(invalid('"timeout must not be negative"')));
      writer.line("namespace := options.Namespace");
      writer.block('if namespace == ""', () => writer.line('namespace = "/"'));
      writer.block("if namespace[0] != '/'", () =>
        writer.line(invalid('fmt.Sprintf("namespace %q must start with /", namespace)')),
      );
      writer.line("parsed, err := url.Parse(address)");
      writer.block("if err != nil", () => writer.line(invalid('fmt.Sprintf("invalid address: %v", err)')));
      writer.line("switch parsed.Scheme {");
      writer.line('case "http", "https", "ws", "wss":');
      writer.line("default:");
      writer.line(`\t${invalid('fmt.Sprintf("address %q must use http, https, ws or wss", address)')}`);
      writer.line("}");
      writer.block('if parsed.Path != "" && parsed.Path != "/"', () =>
        writer.line(
          invalid('fmt.Sprintf("address %q has the path %q; set DialOptions.Namespace instead", address, parsed.Path)'),
        ),
      );
      writer.line(`timeout := ${defaultTimeoutMs} * time.Millisecond`);
      writer.block("if options.Timeout > 0", () => writer.line("timeout = options.Timeout"));
      writer.line();
      writer.line("// Dial owns its Manager rather than sharing one from the package cache, so");
      writer.line("// the socket and the Manager's reconnect_failed belong to this Conn alone.");
      writer.line(`managerOptions := ${SOCKET_ALIAS}.DefaultManagerOptions()`);
      writer.line("managerOptions.Assign(options.Manager)");
      writer.line("managerOptions.SetAutoConnect(false)");
      writer.line("// A server-to-server connection gains nothing from starting on HTTP");
      writer.line("// long-polling and upgrading: one WebSocket is the whole session.");
      writer.block("if managerOptions.Transports() == nil", () =>
        writer.line(`managerOptions.SetTransports(${SOCKET_ALIAS}.WebSocketOnly())`),
      );
      writer.line(`socketOptions := ${SOCKET_ALIAS}.DefaultSocketOptions()`);
      writer.block("if options.Auth != nil", () => {
        writer.line("auth := make(map[string]any, len(options.Auth))");
        writer.block("for key, value := range options.Auth", () => writer.line("auth[key] = value"));
        writer.line("socketOptions.SetAuth(auth)");
      });
      writer.line(`rawSocket := ${SOCKET_ALIAS}.NewManager(address, managerOptions).Socket(namespace, socketOptions)`);
      writer.line();
      writer.line("conn := &Conn{");
      const initializers: (readonly [string, string])[] = [
        ["socket", "rawSocket"],
        ["emitState", `${generated("acquireSocketEmitState")}(rawSocket)`],
        ["namespace", "namespace"],
        ["timeout", "timeout"],
        ["done", "make(chan struct{})"],
        ["dialed", "make(chan struct{})"],
      ];
      const keyWidth = Math.max(...initializers.map(([name]) => name.length + 1));
      for (const [name, value] of initializers) writer.line(`\t${padGoColumn(`${name}:`, keyWidth)}${value},`);
      writer.line("}");
      writer.line(`conn.lifecycle = ${generated("newEventQueue")}(conn.notify)`);
      writer.line(`binding, err := ${side.bindFunction}(rawSocket, handler, conn)`);
      writer.block("if err != nil", () => {
        writer.line(`${generated("releaseSocketEmitState")}(rawSocket, conn.emitState)`);
        writer.line("return nil, err");
      });
      writer.line("conn.binding = binding");
      writer.line("// There is no connection before the first connect, so a call cannot arrive");
      writer.line("// under one; the session it would see is already over.");
      writer.line("conn.session, conn.endSession = context.WithCancel(binding.Context())");
      writer.line("conn.endSession()");
      writer.block("if err := conn.listen(); err != nil", () => {
        writer.line("conn.Dispose()");
        writer.line("return nil, err");
      });
      writer.line("rawSocket.Connect()");
      writer.line();
      writer.line("select {");
      writer.line("case <-conn.dialed:");
      writer.line("\treturn conn, nil");
      writer.line("case <-conn.done:");
      writer.line('\tfailure := conn.stateError("Dial")');
      writer.line("\tconn.Dispose()");
      writer.line("\treturn nil, failure");
      writer.line("case <-ctx.Done():");
      writer.line(`\tfailure := ${generated("errorFromContext")}(ctx, "Dial")`);
      writer.line("\tconn.mu.RLock()");
      writer.line("\tlast := conn.lastError");
      writer.line("\tconn.mu.RUnlock()");
      writer.block("\tif last != \"\"", () => {
        writer.line('\tfailure.Message = fmt.Sprintf("%s; last connect error: %s", failure.Message, last)');
      }, "\t}");
      writer.line("\tconn.Dispose()");
      writer.line("\treturn nil, failure");
      writer.line("}");
    },
  );
}

function writeConnLifecycle(writer: GoWriter, side: GoSide): void {
  const { q } = side;
  const subscription = generated("lifecycleSubscription");

  writer.line("// listen registers the lifecycle listeners. They run on the socket's own");
  writer.line("// goroutines, so each records the transition and queues what observers see,");
  writer.line("// leaving an observer free to make a call.");
  writer.block("func (c *Conn) listen() error", () => {
    writer.line("c.listenConnect = func(...any) { c.handleConnect() }");
    writer.line("c.listenDisconnect = func(args ...any) { c.handleDisconnect(args) }");
    writer.line("c.listenConnectError = func(args ...any) { c.handleConnectError(args) }");
    writer.line('c.listenReconnectFailed = func(...any) { c.terminate("reconnection attempts exhausted") }');
    for (const [event, field] of [
      ["connect", "listenConnect"],
      ["disconnect", "listenDisconnect"],
      ["connect_error", "listenConnectError"],
    ] as const) {
      writer.block(`if err := c.socket.On(${JSON.stringify(event)}, c.${field}); err != nil`, () =>
        writer.line(`return fmt.Errorf("register ${event}: %w", err)`),
      );
    }
    writer.block('if err := c.socket.Io().On("reconnect_failed", c.listenReconnectFailed); err != nil', () =>
      writer.line('return fmt.Errorf("register reconnect_failed: %w", err)'),
    );
    writer.line("return nil");
  });
  writer.line();
  writer.block("func (c *Conn) handleConnect()", () => {
    writer.line("c.mu.Lock()");
    writer.block("if c.live || c.disposed || c.err != nil", () => {
      writer.line("c.mu.Unlock()");
      writer.line("return");
    });
    writer.line("c.live = true");
    writer.line("c.session, c.endSession = context.WithCancel(c.binding.Context())");
    writer.line(`observers := append([]${subscription}(nil), c.observers...)`);
    writer.line("c.mu.Unlock()");
    writer.block("c.dialOnce.Do(func()", () => writer.line("close(c.dialed)"), "})");
    writer.line("c.announce(observers, true, \"\")");
  });
  writer.line();
  writer.block("func (c *Conn) handleDisconnect(args []any)", () => {
    writer.line('reason := "disconnected"');
    writer.block("if len(args) > 0", () => {
      writer.block('if text, ok := args[0].(string); ok && text != ""', () => writer.line("reason = text"));
    });
    writer.line("c.mu.Lock()");
    writer.line("// Socket.IO can report one loss twice; only the transition counts.");
    writer.line("wasLive := c.live");
    writer.block("if wasLive", () => {
      writer.line("c.live = false");
      writer.line("c.endSession()");
    });
    writer.line(`observers := append([]${subscription}(nil), c.observers...)`);
    writer.line("c.mu.Unlock()");
    writer.block("if wasLive", () => writer.line("c.announce(observers, false, reason)"));
    writer.block("if !c.willReconnect()", () => writer.line('c.terminate("connection closed: " + reason)'));
  });
  writer.line();
  writer.block("func (c *Conn) handleConnectError(args []any)", () => {
    writer.line('message := "connect error"');
    writer.block("if len(args) > 0 && args[0] != nil", () => {
      writer.block("if err, ok := args[0].(error); ok", () => writer.line("message = err.Error()"), "} else {");
      // The `} else {` above closes the if and opens its else branch.
      writer.line("\tmessage = fmt.Sprint(args[0])");
      writer.line("}");
    });
    writer.line("c.mu.Lock()");
    writer.line("c.lastError = message");
    writer.line("c.mu.Unlock()");
    writer.line("// A refused handshake destroys the socket before reporting it, so it will");
    writer.line("// not try again, and the server's message is why the connection ended.");
    writer.block("if !c.willReconnect()", () => writer.line("c.terminate(message)"));
  });
  writer.line();
  writer.line("// willReconnect reports whether the socket will try again after a loss: it");
  writer.line("// is still active, which a server-side disconnect or a refused handshake");
  writer.line("// ends, and its Manager has reconnection on.");
  writer.block("func (c *Conn) willReconnect() bool", () =>
    writer.line("return c.socket.Active() && c.socket.Io().Reconnection()"),
  );
  writer.line();
  writer.line("// terminate ends the connection for good after a loss the socket will not");
  writer.line("// recover from. Calls in flight and later ones fail with it as Err.");
  writer.block("func (c *Conn) terminate(message string)", () => {
    writer.line("c.mu.Lock()");
    writer.block("if c.disposed || c.err != nil", () => {
      writer.line("c.mu.Unlock()");
      writer.line("return");
    });
    writer.line(`c.err = ${q}NewRpcError(${q}CodeDisconnected, message, "", nil)`);
    writer.line("c.mu.Unlock()");
    writer.block("c.doneOnce.Do(func()", () => writer.line("close(c.done)"), "})");
  });
  writer.line();
  writer.line("// announce queues one transition for the observers registered when it");
  writer.line("// happened, so an observer added afterwards never sees it.");
  writer.block(`func (c *Conn) announce(observers []${subscription}, connected bool, reason string)`, () => {
    writer.block("if len(observers) > 0", () => writer.line("c.lifecycle.push([]any{observers, connected, reason})"));
  });
  writer.line();
  writer.line("// notify runs on the lifecycle queue, in transition order and off the");
  writer.line("// socket's goroutines.");
  writer.block("func (c *Conn) notify(event []any)", () => {
    writer.line(`observers, _ := event[0].([]${subscription})`);
    writer.line("connected, _ := event[1].(bool)");
    writer.line("reason, _ := event[2].(string)");
    writer.block("for _, sub := range observers", () => {
      writer.block("if c.isDisposed()", () => writer.line("return"));
      writer.line("// An observer that panics must not stop the ones registered after it.");
      writer.block("func()", () => {
        writer.block("defer func()", () => writer.line("_ = recover()"), "}()");
        writer.block("if connected && sub.connect != nil", () => writer.line("sub.connect()"), "} else if !connected && sub.disconnect != nil {");
        writer.line("\tsub.disconnect(reason)");
        writer.line("}");
      }, "}()");
    });
  });
  writer.line();
  writer.block(`func (c *Conn) observe(sub ${subscription}) func()`, () => {
    writer.line("c.mu.Lock()");
    writer.line("c.observerSeq++");
    writer.line("id := c.observerSeq");
    writer.line("sub.id = id");
    writer.line("c.observers = append(c.observers, sub)");
    writer.line("c.mu.Unlock()");
    writer.block("return func()", () => {
      writer.line("c.mu.Lock()");
      writer.line("defer c.mu.Unlock()");
      writer.block("for i, candidate := range c.observers", () => {
        writer.block("if candidate.id == id", () => {
          writer.line("c.observers = append(c.observers[:i], c.observers[i+1:]...)");
          writer.line("return");
        });
      });
    });
  });
  writer.line();
  writer.line("// sessionContext is the context of the latest connection: the one an inbound");
  writer.line("// call arriving now arrived on. Its loss, or Dispose, cancels it.");
  writer.block("func (c *Conn) sessionContext() context.Context", () => {
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.line("return c.session");
  });
  writer.line();
  writer.line("// liveSession returns the channel the current connection's loss closes, or");
  writer.line("// why there is no current connection.");
  writer.block(`func (c *Conn) liveSession(method string) (<-chan struct{}, *${q}RpcError)`, () => {
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.block("if failure := c.failure(method); failure != nil", () => writer.line("return nil, failure"));
    writer.line("return c.session.Done(), nil");
  });
  writer.line();
  writer.block(`func (c *Conn) stateError(method string) *${q}RpcError`, () => {
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.line("return c.failure(method)");
  });
  writer.line();
  writer.line("// failure is why a call cannot be made now; the caller holds mu.");
  writer.block(`func (c *Conn) failure(method string) *${q}RpcError`, () => {
    writer.block("if c.disposed", () =>
      writer.line(`return ${q}NewRpcError(${q}CodeDisposed, "connection is disposed", method, nil)`),
    );
    writer.block("if c.err != nil", () => writer.line(`return ${q}NewRpcError(c.err.Code, c.err.Message, method, nil)`));
    writer.block("if !c.live", () =>
      writer.line(`return ${q}NewRpcError(${q}CodeDisconnected, "socket is disconnected", method, nil)`),
    );
    writer.line("return nil");
  });
  writer.line();
  writer.line("// The server's default maxHttpBufferSize, assumed until a handshake reports");
  writer.line("// the real limit.");
  writer.line(`const ${generated("defaultMaxPayload")} = 1_000_000`);
  writer.line();
  writer.line("// An upper bound on what a packet carries besides its JSON array: the");
  writer.line("// Engine.IO and Socket.IO packet types, the namespace separator and an");
  writer.line("// acknowledgement id of up to 20 digits.");
  writer.line(`const ${generated("packetOverhead")} = 24`);
  writer.line();
  writer.line("// checkPayload measures one outbound packet against the limit the server");
  writer.line("// advertised in its handshake. Engine.IO closes the connection over a larger");
  writer.line("// packet, failing every call in flight, so the one that is too large fails");
  writer.line("// here on its own and nothing is sent.");
  writer.block(`func (c *Conn) checkPayload(method string, packet []any) *${q}RpcError`, () => {
    writer.line("encoded, err := json.Marshal(packet)");
    writer.block("if err != nil", () =>
      writer.line(
        `return ${q}NewRpcError(${q}CodeInternalError, fmt.Sprintf("cannot encode payload: %v", err), method, nil)`,
      ),
    );
    writer.line(`limit := int64(${generated("defaultMaxPayload")})`);
    writer.block(
      "if engine, ok := c.socket.Io().Engine().(interface{ MaxPayload() int64 }); ok && engine.MaxPayload() > 0",
      () => writer.line("limit = engine.MaxPayload()"),
    );
    writer.block(`if size := int64(len(encoded)+len(c.namespace)) + ${generated("packetOverhead")}; size > limit`, () => {
      writer.line('message := fmt.Sprintf("payload of about %d bytes exceeds the %d bytes the server accepts", size, limit)');
      writer.line(`return ${q}NewRpcError(${q}CodeInvalidArgument, message, method, nil)`);
    });
    writer.line("return nil");
  });
}

function writeConnApi(writer: GoWriter, side: GoSide): void {
  const { q } = side;
  const subscription = generated("lifecycleSubscription");

  writer.line("// OnConnect registers fn to run after every reconnect from now on; the first");
  writer.line("// connect has happened by the time Dial returns. To announce something the");
  writer.line("// server must hear on every connection, register fn first and then call it");
  writer.line("// once yourself: it is never missed, and at worst sent twice.");
  writer.line("//");
  writer.line("// Observers are additive, run in registration order off the socket's");
  writer.line("// goroutines, and may make calls. Call the returned function to unsubscribe.");
  writer.block("func (c *Conn) OnConnect(fn func()) func()", () => {
    writer.block("if c == nil || fn == nil", () => writer.line("return func() {}"));
    writer.line(`return c.observe(${subscription}{connect: fn})`);
  });
  writer.line();
  writer.line("// OnDisconnect registers fn to run once each time the connection goes down,");
  writer.line("// with the reason Socket.IO gave. Calls in flight have already failed.");
  writer.block("func (c *Conn) OnDisconnect(fn func(reason string)) func()", () => {
    writer.block("if c == nil || fn == nil", () => writer.line("return func() {}"));
    writer.line(`return c.observe(${subscription}{disconnect: fn})`);
  });
  writer.line();
  writer.line("// OnRpcError observes the failures the server reports out of band: a failed");
  writer.line("// handler for a fire-and-forget client-to-server call has no acknowledgement");
  writer.line("// to answer through. Call the returned function to unsubscribe.");
  writer.block(`func (c *Conn) OnRpcError(fn func(*${side.apiQ}RpcError)) func()`, () => {
    writer.block("if c == nil", () => writer.line("return func() {}"));
    writer.line("return c.binding.OnRpcError(fn)");
  });
  writer.line();
  writer.line("// Connected reports whether the connection is up right now.");
  writer.block("func (c *Conn) Connected() bool", () => {
    writer.block("if c == nil", () => writer.line("return false"));
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.line("return !c.disposed && c.err == nil && c.live");
  });
  writer.line();
  writer.block("func (c *Conn) isDisposed() bool", () => {
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.line("return c.disposed");
  });
  writer.line();
  writer.line("// Context lives as long as the Conn: Dispose cancels it. Each handler call");
  writer.line("// receives a context derived from it for the connection the call arrived on,");
  writer.line("// which the loss of that connection also cancels.");
  writer.block("func (c *Conn) Context() context.Context", () => writer.line("return c.binding.Context()"));
  writer.line();
  writer.line("// Done is closed by Dispose, or by a loss the socket will not recover from:");
  writer.line("// a server-side disconnect, a refused reconnect, or reconnection giving up.");
  writer.block("func (c *Conn) Done() <-chan struct{}", () => writer.line("return c.done"));
  writer.line();
  writer.line("// Err is nil until Done is closed, and then why: DISPOSED, or the DISCONNECTED");
  writer.line("// loss that ended the connection.");
  writer.block("func (c *Conn) Err() error", () => {
    writer.line("c.mu.RLock()");
    writer.line("defer c.mu.RUnlock()");
    writer.block("if c.err != nil", () => writer.line("return c.err"));
    writer.block("if c.disposed", () =>
      writer.line(`return ${q}NewRpcError(${q}CodeDisposed, "connection is disposed", "", nil)`),
    );
    writer.line("return nil");
  });
  writer.line();
  writer.line("// Socket is the underlying Socket.IO socket, which this Conn owns.");
  writer.block(`func (c *Conn) Socket() ${side.socketType}`, () => writer.line("return c.socket"));
  writer.line();
  writer.line("// Dispose closes the connection and releases everything Dial set up. Calls in");
  writer.line("// flight fail with DISPOSED and handlers see their context cancelled. It is");
  writer.line("// safe to call more than once, from any goroutine, a handler included.");
  writer.block("func (c *Conn) Dispose()", () => {
    writer.block("if c == nil", () => writer.line("return"));
    writer.block("c.disposeOnce.Do(func()", () => {
      writer.line("c.emitState.mu.Lock()");
      writer.line("c.mu.Lock()");
      writer.line("c.disposed = true");
      writer.line("c.observers = nil");
      writer.line("c.mu.Unlock()");
      writer.block("c.doneOnce.Do(func()", () => writer.line("close(c.done)"), "})");
      writer.line("c.emitState.mu.Unlock()");
      writer.line("c.binding.Dispose()");
      writer.line('c.socket.RemoveListener("connect", c.listenConnect)');
      writer.line('c.socket.RemoveListener("disconnect", c.listenDisconnect)');
      writer.line('c.socket.RemoveListener("connect_error", c.listenConnectError)');
      writer.line('c.socket.Io().RemoveListener("reconnect_failed", c.listenReconnectFailed)');
      writer.line(`${generated("releaseSocketEmitState")}(c.socket, c.emitState)`);
      writer.line("// Last, and outside every lock: Disconnect runs the socket's listeners");
      writer.line("// synchronously.");
      writer.line("c.socket.Disconnect()");
    }, "})");
  });
}

function writeClientFile(schema: RpcSchema, options: ResolvedGoBackendOptions): string {
  const writer = new GoWriter();
  const declarations = declarationsByName(schema);
  const separate = options.client.separate;
  const side = clientSide(separate ? options.packageName : undefined);

  writer.line(GENERATED_HEADER.trimEnd());
  writer.line();
  writer.line(`package ${separate ? separate.packageName : options.packageName}`);
  writer.line();
  // A separate client carries its own copy of the runtime helpers, which is
  // what needs `reflect`; a colocated one uses the types file's.
  writeImports(
    writer,
    ["context", "encoding/json", "errors", "fmt", "net/url", "sync", "time", ...(separate ? ["reflect"] : [])],
    [
      [SOCKET_ALIAS, options.client.socketImport],
      ...(separate ? ([[options.packageName, separate.typesImport]] as const) : []),
    ],
  );
  writer.line();
  if (separate) {
    writeTypesBridge(writer, schema, options.packageName);
    writer.line();
    writeRuntimeHelpers(writer, side.q);
    writer.line();
  }
  writeSocketEmitState(writer, side);
  writer.line();
  writeEventQueue(writer, side);
  writer.line();
  writeSessionListener(writer);
  writer.line();
  // The client serves the methods the server calls, and calls the ones it serves.
  const inbound = outboundMethods(schema);
  writeHandlerInterface(writer, side, inbound);
  writer.line();
  writeBinding(writer, side, inbound);
  writer.line();
  writeInboundCall(writer, side);
  writeInboundHandlers(writer, side, inbound, declarations);
  writer.line();
  writeDialOptions(writer);
  writer.line();
  writeConnType(writer, side);
  writer.line();
  writeDial(writer, side, options.defaultTimeoutMs);
  writer.line();
  writeConnApi(writer, side);
  writer.line();
  writeConnLifecycle(writer, side);
  writer.line();
  writeAckResult(writer);
  writer.line();
  writeCaller(writer, side, inboundMethods(schema));
  return writer.toString();
}

/**
 * Validate a canonical schema and generate the Go client.
 *
 * Without `options.client.separate` the client shares the types package, and
 * the types file is returned alongside it. With it, the client is its own
 * package and imports the types package `generateGo` writes.
 */
export function generateGoClient(schema: RpcSchema, options: GoBackendOptions = {}): GeneratedGoClientFiles {
  validateGoSchema(schema, options, "client");
  const resolved = resolveGoBackendOptions(options);
  const client = writeClientFile(schema, resolved);
  if (resolved.client.separate) return { [GO_CLIENT_FILENAME]: client };
  return {
    [GO_TYPES_FILENAME]: generateGoTypes(schema, resolved.packageName),
    [GO_CLIENT_FILENAME]: client,
  };
}
