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

**Client->Server calls** (6 functions):
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
import {
  ping,              // from base
  getServerTime,     // from base
  getProduct,        // from app
  handleShowError    // from base
} from './client.generated';

const socket = io('http://localhost:3000');

// Call base functions
const pong = await ping(socket);
const time = await getServerTime(socket);

// Call app functions
const product = await getProduct(socket, 'prod-123');

// Handle base functions
handleShowError(socket, async (socket, error) => {
  console.error('Server error:', error.message);
});
```

## Benefits of Extension

1. **Code Reuse**: Define common functions once in base interfaces
2. **Separation of Concerns**: Framework vs application logic
3. **Maintainability**: Update base functions in one place
4. **Type Safety**: Full TypeScript support across the inheritance chain
