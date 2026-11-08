/**
 * Language-neutral representation of the RPC contract.
 *
 * The schema deliberately models only data that can cross the Socket.IO wire.
 * Backend-specific emitters may project these nodes into their own type systems.
 */

export const RPC_SCHEMA_VERSION = 1 as const;

/**
 * `integer` is a JSON number that is always whole: a `number` alias marked
 * `/** @int *\/`. TypeScript still spells it `number`; typed backends spell it
 * as a 64-bit integer and refuse a fractional value.
 */
export type ScalarTypeName = "string" | "number" | "integer" | "boolean";

export interface ScalarTypeRef {
  kind: "scalar";
  name: ScalarTypeName;
}

export interface VoidTypeRef {
  kind: "void";
}

/** The literal `null` type, as opposed to a nullable value type. */
export interface NullTypeRef {
  kind: "null";
}

/**
 * Any value the JSON data model can express: object, array, string, number,
 * boolean, or null.
 *
 * This is a declared shape, not an escape hatch. It says the contract carries
 * data whose structure the contract does not fix — a document's frontmatter, a
 * patch value — and it says so in a form every backend can project onto its own
 * "some JSON" type. Because the JSON data model contains null, a JSON value is
 * already nullable; `nullableType` below collapses the redundant wrapper.
 */
export interface JsonTypeRef {
  kind: "json";
}

export interface NamedTypeRef {
  kind: "named";
  name: string;
}

export interface ArrayTypeRef {
  kind: "array";
  element: TypeRef;
}

/** A JSON object with arbitrary string keys and homogeneous values. */
export interface MapTypeRef {
  kind: "map";
  value: TypeRef;
}

/** A value that may be omitted / `undefined` at the TypeScript boundary. */
export interface OptionalTypeRef {
  kind: "optional";
  type: TypeRef;
}

/** A value that may explicitly be `null` on the wire. */
export interface NullableTypeRef {
  kind: "nullable";
  type: TypeRef;
}

/** One or more allowed string literal values. */
export interface StringEnumTypeRef {
  kind: "enum";
  values: string[];
}

export interface ObjectField {
  name: string;
  type: TypeRef;
}

export interface ObjectTypeRef {
  kind: "object";
  fields: ObjectField[];
}

/** One member of a discriminated union: the tag literal it carries, and its other fields. */
export interface UnionVariant {
  /** The tag property's string literal in this member. */
  tag: string;
  /** Every property except the tag. */
  fields: ObjectField[];
}

/**
 * A union of object types told apart by one shared property (`tag`) whose type
 * in every member is a distinct string literal: on the wire, an object carrying
 * `tag` beside the fields of the member it names.
 */
export interface DiscriminatedUnionTypeRef {
  kind: "union";
  tag: string;
  variants: UnionVariant[];
}

export type TypeRef =
  | ScalarTypeRef
  | VoidTypeRef
  | NullTypeRef
  | JsonTypeRef
  | NamedTypeRef
  | ArrayTypeRef
  | MapTypeRef
  | OptionalTypeRef
  | NullableTypeRef
  | StringEnumTypeRef
  | ObjectTypeRef
  | DiscriminatedUnionTypeRef;

export interface ObjectTypeDeclaration {
  kind: "object";
  name: string;
  fields: ObjectField[];
}

export interface StringEnumTypeDeclaration {
  kind: "enum";
  name: string;
  values: string[];
}

export interface DiscriminatedUnionTypeDeclaration {
  kind: "union";
  name: string;
  tag: string;
  variants: UnionVariant[];
}

/** A named alias whose target is not itself an object, string enum, or discriminated union. */
export interface AliasTypeDeclaration {
  kind: "alias";
  name: string;
  target: TypeRef;
}

export type TypeDeclaration =
  | ObjectTypeDeclaration
  | StringEnumTypeDeclaration
  | DiscriminatedUnionTypeDeclaration
  | AliasTypeDeclaration;

/** The side that initiates a method call. */
export type RpcDirection = "client-to-server" | "server-to-client";

export interface RpcParameter {
  name: string;
  type: TypeRef;
}

export interface RpcMethod {
  name: string;
  direction: RpcDirection;
  params: RpcParameter[];
  returnType: TypeRef;
}

export interface RpcSchema {
  version: typeof RPC_SCHEMA_VERSION;
  methods: RpcMethod[];
  declarations: TypeDeclaration[];
}

export interface SchemaDiagnosticLocation {
  file: string;
  line: number;
  column: number;
  /** Logical path such as `client-to-server.save.params.value`. */
  path: string;
}

export interface SchemaDiagnostic {
  code: string;
  message: string;
  typeText: string;
  location: SchemaDiagnosticLocation;
}

/**
 * Raised when a TypeScript contract cannot be represented by the portable IR.
 * All diagnostics found during the parse are retained for programmatic callers.
 */
export class SchemaExtractionError extends Error {
  readonly diagnostics: SchemaDiagnostic[];

  constructor(diagnostics: SchemaDiagnostic[]) {
    const detail = diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.code} at ${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column} (${diagnostic.location.path}): ${diagnostic.message}`,
      )
      .join("\n");
    super(`SocketRPC schema extraction failed:\n${detail}`);
    this.name = "SchemaExtractionError";
    this.diagnostics = diagnostics;
  }
}

export function optionalType(type: TypeRef): TypeRef {
  return type.kind === "optional" ? type : { kind: "optional", type };
}

export function nullableType(type: TypeRef): TypeRef {
  // A JSON value already admits null, so wrapping one says nothing new and
  // would force every backend to spell the same nullability twice.
  return type.kind === "nullable" || type.kind === "null" || type.kind === "json"
    ? type
    : { kind: "nullable", type };
}
