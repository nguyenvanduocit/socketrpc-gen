# Example 03: Multi-Level Interface Extension

This example demonstrates **multiple levels of interface inheritance**, showing how to build a layered architecture.

## Architecture Layers

```
Framework (Core)
    ↓ extends
Platform (Auth & Users)
    ↓ extends
Application (Orders)
```

## Structure

```
03-multi-level-extension/
├── framework.define.ts    # Layer 1: Core framework
├── platform.define.ts     # Layer 2: Platform (extends framework)
└── define.ts              # Layer 3: Application (extends platform)
```

## Inheritance Chain

### Server Functions

```
FrameworkServerFunctions
  └─ healthCheck()

PlatformServerFunctions extends FrameworkServerFunctions
  ├─ healthCheck()        (inherited)
  ├─ login()
  ├─ getCurrentUser()
  └─ logout()

ServerFunctions extends PlatformServerFunctions
  ├─ healthCheck()        (inherited)
  ├─ login()              (inherited)
  ├─ getCurrentUser()     (inherited)
  ├─ logout()             (inherited)
  ├─ getOrder()
  ├─ createOrder()
  ├─ cancelOrder()
  └─ listOrders()
```

### Client Functions

```
FrameworkClientFunctions
  ├─ log()
  └─ getVersion()

PlatformClientFunctions extends FrameworkClientFunctions
  ├─ log()                (inherited)
  ├─ getVersion()         (inherited)
  ├─ showNotification()
  └─ requestAuth()

ClientFunctions extends PlatformClientFunctions
  ├─ log()                (inherited)
  ├─ getVersion()         (inherited)
  ├─ showNotification()   (inherited)
  ├─ requestAuth()        (inherited)
  ├─ onOrderStatusChanged()
  ├─ refreshOrderList()
  └─ confirmPayment()
```

## Generate RPC Code

```bash
bun run ../../index.ts ./define.ts
```

The generator will:
1. Read `define.ts` (Application layer)
2. Follow import to `platform.define.ts` (Platform layer)
3. Follow import to `framework.define.ts` (Framework layer)
4. Resolve the complete inheritance chain
5. Generate code for **all 8 server functions** and **all 7 client functions**

## Generated Output

After generation, you'll have:

**Client->Server calls** (8 functions total):
- Framework layer (1): `healthCheck()`
- Platform layer (3): `login()`, `getCurrentUser()`, `logout()`
- Application layer (4): `getOrder()`, `createOrder()`, `cancelOrder()`, `listOrders()`

**Server->Client calls** (7 functions total):
- Framework layer (2): `log()`, `getVersion()`
- Platform layer (2): `showNotification()`, `requestAuth()`
- Application layer (3): `onOrderStatusChanged()`, `refreshOrderList()`, `confirmPayment()`

## Usage Example

```typescript
import { io } from 'socket.io-client';
import {
  // Framework layer
  healthCheck,
  // Platform layer
  login,
  getCurrentUser,
  // Application layer
  createOrder,
  getOrder,
  // Handlers
  handleLog,
  handleShowNotification,
  handleOnOrderStatusChanged
} from './client.generated';

const socket = io('http://localhost:3000');

// Use functions from any layer
const health = await healthCheck(socket);          // Framework
const { user, token } = await login(socket, 'john', 'pass123');  // Platform
const order = await createOrder(socket, { items: ['item1'] });   // Application

// Set up handlers from any layer
handleLog(socket, async (socket, level, message) => {
  console[level](message);  // Framework
});

handleShowNotification(socket, async (socket, title, message) => {
  alert(`${title}: ${message}`);  // Platform
});

handleOnOrderStatusChanged(socket, async (socket, update) => {
  console.log('Order updated:', update);  // Application
});
```

## Use Cases

This pattern is useful for:

1. **Framework Developers**: Provide base RPC functions that all applications use
2. **Platform Teams**: Add platform-specific functions (auth, monitoring, etc.)
3. **Application Developers**: Focus on business logic without reimplementing common functionality
4. **Microservices**: Share common interface layers across services
5. **Plugins/Extensions**: Allow third parties to extend your RPC interfaces

## Benefits

- **Layered Architecture**: Clear separation of concerns
- **Code Reuse**: Framework and platform functions available everywhere
- **Type Safety**: Full TypeScript inference across all layers
- **Maintainability**: Update lower layers without touching applications
- **Scalability**: Add new layers as your system grows
