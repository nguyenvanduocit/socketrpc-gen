# Example 01: Basic RPC Interface

This example demonstrates the simplest use case with no interface extension.

## What's Included

- **ServerFunctions**: Functions that clients can call on the server
  - `getUser()` - Returns user data
  - `createUser()` - Creates a new user
  - `deleteUser()` - Fire-and-forget deletion (void return)

- **ClientFunctions**: Functions that server can call on clients
  - `onMessage()` - Fire-and-forget notification
  - `requestConfirmation()` - Request with boolean response

## Generate RPC Code

```bash
bun run ../../index.ts ./define.ts
```

This will generate:
- `client.generated.ts` - Client-side RPC functions
- `server.generated.ts` - Server-side RPC functions
- `types.generated.ts` - Shared type definitions
- `package.json` - Package configuration (if not exists)
- `tsconfig.json` - TypeScript configuration (if not exists)

## Usage

### Client Side

```typescript
import { io } from 'socket.io-client';
import { createRpcClient } from './client.generated';
import { isRpcError } from './types.generated';

const socket = io('http://localhost:3000');
const rpc = createRpcClient(socket);

// Call server functions — results are `User | RpcError`, narrow with isRpcError
const user = await rpc.server.getUser('user123');
if (isRpcError(user)) {
  console.error('getUser failed:', user.code, user.message);
} else {
  console.log('User:', user.name);
}

const newUser = await rpc.server.createUser('John Doe', 'john@example.com');
if (!isRpcError(newUser)) {
  console.log('Created:', newUser.id);
}

// Handle server->client calls
rpc.handle.onMessage(async (message) => {
  console.log('Received message:', message);
});

// Cleanup all handlers
rpc.dispose();
```

### Server Side

```typescript
import { Server } from 'socket.io';
import { createRpcServer } from './server.generated';

const io = new Server(3000);

io.on('connection', (socket) => {
  const rpc = createRpcServer(socket);

  // Handle client->server calls
  rpc.handle.getUser(async (userId) => {
    return { id: userId, name: 'John', email: 'john@example.com' };
  });

  // Call client functions
  rpc.client.onMessage('Welcome to the server!');

  // Cleanup on disconnect
  socket.on('disconnect', () => rpc.dispose());
});
```
