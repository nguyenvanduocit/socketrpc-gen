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

## Architecture

This is a TypeScript code generator for Socket.IO RPC packages. The tool generates type-safe client-server communication code from interface definitions.

### Core Components

**Main Generator (`index.ts`)**
- CLI entry point using `commander`
- Core generation logic using `ts-morph` AST manipulation
- Extracts function signatures from `ClientFunctions` and `ServerFunctions` interfaces
- Generates client.generated.ts, server.generated.ts, and types.generated.ts files

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

const client = createRpcClient(socket);

// Register handlers with client.handle.* (for calls FROM server)
client.handle.showError(async (error) => {
  console.error('Error:', error);
});

client.handle.onProgress(async (current, total) => {
  console.log(`Progress: ${current}/${total}`);
});

// Make RPC calls with client.server.* (calls TO server)
const result = await client.server.generateText("Hello!");

// Single cleanup call
client.dispose();
```

**Server Side:**
```typescript
import { createRpcServer } from './rpc/server.generated';

io.on('connection', (socket) => {
  const server = createRpcServer(socket);

  // Register handlers with server.handle.* (for calls FROM client)
  server.handle.generateText(async (prompt) => {
    // Call client methods via server.client.* (calls TO client)
    server.client.showError(new Error("Something happened"));
    return "Generated: " + prompt;
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => server.dispose());
});
```

### Vue 3 Integration

```typescript
import { onBeforeUnmount } from 'vue';
import { socket } from './socket';
import { createRpcClient } from './rpc/client.generated';

export default {
  setup() {
    const client = createRpcClient(socket);

    // Register handlers - no manual tracking needed
    client.handle.showError(async (error) => {
      console.error('Error:', error);
    });

    client.handle.onProgress(async (current, total) => {
      console.log(`Progress: ${current}/${total}`);
    });

    // Single cleanup call handles everything
    onBeforeUnmount(() => client.dispose());

    return { client };
  }
}
```

### React Integration

```typescript
import { useEffect, useRef } from 'react';
import { socket } from './socket';
import { createRpcClient, RpcClient } from './rpc/client.generated';

function MyComponent() {
  const clientRef = useRef<RpcClient>();

  useEffect(() => {
    const client = createRpcClient(socket);
    clientRef.current = client;

    client.handle.showError(async (error) => {
      console.error('Error:', error);
    });

    return () => client.dispose();
  }, []);

  return <div>My Component</div>;
}
```

### API Structure

```typescript
// RpcClient interface
interface RpcClient {
  handle: {
    // Register handlers for server-to-client calls
    showError: (handler: (error: Error) => Promise<void>) => void;
    askQuestion: (handler: (question: string) => Promise<string>) => void;
    // ...
  };
  server: {
    // Call server methods
    generateText: (prompt: string, timeout?: number) => Promise<string | RpcError>;
    // ...
  };
  socket: Socket;      // Underlying socket
  disposed: boolean;   // Whether disposed
  dispose(): void;     // Cleanup all handlers
}

// RpcServer interface
interface RpcServer {
  handle: {
    // Register handlers for client-to-server calls
    generateText: (handler: (prompt: string) => Promise<string>) => void;
    // ...
  };
  client: {
    // Call client methods
    showError: (error: Error) => void;
    askQuestion: (question: string, timeout?: number) => Promise<string | RpcError>;
    // ...
  };
  socket: Socket;      // Underlying socket
  disposed: boolean;   // Whether disposed
  dispose(): void;     // Cleanup all handlers
}
```

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
