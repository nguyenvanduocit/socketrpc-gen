/**
 * Knobs for the Rust backend. The contract itself is the canonical `RpcSchema`
 * IR; this module only carries what Rust needs beyond it.
 *
 * The generated module is a directory (`--rust-out`) holding `mod.rs`,
 * `types.rs` and one file per Rust side, so a crate mounts it with a single
 * `mod rpc;`. Both sides can share the directory because each is its own
 * module: unlike Go, two sides never declare the same runtime in one scope.
 */

export const RUST_MOD_FILENAME = "mod.rs" as const;
export const RUST_TYPES_FILENAME = "types.rs" as const;
export const RUST_SERVER_FILENAME = "server.rs" as const;
export const RUST_CLIENT_FILENAME = "client.rs" as const;

export const DEFAULT_RUST_TIMEOUT_MS = 5_000;

/** Crate the generated client is written against: `rust/socketio-client` in this repository. */
export const RUST_CLIENT_CRATE = "socketrpc_socketio_client";

export interface RustBackendOptions {
  /** Default acknowledgement timeout in milliseconds, for both Rust callers. */
  readonly defaultTimeoutMs?: number;
  /** Emit `server.rs` (socketioxide). */
  readonly server?: boolean;
  /** Emit `client.rs` (socketrpc-socketio-client). */
  readonly client?: boolean;
}

export interface ResolvedRustBackendOptions {
  readonly defaultTimeoutMs: number;
  readonly server: boolean;
  readonly client: boolean;
}

export type GeneratedRustFiles = Readonly<Record<string, string>>;

export function resolveRustBackendOptions(options: RustBackendOptions = {}): ResolvedRustBackendOptions {
  return {
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_RUST_TIMEOUT_MS,
    server: options.server ?? false,
    client: options.client ?? false,
  };
}
