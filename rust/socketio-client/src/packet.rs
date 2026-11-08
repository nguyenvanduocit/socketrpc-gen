//! Engine.IO v4 and Socket.IO v5 text framing.
//!
//! Pure functions only: everything here runs in a unit test without a socket.
//! A frame is the text of one WebSocket message; a Socket.IO packet travels as
//! the payload of an Engine.IO `message` frame (`4`).

use serde_json::Value;

/// The Engine.IO frames a client acts on.
#[derive(Debug, PartialEq)]
pub(crate) enum EngineFrame<'a> {
    Open(Handshake),
    Close,
    Ping,
    Message(&'a str),
    /// Pong, upgrade and noop: valid, and nothing for a WebSocket-only client to do.
    Ignored,
}

/// The values the server advertises in its Engine.IO open packet.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Handshake {
    pub ping_interval_ms: u64,
    pub ping_timeout_ms: u64,
    pub max_payload: u64,
}

/// Socket.IO packets as the client receives them, already filtered to one namespace.
#[derive(Debug, PartialEq)]
pub(crate) enum Packet {
    Connect,
    Disconnect,
    Event {
        event: String,
        args: Vec<Value>,
        id: Option<u64>,
    },
    Ack {
        id: u64,
        args: Vec<Value>,
    },
    ConnectError {
        message: String,
    },
    /// A binary event or acknowledgement. The contracts socketrpc-gen generates
    /// are JSON-only, so these are reported rather than reassembled.
    Binary,
}

/// What the server advertises when its open packet omits a value. These are the
/// defaults of the reference Socket.IO server.
const DEFAULT_PING_INTERVAL_MS: u64 = 25_000;
const DEFAULT_PING_TIMEOUT_MS: u64 = 20_000;
pub(crate) const DEFAULT_MAX_PAYLOAD: u64 = 1_000_000;

pub(crate) fn decode_engine(frame: &str) -> Result<EngineFrame<'_>, String> {
    let mut chars = frame.chars();
    let kind = chars.next().ok_or_else(|| "empty engine.io frame".to_string())?;
    let rest = chars.as_str();
    match kind {
        '0' => {
            let open: Value =
                serde_json::from_str(rest).map_err(|err| format!("invalid open packet: {err}"))?;
            let read = |key: &str, fallback: u64| open.get(key).and_then(Value::as_u64).unwrap_or(fallback);
            Ok(EngineFrame::Open(Handshake {
                ping_interval_ms: read("pingInterval", DEFAULT_PING_INTERVAL_MS),
                ping_timeout_ms: read("pingTimeout", DEFAULT_PING_TIMEOUT_MS),
                max_payload: read("maxPayload", DEFAULT_MAX_PAYLOAD),
            }))
        }
        '1' => Ok(EngineFrame::Close),
        '2' => Ok(EngineFrame::Ping),
        '4' => Ok(EngineFrame::Message(rest)),
        '3' | '5' | '6' => Ok(EngineFrame::Ignored),
        other => Err(format!("unknown engine.io packet type {other:?}")),
    }
}

/// Decodes one Socket.IO packet. Returns `Ok(None)` for a packet addressed to
/// another namespace multiplexed over the same connection.
pub(crate) fn decode_packet(text: &str, namespace: &str) -> Result<Option<Packet>, String> {
    let mut chars = text.chars();
    let kind = chars.next().ok_or_else(|| "empty socket.io packet".to_string())?;
    let mut rest = chars.as_str();

    if kind == '5' || kind == '6' {
        return Ok(Some(Packet::Binary));
    }

    let packet_namespace = if rest.starts_with('/') {
        match rest.find(',') {
            Some(comma) => {
                let nsp = &rest[..comma];
                rest = &rest[comma + 1..];
                nsp
            }
            None => {
                let nsp = rest;
                rest = "";
                nsp
            }
        }
    } else {
        "/"
    };
    if packet_namespace != namespace {
        return Ok(None);
    }

    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let id = if digits == 0 {
        None
    } else {
        Some(
            rest[..digits]
                .parse::<u64>()
                .map_err(|err| format!("invalid packet id: {err}"))?,
        )
    };
    let body = &rest[digits..];
    let json = || -> Result<Value, String> {
        serde_json::from_str(body).map_err(|err| format!("invalid packet payload: {err}"))
    };

    match kind {
        '0' => Ok(Some(Packet::Connect)),
        '1' => Ok(Some(Packet::Disconnect)),
        '2' => {
            let Value::Array(mut items) = json()? else {
                return Err("event payload is not an array".to_string());
            };
            if items.is_empty() {
                return Err("event payload has no event name".to_string());
            }
            let Value::String(event) = items.remove(0) else {
                return Err("event name is not a string".to_string());
            };
            Ok(Some(Packet::Event { event, args: items, id }))
        }
        '3' => {
            let id = id.ok_or_else(|| "acknowledgement without an id".to_string())?;
            let Value::Array(args) = json()? else {
                return Err("acknowledgement payload is not an array".to_string());
            };
            Ok(Some(Packet::Ack { id, args }))
        }
        '4' => {
            let message = match json() {
                Ok(Value::Object(fields)) => fields
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("connection refused")
                    .to_string(),
                Ok(Value::String(message)) => message,
                _ => "connection refused".to_string(),
            };
            Ok(Some(Packet::ConnectError { message }))
        }
        other => Err(format!("unknown socket.io packet type {other:?}")),
    }
}

