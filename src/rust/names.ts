/**
 * Rust spellings of contract names.
 *
 * Types and enum variants are UpperCamelCase with acronyms folded (`HTTPServer`
 * → `HttpServer`), fields, parameters and methods snake_case, as rustc's own
 * `non_camel_case_types` / `non_snake_case` lints expect. A derivation never
 * produces `__` or a leading `_`, which keeps every generated local out of a
 * contract's reach (see `emitter.ts`).
 */

/** Strict and reserved keywords, which need the `r#` prefix as identifiers. */
const RUST_KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for",
  "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
  "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use",
  "where", "while", "async", "await", "dyn", "abstract", "become", "box", "do", "final",
  "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen",
]);

/** Keywords a raw identifier cannot spell: `r#self` is a compile error. */
const NON_RAW_KEYWORDS = new Set(["crate", "self", "super", "Self"]);

/** The method prefixes that put a contract method out of reach of the API's own methods. */
export const HANDLER_METHOD_PREFIX = "handle_";
export const CALL_METHOD_PREFIX = "call_";

function identifierWords(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((part) => part.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?[\p{Ll}\p{N}]+|\p{Lu}/gu) ?? [part]);
}

/** UpperCamelCase, or "" when the name holds no letter or digit. */
export function rustTypeName(value: string): string {
  return identifierWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/** snake_case without keyword escaping, or "" when the name holds no letter or digit. */
export function snakeCase(value: string): string {
  return identifierWords(value)
    .map((word) => word.toLowerCase())
    .join("_");
}

/**
 * A snake_case name as it can appear in source: keywords become raw
 * identifiers, and the four keywords a raw identifier cannot spell take a
 * trailing underscore.
 */
export function rustValueIdentifier(value: string): string {
  const snake = snakeCase(value);
  if (NON_RAW_KEYWORDS.has(snake)) return `${snake}_`;
  if (RUST_KEYWORDS.has(snake)) return `r#${snake}`;
  return snake;
}

/** A Rust identifier that can start an item name: letter first, then letters, digits, `_`. */
export function isRustIdentifier(value: string): boolean {
  return /^(r#)?[A-Za-z][A-Za-z0-9_]*$/.test(value) && !NON_RAW_KEYWORDS.has(value);
}

export function isRustKeyword(value: string): boolean {
  return RUST_KEYWORDS.has(value);
}

export function handlerMethodName(wireName: string): string {
  return `${HANDLER_METHOD_PREFIX}${snakeCase(wireName)}`;
}

export function callMethodName(wireName: string): string {
  return `${CALL_METHOD_PREFIX}${snakeCase(wireName)}`;
}
