# Changelog

## [2.2.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v2.1.0...v2.2.0) (2025-10-27)


### Features

* **handler:** allow void handlers to return RpcError and improve error propagation ([#20](https://github.com/nguyenvanduocit/socketrpc-gen/issues/20)) ([c449d37](https://github.com/nguyenvanduocit/socketrpc-gen/commit/c449d37cc1a0e67f2da39378a082cfee1b06a45f))

## [2.1.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v2.0.1...v2.1.0) (2025-10-24)


### Features

* **generator:** add interface extension support and comprehensive examples ([5abb681](https://github.com/nguyenvanduocit/socketrpc-gen/commit/5abb6810e28782bdd4756af817d8cbedf0442113))

## [2.0.1](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v2.0.0...v2.0.1) (2025-10-24)


### Bug Fixes

* **cli:** read version from package.json instead of hardcoded value ([40c8af2](https://github.com/nguyenvanduocit/socketrpc-gen/commit/40c8af2f0e4b5fc9bce0b30c7aa2559a2550b6ca))

## [2.0.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.11.0...v2.0.0) (2025-10-24)


### ⚠ BREAKING CHANGES

* **generator:** Automatic cleanup of event listeners is now enabled by default. Event listeners will be automatically removed when the socket disconnects, preventing memory leaks in long-running applications.

### Features

* **generator:** make auto-cleanup the default behavior ([66431c8](https://github.com/nguyenvanduocit/socketrpc-gen/commit/66431c8c1d6e4d9daae7234cc3f372b57966d2dd))

## [2.0.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.11.0...v2.0.0) (2025-10-24)


### ⚠ BREAKING CHANGES

* **generator:** Automatic cleanup of event listeners is now enabled by default. Event listeners will be automatically removed when the socket disconnects, preventing memory leaks in long-running applications.

**Migration:** If you need the old behavior (manual cleanup control), use the `--no-auto-cleanup` flag when generating code:
```bash
socketrpc-gen ./define.ts --no-auto-cleanup
```

### Features

* **generator:** Make auto-cleanup the default behavior ([#15](https://github.com/nguyenvanduocit/socketrpc-gen/issues/15))
  - Changed default `autoCleanup` to `true` for automatic event listener cleanup on disconnect
  - Added `--no-auto-cleanup` CLI flag to disable automatic cleanup for advanced use cases
  - Improves production-readiness by preventing memory leaks by default
  - Aligns with Socket.IO best practices for event listener management

## [1.11.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.10.0...v1.11.0) (2025-10-24)


### Features

* **generator:** enhance error handling, validation, and configuration options ([1cb80d5](https://github.com/nguyenvanduocit/socketrpc-gen/commit/1cb80d5733d706cf6cfa7a3818b22566e75d4a5a))

## [1.10.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.9.0...v1.10.0) (2025-10-24)


### Features

* **generator:** add socket parameter to handler types ([a052931](https://github.com/nguyenvanduocit/socketrpc-gen/commit/a052931375f7e347975967b8b0f3ae31443138ae))

## [1.9.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.8.0...v1.9.0) (2025-08-26)


### Features

* add exported handler types for better type safety ([c1e5b78](https://github.com/nguyenvanduocit/socketrpc-gen/commit/c1e5b7866adad1a0796abe2460e0a5f3227c7e17))

## [1.8.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.7.0...v1.8.0) (2025-08-26)


### Features

* improve handler functions with proper event listener cleanup ([035ba61](https://github.com/nguyenvanduocit/socketrpc-gen/commit/035ba614cbbf6cf8ace7c5e509ee4f0cce1c62a3))

## [1.7.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.6.0...v1.7.0) (2025-08-26)


### Features

* enhance generated file headers with clear warnings and regeneration instructions ([c468028](https://github.com/nguyenvanduocit/socketrpc-gen/commit/c4680286ca937a9004d55d7267800dcf0675a38e))
* improve RPC generation with custom type imports and void function handling ([ef89b78](https://github.com/nguyenvanduocit/socketrpc-gen/commit/ef89b78f4819d68fdc4299249fc205992ed9a5fa))

## [1.6.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.5.0...v1.6.0) (2025-07-03)


### Features

* bump version ([0615b7d](https://github.com/nguyenvanduocit/socketrpc-gen/commit/0615b7d35469a5c532460f0f5a17b64ea33c91c9))

## [1.5.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.4.0...v1.5.0) (2025-07-01)


### Features

* add handleRpcError function for improved RPC error handling with async/await ([fbeaafe](https://github.com/nguyenvanduocit/socketrpc-gen/commit/fbeaafe945763aa4434d4ac3e6012e818cd26c43))
* enhance error handling in RPC functions and update callback logic ([b8a1f10](https://github.com/nguyenvanduocit/socketrpc-gen/commit/b8a1f10b3f19e368f3ddaa6edd9f8c61ff4e8638))

## [1.4.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.3.0...v1.4.0) (2025-07-01)


### Features

* update version to make it build ([00cdfbe](https://github.com/nguyenvanduocit/socketrpc-gen/commit/00cdfbe1820843d4d5ba5145af20e2da0d6dade0))

## [1.3.0](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.2.2...v1.3.0) (2025-06-25)


### Features

* display CLI version on startup and reformat arguments ([7bdff4c](https://github.com/nguyenvanduocit/socketrpc-gen/commit/7bdff4c656c329e86a262abc9651b67fe3693b63))

## [1.2.2](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.2.1...v1.2.2) (2025-06-24)


### Bug Fixes

* remove 'undefined' from argsString in client and server function AST generation for cleaner output ([dd65553](https://github.com/nguyenvanduocit/socketrpc-gen/commit/dd65553fe1e65b2e549f2227c31a34208f3c465c))

## [1.2.1](https://github.com/nguyenvanduocit/socketrpc-gen/compare/v1.2.0...v1.2.1) (2025-06-24)


### Bug Fixes

* error when create tsconfig file ([23649d2](https://github.com/nguyenvanduocit/socketrpc-gen/commit/23649d2460bd825cd5065bd82e15d93b24f14211))

## [1.2.0](https://github.com/nguyenvanduocit/socket-rpc-template/compare/v1.1.0...v1.2.0) (2025-06-24)


### Features

* improve RpcError handling with enhanced validation and error messaging ([961712f](https://github.com/nguyenvanduocit/socket-rpc-template/commit/961712f21bffa8097ed1f67576b07e402a03a00c))
* update generated file names and enhance error handling in RPC package ([e9261e9](https://github.com/nguyenvanduocit/socket-rpc-template/commit/e9261e938d443aee4d49944670c82af9f2adddd6))

## [1.1.0](https://github.com/nguyenvanduocit/socket-rpc-template/compare/v1.0.0...v1.1.0) (2025-06-24)


### Features

* add RpcError handling and types for RPC package ([a5e5529](https://github.com/nguyenvanduocit/socket-rpc-template/commit/a5e5529fc11a1574f7d9558c6d92dd94da3b5cb1))
* enhance RpcError interface with additional properties and update type guard ([3582c66](https://github.com/nguyenvanduocit/socket-rpc-template/commit/3582c66749ba223686ec5dbecd5c12113641cc6e))

## 1.0.0 (2025-06-24)


### Features

* init ([a23c789](https://github.com/nguyenvanduocit/socket-rpc-template/commit/a23c789ea016fa9294b92a3fe5a68d3723dd8abb))
* init ([2e40902](https://github.com/nguyenvanduocit/socket-rpc-template/commit/2e40902a044f807545aea69c55c0535eba695f9a))
* migrate RPC generator to use ts-morph ([42f6d1c](https://github.com/nguyenvanduocit/socket-rpc-template/commit/42f6d1ca187bf6809924e0f393385eec3185931e))
