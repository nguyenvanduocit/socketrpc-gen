//! The generated Rust client, implementing nothing but `ClientHandler`.
//! Runs every check against the server at argv[1], printing one JSON line per
//! check, then `DONE`. The language of the server is argv[2], which only changes
//! what `crash` is expected to say.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_crosslang::rpc::client::{dial, ClientHandler, Conn, Context, DialOptions};
use rust_crosslang::rpc::{Priority, RpcError, RpcErrorCode, Task};
use serde_json::json;

struct Handler;

impl ClientHandler for Handler {
    async fn handle_ask(&self, _ctx: Context, question: String) -> Result<String, RpcError> {
        if question == "refuse" {
            return Err(RpcError::invalid_argument("refused by the rust client"));
        }
        Ok(format!("rust answered {question}"))
    }

    async fn handle_notify(&self, _ctx: Context, text: String) -> Result<(), RpcError> {
        Err(RpcError::new("NOTIFY_FAILED", text))
    }
}

fn report(check: &str, ok: bool, detail: impl std::fmt::Debug) {
    println!("{}", json!({ "check": check, "ok": ok, "detail": format!("{detail:?}") }));
}

fn sample_task() -> Task {
    let parent = Task {
        id: "p".into(),
        title: "parent".into(),
        priority: Priority::Low,
        tags: vec![],
        scores: HashMap::new(),
        done: true,
        note: None,
        assignee: None,
        due: None,
        extra: json!(null),
        parent: None,
        r#type: "epic".into(),
    };
    Task {
        id: "t1".into(),
        title: "child".into(),
        priority: Priority::InProgress,
        tags: vec!["a".into(), "b".into()],
        scores: HashMap::from([("x".to_string(), 1.5)]),
        done: false,
        note: Some("n".into()),
        assignee: Some("ann".into()),
        due: Some(None),
        extra: json!({ "nested": [1, "two", null] }),
        parent: Some(Box::new(parent)),
        r#type: "story".into(),
    }
}

async fn eventually(mut probe: impl AsyncFnMut() -> bool) -> bool {
    for _ in 0..100 {
        if probe().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("server url");
    let conn: Conn = dial(DialOptions::new(url), Arc::new(Handler)).await.expect("dial");

    let task = sample_task();
    let echoed = conn.call_echo_task(&task).await;
    report("echo_task", echoed.as_ref() == Ok(&task), &echoed);

    let sum = conn.call_add(2.0, 3.5).await;
    report("add", sum == Ok(5.5), &sum);

    let failed = conn.call_fail("QUOTA").await;
    report(
        "fail",
        matches!(&failed, Err(e) if e.code == RpcErrorCode::Other("QUOTA".into())
            && e.message == "refused: QUOTA"
            && e.method.as_deref() == Some("fail")
            && e.data == Some(json!({ "code": "QUOTA" }))),
        &failed,
    );

    let crashed = conn.call_crash().await;
    report("crash", matches!(&crashed, Err(e) if e.code == RpcErrorCode::InternalError), &crashed);

    let late = conn.with_timeout(Duration::from_millis(50)).call_slow(500.0).await;
    report("timeout", matches!(&late, Err(e) if e.code == RpcErrorCode::Timeout), &late);

    for value in 0..50 {
        conn.call_record(f64::from(value)).expect("record");
    }
    // `history` has its own queue, so it may answer before every `record` ran:
    // wait for all fifty, then require arrival order.
    let mut history = Ok(Vec::new());
    eventually(async || {
        history = conn.call_history().await;
        history.as_ref().map(Vec::len) == Ok(50)
    })
    .await;
    let expected: Vec<f64> = (0..50).map(f64::from).collect();
    report("ordering", history.as_ref() == Ok(&expected), &history);

    let calls = (0..100).map(|index| {
        let conn = conn.clone();
        tokio::spawn(async move { conn.call_add(f64::from(index), 1.0).await == Ok(f64::from(index) + 1.0) })
    });
    let mut all = true;
    for call in calls {
        all &= call.await.unwrap_or(false);
    }
    report("concurrent", all, "100 calls");

    let reported: Arc<Mutex<Vec<RpcError>>> = Arc::default();
    let sink = Arc::clone(&reported);
    let _keep = conn.on_rpc_error(move |error| sink.lock().unwrap().push(error.clone()));
    conn.call_explode("kaboom").expect("explode");
    let seen = eventually(async || {
        reported.lock().unwrap().iter().any(|e| {
            // The method is not checked: the TypeScript server reports a thrown
            // rpcError without one, the Rust server fills it in.
            e.code == RpcErrorCode::Other("EXPLODED".into()) && e.message == "kaboom"
        })
    })
    .await;
    report("explode", seen, &*reported.lock().unwrap());

    let relayed = conn.call_relay("hi").await;
    report("relay", relayed.as_deref() == Ok("rust answered hi"), &relayed);
    let refused = conn.call_relay("refuse").await;
    report("relay_refused", refused.as_deref() == Ok("error:INVALID_ARGUMENT"), &refused);

    let pushed = conn.call_push_notify("n").await;
    let observed = eventually(async || {
        conn.call_last_client_error().await == Ok(Some("NOTIFY_FAILED".to_string()))
    })
    .await;
    report("push_notify", pushed.as_deref() == Ok("sent") && observed, &pushed);

    let disconnects: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&disconnects);
    let _keep = conn.on_disconnect(move |reason| sink.lock().unwrap().push(reason.to_string()));
    conn.call_kick().expect("kick");
    let dropped = eventually(async || !disconnects.lock().unwrap().is_empty()).await;
    let after = conn.call_add(1.0, 1.0).await;
    report(
        "server_disconnect",
        dropped
            && disconnects.lock().unwrap().first().map(String::as_str) == Some("io server disconnect")
            && matches!(&after, Err(e) if e.code == RpcErrorCode::Disconnected),
        (&*disconnects.lock().unwrap(), &after),
    );

    conn.dispose();
    let disposed = conn.call_add(1.0, 1.0).await;
    report("dispose", matches!(&disposed, Err(e) if e.code == RpcErrorCode::Disposed), &disposed);

    println!("DONE");
}
