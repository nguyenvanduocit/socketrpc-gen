# Example 02: Single-Level Interface Extension

This example demonstrates extending base interfaces with application-specific functions.

## Structure

```
02-single-extension/
├── base.define.ts    # Base/framework interfaces
└── define.ts         # Application interfaces (extends base)
```

## What's Included

### Base Interfaces (base.define.ts)

- **BaseServerFunctions**: Framework-level server functions
  - `ping()` - Health check
  - `getServerTime()` - Get server timestamp

- **BaseClientFunctions**: Framework-level client functions
  - `showError()` - Display error message
  - `showSuccess()` - Display success message
  - `getClientInfo()` - Get client environment info

### Application Interfaces (define.ts)

- **ServerFunctions extends BaseServerFunctions**:
  - Inherits: `ping()`, `getServerTime()`
  - Adds: `getProduct()`, `createProduct()`, `listProducts()`

- **ClientFunctions extends BaseClientFunctions**:
  - Inherits: `showError()`, `showSuccess()`, `getClientInfo()`
  - Adds: `onProductUpdated()`, `refreshProducts()`

## Generate RPC Code

```bash
bun run ../../index.ts ./define.ts
```

The generator will automatically:
1. Read `define.ts`
2. Follow the import to `base.define.ts`
3. Resolve the interface inheritance
4. Generate code for **all functions** from both base and derived interfaces

## Generated Functions

After generation, you'll have access to:

**Client->Server calls** (5 functions):
- `ping()` (from base)
- `getServerTime()` (from base)
- `getProduct()`
- `createProduct()`
- `listProducts()`

**Server->Client calls** (5 functions):
- `showError()` (from base)
- `showSuccess()` (from base)
- `getClientInfo()` (from base)
- `onProductUpdated()`
- `refreshProducts()`

## Usage Example

```typescript
import { io } from 'socket.io-client';
import { createRpcClient } from './client.generated';
import { isRpcError } from './types.generated';

const socket = io('http://localhost:3000');
const rpc = createRpcClient(socket);

// Handle base functions (one handler per method; re-registering replaces)
rpc.handle.showError(async (error) => {
  console.error('Server error:', error.message);
});

// Call base functions
const pong = await rpc.server.ping();
const time = await rpc.server.getServerTime();

// Call app functions
const product = await rpc.server.getProduct('prod-123');
if (isRpcError(product)) {
  console.error(`getProduct failed: ${product.code} ${product.message}`);
} else {
  console.log(product.name);
}

// Cleanup removes every handler registered above
rpc.dispose();
```

## Benefits of Extension

1. **Code Reuse**: Define common functions once in base interfaces
2. **Separation of Concerns**: Framework vs application logic
3. **Maintainability**: Update base functions in one place
4. **Type Safety**: Full TypeScript support across the inheritance chain
