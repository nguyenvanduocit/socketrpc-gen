# Example 06: Go Client, Go Server

This example generates a **Go client** and a **Go server** from one `define.ts`,
into two packages of one Go module. A worker (the client) dials a coordinator
(the server), registers itself on every connection, and runs the tasks the
coordinator hands it.

## What's Included

- **ServerFunctions**: implemented by the coordinator, called by the worker
  - `register()` – acknowledged; the worker announces itself, again after every reconnect
  - `progress()` – fire-and-forget

- **ClientFunctions**: implemented by the worker, called by the coordinator
  - `runTask()` – acknowledged, with named types both ways
  - `cancelTask()` – fire-and-forget

- **Programs** written against the generated code
  - `cmd/server` – the coordinator, with an auth middleware on `/worker`
  - `cmd/worker` – the worker: `Dial`, the re-announce pattern, a handler that calls back

## Generate

From the repository root:

```bash
bun run generate:go-client-example
```

which runs:

```bash
bun run index.ts ./examples/06-go-client/define.ts \
  --client go --server go \
  --go-out ./examples/06-go-client/wire --go-package wire \
  --go-client-out ./examples/06-go-client/wireclient --go-client-package wireclient
```

This writes:

| File | Package | Holds |
| --- | --- | --- |
| `wire/types.generated.go` | `wire` | the contract's structs, `RpcError`, the error codes |
| `wire/server.generated.go` | `wire` | `ServerHandler`, `BindServer`, the server's `Client` |
| `wireclient/client.generated.go` | `wireclient` | `ClientHandler`, `Dial`, `DialOptions`, `Conn` |

The types are declared once, in `wire`. The client imports that package for
every contract type (`wire.Task`, `wire.RpcError`), through the import path the
generator reads from the `go.mod` at or above `--go-out`:
`example.com/coordinator/wire`. It imports the Socket.IO client as `sioclient`.

Nothing TypeScript is written: no `.ts` files, no `package.json`, no `tsconfig.json`.

## The Go module

`go.mod` requires `github.com/nguyenvanduocit/socketrpc-gen/go/socketio`, the
Socket.IO implementation the generated code is written against. In your own
module:

```bash
go get github.com/nguyenvanduocit/socketrpc-gen/go/socketio
```

Inside this repository, point the module at the checkout's copy before building:

```bash
cd examples/06-go-client
go mod edit -replace=github.com/nguyenvanduocit/socketrpc-gen/go/socketio=../../go/socketio
go build ./...
```

`tests/generator.test.ts` does the same on a copy of this directory and runs
`go build ./...` and `go vet ./...`, so the programs below are compiled on every
test run.

## Run

```bash
go run ./cmd/server                 # coordinator listening on 127.0.0.1:3000
go run ./cmd/worker                 # in a second terminal
go run ./cmd/worker -token wrong    # refused: Dial returns the middleware's message
```

The worker logs `registered as worker-1 with 1 pending`, and the coordinator
logs three progress lines and the result. Stop and restart the coordinator: the
worker logs the disconnect, reconnects by itself, sends its token again, and
registers again through `OnConnect`. A bad token ends `Dial` at once:

```
dial: DISCONNECTED: unauthorized: unknown worker token
```

## The worker

```go
handler := &worker{} // implements wireclient.ClientHandler

ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
conn, err := wireclient.Dial(ctx, "http://127.0.0.1:3000", handler, &wireclient.DialOptions{
    Namespace: "/worker",
    Auth:      map[string]any{"token": token},
    Timeout:   10 * time.Second,
})
if err != nil {
    var failure *wire.RpcError
    if errors.As(err, &failure) {
        log.Fatalf("dial: %s: %s", failure.Code, failure.Message)
    }
    log.Fatal(err)
}
defer conn.Dispose()

register := func() {
    callCtx, cancel := context.WithTimeout(conn.Context(), 5*time.Second)
    defer cancel()
    if _, err := conn.CallRegister(callCtx, wire.Worker{Name: "worker-1", Capacity: 4}); err != nil {
        log.Printf("register: %v", err)
    }
}
conn.OnConnect(register) // every reconnect from now on
register()               // the connection Dial just made
```

`OnConnect` runs after every reconnect from the moment it is registered, and the
first connect has already happened when `Dial` returns. Registering the observer
first and then calling it once yourself means the announcement is never missed;
at worst it is sent twice, so make it idempotent.

A contract method reaches the generated Go under a prefix: `register` is called
as `CallRegister` on `Conn` and implemented as `HandleRegister` on the server's
`ServerHandler`; `runTask` is `HandleRunTask` on `ClientHandler` and
`CallRunTask` on the server's `Client`. Wire event names are the contract's own.

## What to know about the client

- **Calls take a context first.** Cancelling it fails the call with `ABORTED`;
  its deadline, or the call timeout (`DialOptions.Timeout`, else the generator's
  `--timeout`), fails it with `TIMEOUT`, whichever comes first.
- **A call made while the connection is down fails at once** with
  `DISCONNECTED`. The TypeScript client buffers such a call until it
  reconnects; the Go client does not. A call in flight when the connection drops
  fails the same way, promptly, without waiting for its timeout. `DISCONNECTED`
  means the outcome is unknown: the server may have run the call.
- **Handlers outlive reconnects.** The `ClientHandler` given to `Dial` answers on
  every connection. Each method has its own queue: repeated calls to one method
  run in arrival order, a slow handler holds up only its own method, and a
  handler that returns an error or panics reports it to the server as an
  `RpcError` and never stops the calls after it.
- **A payload too large for the server fails on its own.** Each outbound packet
  is measured against the limit the server advertised in its handshake (its
  `MaxHttpBufferSize`, 1,000,000 bytes by default). An oversized call fails with
  `INVALID_ARGUMENT` and nothing is sent; an oversized handler reply answers the
  server with `INTERNAL_ERROR`. The connection stays up either way.

The main [README](../../README.md#go-client) has the full reference.