/// The `/nsp,` prefix a packet for a non-default namespace carries.
fn namespace_prefix(namespace: &str) -> String {
    if namespace == "/" {
        String::new()
    } else {
        format!("{namespace},")
    }
}

pub(crate) fn encode_pong() -> String {
    "3".to_string()
}

pub(crate) fn encode_connect(namespace: &str, auth: Option<&Value>) -> String {
    let auth = auth.map(Value::to_string).unwrap_or_default();
    format!("40{}{auth}", namespace_prefix(namespace))
}

pub(crate) fn encode_disconnect(namespace: &str) -> String {
    format!("41{}", namespace_prefix(namespace))
}

pub(crate) fn encode_event(namespace: &str, id: Option<u64>, event: &str, args: &[Value]) -> String {
    let mut items = Vec::with_capacity(args.len() + 1);
    items.push(Value::String(event.to_string()));
    items.extend_from_slice(args);
    let id = id.map(|id| id.to_string()).unwrap_or_default();
    format!("42{}{id}{}", namespace_prefix(namespace), Value::Array(items))
}

pub(crate) fn encode_ack(namespace: &str, id: u64, args: &[Value]) -> String {
    format!("43{}{id}{}", namespace_prefix(namespace), Value::Array(args.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn open_packet_reads_the_advertised_limits() {
        let frame = decode_engine(r#"0{"sid":"a","pingInterval":300,"pingTimeout":200,"maxPayload":1000}"#);
        assert_eq!(
            frame,
            Ok(EngineFrame::Open(Handshake { ping_interval_ms: 300, ping_timeout_ms: 200, max_payload: 1000 }))
        );
    }

    #[test]
    fn event_with_namespace_and_id() {
        let packet = decode_packet(r#"2/admin,12["hello",1,{"a":true}]"#, "/admin");
        assert_eq!(
            packet,
            Ok(Some(Packet::Event { event: "hello".into(), args: vec![json!(1), json!({"a": true})], id: Some(12) }))
        );
    }

    #[test]
    fn packet_for_another_namespace_is_skipped() {
        assert_eq!(decode_packet(r#"2/other,["hello"]"#, "/"), Ok(None));
        assert_eq!(decode_packet(r#"2["hello"]"#, "/admin"), Ok(None));
    }

    #[test]
    fn ack_and_connect_error() {
        assert_eq!(decode_packet("37[null]", "/"), Ok(Some(Packet::Ack { id: 7, args: vec![Value::Null] })));
        assert_eq!(
            decode_packet(r#"4{"message":"nope"}"#, "/"),
            Ok(Some(Packet::ConnectError { message: "nope".into() }))
        );
    }

    #[test]
    fn encoders_round_trip_through_the_decoder() {
        let frame = encode_event("/admin", Some(3), "go", &[json!("x"), json!([1, 2])]);
        assert_eq!(frame, r#"42/admin,3["go","x",[1,2]]"#);
        let Ok(EngineFrame::Message(body)) = decode_engine(&frame) else {
            unreachable!("encode_event writes an engine message frame");
        };
        assert_eq!(
            decode_packet(body, "/admin"),
            Ok(Some(Packet::Event { event: "go".into(), args: vec![json!("x"), json!([1, 2])], id: Some(3) }))
        );
        assert_eq!(encode_ack("/", 9, &[json!(true)]), "439[true]");
        assert_eq!(encode_connect("/", Some(&json!({"token": "t"}))), r#"40{"token":"t"}"#);
        assert_eq!(encode_disconnect("/chat"), "41/chat,");
    }

    #[test]
    fn malformed_packets_are_errors() {
        assert!(decode_packet("2{}", "/").is_err());
        assert!(decode_packet("2[1]", "/").is_err());
        assert!(decode_packet("3[1]", "/").is_err());
        assert!(decode_engine("").is_err());
    }
}
