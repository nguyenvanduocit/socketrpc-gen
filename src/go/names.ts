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

function identifierParts(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function exportedIdentifier(value: string): string {
  return identifierParts(value)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function localIdentifier(value: string): string {
  const exported = exportedIdentifier(value);
  if (!exported) return "";
  return exported.charAt(0).toLowerCase() + exported.slice(1);
}

export function goString(value: string): string {
  return JSON.stringify(value);
}

export function padGoColumn(value: string, width: number): string {
  return `${value}${" ".repeat(width - value.length + 1)}`;
}
