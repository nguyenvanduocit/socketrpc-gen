# Quick Start Guide

Choose the example that matches your needs:

## 🚀 Just Starting? → [Example 01](./01-basic/)

```bash
cd examples/01-basic
bun run ../../index.ts ./define.ts
```

**Perfect for:**
- New projects
- Simple client-server communication
- Learning the basics

---

## 🏗️ Building a Framework? → [Example 02](./02-single-extension/)

```bash
cd examples/02-single-extension
bun run ../../index.ts ./define.ts
```

**Perfect for:**
- Reusable base functionality
- Framework + Application separation
- Shared interface libraries

---

## 🏢 Enterprise Architecture? → [Example 03](./03-multi-level-extension/)

```bash
cd examples/03-multi-level-extension
bun run ../../index.ts ./define.ts
```

**Perfect for:**
- Multi-layer applications
- Framework → Platform → Application
- Plugin systems
- Microservices with shared base

---

## 🤖 Using Zod Schemas? → [Example 04](./04-zod-integration/)

```bash
cd examples/04-zod-integration
bun run ../../index.ts ./define.ts
```

**Perfect for:**
- Schema-first contracts: `z.infer<>` types feed the RPC interfaces
- Reusing schemas shared with AI frameworks that already speak Zod
- Runtime validation inside handlers with `Schema.safeParse()`

---

## 🐹 Go Server? → [Example 05](./05-go-server/)

```bash
cd examples/05-go-server
bun run ../../index.ts ./define.ts \
  --client typescript --server go --go-out ./rpc --go-package rpc
```

**Perfect for:**
- TypeScript client + Go server from one contract
- Go bindings with `HandleX` / `CallX` methods and `OnRpcError`
- Contracts that stay inside the portable subset (named types, scalars, arrays, records, `T | null`, `void`)

---

## What Gets Generated?

For each example, you'll get:

```
✅ client.generated.ts    - Client-side RPC functions
✅ server.generated.ts    - Server-side RPC functions
✅ types.generated.ts     - Shared type definitions
✅ package.json          - Package config (if not exists)
✅ tsconfig.json         - TypeScript config (if not exists)
```

## CLI Options

```bash
# Basic generation
bun run ../../index.ts ./define.ts

# With custom options
bun run ../../index.ts ./define.ts \
  --package-name "my-rpc" \
  --timeout 3000 \
  --error-logger "@/lib/logger"

# Calls reject with the RpcError instead of returning `T | RpcError`
bun run ../../index.ts ./define.ts --error-mode throw

# TypeScript client + Go server (types.generated.go + server.generated.go in --go-out)
bun run ../../index.ts ./define.ts \
  --client typescript --server go --go-out ./rpc --go-package rpc

# Watch mode (auto-regenerate on changes)
bun run ../../index.ts ./define.ts --watch
```

Run `bun run ../../index.ts --help` for the full list, including `--go-socket-import`.

## Next Steps

1. ✅ Pick an example and generate code
2. 📖 Read the example's README
3. 🔍 Examine the generated files
4. 🎯 Adapt to your project

Need help? Check the [main examples README](./README.md)
