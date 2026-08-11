/**
 * Deliberately small, language-neutral input accepted by the isolated Go emitter.
 * The shared SocketRPC schema can be projected into this shape during integration.
 */

export type GoScalar = "string" | "boolean" | "number" | "integer";

export type GoTypeRef =
  | { readonly kind: "scalar"; readonly name: GoScalar }
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "array"; readonly element: GoTypeRef }
  | { readonly kind: "map"; readonly value: GoTypeRef }
  | { readonly kind: "nullable"; readonly value: GoTypeRef };

export interface GoObjectField {
  /** JSON field name on the wire. */
  readonly name: string;
  /** Optional explicit exported Go identifier. Defaults to a derived identifier. */
  readonly goName?: string;
  readonly type: GoTypeRef;
  /** Missing and null both decode to nil. Cannot be combined with nullable. */
  readonly optional?: boolean;
}

export interface GoObjectDeclaration {
  readonly kind: "object";
  /** Exported Go type identifier. */
  readonly name: string;
  readonly fields: readonly GoObjectField[];
}

export interface GoEnumDeclaration {
  readonly kind: "enum";
  /** Exported Go type identifier. */
  readonly name: string;
  /** String literals accepted on the wire. */
  readonly values: readonly string[];
}

export type GoTypeDeclaration = GoObjectDeclaration | GoEnumDeclaration;

export interface GoMethodParameter {
  /** Parameter name used for diagnostics and the generated local identifier. */
  readonly name: string;
  readonly goName?: string;
  readonly type: GoTypeRef;
  /**
   * Optional positional arguments are intentionally rejected by this backend:
   * an omitted final argument is indistinguishable from a Socket.IO ack callback.
   */
  readonly optional?: boolean;
}

export interface GoRpcMethod {
  /** Socket.IO event name. */
  readonly name: string;
  /** Optional exported Go method identifier. Defaults to a derived identifier. */
  readonly goName?: string;
  readonly params: readonly GoMethodParameter[];
  /** Omit for a void, fire-and-forget RPC. */
  readonly result?: GoTypeRef;
}

export interface GoEmitterSchema {
  readonly packageName: string;
  readonly declarations: readonly GoTypeDeclaration[];
  /** Calls emitted by the TypeScript client and handled by the generated Go server. */
  readonly clientToServer: readonly GoRpcMethod[];
  /** Calls made by the generated per-socket Go Client and handled by TypeScript. */
  readonly serverToClient: readonly GoRpcMethod[];
}

export interface GoEmitterOptions {
  /** Import used for the concrete Socket.IO server socket. */
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

export const DEFAULT_GO_SOCKET_IMPORT =
  "github.com/zishang520/socket.io/servers/socket/v3";
