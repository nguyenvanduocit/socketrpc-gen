//! A Socket.IO v5 / Engine.IO v4 client over WebSocket, written for the Rust
//! clients socketrpc-gen generates.
//!
//! It is deliberately small and makes the guarantees an RPC layer needs:
//!
//! - **Ordered delivery.** Every inbound event reaches [`Events`] in arrival
//!   order, from one reader task. Nothing is spawned per packet.
//! - **Unique acknowledgement ids.** Ids are a per-socket counter, so two calls
//!   in flight can never be answered with each other's result.
//! - **No buffering across a disconnect.** [`Socket::emit`] and
//!   [`Socket::emit_with_ack`] decide send-or-refuse under the same lock the
//!   connection lifecycle takes: a call made while disconnected fails with
//!   [`Error::Disconnected`] at once and is never sent later, and a call in
//!   flight fails the moment its connection drops.
//! - **Session-bound replies.** An [`Ack`] answers only on the connection its
//!   event arrived on; the server numbers acknowledgements per connection, so a
//!   reply after a reconnect would answer a different call.
//! - **Payload limit.** A frame larger than the server's advertised
//!   `maxPayload` is refused with [`Error::PayloadTooLarge`] instead of being
//!   written, which would make the server close the connection.
//!
//! Only the WebSocket transport is spoken (no HTTP long-polling, no binary
//! attachments). Every Socket.IO v4 server accepts a direct WebSocket
//! connection unless it was configured to allow polling only.

mod packet;

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

use packet::{EngineFrame, Handshake, Packet};

/// How to reach the server and how to behave when the connection drops.
#[derive(Debug, Clone)]
pub struct Options {
    /// `http://`, `https://`, `ws://` or `wss://` origin of the server. Its path
    /// must be empty: the namespace goes in [`Options::namespace`].
    pub url: String,
    /// Engine.IO path on the server. Default `/socket.io/`.
    pub path: String,
    /// Socket.IO namespace. Default `/`.
    pub namespace: String,
    /// Sent in the CONNECT packet; read by the server as `socket.handshake.auth`.
    pub auth: Option<Value>,
    /// Extra HTTP headers on the WebSocket upgrade request.
    pub headers: Vec<(String, String)>,
    /// Retry an unreachable server, and reconnect after a dropped connection.
    /// A server that refuses the namespace, or disconnects the socket itself,
    /// is never retried. Default `true`.
    pub reconnect: bool,
    /// First delay between attempts; doubles up to `reconnect_delay_max`.
    pub reconnect_delay: Duration,
    pub reconnect_delay_max: Duration,
    /// Bound on one connection attempt: upgrade, Engine.IO open and Socket.IO CONNECT.
    pub connect_timeout: Duration,
}

impl Options {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            path: "/socket.io/".to_string(),
            namespace: "/".to_string(),
            auth: None,
            headers: Vec::new(),
            reconnect: true,
            reconnect_delay: Duration::from_millis(500),
            reconnect_delay_max: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(20),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// No connection right now; nothing was sent.
    Disconnected,
    /// [`Socket::close`] was called, or every [`Socket`] handle was dropped.
    Closed,
    /// No acknowledgement, or no connection, within the allotted time.
    Timeout,
    /// The server refused the namespace (Socket.IO CONNECT_ERROR), with its message.
    Refused(String),
    /// The frame exceeds the largest packet the server accepts.
    PayloadTooLarge { size: u64, max: u64 },
    InvalidOptions(String),
    Transport(String),
    Protocol(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Disconnected => f.write_str("socket has been disconnected"),
            Error::Closed => f.write_str("socket is closed"),
            Error::Timeout => f.write_str("operation has timed out"),
            Error::Refused(message) => write!(f, "connection refused: {message}"),
            Error::PayloadTooLarge { size, max } => {
                write!(f, "payload of {size} bytes exceeds the server limit of {max} bytes")
            }
            Error::InvalidOptions(message) => write!(f, "invalid options: {message}"),
            Error::Transport(message) => write!(f, "transport error: {message}"),
            Error::Protocol(message) => write!(f, "protocol error: {message}"),
        }
    }
}

