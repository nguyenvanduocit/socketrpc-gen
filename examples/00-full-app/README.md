# Full Application Example

This is a complete working application demonstrating how to use the generated Socket.IO RPC code in a real-world scenario. Unlike the other examples that only show interface definitions, this includes actual client and server implementations.

## Structure

```
examples/00-full-app/pkg/
├── rpc/
│   ├── define.ts              # Interface definitions (input)
│   ├── client.generated.ts    # Generated client RPC (createRpcClient)
│   ├── server.generated.ts    # Generated server RPC (createRpcServer)
│   └── types.generated.ts     # Generated types
├── client/
│   └── index.ts               # Client implementation
├── server/
│   └── index.ts               # Server implementation
└── webapp/
    └── main.ts                # Web application entry point
```

## Generate RPC Code

From the project root:

```bash
bun run index.ts ./examples/00-full-app/pkg/rpc/define.ts
```

## Handler Lifecycle

`createRpcClient(socket)` / `createRpcServer(socket)` own every listener they register. `rpc.handle.<method>(handler)` registers **one handler per method** — re-registering replaces the previous one — and returns an `Unsubscribe`. The event observers are additive and each return their own `Unsubscribe`: `rpc.onDisconnect` / `rpc.onRpcError` on both sides, plus `rpc.onConnect` / `rpc.onReconnect` on the client. A single `rpc.dispose()` removes all of them, so a component mount, remount, or HMR reload never stacks listeners or double-answers an ack.

### Vue 3 Composition API

```typescript
import { onBeforeUnmount } from 'vue';
import { socket } from './socket';
import { createRpcClient } from './rpc/client.generated';

export default {
  setup() {
    const rpc = createRpcClient(socket);

    rpc.handle.showError(async (error) => {
      console.error('Error:', error);
    });
    rpc.handle.updateDiscoveredUrls(async (url) => {
      console.log('Discovered:', url);
    });

    onBeforeUnmount(() => rpc.dispose());
  }
}
```

### React

```typescript
import { useEffect } from 'react';
import { socket } from './socket';
import { createRpcClient } from './rpc/client.generated';

function MyComponent() {
  useEffect(() => {
    const rpc = createRpcClient(socket);

    rpc.handle.showError(async (error) => {
      console.error('Error:', error);
    });
    rpc.handle.updateDiscoveredUrls(async (url) => {
      console.log('Discovered:', url);
    });

    return () => rpc.dispose();
  }, []);

  return <div>My Component</div>;
}
```

### Plain JavaScript/TypeScript

```typescript
import { socket } from './socket';
import { createRpcClient } from './rpc/client.generated';

const rpc = createRpcClient(socket);

rpc.handle.showError(async (error) => {
  console.error('Error:', error);
});
rpc.handle.updateDiscoveredUrls(async (url) => {
  console.log('Discovered:', url);
});

// When you want to clean up (e.g., before page navigation)
function cleanup() {
  rpc.dispose();
}
```

## Why Cleanup is Important

Without `rpc.dispose()`:
- ❌ Socket listeners outlive the component that created them
- ❌ Memory leaks in long-running applications

With `rpc.dispose()`:
- ✅ Handlers are removed when components unmount
- ✅ No listener accumulation during HMR
- ✅ No memory leaks
- ✅ Clean, predictable behavior

## Usage Patterns

### Client Calling Server

```typescript
import { createRpcClient } from './rpc/client.generated';
import { isRpcError } from './rpc/types.generated';

const rpc = createRpcClient(socket);

const result = await rpc.server.generateText('Hello world');
if (isRpcError(result)) {
  console.error('Error:', result.message);
} else {
  console.log('Result:', result);
}
```

### Server Calling Client

```typescript
import { createRpcServer } from './rpc/server.generated';

const rpc = createRpcServer(socket);

rpc.client.showError(new Error('Something went wrong'));
```

### Setting Up Handlers (Client Side)

```typescript
import { createRpcClient } from './rpc/client.generated';

const rpc = createRpcClient(socket);

const unsubscribe = rpc.handle.showError(async (error) => {
  console.error('Server sent error:', error);
});

// Remove just this handler, or call rpc.dispose() to remove everything
unsubscribe();
```

### Setting Up Handlers (Server Side)

```typescript
import { createRpcServer } from './rpc/server.generated';

const rpc = createRpcServer(socket);

const unsubscribe = rpc.handle.generateText(async (prompt) => {
  const text = await generateTextWithAI(prompt);
  return text;
});

// Remove just this handler, or call rpc.dispose() to remove everything
unsubscribe();
```
