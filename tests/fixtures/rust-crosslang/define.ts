/**
 * Contract for the Rust cross-language harness (tests/rust-crosslang.integration.test.ts).
 *
 * One contract, four pairings: the generated TypeScript client against the
 * generated Rust server, the generated Rust client against the generated
 * TypeScript server, and the Rust client against the Rust server. `Task` holds
 * every shape the portable subset accepts, so an echo through any peer proves
 * the two backends agree on its wire form.
 */

export type Priority = "low" | "high" | "in-progress";

export type Task = {
  id: string;
  title: string;
  priority: Priority;
  tags: string[];
  scores: Record<string, number>;
  done: boolean;
  /** Omitted or a string. */
  note?: string;
  /** Always present, possibly null. */
  assignee: string | null;
  /** Omitted, null, or a string — three states Rust keeps apart. */
  due?: string | null;
  /** Any JSON value. */
  extra: unknown;
  /** Recursive through an optional field: boxed in Rust. */
  parent?: Task;
  /** A Rust keyword as a wire name. */
  type: string;
};

/** Functions the server provides; the client calls these. */
export interface ServerFunctions {
  echoTask: (task: Task) => Task;
  add: (a: number, b: number) => number;
  /** Fails with `code`, message `refused: <code>` and data `{ code }`. */
  fail: (code: string) => string;
  /** The handler crashes: a Rust panic or a thrown TypeScript error. */
  crash: () => string;
  /** Answers after `ms` milliseconds. */
  slow: (ms: number) => number;
  /** Fire-and-forget; `history` returns the values in the order they were handled. */
  record: (value: number) => void;
  history: () => number[];
  /** Fire-and-forget whose handler fails with code EXPLODED: reported through `__rpc:error__`. */
  explode: (reason: string) => void;
  /** Calls the client's `ask` and answers with its reply, or `error:<code>`. */
  relay: (question: string) => string;
  /** Calls the client's `notify`, whose handler fails; answers `sent`. */
  pushNotify: (text: string) => string;
  /** The code of the last failure the client reported through `__rpc:error__`, or null. */
  lastClientError: () => string | null;
  /** The server disconnects this socket. */
  kick: () => void;
}

/** Functions the client provides; the server calls these. */
export interface ClientFunctions {
  /** Answers `<language> answered <question>`; `"refuse"` fails with INVALID_ARGUMENT. */
  ask: (question: string) => string;
  /** Always fails with code NOTIFY_FAILED. */
  notify: (text: string) => void;
}