impl std::error::Error for Error {}

/// What the connection reports, in the order it happened.
#[derive(Debug)]
pub enum Event {
    /// A reconnect completed. The first connection is reported by
    /// [`connect`] returning, not by this event.
    Connect,
    /// The connection dropped. `reason` uses socket.io-client's vocabulary:
    /// `transport close`, `transport error`, `ping timeout`, `parse error`,
    /// `io server disconnect`, `io client disconnect`.
    Disconnect { reason: String },
    /// An event from the server. `ack` is present when the server awaits an
    /// acknowledgement.
    Message { event: String, args: Vec<Value>, ack: Option<Ack> },
}

/// Ordered stream of [`Event`]s for one socket.
#[derive(Debug)]
pub struct Events {
    receiver: mpsc::UnboundedReceiver<Event>,
}

impl Events {
    /// The next event, or `None` once the socket is closed for good.
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }
}

/// The reply slot of one inbound event.
#[derive(Debug)]
pub struct Ack {
    shared: Arc<Shared>,
    epoch: u64,
    id: u64,
}

impl Ack {
    /// Answers the event. Fails with [`Error::Disconnected`] when the connection
    /// it arrived on has ended, and with [`Error::PayloadTooLarge`] when the
    /// reply would exceed the server's limit — in which case nothing is sent
    /// and the caller may answer again with something smaller.
    pub fn send(&self, args: &[Value]) -> Result<(), Error> {
        let frame = packet::encode_ack(&self.shared.namespace, self.id, args);
        let state = self.shared.lock();
        match &state.session {
            Some(session) if session.epoch == self.epoch => session.send(frame, state.max_payload),
            _ => Err(Error::Disconnected),
        }
    }
}

/// A handle on one Socket.IO connection. Cheap to clone; the connection closes
/// when the last clone is dropped or [`Socket::close`] is called.
#[derive(Debug, Clone)]
pub struct Socket {
    shared: Arc<Shared>,
    _owner: Arc<Owner>,
}

impl Socket {
    pub fn connected(&self) -> bool {
        self.shared.lock().session.is_some()
    }

    /// The largest frame the server accepts, as it advertised in the handshake.
    pub fn max_payload(&self) -> u64 {
        self.shared.lock().max_payload
    }

    pub fn namespace(&self) -> &str {
        &self.shared.namespace
    }

    /// Sends an event without awaiting an acknowledgement.
    pub fn emit(&self, event: &str, args: &[Value]) -> Result<(), Error> {
        let frame = packet::encode_event(&self.shared.namespace, None, event, args);
        let state = self.shared.lock();
        state.sendable()?.send(frame, state.max_payload)
    }

    /// Sends an event and awaits the server's acknowledgement arguments.
    ///
    /// Dropping the returned future abandons the call; a late acknowledgement
    /// for it is discarded.
    pub async fn emit_with_ack(&self, event: &str, args: &[Value], timeout: Duration) -> Result<Vec<Value>, Error> {
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut state = self.shared.lock();
            let id = state.next_ack;
            let frame = packet::encode_event(&self.shared.namespace, Some(id), event, args);
            state.sendable()?.send(frame, state.max_payload)?;
            state.next_ack += 1;
            state.pending.insert(id, sender);
            id
        };
        let _pending = PendingGuard { shared: &self.shared, id };
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::Disconnected),
            Err(_) => Err(Error::Timeout),
        }
    }

    /// Disconnects from the namespace and stops reconnecting. Calls in flight
    /// fail with [`Error::Disconnected`]; later calls with [`Error::Closed`].
    pub fn close(&self) {
        self.shared.close();
    }
}

