# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `bun install` - Install dependencies (use bun, not npm)
- `bun run index.ts <path>` - Generate RPC code from interface definitions
- `bun run index.ts <path> --watch` - Watch mode for automatic regeneration

### CLI Usage Examples
- `bun run index.ts ./examples/00-full-app/pkg/rpc/define.ts` - Generate from full app example (complete working application)
- `bun run index.ts ./examples/01-basic/define.ts` - Generate from basic example (simple interfaces)
- `bun run index.ts ./examples/00-full-app/pkg/rpc/define.ts --package-name "my-rpc" --timeout 3000`
- `bun run index.ts ./examples/05-go-server/define.ts --client typescript --server go --go-out ./examples/05-go-server/rpc` - TypeScript client + Go server

### Verification Commands
- `bun run check` - typecheck then run the full suite
- `bun test` - full suite (includes Go compile, `go test -race`, and cross-language integration; requires the `go` toolchain)
- `bun run generate:examples` - regenerate every example, then diff to spot drift

## Architecture

This is a TypeScript code generator for Socket.IO RPC packages. The tool generates type-safe client-server communication code from interface definitions.

### Core Components

**Main Generator (`index.ts`)**
- CLI entry point using `commander`
- Core generation logic using `ts-morph` AST manipulation
- Extracts function signatures from `ClientFunctions` and `ServerFunctions` interfaces
- Generates client.generated.ts, server.generated.ts, and types.generated.ts files

**Canonical IR (`src/schema.ts`)**
- `RpcSchema` is the single language-neutral representation of a contract: methods with a
  direction, plus the named object/enum/alias declarations they reference.
- `src/extract.ts` produces it alongside the string signatures the TypeScript emitters use.
  TypeScript emission stays permissive (it reads only the strings, so it accepts anything
  TypeScript accepts); a contract the IR cannot model is reported through `diagnostics`
  rather than raised.
- `requireRpcSchema()` is how a non-TypeScript backend obtains the IR — it refuses with
  every diagnostic at once, so an unsupported-type sentinel can never reach an emitter.
- There is exactly one schema type. Backends add options (`src/go/options.ts`), never a
  parallel schema.

**Go Backend (`src/go/`)**
- `options.ts` - Go-only knobs: package clause, socket import, default ack timeout
- `project.ts` - the single projection of `TypeRef` onto Go types, shared by both passes
- `validate.ts` - refuses shapes with no sound Go spelling, naming the fix in the message
- `emitter.ts` - writes gofmt-clean `types.generated.go` + `server.generated.go`
- Identifiers are derived idiomatically (`id` → `ID`, `roomId` → `RoomID`), so the schema
  carries no per-name override channel.

**Key Generation Process**
1. Parse input TypeScript file containing interface definitions
2. Extract function signatures from `ClientFunctions` and `ServerFunctions` interfaces
3. Generate bidirectional RPC functions:
   - Client functions call server methods
   - Server functions call client methods
   - Handler functions set up event listeners
4. Generate factory functions (`createRpcClient`, `createRpcServer`) for ergonomic API
5. Generate error handling with `RpcError` type
6. Output complete package with TypeScript declarations

### Generated Code Structure
- **Factory functions** - `createRpcClient()` / `createRpcServer()` for ergonomic API
- **Client/Server interfaces** - `RpcClient`, `RpcServer` with `.handle`, `.server`/`.client`, `.dispose()`
- **Error handling** - Built-in `RpcError` type and `isRpcError()` guard
- **Type safety** - Full TypeScript support with generated type imports

### Multi-Language Generation

