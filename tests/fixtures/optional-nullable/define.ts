/**
 * Contract for the optional/nullable harness.
 *
 * `boolean` and a named string-literal union are the two types TypeScript
 * rewrites when `undefined` or `null` joins them: `boolean | undefined` becomes
 * `true | false | undefined`, and `Status | null` becomes `"active" | "archived"
 * | null`, which has no name left. The Go backend has to read both back as what
 * the author wrote, a bool and a named enum behind a pointer.
 *
 * Each of them appears in every position a type can take: an optional field, a
 * nullable field, an optional nullable field, an array element, a map value and
 * a positional parameter. The TypeScript `enum` rides along because it takes the
 * same path as the alias once a modifier is applied.
 */

export type Status = "active" | "archived";

export enum Role {
  Owner = "owner",
  Guest = "guest",
}

export type Account = {
  id: string;
  /** Absent, true and false are three different facts. */
  verified?: boolean;
  suspended: boolean | null;
  reviewed?: boolean | null;
  status?: Status;
  previous: Status | null;
  next?: Status | null;
  role?: Role;
  mentor: Role | null;
  history: (Status | null)[];
  switches: Record<string, boolean | null>;
};

/**
 * Functions the Go server provides; the TypeScript client calls these. `echo` is
 * written as a property and `describe` as a method signature: both are RPC methods.
 */
export interface ServerFunctions {
  /** Returns the account exactly as the server decoded it. */
  echo: (account: Account) => Account;
  /** Reports which of the nilable arguments reached the handler as nil. */
  describe(flag: boolean | null, status: Status | null): string;
}

export interface ClientFunctions {}