/// Connects, retrying an unreachable server while [`Options::reconnect`] is set,
/// and returns once the namespace has accepted the socket.
///
/// A refusal ([`Error::Refused`]) returns at once. To bound the retries, wrap
/// the call in [`tokio::time::timeout`]: dropping the future stops them.
pub async fn connect(options: Options) -> Result<(Socket, Events), Error> {
    let url = websocket_url(&options)?;
    let mut delay = options.reconnect_delay;
    let connection = loop {
        match handshake(&options, &url).await {
            Ok(connection) => break connection,
            Err(error @ (Error::Refused(_) | Error::InvalidOptions(_))) => return Err(error),
            Err(error) if !options.reconnect => return Err(error),
            Err(_) => {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(options.reconnect_delay_max);
            }
        }
    };

    let (close_sender, close_receiver) = watch::channel(false);
    let shared = Arc::new(Shared {
        namespace: options.namespace.clone(),
        state: Mutex::new(State {
            session: None,
            closed: false,
            next_ack: 0,
            pending: HashMap::new(),
            max_payload: packet::DEFAULT_MAX_PAYLOAD,
            epoch: 0,
        }),
        close: close_sender,
    });
    let (outbound_sender, outbound) = mpsc::unbounded_channel();
    let epoch = shared.install(outbound_sender, &connection.handshake);
    let (event_sender, receiver) = mpsc::unbounded_channel();

    tokio::spawn(drive(
        Arc::clone(&shared),
        options,
        url,
        Session0 { connection, outbound, epoch },
        event_sender,
        close_receiver,
    ));

    let owner = Arc::new(Owner { shared: Arc::clone(&shared) });
    Ok((Socket { shared, _owner: owner }, Events { receiver }))
}

// ---------------------------------------------------------------------------
// Shared state

type Pending = oneshot::Sender<Result<Vec<Value>, Error>>;

#[derive(Debug)]
struct Shared {
    namespace: String,
    state: Mutex<State>,
    close: watch::Sender<bool>,
}

#[derive(Debug)]
struct State {
    session: Option<LiveSession>,
    closed: bool,
    next_ack: u64,
    pending: HashMap<u64, Pending>,
    max_payload: u64,
    epoch: u64,
}

impl State {
    fn sendable(&self) -> Result<&LiveSession, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        self.session.as_ref().ok_or(Error::Disconnected)
    }
}

/// The writer side of the connection that is up right now.
#[derive(Debug)]
struct LiveSession {
    epoch: u64,
    outbound: mpsc::UnboundedSender<String>,
}

impl LiveSession {
    fn send(&self, frame: String, max_payload: u64) -> Result<(), Error> {
        let size = frame.len() as u64;
        if size > max_payload {
            return Err(Error::PayloadTooLarge { size, max: max_payload });
        }
        self.outbound.send(frame).map_err(|_| Error::Disconnected)
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // Every critical section leaves the state consistent before it can
        // panic, so a poisoned lock still guards valid data.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn install(&self, outbound: mpsc::UnboundedSender<String>, handshake: &Handshake) -> u64 {
        let mut state = self.lock();
        state.epoch += 1;
        state.max_payload = handshake.max_payload;
        let epoch = state.epoch;
        state.session = Some(LiveSession { epoch, outbound });
        epoch
    }

    fn end_session(&self) {
        let pending = {
            let mut state = self.lock();
            state.session = None;
            std::mem::take(&mut state.pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(Error::Disconnected));
        }
    }

    fn resolve(&self, id: u64, args: Vec<Value>) {
        let sender = self.lock().pending.remove(&id);
        if let Some(sender) = sender {
            let _ = sender.send(Ok(args));
        }
    }

    fn close(&self) {
        {
            let mut state = self.lock();
            if state.closed {
                return;
            }
            state.closed = true;
        }
        self.end_session();
        self.close.send_replace(true);
    }

    fn is_closed(&self) -> bool {
        self.lock().closed
    }
}

/// Closes the connection when the last user-facing [`Socket`] is dropped. The
/// reader task and outstanding [`Ack`]s hold `Shared` directly, so they cannot
/// keep a connection nobody can reach alive.
#[derive(Debug)]
struct Owner {
    shared: Arc<Shared>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.shared.close();
    }
}

/// Removes an abandoned call's slot, so a dropped `emit_with_ack` future does
/// not leave its sender behind until the session ends.
struct PendingGuard<'a> {
    shared: &'a Shared,
    id: u64,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.shared.lock().pending.remove(&self.id);
    }
}

