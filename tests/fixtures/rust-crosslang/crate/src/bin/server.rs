//! The generated Rust server, implementing nothing but `ServerHandler`.
//! Prints `LISTENING <addr>` once it accepts connections.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_crosslang::rpc::server::{bind_server, Context, ServerHandler};
use rust_crosslang::rpc::{RpcError, RpcErrorCode, Task};
use serde_json::json;
use socketioxide::extract::SocketRef;
use socketioxide::SocketIo;

#[derive(Default)]
struct State {
    history: Mutex<Vec<f64>>,
    last_client_error: Mutex<Option<String>>,
}

struct Handler {
    state: Arc<State>,
}

impl ServerHandler for Handler {
    async fn handle_echo_task(&self, _ctx: Context, task: Task) -> Result<Task, RpcError> {
        Ok(task)
    }

    async fn handle_add(&self, _ctx: Context, a: f64, b: f64) -> Result<f64, RpcError> {
        Ok(a + b)
    }

    async fn handle_fail(&self, _ctx: Context, code: String) -> Result<String, RpcError> {
        Err(RpcError::new(code.as_str(), format!("refused: {code}")).with_data(json!({ "code": code })))
    }

    async fn handle_crash(&self, _ctx: Context) -> Result<String, RpcError> {
        panic!("handler crashed")
    }

    async fn handle_slow(&self, _ctx: Context, ms: f64) -> Result<f64, RpcError> {
        tokio::time::sleep(Duration::from_millis(ms as u64)).await;
        Ok(ms)
    }

    async fn handle_record(&self, _ctx: Context, value: f64) -> Result<(), RpcError> {
        // Uneven delays: if calls were not serialized per method, they would finish out of order.
        tokio::time::sleep(Duration::from_millis((value as u64 * 7) % 5)).await;
        self.state.history.lock().unwrap().push(value);
        Ok(())
    }

    async fn handle_history(&self, _ctx: Context) -> Result<Vec<f64>, RpcError> {
        Ok(self.state.history.lock().unwrap().clone())
    }

    async fn handle_explode(&self, _ctx: Context, reason: String) -> Result<(), RpcError> {
        Err(RpcError::new("EXPLODED", reason))
    }

    async fn handle_relay(&self, ctx: Context, question: String) -> Result<String, RpcError> {
        match ctx.client().call_ask(&question).await {
            Ok(answer) => Ok(answer),
            Err(error) => Ok(format!("error:{}", error.code)),
        }
    }

    async fn handle_push_notify(&self, ctx: Context, text: String) -> Result<String, RpcError> {
        ctx.client().call_notify(&text)?;
        Ok("sent".to_string())
    }

    async fn handle_last_client_error(&self, _ctx: Context) -> Result<Option<String>, RpcError> {
        Ok(self.state.last_client_error.lock().unwrap().clone())
    }

    async fn handle_kick(&self, ctx: Context) -> Result<(), RpcError> {
        ctx.socket().clone().disconnect().map_err(|err| RpcError::new(RpcErrorCode::InternalError, err.to_string()))
    }
}

#[tokio::main]
async fn main() {
    let (layer, io) = SocketIo::new_layer();
    io.ns("/", |socket: SocketRef| {
        let state = Arc::new(State::default());
        let binding = bind_server(&socket, Arc::new(Handler { state: Arc::clone(&state) }));
        let _ = binding.on_rpc_error(move |error| {
            *state.last_client_error.lock().unwrap() = Some(error.code.to_string());
        });
        async {}
    });
    let app = axum::Router::new().layer(layer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("LISTENING {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}
