# Migration Guide

## v7 → v8

v8 is a naming pass over the generated API, in both backends. Event names, argument order and
the acknowledgement protocol are unchanged.

**One field name is on the wire: `RpcError.origin` is now `method`.** It is serialized into the
error payload, so a v8 peer reading the new name from a v7 peer that still sends the old one gets
nothing. Upgrade both sides together, or accept a blank field until the slower side catches up.
Everything else in this guide is local to your codebase and can be migrated per side.

Regenerate first, then work through the sections below:

```bash
bunx socketrpc-gen ./src/rpc/define.ts
```

Most of the work is mechanical. [Two changes are not](#4-rpchandlerpcerror--rpconrpcerror), so read
those before running any find-and-replace.

> The `sed -i ''` below is the BSD/macOS form. On Linux, drop the `''`: `sed -i 's/…/…/g'`.

---

### At a glance

**TypeScript**

| v7 | v8 | Mechanical? |
|----|----|-------------|
| `UnsubscribeFunction` | `Unsubscribe` | yes |
| `RpcClientServer` | `RpcClientRemote` | yes |
| `RpcServerClient` | `RpcServerRemote` | yes |
| `RpcError.origin` | `RpcError.method` | yes, but see the wire note above |
| `toRpcError(e, { origin })` | `toRpcError(e, { method })` | yes |
| `ClientToServerEvents` / `ServerToClientEvents` from a side file | from `./types.generated` | yes |
| `rpc.handle.rpcError(fn)` | `rpc.onRpcError(fn)` | **no — semantics changed** |

**Go**

| v7 | v8 | Mechanical? |
|----|----|-------------|
| `RpcError.Origin`, `json:"origin"` | `RpcError.Method`, `json:"method"` | yes |
| `NewRpcError(code, message, origin, data)` | `NewRpcError(code, message, method, data)` | no change at the call site |
| `OnRpcError(fn)` returns nothing | returns `func()` to unsubscribe | source-compatible |
| `OnRpcError` keeps one observer | keeps all of them | **no — semantics changed** |

Unchanged in both: `createRpcClient` / `createRpcServer`, `rpc.handle.*`, `rpc.server.*`,
`rpc.client.*`, `rpc.socket`, `rpc.connected`, `rpc.onConnect` / `onDisconnect` / `onReconnect`,
`rpc.disposed`, `rpc.dispose()`, `RpcError`, `isRpcError`, `rpcError`, `RpcErrorCodes`,
`RpcCallOptions`, `BindServer`, `ServerHandler`, `Client`, `Dispose`.

---

### 1. `UnsubscribeFunction` → `Unsubscribe`

The `Function` suffix carried no information. Only affects code that named the type explicitly:

```bash
rg -l 'UnsubscribeFunction' --glob '!*.generated.ts' | xargs sed -i '' 's/UnsubscribeFunction/Unsubscribe/g'
```

```diff
-import type { UnsubscribeFunction } from './rpc/types.generated';
-const offs: UnsubscribeFunction[] = [];
+import type { Unsubscribe } from './rpc/types.generated';
+const offs: Unsubscribe[] = [];
```

### 2. `RpcClientServer` / `RpcServerClient` → `*Remote`

`RpcClientServer` read like a client-server hybrid; you had to decode word order to recover "the
client's view of the server". Both sides now use the same suffix for the same idea — the peer's API:

```bash
rg -l 'RpcClientServer|RpcServerClient' --glob '!*.generated.ts' \
  | xargs sed -i '' -e 's/RpcClientServer/RpcClientRemote/g' -e 's/RpcServerClient/RpcServerRemote/g'
```

The property names are untouched: `rpc.server.*` on the client, `rpc.client.*` on the server.

### 3. `RpcError.origin` → `RpcError.method`

On the web, `origin` means a URL origin (`location.origin`, CORS). The field holds an RPC method
name, so it is now called `method` — in TypeScript, in Go, and in the JSON on the wire:

```diff
 const user = await rpc.server.getUser(id);
 if (isRpcError(user)) {
-  console.error(`${user.origin} failed:`, user.message);
+  console.error(`${user.method} failed:`, user.message);
 }
```

```diff
 binding.OnRpcError(func(failure *rpc.RpcError) {
-    log.Printf("%s failed: %s", failure.Origin, failure.Message)
+    log.Printf("%s failed: %s", failure.Method, failure.Message)
 })
```

Same rename in the `toRpcError` options bag, if you call it directly:

```diff
-throw toRpcError(err, { origin: 'getUser' });
+throw toRpcError(err, { method: 'getUser' });
```

> **Check your logs and dashboards.** If anything downstream parses the serialized error — a log
> pipeline, an error tracker, an alert query — it reads `origin` off the JSON payload and will go
> blank until you update the field name there too. No compiler catches this, in either language.

### 4. `rpc.handle.rpcError` → `rpc.onRpcError`

**Read this before running a find-and-replace — the behavior changed, not just the name.**

Two things were wrong with `handle.rpcError`. It shared a name with the `rpcError(code, message)`
factory, and it sat inside `handle`, which is the namespace for RPC methods you implement. It is now
a top-level subscription alongside `onConnect` / `onDisconnect` / `onReconnect`:

```diff
-const off = rpc.handle.rpcError((error) => {
+const off = rpc.onRpcError((error) => {
   console.error(error.code, error.message);
 });
```

**The behavior change:** `handle.*` registrations *replace* — registering a second handler for the
same RPC method silently unhooks the first, which is what you want for an ack that must be answered
exactly once. `on*` subscriptions are *additive* — every subscriber runs, in registration order.

So a second `handle.rpcError(...)` used to disable the first. A second `onRpcError(...)` does not:

```typescript
rpc.onRpcError(reportToSentry);
rpc.onRpcError(showToast);      // v7: replaced reportToSentry. v8: both run.
```

If you relied on re-registration to swap the active error handler, keep the returned unsubscribe
function and call it yourself:

```typescript
let off = rpc.onRpcError(handlerA);
// later
off();
off = rpc.onRpcError(handlerB);
```

Grep for the pattern before you migrate:

```bash
rg -n 'handle\.rpcError' --glob '!*.generated.ts'
```

**Go changed the same way**, so the two backends still behave identically. `OnRpcError` now keeps
every observer and returns an unsubscribe:

```diff
-binding.OnRpcError(reportFailure)
-binding.OnRpcError(alsoLog)   // v7: replaced reportFailure
+unsubscribe := binding.OnRpcError(reportFailure)
+binding.OnRpcError(alsoLog)   // v8: both run, in this order
+defer unsubscribe()
```

Existing Go call sites keep compiling — adding a return value to a function is source-compatible for
callers that ignore it. Only the swap-by-re-registering idiom needs rewriting, the same as in
TypeScript. A panicking observer no longer stops the ones registered after it, and `Dispose` drops
them all.

### 5. Event maps moved to `types.generated.ts`

`ClientToServerEvents` and `ServerToClientEvents` describe the wire in both directions, so both side
files used to export identical copies. A module importing from both sides got a duplicate-identifier
clash. There is now one copy, in `types.generated.ts`:

```diff
-import type { ClientToServerEvents, ServerToClientEvents } from './rpc/server.generated';
+import type { ClientToServerEvents, ServerToClientEvents } from './rpc/types.generated';

 const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
```

If you publish the generated package, the subpath is `<pkg>/types.generated`.

### 6. Method names: fewer are rejected, six now are

v7's TypeScript path refused eleven names — `rpcError`, `dispose`, `disposed`, `handle`, `server`,
`client`, `socket`, `connected`, `onConnect`, `onDisconnect`, `onReconnect` — on the theory that they
would collide with the generated surface. They never could: every RPC method lands inside `handle` /
`server` / `client`, and those namespaces hold nothing else. All eleven are available:

```typescript
export interface ServerFunctions {
  dispose: (jobId: string) => void;       // rejected by v7, fine in v8
  connected: () => boolean;               // rejected by v7, fine in v8
}
```

In their place, the TypeScript path now rejects the six names socket.io itself reserves — `connect`,
`connect_error`, `disconnect`, `disconnecting`, `newListener`, `removeListener`. Emitting any of them
throws `"<name>" is a reserved event name` at runtime, so v7 generated code that only failed once the
app was running. The Go backend already refused these, so a Go contract needs no change here. If
generation fails after you upgrade, rename the method:

```diff
 export interface ClientFunctions {
-  disconnect: (reason: string) => void;
+  connectionLost: (reason: string) => void;
 }
```

---

### Verifying the migration

```bash
# 1. Regenerate
bunx socketrpc-gen ./src/rpc/define.ts

# 2. Nothing should match
rg -n 'UnsubscribeFunction|RpcClientServer|RpcServerClient|handle\.rpcError' \
   --glob '!*.generated.ts' src/

# 3. Review each hit by hand — `.origin` also matches location.origin and CORS code
rg -n '\.origin\b|\.Origin\b' --glob '!*.generated.*' src/

# 4. Type-check — catches every rename except the JSON consumers noted in section 3
bunx tsc --noEmit
go build ./...   # if you generate a Go server
```
