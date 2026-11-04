/**
 * Knobs for the Go backend.
 *
 * The contract itself is the canonical `RpcSchema` IR in `src/schema.ts`; this
 * module only carries the things Go needs that a language-neutral contract
 * cannot express — package clauses, transport imports, and a default ack
 * timeout.
 */

/**
 * Where the Go client lives relative to the types package.
 *
 * Absent, the client shares the types package and spells contract types
 * unqualified. Present, the client is its own package importing the types
 * package, so a Go server and a Go client generated from one contract share one
 * set of types. A separate package cannot be described without the import path
 * it reaches the types through, so the two travel together.
 */
export interface GoClientPackage {
  /** Go package clause of the client file. */
  readonly packageName: string;
  /** Import path of the types package (`--go-out`), derived from its go.mod. */
  readonly typesImport: string;
}

export interface GoClientOptions {
  /** Import path of the Socket.IO client socket package. */
  readonly socketImport?: string;
  /** Set when the client is generated into its own package. */
  readonly separate?: GoClientPackage;
}

export interface GoBackendOptions {
  /** Go package clause of the types package, and of the server written into it. */
  readonly packageName?: string;
  /** Import path of the Socket.IO server socket package. */
  readonly socketImport?: string;
  /** Default acknowledgement timeout in milliseconds, for both Go callers. */
  readonly defaultTimeoutMs?: number;
  /** Options only the Go client reads. */
  readonly client?: GoClientOptions;
}

export const GO_TYPES_FILENAME = "types.generated.go" as const;
export const GO_SERVER_FILENAME = "server.generated.go" as const;
export const GO_CLIENT_FILENAME = "client.generated.go" as const;

export type GeneratedGoFiles = Readonly<{
  [GO_TYPES_FILENAME]: string;
  [GO_SERVER_FILENAME]: string;
}>;

/**
 * The Go client's output. The types file is present only when the client
 * shares the types package; a separate client imports the one the server's
 * generation wrote.
 */
export type GeneratedGoClientFiles = Readonly<{
  [GO_CLIENT_FILENAME]: string;
  [GO_TYPES_FILENAME]?: string;
}>;

/** The Socket.IO server implementation the generated bindings are written against. */
export const DEFAULT_GO_SOCKET_IMPORT = "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket";

/** The Socket.IO client implementation the generated client is written against. */
export const DEFAULT_GO_CLIENT_SOCKET_IMPORT =
  "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket";

export const DEFAULT_GO_PACKAGE_NAME = "rpc";

export const DEFAULT_GO_TIMEOUT_MS = 5_000;

export interface ResolvedGoClientOptions {
  readonly socketImport: string;
  readonly separate: GoClientPackage | undefined;
}

export interface ResolvedGoBackendOptions {
  readonly packageName: string;
  readonly socketImport: string;
  readonly defaultTimeoutMs: number;
  readonly client: ResolvedGoClientOptions;
}

export function resolveGoBackendOptions(options: GoBackendOptions = {}): ResolvedGoBackendOptions {
  return {
    packageName: options.packageName ?? DEFAULT_GO_PACKAGE_NAME,
    socketImport: options.socketImport ?? DEFAULT_GO_SOCKET_IMPORT,
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_GO_TIMEOUT_MS,
    client: {
      socketImport: options.client?.socketImport ?? DEFAULT_GO_CLIENT_SOCKET_IMPORT,
      separate: options.client?.separate,
    },
  };
}
