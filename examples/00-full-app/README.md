# Full Application Example

This is a complete working application demonstrating how to use the generated Socket.IO RPC code in a real-world scenario. Unlike the other examples that only show interface definitions, this includes actual client and server implementations.

## Structure

```
examples/00-full-app/pkg/
├── rpc/
│   ├── define.ts              # Interface definitions (input)
│   ├── client.generated.ts    # Generated client RPC functions
│   ├── server.generated.ts    # Generated server RPC functions
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

## Important: Proper Handler Cleanup

Handler functions return an unsubscribe function that **MUST** be called to clean up event listeners. Failing to do so will cause memory leaks and `MaxListenersExceededWarning` errors.

### Vue 3 Composition API

```typescript
import { onMounted, onBeforeUnmount } from 'vue';
import { socket } from './socket';
import { handleShowError, handleOnResyncProgress } from './rpc/client.generated';

export default {
  setup() {
    const unsubscribers: Array<() => void> = [];

    onMounted(() => {
      // Register all handlers and store unsubscribe functions
      unsubscribers.push(
        handleShowError(socket, async (socket, error) => {
          console.error('Error:', error);
        }),
        handleOnResyncProgress(socket, async (socket, msg, current, total) => {
          console.log(`Progress: ${current}/${total}`);
        })
      );
    });

    onBeforeUnmount(() => {
      // Clean up all handlers when component unmounts
      unsubscribers.forEach(fn => fn());
    });
  }
}
```

### React

```typescript
import { useEffect } from 'react';
import { socket } from './socket';
import { handleShowError, handleOnResyncProgress } from './rpc/client.generated';

function MyComponent() {
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    // Register handlers
    unsubscribers.push(
      handleShowError(socket, async (socket, error) => {
        console.error('Error:', error);
      }),
      handleOnResyncProgress(socket, async (socket, msg, current, total) => {
        console.log(`Progress: ${current}/${total}`);
      })
    );

    // Cleanup function
    return () => {
      unsubscribers.forEach(fn => fn());
    };
  }, []);

  return <div>My Component</div>;
}
```

### Plain JavaScript/TypeScript

```typescript
import { socket } from './socket';
import { handleShowError, handleOnResyncProgress } from './rpc/client.generated';

// Register handlers
const unsubscribers: Array<() => void> = [];

unsubscribers.push(
  handleShowError(socket, async (socket, error) => {
    console.error('Error:', error);
  }),
  handleOnResyncProgress(socket, async (socket, msg, current, total) => {
    console.log(`Progress: ${current}/${total}`);
  })
);

// When you want to clean up (e.g., before page navigation)
function cleanup() {
  unsubscribers.forEach(fn => fn());
}
```

## Why Cleanup is Important

Without proper cleanup:
- ❌ Event listeners accumulate on every component mount/remount
- ❌ HMR (Hot Module Replacement) causes listener stacking
- ❌ You'll see `MaxListenersExceededWarning: Possible EventTarget memory leak detected`
- ❌ Memory leaks in long-running applications

With proper cleanup:
- ✅ Handlers are removed when components unmount
- ✅ No listener accumulation during HMR
- ✅ No memory leaks
- ✅ Clean, predictable behavior

## Usage Patterns

### Client Calling Server

```typescript
import { generateText } from './rpc/client.generated';

const result = await generateText(socket, 'Hello world');
if (isRpcError(result)) {
  console.error('Error:', result.message);
} else {
  console.log('Result:', result);
}
```

### Server Calling Client

```typescript
import { showError } from './rpc/server.generated';

showError(socket, new Error('Something went wrong'));
```

### Setting Up Handlers (Client Side)

```typescript
import { handleShowError } from './rpc/client.generated';

const unsubscribe = handleShowError(socket, async (socket, error) => {
  console.error('Server sent error:', error);
});

// Later, clean up
unsubscribe();
```

### Setting Up Handlers (Server Side)

```typescript
import { handleGenerateText } from './rpc/server.generated';

const unsubscribe = handleGenerateText(socket, async (socket, prompt) => {
  const text = await generateTextWithAI(prompt);
  return text;
});

// Later, clean up
unsubscribe();
```
