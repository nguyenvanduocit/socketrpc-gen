# Example 07: Rust Server and Rust Client

A **Rust server** and a **Rust client** generated from one `define.ts` (the chat
contract of example 05), talking to each other in one binary.

## Generate

```bash
bun run ../../index.ts ./define.ts --client rust --server rust --rust-out ./src/rpc
```

| File | Side |
| --- | --- |
| `src/rpc/mod.rs` | the module: declares the files below, re-exports the types |
| `src/rpc/types.rs` | `ChatRoom`, `Message`, `Visibility`, `RpcError` |
| `src/rpc/server.rs` | `ServerHandler`, `bind_server`, `Client` (socketioxide) |
| `src/rpc/client.rs` | `ClientHandler`, `dial`, `Conn` (socketrpc-socketio-client) |

No TypeScript is written: neither side is TypeScript. Add `typescript` to
`--client` to also get the TypeScript client package next to `define.ts`.

## Run

```bash
cargo run
```

`src/main.rs` implements `ServerHandler` (`handle_create_room`, …) and
`ClientHandler` (`handle_on_message`, `handle_confirm_leave`), serves the server
with axum, dials it, and calls it with `call_create_room`, `call_post_message`, ….
The server pushes `onMessage` back and asks `confirmLeave`.

Outside this repository, depend on the client crate through git:

```toml
socketrpc-socketio-client = { git = "https://github.com/nguyenvanduocit/socketrpc-gen" }
```
