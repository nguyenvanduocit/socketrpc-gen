/**
 * Projection of the canonical `RpcSchema` IR onto Go's type system.
 *
 * Both passes of the backend go through here so they cannot disagree:
 * `validate.ts` refuses every shape `renderGoType` would not know how to write,
 * and `emitter.ts` writes only shapes that survived validation.
 */

import type { ArrayTypeRef, MapTypeRef, RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "../schema";
import { exportedIdentifier } from "./names";

/** The declarations an emptiness question has to be resolved against. */
export type DeclarationScope = ReadonlyMap<string, TypeDeclaration>;

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
  // `any` is already the Go value that can be nil, so a pointer to one would add
  // a second, meaningless way to spell the absence the JSON value itself carries.
  return nilable && core.kind !== "json" ? `*${rendered}` : rendered;
}

function renderCoreGoType(ref: TypeRef): string {
  switch (ref.kind) {
    case "json":
      return "any";
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
 * Follows named aliases down to the slice or map they ultimately spell.
 *
 * `type Tags = string[]` is a Go alias, so a value typed `Tags` *is* a slice and
 * its zero value is the same nil a bare `[]string` has. Emptiness therefore has
 * to be decided on the resolved type, not on the syntactic one. A nilable hop
 * ends the walk: once the contract admits null, nil is a legitimate value and
 * must be left alone.
 */
function resolveComposite(
  ref: TypeRef,
  declarations: DeclarationScope,
  seen: ReadonlySet<string> = new Set(),
): ArrayTypeRef | MapTypeRef | undefined {
  if (ref.kind === "array" || ref.kind === "map") return ref;
  if (ref.kind !== "named" || seen.has(ref.name)) return undefined;

  const declaration = declarations.get(ref.name);
  if (declaration?.kind !== "alias") return undefined;

  const { core, nilable } = unwrapOptionality(declaration.target);
  if (nilable) return undefined;
  return resolveComposite(core, declarations, new Set([...seen, ref.name]));
}

/**
 * The empty literal for a value whose Go zero value is nil but whose contract
 * promises a slice or a map.
 *
 * Go's zero slice and map are nil, and `encoding/json` writes nil as `null`. A
 * contract that declares `() => string[]` would then deliver `null` to a client
 * whose generated type says `string[]` — the generator would be emitting a
 * type-safe client and a server able to violate it. The same holds one level in:
 * a required `tags: string[]` field of a returned struct is nil in a zero value
 * and would serialize as null.
 *
 * Returns undefined when nil is a legitimate value (an optional or nullable
 * declaration) or when the Go zero value already encodes correctly.
 */
export function emptyCompositeLiteral(
  ref: TypeRef,
  declarations: DeclarationScope,
): string | undefined {
  const { core, nilable } = unwrapOptionality(ref);
  if (nilable) return undefined;
  const resolved = resolveComposite(core, declarations);
  if (!resolved) return undefined;
  return `${renderGoType(resolved)}{}`;
}

/** A method's Go result type, or undefined when it is fire-and-forget. */
export function resultGoType(method: RpcMethod): string | undefined {
  return method.returnType.kind === "void" ? undefined : renderGoType(method.returnType);
}

export function declarationsByName(schema: RpcSchema): Map<string, TypeDeclaration> {
  return new Map(schema.declarations.map((declaration) => [declaration.name, declaration]));
}