// ---------------------------------------------------------------------------
// Connection

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Connection {
    sink: SplitSink<Stream, Message>,
    stream: SplitStream<Stream>,
    handshake: Handshake,
}

/// The connection `connect` established, handed to the reader task.
struct Session0 {
    connection: Connection,
    outbound: mpsc::UnboundedReceiver<String>,
    epoch: u64,
}

fn websocket_url(options: &Options) -> Result<Url, Error> {
    let invalid = |message: String| Error::InvalidOptions(message);
    let mut url = Url::parse(&options.url).map_err(|err| invalid(format!("url {:?}: {err}", options.url)))?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => return Err(invalid(format!("unsupported url scheme {other:?}"))),
    };
    if !matches!(url.path(), "" | "/") {
        return Err(invalid(format!(
            "url path {:?} would be ignored: put the namespace in Options::namespace and the Engine.IO path in Options::path",
            url.path()
        )));
    }
    if !options.namespace.starts_with('/') {
        return Err(invalid(format!("namespace {:?} must start with '/'", options.namespace)));
    }
    url.set_scheme(scheme)
        .map_err(|()| invalid(format!("cannot use scheme {scheme} for {:?}", options.url)))?;
    url.set_path(&options.path);
    url.query_pairs_mut().append_pair("EIO", "4").append_pair("transport", "websocket");
    Ok(url)
}

async fn next_text(stream: &mut SplitStream<Stream>) -> Result<String, Error> {
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => return Ok(text.as_str().to_string()),
            Some(Ok(Message::Close(_))) | None => return Err(Error::Transport("connection closed".into())),
            Some(Ok(_)) => continue,
            Some(Err(err)) => return Err(Error::Transport(err.to_string())),
        }
    }
}

async fn send_text(sink: &mut SplitSink<Stream, Message>, frame: String) -> Result<(), Error> {
    sink.send(Message::Text(frame.into())).await.map_err(|err| Error::Transport(err.to_string()))
}

/// One connection attempt: WebSocket upgrade, Engine.IO open, Socket.IO CONNECT.
async fn handshake(options: &Options, url: &Url) -> Result<Connection, Error> {
    let attempt = async {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|err| Error::InvalidOptions(err.to_string()))?;
        for (name, value) in &options.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|err| Error::InvalidOptions(format!("header {name:?}: {err}")))?;
            let value =
                HeaderValue::from_str(value).map_err(|err| Error::InvalidOptions(format!("header value: {err}")))?;
            request.headers_mut().insert(name, value);
        }
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|err| Error::Transport(err.to_string()))?;
        let (mut sink, mut stream) = socket.split();

        let handshake = loop {
            let text = next_text(&mut stream).await?;
            match packet::decode_engine(&text).map_err(Error::Protocol)? {
                EngineFrame::Open(handshake) => break handshake,
                EngineFrame::Close => return Err(Error::Transport("closed during handshake".into())),
                _ => continue,
            }
        };

        send_text(&mut sink, packet::encode_connect(&options.namespace, options.auth.as_ref())).await?;
        loop {
            let text = next_text(&mut stream).await?;
            match packet::decode_engine(&text).map_err(Error::Protocol)? {
                EngineFrame::Ping => send_text(&mut sink, packet::encode_pong()).await?,
                EngineFrame::Close => return Err(Error::Transport("closed during handshake".into())),
                EngineFrame::Message(body) => match packet::decode_packet(body, &options.namespace) {
                    Ok(Some(Packet::Connect)) => break,
                    Ok(Some(Packet::ConnectError { message })) => return Err(Error::Refused(message)),
                    Ok(_) => continue,
                    Err(err) => return Err(Error::Protocol(err)),
                },
                EngineFrame::Open(_) | EngineFrame::Ignored => continue,
            }
        }
        Ok(Connection { sink, stream, handshake })
    };
    tokio::time::timeout(options.connect_timeout, attempt)
        .await
        .map_err(|_| Error::Timeout)?
}

