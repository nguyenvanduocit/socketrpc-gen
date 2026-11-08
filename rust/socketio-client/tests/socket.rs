#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;
use std::time::Duration;

use serde_json::{json, Value};
use socketioxide::extract::{AckSender, Data, SocketRef};
use socketioxide::handler::ConnectHandler;
use socketioxide::SocketIo;
use socketrpc_socketio_client::{connect, Error, Event, Events, Options};

async fn serve(io_setup: impl FnOnce(&SocketIo)) -> SocketAddr {
    let (layer, io) = SocketIo::builder().max_payload(10_000).max_buffer_size(1024).build_layer();
    io_setup(&io);
    let app = axum::Router::new().layer(layer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

fn echo_server(io: &SocketIo) {
    io.ns("/", async |socket: SocketRef| {
        socket.on("echo", async |Data(value): Data<Value>, ack: AckSender| {
            ack.send(&value).ok();
        });
        socket.on("slow", async |Data(ms): Data<u64>, ack: AckSender| {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            ack.send(&ms).ok();
        });
        socket.on("ask", async |socket: SocketRef, Data(question): Data<String>| {
            let answer = socket
                .emit_with_ack::<_, Value>("question", &question)
                .unwrap()
                .await
                .unwrap_or(Value::Null);
            socket.emit("answer", &answer).ok();
        });
        socket.on("kick", async |socket: SocketRef| {
            socket.disconnect().ok();
        });
        socket.on("burst", async |socket: SocketRef, Data(count): Data<u64>| {
            for index in 0..count {
                socket.emit("seq", &index).ok();
            }
        });
    });
}

async fn next_message(events: &mut Events) -> (String, Vec<Value>, Option<socketrpc_socketio_client::Ack>) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap() {
            Some(Event::Message { event, args, ack }) => return (event, args, ack),
            Some(_) => continue,
            None => panic!("events ended"),
        }
    }
}

#[tokio::test]
async fn acknowledged_calls_get_their_own_answer() {
    let addr = serve(echo_server).await;
    let (socket, _events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();
    assert!(socket.connected());

    let calls = (0..200u64).map(|index| {
        let socket = socket.clone();
        tokio::spawn(async move {
            let args = socket.emit_with_ack("echo", &[json!(index)], Duration::from_secs(5)).await.unwrap();
            assert_eq!(args, vec![json!(index)]);
        })
    });
    for call in calls {
        call.await.unwrap();
    }
}

#[tokio::test]
async fn timeout_and_server_initiated_call() {
    let addr = serve(echo_server).await;
    let (socket, mut events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();

    let late = socket.emit_with_ack("slow", &[json!(300)], Duration::from_millis(50)).await;
    assert_eq!(late, Err(Error::Timeout));

    socket.emit("ask", &[json!("ping?")]).unwrap();
    let (event, args, ack) = next_message(&mut events).await;
    assert_eq!((event.as_str(), args), ("question", vec![json!("ping?")]));
    ack.expect("server awaits an ack").send(&[json!("pong!")]).unwrap();
    let (event, args, _) = next_message(&mut events).await;
    assert_eq!((event.as_str(), args), ("answer", vec![json!("pong!")]));
}

#[tokio::test]
async fn events_arrive_in_order() {
    let addr = serve(echo_server).await;
    let (socket, mut events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();
    socket.emit("burst", &[json!(500)]).unwrap();
    for expected in 0..500u64 {
        let (event, args, _) = next_message(&mut events).await;
        assert_eq!((event.as_str(), args), ("seq", vec![json!(expected)]));
    }
}

#[tokio::test]
async fn oversized_frame_is_refused_without_closing() {
    let addr = serve(echo_server).await;
    let (socket, _events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();
    assert_eq!(socket.max_payload(), 10_000);
    let big = "x".repeat(20_000);
    let refused = socket.emit_with_ack("echo", &[json!(big)], Duration::from_secs(1)).await;
    assert!(matches!(refused, Err(Error::PayloadTooLarge { .. })), "{refused:?}");
    let ok = socket.emit_with_ack("echo", &[json!("small")], Duration::from_secs(1)).await;
    assert_eq!(ok, Ok(vec![json!("small")]));
}

#[tokio::test]
async fn server_disconnect_fails_calls_and_is_not_retried() {
    let addr = serve(echo_server).await;
    let (socket, mut events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();
    let in_flight = {
        let socket = socket.clone();
        tokio::spawn(async move { socket.emit_with_ack("slow", &[json!(2000)], Duration::from_secs(5)).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    socket.emit("kick", &[]).unwrap();
    match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap() {
        Some(Event::Disconnect { reason }) => assert_eq!(reason, "io server disconnect"),
        other => panic!("expected a disconnect, got {other:?}"),
    }
    assert_eq!(in_flight.await.unwrap(), Err(Error::Disconnected));
    assert!(!socket.connected());
    assert_eq!(socket.emit("echo", &[]), Err(Error::Closed));
}

#[tokio::test]
async fn refused_namespace_returns_the_server_message() {
    let addr = serve(|io| {
        io.ns(
            "/",
            (async |_: SocketRef| {}).with(async |Data(auth): Data<Value>| {
                if auth.get("token") == Some(&json!("good")) {
                    Ok(())
                } else {
                    Err("bad token")
                }
            }),
        );
    })
    .await;
    let mut options = Options::new(format!("http://{addr}"));
    options.auth = Some(json!({"token": "bad"}));
    let refused = connect(options.clone()).await.map(|_| ());
    assert_eq!(refused, Err(Error::Refused("bad token".into())));
    options.auth = Some(json!({"token": "good"}));
    assert!(connect(options).await.is_ok());
}

#[tokio::test]
async fn unreachable_server_is_retried_until_it_appears() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let mut options = Options::new(format!("http://{addr}"));
    options.reconnect_delay = Duration::from_millis(50);
    options.reconnect_delay_max = Duration::from_millis(100);
    let dial = tokio::spawn(connect(options));
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (layer, io) = SocketIo::new_layer();
    echo_server(&io);
    let app = axum::Router::new().layer(layer);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (socket, _events) = tokio::time::timeout(Duration::from_secs(5), dial).await.unwrap().unwrap().unwrap();
    let args = socket.emit_with_ack("echo", &[json!(1)], Duration::from_secs(1)).await.unwrap();
    assert_eq!(args, vec![json!(1)]);
}

#[tokio::test]
async fn close_stops_everything() {
    let addr = serve(echo_server).await;
    let (socket, mut events) = connect(Options::new(format!("http://{addr}"))).await.unwrap();
    socket.close();
    match tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap() {
        Some(Event::Disconnect { reason }) => assert_eq!(reason, "io client disconnect"),
        other => panic!("expected a disconnect, got {other:?}"),
    }
    assert!(tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().is_none());
    assert_eq!(socket.emit("echo", &[]), Err(Error::Closed));
}
