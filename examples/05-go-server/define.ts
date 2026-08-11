/**
 * Example 05: TypeScript client, Go server
 *
 * Generated with:
 *   bunx socketrpc-gen ./examples/05-go-server/define.ts \
 *     --client typescript --server go --go-out ./examples/05-go-server/rpc
 *
 * The TypeScript backend reads the signatures as written, so it accepts any
 * type TypeScript accepts. The Go backend reads the portable RpcSchema IR and
 * therefore only accepts shapes that have a sound Go spelling. Everything below
 * stays inside that subset:
 *
 *   - named object types and string-literal unions (never inline ones)
 *   - string / number / boolean scalars, arrays, string-keyed records
 *   - `void` for fire-and-forget
 *
 * Timestamps travel as ISO-8601 strings rather than `Date`, because `Date` is a
 * host object with no portable wire shape. Ambient types such as `Error` are
 * rejected for the same reason.
 */

/** A chat room. `memberCount` becomes a Go float64 — JSON has one number type. */
export type ChatRoom = {
  id: string;
  topic: string;
  memberCount: number;
  visibility: Visibility;
};

/** A string-literal union becomes a validated Go string enum. */
export type Visibility = "public" | "private";

export type Message = {
  id: string;
  roomId: string;
  body: string;
  /** ISO-8601. `Date` has no portable wire shape; a string does. */
  sentAt: string;
  /** Optional fields become Go pointers tagged `omitempty`. */
  editedAt?: string;
};

/** Functions the Go server provides; the TypeScript client calls these. */
export interface ServerFunctions {
  createRoom: (topic: string, visibility: Visibility) => ChatRoom;
  listRooms: () => ChatRoom[];
  postMessage: (roomId: string, body: string) => Message;
  /** Fire-and-forget: no acknowledgement travels on the wire. */
  typing: (roomId: string) => void;
}

/** Functions the TypeScript client provides; the Go server calls these. */
export interface ClientFunctions {
  onMessage: (message: Message) => void;
  confirmLeave: (roomId: string) => boolean;
}
