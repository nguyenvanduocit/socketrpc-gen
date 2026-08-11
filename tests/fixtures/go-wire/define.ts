/**
 * Wire fixture for the cross-language compatibility harness.
 *
 * The generated client from this file is driven against a handcrafted Go
 * Socket.IO server (`goserver/main.go`). Every signature here exists to pin one
 * observable property of the wire protocol, so a Go implementer can read this
 * file as the contract they have to satisfy.
 */

/** Plain success payload — proves object encoding survives the Go → TS hop. */
export type Echo = {
  id: string;
  payload: string;
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

/** Functions the Go server provides; the TypeScript client calls these. */
export interface ServerFunctions {
  /** Value-returning ack: Go answers with the echoed payload. */
  echo: (id: string, payload: string) => Echo;

  /** Go answers the ack with a branded RpcError carrying a custom code + data. */
  failTyped: (reason: string) => Echo;

  /** Fire-and-forget: no ack id on the wire, Go records the note. */
  note: (text: string) => void;

  /** Reads back what `note` recorded, so fire-and-forget delivery is observable. */
  readNotes: () => string[];

  /** Go deliberately drops the ack, exercising the client-side TIMEOUT path. */
  neverAck: (id: string) => Echo;

  /** Go closes the socket with the call in flight, exercising DISCONNECTED. */
  dropWhileInFlight: (id: string) => Echo;

  /** Returns a `{ message, code }`-shaped success — brand soundness across languages. */
  receipt: (id: string) => Receipt;

  /**
   * Go calls back into the client — first fire-and-forget (`notify`), then a
   * value-returning ack (`ask`) — and folds the client's answer into its reply.
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
