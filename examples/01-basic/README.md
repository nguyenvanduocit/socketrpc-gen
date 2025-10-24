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
import { getUser, createUser, handleOnMessage } from './client.generated';

const socket = io('http://localhost:3000');

// Call server functions
const user = await getUser(socket, 'user123');
const newUser = await createUser(socket, 'John Doe', 'john@example.com');

// Handle server->client calls
handleOnMessage(socket, async (socket, message) => {
  console.log('Received message:', message);
});
```

### Server Side

```typescript
import { Server } from 'socket.io';
import { handleGetUser, handleCreateUser, onMessage } from './server.generated';

const io = new Server(3000);

io.on('connection', (socket) => {
  // Handle client->server calls
  handleGetUser(socket, async (socket, userId) => {
    return { id: userId, name: 'John', email: 'john@example.com' };
  });

  // Call client functions
  onMessage(socket, 'Welcome to the server!');
});
```
