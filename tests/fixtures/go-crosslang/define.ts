/**
 * Contract for the end-to-end cross-language harness.
 *
 * `tests/fixtures/go-wire` proves the wire protocol against a *handcrafted* Go
 * server, so it answers "could a Go implementer satisfy this protocol?".
 * This fixture answers the next question: does the Go server the generator
 * *emits* satisfy it? Both sides below are generated — TypeScript client from
 * the TypeScript backend, Go server from the Go backend — out of one canonical
 * RpcSchema, and `goserver/main.go` only implements the handler interface.
 *
 * Every signature here is deliberately inside the portable subset of the IR:
 * named object types, string enums, scalars, arrays. Shapes Go refuses (inline
 * object literals, ambient `Error`, optional positional parameters) are covered
 * by the rejection tests in tests/go-emitter.test.ts instead.
 */

/** Plain success payload — proves object encoding survives the Go → TS hop. */
export type Echo = {
  id: string;
  payload: string;
  /** Optional field: absent on the wire unless the Go handler fills it in. */
  note?: string;
};

/**
 * A success value that structurally looks like an error. Go serializes this
 * from an ordinary struct; `isRpcError` must still report false because the
 * `__rpcError` brand is absent.
 */
export type Receipt = {
  message: string;
  code: string;
};

/** String-literal union — becomes a validated Go string enum. */
export type Priority = "low" | "high";

/** Functions the Go server provides; the TypeScript client calls these. */
export interface ServerFunctions {
  /** Value-returning ack: Go answers with the echoed payload. */
  echo: (id: string, payload: string) => Echo;

  /** Go answers the ack with a branded RpcError carrying a custom code + data. */
  failTyped: (reason: string) => Echo;

  /** Go panics; the generated recover must turn it into an INTERNAL_ERROR ack. */
  failPanic: (reason: string) => Echo;

  /** Fire-and-forget: no ack id on the wire, Go records the note. */
  note: (text: string, priority: Priority) => void;

  /** Reads back what `note` recorded, so fire-and-forget delivery is observable. */
  readNotes: () => string[];

  /**
   * Reads back the out-of-band failures the client reported. A client handler
   * for a fire-and-forget server-to-client call has no acknowledgement to fail
   * through, so it emits `__rpc:error__` instead; this makes what the Go binding
   * observed through `OnRpcError` visible to the test.
   */
  readRpcErrors: () => string[];

  /** Go blocks until the binding is torn down, exercising the client TIMEOUT path. */
  neverAck: (id: string) => Echo;

  /** Go closes the socket with the call in flight, exercising DISCONNECTED. */
  dropWhileInFlight: (id: string) => Echo;

  /** Returns a `{ message, code }`-shaped success — brand soundness across languages. */
  receipt: (id: string) => Receipt;

  /**
   * Go calls back into the client through the *generated* Go Client — first
   * fire-and-forget (`notify`), then a value-returning ack (`ask`) — and folds
   * the client's answer into its reply.
   */
  roundTrip: (question: string) => string;
}

/** Functions the TypeScript client provides; the Go server calls these. */
export interface ClientFunctions {
  /** Go → TS fire-and-forget. */
  notify: (text: string) => void;

  /** Go → TS value-returning ack. */
  ask: (question: string) => string;
}
