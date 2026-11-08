//! A Rust server and a Rust client generated from one `define.ts`, talking to
//! each other in one process. Run with `cargo run`.

mod rpc;

use std::sync::{Arc, Mutex};

use rpc::client::{dial, ClientHandler, DialOptions};
use rpc::server::{bind_server, Context, ServerHandler};
use rpc::{ChatRoom, Message, RpcError, Visibility};
use socketioxide::extract::SocketRef;
use socketioxide::SocketIo;

/// The server: implements the contract's `ServerFunctions`.
#[derive(Default)]
struct Chat {
    rooms: Mutex<Vec<ChatRoom>>,
}

impl ServerHandler for Chat {
    async fn handle_create_room(&self, _ctx: Context, topic: String, visibility: Visibility) -> Result<ChatRoom, RpcError> {
        let mut rooms = self.rooms.lock().map_err(RpcError::internal)?;
        let room = ChatRoom { id: format!("room-{}", rooms.len() + 1), topic, member_count: 1.0, visibility };
        rooms.push(room.clone());
        Ok(room)
    }

    async fn handle_list_rooms(&self, _ctx: Context) -> Result<Vec<ChatRoom>, RpcError> {
        Ok(self.rooms.lock().map_err(RpcError::internal)?.clone())
    }

    async fn handle_post_message(&self, ctx: Context, room_id: String, body: String) -> Result<Message, RpcError> {
        let message = Message { id: "m1".into(), room_id, body, sent_at: "2026-01-01T00:00:00Z".into(), edited_at: None };
        // Push it back to the client, fire-and-forget.
        ctx.client().call_on_message(&message)?;
        Ok(message)
    }

    async fn handle_typing(&self, _ctx: Context, room_id: String) -> Result<(), RpcError> {
        println!("server: someone is typing in {room_id}");
        Ok(())
    }
}

/// The client: implements the contract's `ClientFunctions`.
struct Member;

impl ClientHandler for Member {
    async fn handle_on_message(&self, _ctx: rpc::client::Context, message: Message) -> Result<(), RpcError> {
        println!("client: pushed {:?}", message.body);
        Ok(())
    }

    async fn handle_confirm_leave(&self, _ctx: rpc::client::Context, room_id: String) -> Result<bool, RpcError> {
        Ok(room_id != "room-1")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let chat = Arc::new(Chat::default());
    let (layer, io) = SocketIo::new_layer();
    io.ns("/", move |socket: SocketRef| {
        // Bind before the first `.await`, so no event can arrive before the listeners.
        let binding = bind_server(&socket, Arc::clone(&chat));
        let client = binding.client();
        tokio::spawn(async move {
            match client.call_confirm_leave("room-1").await {
                Ok(leave) => println!("server: client may leave room-1: {leave}"),
                Err(error) => println!("server: confirmLeave failed: {error}"),
            }
        });
        async {}
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, axum::Router::new().layer(layer)).await });

    let conn = dial(DialOptions::new(url), Arc::new(Member)).await?;
    let room = conn.call_create_room("rust", Visibility::Public).await?;
    println!("client: created {room:?}");
    conn.call_typing(&room.id)?;
    let message = conn.call_post_message(&room.id, "hello from rust").await?;
    println!("client: posted {:?}", message.id);
    println!("client: rooms {:?}", conn.call_list_rooms().await?.len());
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    conn.dispose();
    Ok(())
}
