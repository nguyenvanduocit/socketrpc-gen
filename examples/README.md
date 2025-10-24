# socketrpc-gen Examples

This directory contains examples demonstrating different use cases and features of socketrpc-gen.

## Quick Start

Each example is self-contained with its own README. To try an example:

```bash
cd examples/01-basic
bun run ../../index.ts ./define.ts
```

## Examples Overview

### [01-basic](./01-basic/) - Basic RPC Interfaces

**What it demonstrates:**
- Simple interface definitions without any extension
- Basic client-server RPC communication
- Fire-and-forget functions (void return)
- Functions with return values

**Complexity:** ⭐ Beginner

**Use when:**
- Starting a new project
- You don't need interface inheritance
- Simple client-server communication

**Functions generated:** 5 total (3 server, 2 client)

---

### [02-single-extension](./02-single-extension/) - Single-Level Extension

**What it demonstrates:**
- Extending base interfaces with application-specific functions
- Separating framework and application logic
- Type reuse across interface inheritance

**Complexity:** ⭐⭐ Intermediate

**Use when:**
- Building a framework that others will extend
- Separating common functionality from app-specific features
- Creating reusable interface libraries

**Functions generated:** 11 total (6 server, 5 client)

**Structure:**
```
base.define.ts → define.ts
(framework)      (application)
```

---

### [03-multi-level-extension](./03-multi-level-extension/) - Multi-Level Extension

**What it demonstrates:**
- Multiple levels of interface inheritance
- Layered architecture (Framework → Platform → Application)
- Complex type resolution across multiple files
- Enterprise-scale architecture patterns

**Complexity:** ⭐⭐⭐ Advanced

**Use when:**
- Building large-scale applications with multiple layers
- Creating plugin systems
- Developing microservices with shared base functionality
- Framework → Platform → Application architecture

**Functions generated:** 15 total (8 server, 7 client)

**Structure:**
```
framework.define.ts → platform.define.ts → define.ts
(core)                (auth/users)         (business logic)
```

---

## Feature Comparison

| Feature | Example 01 | Example 02 | Example 03 |
|---------|-----------|-----------|-----------|
| Interface Extension | ❌ | ✅ Single-level | ✅ Multi-level |
| Multiple Files | ❌ | ✅ 2 files | ✅ 3 files |
| Layered Architecture | ❌ | ✅ 2 layers | ✅ 3 layers |
| Complexity | Low | Medium | High |
| Real-world Use | Simple apps | Frameworks | Enterprise |

## Common Patterns

### Pattern 1: Framework Base Classes (Example 02)

Create a `base.define.ts` with common functions:
- Error handling (`showError`)
- Success notifications (`showSuccess`)
- Health checks (`ping`)
- Utility functions

Then extend in your `define.ts` with business logic.

### Pattern 2: Layered Architecture (Example 03)

Structure your interfaces in layers:
1. **Framework Layer**: Core functionality (logging, health)
2. **Platform Layer**: Cross-cutting concerns (auth, monitoring)
3. **Application Layer**: Business logic (orders, products)

Each layer extends the one below it.

### Pattern 3: Plugin System

Base application provides core interfaces, plugins extend with additional functions:
```typescript
// core.define.ts
export interface CoreFunctions { ... }

// plugin-a.define.ts
export interface PluginAFunctions extends CoreFunctions { ... }

// plugin-b.define.ts
export interface PluginBFunctions extends CoreFunctions { ... }
```

## Testing Examples

To verify all examples work:

```bash
# Test example 01
cd examples/01-basic
bun run ../../index.ts ./define.ts

# Test example 02
cd ../02-single-extension
bun run ../../index.ts ./define.ts

# Test example 03
cd ../03-multi-level-extension
bun run ../../index.ts ./define.ts
```

Each should generate without errors and produce `client.generated.ts`, `server.generated.ts`, and `types.generated.ts`.

## Tips

1. **Start Simple**: Begin with Example 01, then move to extensions as your needs grow
2. **File Organization**: Keep definition files close to where they're used
3. **Naming Convention**: Use `*.define.ts` for interface definition files
4. **Documentation**: Document your interfaces well - JSDoc comments are preserved
5. **Type Safety**: Export all custom types from your definition files

## Next Steps

After trying these examples:
1. Check the generated code to understand what's created
2. Read the [main documentation](../README.md) for CLI options
3. Integrate into your project
4. Consider which pattern fits your architecture

## Questions?

- See individual example READMEs for detailed usage
- Check [main README](../README.md) for CLI options and configuration
- Report issues at https://github.com/nguyenvanduocit/socketrpc-gen
