/**
 * Projection of the canonical `RpcSchema` IR onto Rust's type system.
 *
 * Both passes of the backend go through here so they cannot disagree:
 * `validate.ts` refuses every shape these functions would not know how to
 * write, and the emitters write only shapes that survived validation.
 */

import type { ObjectField, RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "../schema";
import { rustTypeName } from "./names";

export type DeclarationScope = ReadonlyMap<string, TypeDeclaration>;

export function declarationsByName(schema: RpcSchema): Map<string, TypeDeclaration> {
  return new Map(schema.declarations.map((declaration) => [declaration.name, declaration]));
}

export interface UnwrappedType {
  /** The value type with every absence modifier stripped. */
  readonly core: TypeRef;
  /** The key may be missing entirely. */
  readonly optional: boolean;
  /** The value may be an explicit null. */
  readonly nullable: boolean;
}

/**
 * Rust keeps "absent" and "null" apart where the IR does: `Option<T>` for
 * either, and `Option<Option<T>>` for a field that may be both, so a handler can
 * tell an omitted key from an explicit null.
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
  return { core, optional, nullable };
}

/**
 * Variant name for a string-literal member: UpperCamelCase, with a `V` in front
 * when the literal starts with a digit (`"1st"` → `V1st`). "" when the literal
 * holds no letter or digit at all.
 */
export function enumVariantName(value: string): string {
  const name = rustTypeName(value);
  return /^[0-9]/.test(name) ? `V${name}` : name;
}

export const JSON_VALUE = "::serde_json::Value";

function renderCore(core: TypeRef): string {
  switch (core.kind) {
    case "scalar":
      return core.name === "string" ? "String" : core.name === "number" ? "f64" : "bool";
    case "json":
      return JSON_VALUE;
    case "named":
      return rustTypeName(core.name);
    case "array":
      return `Vec<${renderRustType(core.element)}>`;
    case "map":
      return `::std::collections::HashMap<String, ${renderRustType(core.value)}>`;
    default:
      throw new Error(`renderRustType: unvalidated type kind ${core.kind}`);
  }
}

/**
 * The owned Rust type of a validated reference. `boxed` wraps the core in a
 * `Box`, which a recursive field needs (`boxedFields`).
 */
export function renderRustType(ref: TypeRef, boxed = false): string {
  const { core, optional, nullable } = unwrapOptionality(ref);
  let rendered = renderCore(core);
  if (boxed) rendered = `Box<${rendered}>`;
  // A JSON value already holds null, so only a missing key adds an Option.
  if (core.kind === "json") return optional ? `Option<${rendered}>` : rendered;
  if (optional && nullable) return `Option<Option<${rendered}>>`;
  if (optional || nullable) return `Option<${rendered}>`;
  return rendered;
}

/** Whether a named type is a string enum, which the generated code derives `Copy` for. */
function isCopyNamed(name: string, declarations: DeclarationScope): boolean {
  return declarations.get(name)?.kind === "enum";
}

/**
 * The type a generated `call_*` method takes a parameter as: borrowed where
 * the owned type would force the caller to give up or clone a value it only
 * lends for serialization (`&str`, `&[T]`, `&T`), by value where it is `Copy`.
 */
export function renderParamType(ref: TypeRef, declarations: DeclarationScope): string {
  const { core, nullable } = unwrapOptionality(ref);
  const borrowed = ((): string => {
    switch (core.kind) {
      case "scalar":
        return core.name === "string" ? "&str" : core.name === "number" ? "f64" : "bool";
      case "named":
        return isCopyNamed(core.name, declarations) ? rustTypeName(core.name) : `&${rustTypeName(core.name)}`;
      case "array":
        return `&[${renderRustType(core.element)}]`;
      default:
        return `&${renderCore(core)}`;
    }
  })();
  if (core.kind === "json") return borrowed;
  return nullable ? `Option<${borrowed}>` : borrowed;
}

/** The named type a reference embeds by value: through absence modifiers, never through Vec or HashMap. */
function byValueDependency(ref: TypeRef): string | undefined {
  const { core } = unwrapOptionality(ref);
  return core.kind === "named" ? core.name : undefined;
}

/** The named types a declaration embeds by value. */
function byValueEdges(declaration: TypeDeclaration): string[] {
  switch (declaration.kind) {
    case "object":
      return declaration.fields.flatMap((field) => byValueDependency(field.type) ?? []);
    case "alias":
      return byValueDependency(declaration.target) ? [byValueDependency(declaration.target) as string] : [];
    case "enum":
      return [];
  }
}

function reaches(from: string, target: string, declarations: DeclarationScope): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (name === target) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const declaration = declarations.get(name);
    if (declaration) stack.push(...byValueEdges(declaration));
  }
  return false;
}

/**
 * Whether `field` of object `owner` is spelled `Option<Box<T>>`.
 *
 * `Option<T>` is no indirection in Rust — it stores `T` inline — so a struct
 * reaching itself through optional fields alone has no finite size. Every
 * optional or nullable field whose object type leads back to its owner by value
 * is boxed; a cycle with no such field anywhere is refused by validation.
 */
export function isBoxedField(owner: string, field: ObjectField, declarations: DeclarationScope): boolean {
  const { core, optional, nullable } = unwrapOptionality(field.type);
  if (!(optional || nullable) || core.kind !== "named") return false;
  if (declarations.get(core.name)?.kind !== "object") return false;
  return reaches(core.name, owner, declarations);
}

/**
 * A by-value cycle with no boxed hop, as the trail of declaration names it
 * runs through, or undefined when every cycle has one.
 */
export function unboxedCycle(declarations: DeclarationScope): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const unboxedEdges = (name: string): string[] => {
    const declaration = declarations.get(name);
    if (!declaration) return [];
    if (declaration.kind !== "object") return byValueEdges(declaration);
    return declaration.fields
      .filter((field) => !isBoxedField(name, field, declarations))
      .flatMap((field) => byValueDependency(field.type) ?? []);
  };

  const visit = (name: string, trail: readonly string[]): string[] | undefined => {
    if (visiting.has(name)) return [...trail, name];
    if (visited.has(name)) return undefined;
    visiting.add(name);
    for (const next of unboxedEdges(name)) {
      const cycle = visit(next, [...trail, name]);
      if (cycle) return cycle;
    }
    visiting.delete(name);
    visited.add(name);
    return undefined;
  };

  for (const name of declarations.keys()) {
    const cycle = visit(name, []);
    if (cycle) return cycle;
  }
  return undefined;
}

export function inboundMethods(schema: RpcSchema): RpcMethod[] {
  return schema.methods.filter((method) => method.direction === "client-to-server");
}

export function outboundMethods(schema: RpcSchema): RpcMethod[] {
  return schema.methods.filter((method) => method.direction === "server-to-client");
}

/** A method's Rust result type: `()` for fire-and-forget. */
export function resultRustType(method: RpcMethod): string {
  return method.returnType.kind === "void" ? "()" : renderRustType(method.returnType);
}

/** Every declaration name a set of type references mentions, in first-mention order. */
export function referencedDeclarations(refs: readonly TypeRef[], declarations: DeclarationScope): string[] {
  const names: string[] = [];
  const walk = (ref: TypeRef): void => {
    switch (ref.kind) {
      case "optional":
      case "nullable":
        walk(ref.type);
        return;
      case "array":
        walk(ref.element);
        return;
      case "map":
        walk(ref.value);
        return;
      case "named":
        if (declarations.has(ref.name) && !names.includes(ref.name)) names.push(ref.name);
        return;
      default:
        return;
    }
  };
  refs.forEach(walk);
  return names;
}
