/**
 * Contract for the JSON-value harness, modelled on a real document editor.
 *
 * A document has a fixed envelope — path, body — around frontmatter whose keys
 * and value shapes belong to the document, not to the RPC contract. That is the
 * shape `unknown` exists for: the contract states that arbitrary JSON travels
 * here, and TypeScript still refuses every operation on the value until the
 * receiver narrows it. `any` would say the same thing while switching type
 * checking off at both ends, so the IR keeps refusing it.
 *
 * Everything below is inside the portable subset, and every position a JSON
 * value can occupy appears at least once: a map value, a required field, an
 * optional field, a positional parameter, a result, an array element, and both
 * directions of the connection.
 */

/** Frontmatter as a named alias, so the Go projection is exercised through one. */
export type Frontmatter = Record<string, unknown>;

/** A document: fixed envelope, open frontmatter. */
export type Document = {
  path: string;
  /** Keys and value shapes are the document's business, not the contract's. */
  frontmatter: Record<string, unknown>;
  body: string;
  /** Absent unless the last write failed — proves `omitempty` on a JSON value. */
  lastError?: unknown;
};

/** One edit to a single frontmatter key. */
export type Mutation = {
  path: string;
  key: string;
  /** Whatever JSON the key should hold: string, number, list, object, or null. */
  value: unknown;
};

/** Functions the Go server provides; the TypeScript client calls these. */
export interface ServerFunctions {
  /** Round-trips a whole document, frontmatter included. */
  readDocument: (path: string) => Document;

  /** Takes a JSON value nested inside a named struct and stores it. */
  applyMutation: (mutation: Mutation) => Document;

  /** A bare JSON value as the result: the key's current value, or null. */
  readKey: (path: string, key: string) => unknown;

  /** A named `Record<string, unknown>` in and out — `map[string]any` both ways. */
  mergeFrontmatter: (path: string, patch: Frontmatter) => Frontmatter;

  /** Fire-and-forget carrying a JSON payload; no acknowledgement on the wire. */
  recordEvent: (name: string, payload: unknown) => void;

  /** Reads back what `recordEvent` recorded, making delivery observable. */
  readEvents: () => string[];

  /** An array of JSON values; nil must still arrive as `[]`. */
  history: (path: string) => unknown[];

  /**
   * The handler puts a value into the result that Go can hold in an `any` but
   * JSON cannot encode. Socket.IO's write path discards encoding failures, so
   * without the emitter's preflight this call would answer nothing at all and
   * the client would wait out its own timeout.
   */
  unencodableValue: () => unknown;

  /**
   * Drives the *outbound* generated surface with JSON values: a fire-and-forget
   * push carrying frontmatter, then an acknowledged call whose result is an
   * arbitrary JSON value chosen by the TypeScript client.
   */
  syncBack: (path: string) => unknown;
}

/** Functions the TypeScript client provides; the Go server calls these. */
export interface ClientFunctions {
  /** Go → TS fire-and-forget carrying a JSON map. */
  documentChanged: (path: string, frontmatter: Frontmatter) => void;

  /** Go → TS acknowledged call: JSON in, JSON out. */
  resolveConflict: (key: string, incoming: unknown) => unknown;
}
