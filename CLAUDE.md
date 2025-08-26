# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `bun install` - Install dependencies (use bun, not npm)
- `bun run index.ts <path>` - Generate RPC code from interface definitions
- `bun run index.ts <path> --watch` - Watch mode for automatic regeneration

### CLI Usage Examples
- `bun run index.ts ./example/pkg/rpc/define.ts` - Generate RPC package from example
- `bun run index.ts ./example/pkg/rpc/define.ts --package-name "my-rpc" --timeout 3000`

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
4. Generate error handling with `RpcError` type
5. Output complete package with TypeScript declarations

### Generated Code Structure
- **Client functions** - Allow client to call server methods
- **Server functions** - Allow server to call client methods  
- **Handler functions** - Set up event listeners with pattern `handle<FunctionName>`
- **Error handling** - Built-in `handleRpcError` function and `RpcError` type
- **Type safety** - Full TypeScript support with generated type imports

### Interface Requirements
- Must define `ClientFunctions` and `ServerFunctions` interfaces
- Do NOT use `Promise` in interface return types (automatically wrapped)
- Use `void` for fire-and-forget functions
- Non-void functions automatically get acknowledgment handling and timeout support

### Example Structure
```
pkg/rpc/
├── define.ts              # Interface definitions (input)
├── client.generated.ts    # Generated client RPC functions
├── server.generated.ts    # Generated server RPC functions  
├── types.generated.ts     # Generated types and error handling
├── index.ts              # Package entry point
├── package.json          # Generated package config
└── tsconfig.json         # Generated TypeScript config
```

The tool automatically infers the output directory from the input file path and generates a complete npm package structure.