`--client <lang>` and `--server <lang>` select the backends; both default to `typescript`,
so existing invocations are unchanged. `--server go` emits `types.generated.go` and
`server.generated.go` (into `--go-out`, default the input file's directory) and skips
`server.generated.ts`. `--go-package` sets the Go package clause and `--go-socket-import`
the transport, which defaults to `github.com/zishang520/socket.io/servers/socket/v3`.

The Go backend only accepts the portable subset of the IR — named object types, named
string-literal unions, scalars, arrays, string-keyed records, `T | null`, optional fields,
and `void`. Inline object literals, inline unions, ambient types (`Error`, `Date`), tuples,
intersections, generics, `any`, and optional *positional* parameters are refused with the
declaration to write instead. See `examples/05-go-server/`.

Behaviour parity worth knowing: the Go server serializes dispatch per RPC method (same-method
calls keep Socket.IO's arrival order, a blocked handler stalls only its own method), and nil
slices/maps returned from a handler are normalized so a client typed `T[]` never sees `null`.

### Interface Requirements
- Must define `ClientFunctions` and `ServerFunctions` interfaces
- Do NOT use `Promise` in interface return types (automatically wrapped)
- Use `void` for fire-and-forget functions
- Non-void functions automatically get acknowledgment handling and timeout support

### Ergonomic API Usage (Recommended)

The generator creates `createRpcClient()` and `createRpcServer()` factory functions that provide a clean API with automatic cleanup.

**Client Side:**
```typescript
import { createRpcClient } from './rpc/client.generated';

const rpc = createRpcClient(socket);

// Register handlers with rpc.handle.* (for calls FROM server)
rpc.handle.showError(async (error) => {
  console.error('Error:', error);
});

rpc.handle.onProgress(async (current, total) => {
  console.log(`Progress: ${current}/${total}`);
});

// Make RPC calls with rpc.server.* (calls TO server)
const result = await rpc.server.generateText("Hello!");

// Single cleanup call
rpc.dispose();
```

**Server Side:**
```typescript
import { createRpcServer } from './rpc/server.generated';

io.on('connection', (socket) => {
  const rpc = createRpcServer(socket);

  // Register handlers with rpc.handle.* (for calls FROM client)
  rpc.handle.generateText(async (prompt) => {
    // Call client methods via rpc.client.* (calls TO client)
    rpc.client.showError(new Error("Something happened"));
    return "Generated: " + prompt;
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => rpc.dispose());
});
```

### Vue 3 Integration

```vue
<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { socket } from './socket';
import { createRpcClient } from './rpc/client.generated';

const rpc = createRpcClient(socket);

// Register handlers - no manual tracking needed
rpc.handle.showError(async (error) => {
  console.error('Error:', error);
});

rpc.handle.onProgress(async (current, total) => {
  console.log(`Progress: ${current}/${total}`);
});

// Single cleanup call handles everything
onBeforeUnmount(() => rpc.dispose());
</script>
```

### React Integration

```typescript
import { useEffect, useRef } from 'react';
import { socket } from './socket';
import { createRpcClient, RpcClient } from './rpc/client.generated';

function MyComponent() {
  const rpcRef = useRef<RpcClient>();

  useEffect(() => {
    const rpc = createRpcClient(socket);
    rpcRef.current = rpc;

    rpc.handle.showError(async (error) => {
      console.error('Error:', error);
    });

    return () => rpc.dispose();
  }, []);

  return <div>My Component</div>;
}
```

### API Structure

```typescript
// RpcClient interface
interface RpcClient {
  handle: {
    // Register handlers for server-to-client calls. Returns an unsubscribe function.
    // Re-registering the same name replaces the previous handler.
    showError: (handler: (error: Error) => Promise<void>) => UnsubscribeFunction;
    askQuestion: (handler: (question: string) => Promise<string>) => UnsubscribeFunction;
    // ...
  };
  server: {
    // Call server methods. `opts` carries timeout / AbortSignal / volatile.
    generateText: (prompt: string, opts?: RpcCallOptions) => Promise<string | RpcError>;
    // ...
  };
  socket: Socket;        // Underlying socket
  connected: boolean;    // Whether the socket is currently connected
  onConnect(handler: () => void): UnsubscribeFunction;            // re-sync on (re)connect
  onDisconnect(handler: (reason: string) => void): UnsubscribeFunction;
  onReconnect(handler: (attempt: number) => void): UnsubscribeFunction;
  disposed: boolean;     // Whether disposed
  dispose(): void;       // Cleanup all handlers
}

// RpcServer interface
interface RpcServer {
  handle: {
    // Register handlers for client-to-server calls. Returns an unsubscribe function.
    generateText: (handler: (prompt: string) => Promise<string>) => UnsubscribeFunction;
    // ...
  };
  client: {
    // Call client methods. `opts` carries timeout / AbortSignal / volatile.
    showError: (error: Error, opts?: RpcCallOptions) => void;
    askQuestion: (question: string, opts?: RpcCallOptions) => Promise<string | RpcError>;
    // ...
  };
  socket: Socket;        // Underlying socket
  connected: boolean;    // Whether the socket is currently connected
  onDisconnect(handler: (reason: string) => void): UnsubscribeFunction;
  disposed: boolean;     // Whether disposed
  dispose(): void;       // Cleanup all handlers
}
```

### Error model

- `RpcError` is **branded** with a `__rpcError: true` field; `isRpcError()` checks the brand, so a
  successful result shaped like `{ message, code }` is never misread as an error.
- Handlers signal failure by **throwing** — `throw rpcError(code, message, data?)` for a typed error,
  or any thrown value (normalized to `INTERNAL_ERROR`). Do not return `RpcError` from a handler.
- Standard codes: `TIMEOUT`, `DISPOSED`, `DISCONNECTED`, `ABORTED`, `INTERNAL_ERROR`, `INVALID_ARGUMENT`.
- `--error-mode throw` makes calls reject with the `RpcError` instead of returning `T | RpcError`.

### Example Structure
```
pkg/rpc/
├── define.ts              # Interface definitions (input)
├── client.generated.ts    # Generated client RPC (includes createRpcClient)
├── server.generated.ts    # Generated server RPC (includes createRpcServer)
├── types.generated.ts     # Generated types and error handling
├── index.ts              # Package entry point
├── package.json          # Generated package config
└── tsconfig.json         # Generated TypeScript config
```

The tool automatically infers the output directory from the input file path and generates a complete npm package structure.
