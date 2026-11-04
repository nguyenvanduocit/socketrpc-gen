/**
 * Contract for the Go client <-> TypeScript server harness.
 *
 * The roles here are the reverse of `tests/fixtures/go-crosslang`: the server is
 * the generated TypeScript `createRpcServer`, running in the Bun test process,
 * and the client is the generated Go `Dial`/`Conn`, compiled into
 * `goclient/main.go`. Both are produced by one CLI invocation
 * (`--client go --server typescript`) from this file, so when they agree on the
 * wire, the two backends agree.
 *
 * Every signature stays inside the portable subset the Go backend accepts:
 * named object types, scalars, arrays, `void`.
 */

/** Plain success payload: proves object decoding survives the TS -> Go hop. */
export type Greeting = {
  text: string;
  from: string;
};

/** Functions the TypeScript server provides; the Go client calls these. */
export interface ServerFunctions {
  /** Go -> TS value-returning ack. */
  greet: (name: string) => Greeting;

  /**
   * The TS handler always throws `rpcError("INVALID_ARGUMENT", ..., data)`, so
   * the Go caller must receive that code, message and data intact.
   */
  validate: (value: string) => Greeting;

  /**
   * The TS handler calls `ask` back on the Go client and folds the answer (or
   * the RpcError code the Go handler returned) into its reply.
   */
  relay: (question: string) => string;

  /**
   * The TS handler pushes a fire-and-forget `notify` to the Go client, whose
   * handler fails; the failure can only return through `__rpc:error__`, which
   * the TS server observes with `onRpcError`.
   */
  pushNotify: (text: string) => string;

  /**
   * Fire-and-forget whose TS handler throws; the TS server reports the failure
   * through `__rpc:error__`, which the Go client observes with `OnRpcError`.
   */
  explode: (reason: string) => void;
}

/** Functions the Go client provides; the TypeScript server calls these. */
export interface ClientFunctions {
  /** TS -> Go value-returning ack. `"refuse"` is answered with INVALID_ARGUMENT. */
  ask: (question: string) => string;

  /** TS -> Go fire-and-forget. The Go handler always returns an error. */
  notify: (text: string) => void;
}