/// Resolves once the socket has been closed. Checks the current value first,
/// so a close that happened before the call is not missed.
async fn closed(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

struct SessionEnd {
    reason: &'static str,
    reconnect: bool,
}

/// The reader task: runs one connection after another until the socket is
/// closed, a reconnect is refused, or reconnecting is off.
async fn drive(
    shared: Arc<Shared>,
    options: Options,
    url: Url,
    first: Session0,
    events: mpsc::UnboundedSender<Event>,
    mut close: watch::Receiver<bool>,
) {
    let Session0 { mut connection, mut outbound, mut epoch } = first;
    loop {
        let end = run_session(&shared, &mut connection, &mut outbound, epoch, &events, &mut close).await;
        shared.end_session();
        let _ = events.send(Event::Disconnect { reason: end.reason.to_string() });
        if !end.reconnect || !options.reconnect || shared.is_closed() {
            shared.close();
            return;
        }

        let mut delay = options.reconnect_delay;
        loop {
            tokio::select! {
                () = closed(&mut close) => return,
                () = tokio::time::sleep(delay) => {}
            }
            let attempt = tokio::select! {
                () = closed(&mut close) => return,
                attempt = handshake(&options, &url) => attempt,
            };
            match attempt {
                Ok(next) => {
                    let (sender, receiver) = mpsc::unbounded_channel();
                    connection = next;
                    outbound = receiver;
                    epoch = shared.install(sender, &connection.handshake);
                    if shared.is_closed() {
                        shared.end_session();
                        return;
                    }
                    let _ = events.send(Event::Connect);
                    break;
                }
                Err(Error::Refused(_)) => {
                    shared.close();
                    return;
                }
                Err(_) => delay = (delay * 2).min(options.reconnect_delay_max),
            }
        }
    }
}

async fn run_session(
    shared: &Arc<Shared>,
    connection: &mut Connection,
    outbound: &mut mpsc::UnboundedReceiver<String>,
    epoch: u64,
    events: &mpsc::UnboundedSender<Event>,
    close: &mut watch::Receiver<bool>,
) -> SessionEnd {
    let Connection { sink, stream, handshake } = connection;
    let window = Duration::from_millis(handshake.ping_interval_ms + handshake.ping_timeout_ms);
    let deadline = tokio::time::sleep(window);
    tokio::pin!(deadline);
    let end = |reason, reconnect| SessionEnd { reason, reconnect };

    loop {
        tokio::select! {
            biased;
            () = closed(close) => {
                let _ = send_text(sink, packet::encode_disconnect(&shared.namespace)).await;
                let _ = sink.close().await;
                return end("io client disconnect", false);
            }
            frame = outbound.recv() => match frame {
                Some(frame) => {
                    if send_text(sink, frame).await.is_err() {
                        return end("transport error", true);
                    }
                }
                None => return end("io client disconnect", false),
            },
            () = &mut deadline => return end("ping timeout", true),
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => match packet::decode_engine(text.as_str()) {
                    Ok(EngineFrame::Ping) => {
                        deadline.as_mut().reset(tokio::time::Instant::now() + window);
                        if send_text(sink, packet::encode_pong()).await.is_err() {
                            return end("transport error", true);
                        }
                    }
                    Ok(EngineFrame::Close) => return end("transport close", true),
                    Ok(EngineFrame::Message(body)) => match packet::decode_packet(body, &shared.namespace) {
                        Ok(Some(Packet::Event { event, args, id })) => {
                            let ack = id.map(|id| Ack { shared: Arc::clone(shared), epoch, id });
                            let _ = events.send(Event::Message { event, args, ack });
                        }
                        Ok(Some(Packet::Ack { id, args })) => shared.resolve(id, args),
                        Ok(Some(Packet::Disconnect)) => return end("io server disconnect", false),
                        Ok(_) => {}
                        Err(_) => return end("parse error", true),
                    },
                    Ok(EngineFrame::Open(_) | EngineFrame::Ignored) => {}
                    Err(_) => return end("parse error", true),
                },
                Some(Ok(Message::Close(_))) | None => return end("transport close", true),
                Some(Ok(_)) => {}
                Some(Err(_)) => return end("transport error", true),
            },
        }
    }
}
