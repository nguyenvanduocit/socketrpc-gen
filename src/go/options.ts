/**
 * Knobs for the Go backend.
 *
 * The contract itself is the canonical `RpcSchema` IR in `src/schema.ts`; this
 * module only carries the things Go needs that a language-neutral contract
 * cannot express — a package clause, a transport import, and a default ack
 * timeout.
 */

export interface GoBackendOptions {
  /** Go package clause written into both generated files. */
  readonly packageName?: string;
  /** Import path of the Socket.IO server socket package. */
  readonly socketImport?: string;
  /** Default server-to-client acknowledgement timeout in milliseconds. */
  readonly defaultTimeoutMs?: number;
}

export const GO_TYPES_FILENAME = "types.generated.go" as const;
export const GO_SERVER_FILENAME = "server.generated.go" as const;

export type GeneratedGoFiles = Readonly<{
  [GO_TYPES_FILENAME]: string;
  [GO_SERVER_FILENAME]: string;
}>;

/** The Socket.IO server implementation the generated bindings are written against. */
export const DEFAULT_GO_SOCKET_IMPORT = "github.com/zishang520/socket.io/servers/socket/v3";

export const DEFAULT_GO_PACKAGE_NAME = "rpc";

export const DEFAULT_GO_TIMEOUT_MS = 5_000;

export interface ResolvedGoBackendOptions {
  readonly packageName: string;
  readonly socketImport: string;
  readonly defaultTimeoutMs: number;
}

export function resolveGoBackendOptions(options: GoBackendOptions = {}): ResolvedGoBackendOptions {
  return {
    packageName: options.packageName ?? DEFAULT_GO_PACKAGE_NAME,
    socketImport: options.socketImport ?? DEFAULT_GO_SOCKET_IMPORT,
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_GO_TIMEOUT_MS,
  };
}
