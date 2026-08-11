const GO_KEYWORDS = new Set([
  "break",
  "default",
  "func",
  "interface",
  "select",
  "case",
  "defer",
  "go",
  "map",
  "struct",
  "chan",
  "else",
  "goto",
  "package",
  "switch",
  "const",
  "fallthrough",
  "if",
  "range",
  "type",
  "continue",
  "for",
  "import",
  "return",
  "var",
]);

export function isGoIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !GO_KEYWORDS.has(value);
}

export function isExportedGoIdentifier(value: string): boolean {
  return isGoIdentifier(value) && /^[A-Z]/.test(value);
}

// Words Go spells in full caps. Matching golint's list keeps generated
// identifiers indistinguishable from hand-written Go, which is why the schema
// carries no per-name override channel: the derivation is good enough on its own.
const GO_INITIALISMS = new Set([
  "acl", "api", "ascii", "cpu", "css", "dns", "eof", "guid", "html", "http",
  "https", "id", "ip", "json", "lhs", "qps", "ram", "rhs", "rpc", "sla", "smtp",
  "sql", "ssh", "tcp", "tls", "ttl", "udp", "ui", "uid", "uuid", "uri", "url",
  "utf8", "vm", "xml", "xmpp", "xsrf", "xss",
]);

/**
 * Splits an arbitrary wire name into words, honouring both separators
 * (`pending-review`) and camel-case humps (`displayName`, `userID`).
 */
function identifierWords(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((part) => part.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?[\p{Ll}\p{N}]+|\p{Lu}/gu) ?? [part]);
}

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (GO_INITIALISMS.has(lower)) return lower.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function exportedIdentifier(value: string): string {
  return identifierWords(value).map(capitalizeWord).join("");
}

export function localIdentifier(value: string): string {
  const words = identifierWords(value);
  const [first, ...rest] = words;
  if (!first) return "";
  // Go spells a leading initialism in full lower case (`id`, `url`, `apiKey`),
  // so the first word is lowered whole rather than only at its first character.
  return [first.toLowerCase(), ...rest.map(capitalizeWord)].join("");
}

/**
 * Prefix for every identifier the emitter declares in a scope that also holds
 * an identifier derived from the contract.
 *
 * `identifierWords` splits on every non-alphanumeric rune, so no name derived
 * from a wire identifier can contain an underscore — `exportedIdentifier` and
 * `localIdentifier` are incapable of producing one. Spelling the emitter's own
 * identifiers with a leading underscore-bearing prefix therefore keeps the two
 * namespaces disjoint *by construction*, rather than by a reserved-word list
 * that has to be kept in step with the emitter by hand.
 *
 * "Scope" includes a *type's member namespace*: `ServerBinding` carries one
 * member per contract method, so every member the emitter adds to that type is
 * prefixed too. The one namespace this cannot reach is the method set
 * `encoding/json` dictates — see `STRUCT_METHODS` in the emitter for how a
 * field named after the marshaller is served instead of refused.
 *
 * `tests/go-collisions.test.ts` pins both halves: the property this rests on,
 * and the emitter's own output fed back through every channel a contract owns.
 */
export const GENERATED_PREFIX = "rpc_";

/** Spells an emitter-owned identifier in the reserved namespace. */
export function generated(name: string): string {
  return `${GENERATED_PREFIX}${name}`;
}

/**
 * Prefixes the contract's own methods carry in the generated Go API.
 *
 * `go vet`'s `stdmethods` analyzer objects to any method *named* like one the
 * standard library gives a fixed signature — `MarshalJSON`, `Scan`, `Seek`,
 * `WriteTo` and the rest — whoever declared it and whatever it means. A contract
 * is free to call an RPC method `scan` or `marshalJSON`, so an unprefixed name
 * reaches `ServerHandler` and `Client` verbatim and the generated package stops
 * vetting.
 *
 * A prefix closes that class by construction rather than by a list that would
 * have to track the standard library release by release. `exportedIdentifier`
 * splits on every non-alphanumeric rune, so a contract-derived name is always
 * `[A-Za-z0-9]+`, and validation admits a method only when that name is an
 * exported Go identifier — leaving `[A-Z][A-Za-z0-9]*`. Every generated method
 * is therefore `Handle` or `Call` followed by an upper-case letter, while every
 * canonical method name is a bare standard-library verb. The two shapes cannot
 * meet, so no wire name can produce a canonical one.
 *
 * `tests/go-collisions.test.ts` pins the whole `stdmethods` family against the
 * shape, and vets every channel of the emitter's output with no exclusions.
 */
export const HANDLER_METHOD_PREFIX = "Handle";
export const CLIENT_METHOD_PREFIX = "Call";

/** The `ServerHandler` method a client-to-server contract method is implemented as. */
export function handlerMethodName(wireName: string): string {
  return `${HANDLER_METHOD_PREFIX}${exportedIdentifier(wireName)}`;
}

/** The `Client` method a server-to-client contract method is called through. */
export function clientMethodName(wireName: string): string {
  return `${CLIENT_METHOD_PREFIX}${exportedIdentifier(wireName)}`;
}

export function goString(value: string): string {
  return JSON.stringify(value);
}

export function padGoColumn(value: string, width: number): string {
  return `${value}${" ".repeat(width - value.length + 1)}`;
}
