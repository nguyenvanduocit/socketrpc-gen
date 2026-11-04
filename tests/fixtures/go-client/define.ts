/**
 * Contract for the Go client against the Go server.
 *
 * One CLI invocation turns this file into two Go packages inside one module:
 * `wire` (the shared types and the generated server) and `wireclient` (the
 * generated client, which imports `wire` for every contract type). The checked-in
 * `e2e_test.go` runs both sides in one process and drives every requirement the
 * first Go-client user listed: namespaces, auth, reconnect, ctx-first calls,
 * per-method ordering on the client's handlers, and the payload limit.
 *
 * Every signature stays inside the portable subset the Go backend accepts.
 */

/** What the server read from the handshake; proves auth reached the namespace. */
export type Session = {
  namespace: string;
  token: string;
};

/** Sent server to client; a named type both packages must agree on. */
export type Job = {
  id: string;
  input: string;
};

export type JobResult = {
  id: string;
  output: string;
};

/** Functions the Go server provides; the Go client calls these. */
export interface ServerFunctions {
  /** Acknowledged call: the server answers with its argument. */
  echo: (text: string) => string;

  /** Answers with the byte length of its argument; the payload-limit probe. */
  measure: (blob: string) => number;

  /** Answers with the namespace and the token the handshake carried. */
  whoAmI: () => Session;

  /** Fire-and-forget, client to server. */
  note: (text: string) => void;

  /** Reads back what `note` recorded on this connection, in arrival order. */
  readNotes: () => string[];

  /** Never answers; it returns only when the connection's binding is torn down. */
  hold: (id: string) => string;
}

/** Functions the Go client provides; the Go server calls these. */
export interface ClientFunctions {
  /** Acknowledged call, server to client, with named types both ways. */
  runJob: (job: Job) => JobResult;

  /** Fire-and-forget, server to client; the per-method ordering probe. */
  record: (seq: number) => void;

  /** Blocks until the test releases it; the slow method that must block nothing else. */
  stall: (id: string) => string;

  /** Answers, refuses with a typed error, or panics, depending on the question. */
  ask: (question: string) => string;
}
