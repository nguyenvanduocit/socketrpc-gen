# Example 05: TypeScript Client, Go Server

This example generates a **TypeScript client** and a **Go server** from one
`define.ts`. Both sides come out of the same canonical `RpcSchema` IR, so the
event names, argument order, acknowledgement shape and error branding are the
same contract expressed twice.

## What's Included

- **ServerFunctions**: implemented in Go, called from TypeScript
  - `createRoom()` – returns a `ChatRoom`, takes a `Visibility` string enum
  - `listRooms()` – returns an array
  - `postMessage()` – returns a `Message` with an optional field
  - `typing()` – fire-and-forget (void return)

- **ClientFunctions**: implemented in TypeScript, called from Go
  - `onMessage()` – fire-and-forget push
  - `confirmLeave()` – value-returning call

## Generate

```bash
bun run ../../index.ts ./define.ts \
  --client typescript --server go --go-out ./rpc
```

This writes:

| File | Side |
| --- | --- |
| `client.generated.ts` | TypeScript client (`createRpcClient`) |
| `types.generated.ts` | Shared TypeScript vocabulary (`RpcError`, `isRpcError`) |
| `rpc/types.generated.go` | Go structs, string enums, `RpcError` |
| `rpc/server.generated.go` | Go `ServerHandler`, `BindServer`, outbound `Client` |

No `server.generated.ts` is emitted — the server is Go.

## Go Side

Add the transport and implement the generated interface:

```bash
go get github.com/zishang520/socket.io/servers/socket/v3
```

```go
package main

import (
    "context"

    "github.com/zishang520/socket.io/servers/socket/v3"

    "example.com/chat/rpc"
)

type handler struct{ client *rpc.Client }

func (h *handler) CreateRoom(ctx context.Context, topic string, visibility rpc.Visibility) (rpc.ChatRoom, error) {
    return rpc.ChatRoom{ID: "r1", Topic: topic, MemberCount: 1, Visibility: visibility}, nil
}

func (h *handler) ListRooms(ctx context.Context) ([]rpc.ChatRoom, error) { return nil, nil }

func (h *handler) PostMessage(ctx context.Context, roomID string, body string) (rpc.Message, error) {
    message := rpc.Message{ID: "m1", RoomID: roomID, Body: body, SentAt: "2026-01-01T00:00:00Z"}

    // Call back into the TypeScript client through the generated Client.
    _ = h.client.OnMessage(ctx, message)

    // Return a typed failure by returning an *RpcError; anything else becomes
    // INTERNAL_ERROR.
    return message, nil
}

func (h *handler) Typing(ctx context.Context, roomID string) error { return nil }

func serve(raw *socket.Socket) {
    client, err := rpc.NewClient(raw, nil)
    if err != nil {
        return
    }
    binding, err := rpc.BindServer(raw, &handler{client: client})
    if err != nil {
        client.Dispose()
        return
    }
    go func() {
        <-binding.Context().Done()
        client.Dispose()
    }()
}
```

## TypeScript Side

Unchanged from the all-TypeScript examples — the client does not know or care
what language answers it:

```typescript
import { io } from "socket.io-client";
import { createRpcClient } from "./client.generated";
import { isRpcError } from "./types.generated";

const rpc = createRpcClient(io("http://localhost:3000"));

rpc.handle.onMessage(async (message) => console.log(message.body));
rpc.handle.confirmLeave(async (roomId) => confirm(`Leave ${roomId}?`));

const room = await rpc.server.createRoom("general", "public");
if (isRpcError(room)) console.error(room.code, room.message);

rpc.dispose();
```

## What the Go Backend Refuses

The Go backend only accepts contracts the portable IR can model, and names the
declaration you should write instead:

| In `define.ts` | Why | Write instead |
| --- | --- | --- |
| `(filter: { q: string }) => void` | an inline object literal has no Go name | a named `type Filter = { q: string }` |
| `(mode: "a" \| "b") => void` | an inline union has no Go name | a named `type Mode = "a" \| "b"` |
| `(error: Error) => void` | ambient host types have no wire shape | a named `type Failure = { message: string }` |
| `(limit?: number) => void` | an omitted trailing argument is indistinguishable from a Socket.IO ack | make it required, or move it into an object |
| `() => Date` | `Date` has no portable wire shape | an ISO-8601 `string` |

The all-TypeScript path accepts all of these, so switching a server to Go can
surface contract changes. Generate early to find them.

## Dispatch Order

The generated Go server gives every RPC method its own serialized dispatch
queue. Repeated calls to the same method are handled in the order Socket.IO
delivered them — matching the TypeScript server backend — while a slow or
blocked handler stalls only its own method and never the connection.

Calls to *different* methods still run concurrently on a Go server, so a
contract that depends on cross-method ordering should carry an explicit
sequence number in the payload.
