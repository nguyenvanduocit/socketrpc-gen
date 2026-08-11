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

export function goString(value: string): string {
  return JSON.stringify(value);
}

export function padGoColumn(value: string, width: number): string {
  return `${value}${" ".repeat(width - value.length + 1)}`;
}
