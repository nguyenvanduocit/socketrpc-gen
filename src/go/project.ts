/**
 * Projection of the canonical `RpcSchema` IR onto Go's type system.
 *
 * Both passes of the backend go through here so they cannot disagree:
 * `validate.ts` refuses every shape `renderGoType` would not know how to write,
 * and `emitter.ts` writes only shapes that survived validation.
 */

import type { RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "../schema";
import { exportedIdentifier } from "./names";

/** Go identifier for an IR declaration name. */
export function goTypeName(name: string): string {
  return exportedIdentifier(name);
}

export interface UnwrappedType {
  /** The value type with every absence modifier stripped. */
  readonly core: TypeRef;
  /** True when the value may arrive absent or null — both decode to nil. */
  readonly nilable: boolean;
  /** True when the key may be missing entirely, which drives `,omitempty`. */
  readonly optional: boolean;
}

/**
 * Go spells "absent" and "null" with the same nil, so the IR's `optional` and
 * `nullable` modifiers collapse into a single pointer. Only `optional` reaches
 * the JSON tag, because omitting a key and writing null are still distinct on
 * the wire even though Go decodes both to nil.
 */
export function unwrapOptionality(ref: TypeRef): UnwrappedType {
  let core = ref;
  let optional = false;
  let nullable = false;
  while (core.kind === "optional" || core.kind === "nullable") {
    if (core.kind === "optional") optional = true;
    else nullable = true;
    core = core.type;
  }
  return { core, nilable: optional || nullable, optional };
}

/**
 * Renders a validated type reference. Unvalidated kinds throw rather than
 * guessing, so a gap between the two passes surfaces as a crash in tests
 * instead of as malformed Go.
 */
export function renderGoType(ref: TypeRef): string {
  const { core, nilable } = unwrapOptionality(ref);
  const rendered = renderCoreGoType(core);
  return nilable ? `*${rendered}` : rendered;
}

function renderCoreGoType(ref: TypeRef): string {
  switch (ref.kind) {
    case "scalar":
      switch (ref.name) {
        case "string":
          return "string";
        case "number":
          return "float64";
        case "boolean":
          return "bool";
      }
    // falls through for an unknown scalar, which validation rejects first
    case "named":
      return goTypeName(ref.name);
    case "array":
      return `[]${renderGoType(ref.element)}`;
    case "map":
      return `map[string]${renderGoType(ref.value)}`;
    default:
      throw new Error(
        `Internal error: type kind '${ref.kind}' reached the Go emitter without validation.`,
      );
  }
}

/** Methods the TypeScript client calls; the generated Go server handles them. */
export function inboundMethods(schema: RpcSchema): RpcMethod[] {
  return schema.methods.filter((method) => method.direction === "client-to-server");
}

/** Methods the generated Go server calls; the TypeScript client handles them. */
export function outboundMethods(schema: RpcSchema): RpcMethod[] {
  return schema.methods.filter((method) => method.direction === "server-to-client");
}

/**
 * The empty literal for a result whose Go zero value is nil but whose contract
 * promises a value.
 *
 * Go's zero slice and map are nil, and `encoding/json` writes nil as `null`. A
 * contract that declares `() => string[]` would then deliver `null` to a client
 * whose generated type says `string[]` — the generator would be emitting a
 * type-safe client and a server able to violate it. Returns undefined when nil
 * is a legitimate value (an optional or nullable result) or when the Go zero
 * value already encodes correctly.
 */
export function emptyResultLiteral(ref: TypeRef): string | undefined {
  const { core, nilable } = unwrapOptionality(ref);
  if (nilable) return undefined;
  if (core.kind !== "array" && core.kind !== "map") return undefined;
  return `${renderGoType(core)}{}`;
}

/** A method's Go result type, or undefined when it is fire-and-forget. */
export function resultGoType(method: RpcMethod): string | undefined {
  return method.returnType.kind === "void" ? undefined : renderGoType(method.returnType);
}

export function declarationsByName(schema: RpcSchema): Map<string, TypeDeclaration> {
  return new Map(schema.declarations.map((declaration) => [declaration.name, declaration]));
}
