import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import {
  extractInterfacesFromFile,
  extractRpcSchemaFromFile,
} from "../src/extract";
import { generateGo } from "../src/go";
import { SchemaExtractionError } from "../src/schema";

const fixtureRoot = path.join(
  import.meta.dir,
  "..",
  ".test-tmp",
  `schema-${process.pid}-${Date.now()}`,
);
let fixtureCounter = 0;
const TEST_TIMEOUT_MS = 30_000;

function createFixture(files: Record<string, string>): string {
  const directory = path.join(fixtureRoot, String(fixtureCounter++));
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), contents);
  }
  return path.join(directory, "define.ts");
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("SocketRPC schema extraction", () => {
  test(
    "builds a portable IR across imported and inherited interfaces",
    async () => {
      const inputPath = createFixture({
        "base.ts": `
        export type Role = "admin" | "member";

        export interface Profile {
          id: string;
          role: Role;
          tags: string[];
          attributes: Record<string, string>;
          displayName?: string | null;
          metadata: { active: boolean };
        }

        export interface BaseServerFunctions {
          getProfile: (id: string) => Profile | null;
        }

        export interface BaseClientFunctions {
          profileChanged: (kind: "created" | "deleted", profile: Profile) => void;
        }
      `,
        "define.ts": `
        import type {
          BaseClientFunctions,
          BaseServerFunctions,
          Profile,
        } from "./base";

        export type ProfileMap = Record<string, Profile>;

        export interface ServerFunctions extends BaseServerFunctions {
          saveProfiles: (profiles: Profile[], byId: ProfileMap) => Profile;
        }

        export interface ClientFunctions extends BaseClientFunctions {
          reset: (reason?: string) => void;
        }
      `,
      });

      const extracted = await extractInterfacesFromFile(inputPath);
      expect(extracted.diagnostics).toEqual([]);
      const schema = extracted.schema!;

      expect(schema.version).toBe(1);
      expect(
        schema.methods.map(({ name, direction }) => ({ name, direction })),
      ).toEqual([
        { name: "getProfile", direction: "client-to-server" },
        { name: "saveProfiles", direction: "client-to-server" },
        { name: "profileChanged", direction: "server-to-client" },
        { name: "reset", direction: "server-to-client" },
      ]);

      expect(
        schema.methods.find(({ name }) => name === "getProfile")?.returnType,
      ).toEqual({
        kind: "nullable",
        type: { kind: "named", name: "Profile" },
      });
      expect(
        schema.methods.find(({ name }) => name === "saveProfiles")?.params,
      ).toEqual([
        {
          name: "profiles",
          type: {
            kind: "array",
            element: { kind: "named", name: "Profile" },
          },
        },
        {
          name: "byId",
          type: { kind: "named", name: "ProfileMap" },
        },
      ]);
      expect(
        schema.methods.find(({ name }) => name === "reset")?.params,
      ).toEqual([
        {
          name: "reason",
          type: {
            kind: "optional",
            type: { kind: "scalar", name: "string" },
          },
        },
      ]);

      expect(
        schema.declarations.find(({ name }) => name === "Profile"),
      ).toEqual({
        kind: "object",
        name: "Profile",
        fields: [
          { name: "id", type: { kind: "scalar", name: "string" } },
          { name: "role", type: { kind: "named", name: "Role" } },
          {
            name: "tags",
            type: {
              kind: "array",
              element: { kind: "scalar", name: "string" },
            },
          },
          {
            name: "attributes",
            type: {
              kind: "map",
              value: { kind: "scalar", name: "string" },
            },
          },
          {
            name: "displayName",
            type: {
              kind: "optional",
              type: {
                kind: "nullable",
                type: { kind: "scalar", name: "string" },
              },
            },
          },
          {
            name: "metadata",
            type: {
              kind: "object",
              fields: [
                { name: "active", type: { kind: "scalar", name: "boolean" } },
              ],
            },
          },
        ],
      });
      expect(schema.declarations.find(({ name }) => name === "Role")).toEqual({
        kind: "enum",
        name: "Role",
        values: ["admin", "member"],
      });
      expect(
        schema.declarations.find(({ name }) => name === "ProfileMap"),
      ).toEqual({
        kind: "alias",
        name: "ProfileMap",
        target: {
          kind: "map",
          value: { kind: "named", name: "Profile" },
        },
      });

      // Existing TypeScript emitters receive the same string API as before.
      expect(extracted.clientToServerFunctions).toEqual([
        {
          name: "getProfile",
          params: [{ name: "id", type: "string", isOptional: false }],
          returnType: "Profile | null",
          isVoid: false,
        },
        {
          name: "saveProfiles",
          params: [
            { name: "profiles", type: "Profile[]", isOptional: false },
            { name: "byId", type: "ProfileMap", isOptional: false },
          ],
          returnType: "Profile",
          isVoid: false,
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports every unsupported type with a stable diagnostic code and location",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
        export interface ServerFunctions {
          invalid: (value: string | number, tuple: [string, number]) => Promise<string>;
        }

        export interface ClientFunctions {
          callback: (handler: () => void) => void;
        }
      `,
      });

      let caught: unknown;
      try {
        await extractRpcSchemaFromFile(inputPath);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SchemaExtractionError);
      const error = caught as SchemaExtractionError;
      expect(error.diagnostics.map(({ code }) => code)).toEqual([
        "UNSUPPORTED_UNION_TYPE",
        "UNSUPPORTED_TUPLE_TYPE",
        "UNSUPPORTED_PROMISE_TYPE",
        "UNSUPPORTED_FUNCTION_TYPE",
      ]);
      expect(error.diagnostics.map(({ location }) => location.path)).toEqual([
        "client-to-server.invalid.params.value",
        "client-to-server.invalid.params.tuple",
        "client-to-server.invalid.returnType",
        "server-to-client.callback.params.handler",
      ]);
      expect(error.message).toContain("Promise<T>");
      expect(error.diagnostics.every(({ location }) => location.line > 0)).toBe(
        true,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps TypeScript extraction working for contracts the portable IR rejects",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
        export interface ServerFunctions {
          search: (query: string | number) => string;
          touch: (at: Date) => void;
          raw: (payload: any) => void;
          lookup: (index: Map<string, string>) => void;
        }

        export interface ClientFunctions {
          ping: () => void;
        }
      `,
      });

      const extracted = await extractInterfacesFromFile(inputPath);

      // No portable schema is published, so unsupported sentinels cannot escape.
      expect(extracted.schema).toBeUndefined();
      expect(extracted.diagnostics.map(({ code }) => code)).toEqual([
        "UNSUPPORTED_UNION_TYPE",
        "UNSUPPORTED_ANY_TYPE",
        "UNSUPPORTED_GENERIC_TYPE",
      ]);

      // TypeScript emission keeps the exact historical type text for all of them.
      expect(extracted.clientToServerFunctions).toEqual([
        {
          name: "search",
          params: [
            { name: "query", type: "string | number", isOptional: false },
          ],
          returnType: "string",
          isVoid: false,
        },
        {
          name: "touch",
          params: [{ name: "at", type: "Date", isOptional: false }],
          returnType: "void",
          isVoid: true,
        },
        {
          name: "raw",
          params: [{ name: "payload", type: "any", isOptional: false }],
          returnType: "void",
          isVoid: true,
        },
        {
          name: "lookup",
          params: [
            { name: "index", type: "Map<string, string>", isOptional: false },
          ],
          returnType: "void",
          isVoid: true,
        },
      ]);

      // The portable backends still refuse the very same contract.
      let caught: unknown;
      try {
        await extractRpcSchemaFromFile(inputPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaExtractionError);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("optional and nullable modifiers on boolean and on named string unions", () => {
  // TypeScript spells `boolean | undefined` as the union `true | false | undefined`,
  // and flattens `Status | undefined` into `"a" | "b" | undefined`, dropping the
  // alias. Both have to reach the IR as what the author wrote.
  const contract = `
    export type Status = "active" | "archived";

    export type Account = {
      id: string;
      verified?: boolean;
      suspended: boolean | null;
      reviewed?: boolean | null;
      status?: Status;
      previous: Status | null;
      next?: Status | null;
      current: Status;
      theme?: "light" | "dark";
    };

    export interface ServerFunctions {
      get: (id: string) => Account;
      setStatus: (id: string, status: Status | null) => void;
    }
    export interface ClientFunctions {}
  `;

  const field = (schema: Awaited<ReturnType<typeof extractRpcSchemaFromFile>>, name: string) => {
    const account = schema.declarations.find((d) => d.name === "Account");
    if (account?.kind !== "object") throw new Error("Account is not an object");
    return account.fields.find((f) => f.name === name)?.type;
  };

  test(
    "an optional or nullable boolean is a boolean with that modifier",
    async () => {
      const schema = await extractRpcSchemaFromFile(createFixture({ "define.ts": contract }));
      const boolean = { kind: "scalar", name: "boolean" } as const;
      expect(field(schema, "verified")).toEqual({ kind: "optional", type: boolean });
      expect(field(schema, "suspended")).toEqual({ kind: "nullable", type: boolean });
      expect(field(schema, "reviewed")).toEqual({
        kind: "optional",
        type: { kind: "nullable", type: boolean },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an optional or nullable alias of a string union stays a reference to the alias",
    async () => {
      const schema = await extractRpcSchemaFromFile(createFixture({ "define.ts": contract }));
      const status = { kind: "named", name: "Status" } as const;
      expect(field(schema, "current")).toEqual(status);
      expect(field(schema, "status")).toEqual({ kind: "optional", type: status });
      expect(field(schema, "previous")).toEqual({ kind: "nullable", type: status });
      expect(field(schema, "next")).toEqual({
        kind: "optional",
        type: { kind: "nullable", type: status },
      });
      expect(
        schema.methods.find(({ name }) => name === "setStatus")?.params[1]?.type,
      ).toEqual({ kind: "nullable", type: status });
      expect(schema.declarations.find(({ name }) => name === "Status")).toEqual({
        kind: "enum",
        name: "Status",
        values: ["active", "archived"],
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a union written inline stays inline: it has no name to refer to",
    async () => {
      const schema = await extractRpcSchemaFromFile(createFixture({ "define.ts": contract }));
      expect(field(schema, "theme")).toEqual({
        kind: "optional",
        type: { kind: "enum", values: ["light", "dark"] },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Go backend writes them as pointers, a bool and a named enum",
    async () => {
      const schema = await extractRpcSchemaFromFile(
        createFixture({
          "define.ts": contract.replace('theme?: "light" | "dark";', ""),
        }),
      );
      const types = generateGo(schema)["types.generated.go"]!;
      expect(types).toMatch(/Verified\s+\*bool\s+`json:"verified,omitempty"`/);
      expect(types).toMatch(/Suspended\s+\*bool\s+`json:"suspended"`/);
      expect(types).toMatch(/Status\s+\*Status\s+`json:"status,omitempty"`/);
      expect(types).toMatch(/Previous\s+\*Status\s+`json:"previous"`/);
      expect(types).toMatch(/Current\s+Status\s+`json:"current"`/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a union that mixes boolean with another type is still refused",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
          export type Mixed = { value: string | boolean };
          export interface ServerFunctions { get: () => Mixed }
          export interface ClientFunctions {}
        `,
      });
      let caught: unknown;
      try {
        await extractRpcSchemaFromFile(inputPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaExtractionError);
      expect((caught as SchemaExtractionError).diagnostics.map(({ code }) => code)).toEqual([
        "UNSUPPORTED_UNION_TYPE",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an optional or nullable enum or object stays a reference to its declaration",
    async () => {
      const schema = await extractRpcSchemaFromFile(
        createFixture({
          "define.ts": `
            export enum Role { Owner = "owner", Guest = "guest" }
            export type Owner = { name: string };
            export type Account = {
              role?: Role;
              mentor: Role | null;
              owner?: Owner;
              backup: Owner | null;
            };
            export interface ServerFunctions { get: () => Account }
            export interface ClientFunctions {}
          `,
        }),
      );
      const role = { kind: "named", name: "Role" } as const;
      const owner = { kind: "named", name: "Owner" } as const;
      expect(field(schema, "role")).toEqual({ kind: "optional", type: role });
      expect(field(schema, "mentor")).toEqual({ kind: "nullable", type: role });
      expect(field(schema, "owner")).toEqual({ kind: "optional", type: owner });
      expect(field(schema, "backup")).toEqual({ kind: "nullable", type: owner });
      expect(schema.declarations.find(({ name }) => name === "Role")).toEqual({
        kind: "enum",
        name: "Role",
        values: ["owner", "guest"],
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an optional alias that itself includes null is refused with the rewrite that works",
    async () => {
      // `Maybe` is merged into the union it joins, so `next?: Maybe` reaches the
      // backend as `"active" | "archived" | null | undefined` with no name left.
      // Telling the author to "extract the union into an alias" would send them
      // back to the declaration they already have.
      const contractWithAliasOfNull = `
        export type Status = "active" | "archived";
        export type Maybe = Status | null;
        export type Account = { next?: Maybe };
        export interface ServerFunctions { get: () => Account }
        export interface ClientFunctions {}
      `;
      const schema = await extractRpcSchemaFromFile(
        createFixture({ "define.ts": contractWithAliasOfNull }),
      );
      expect(() => generateGo(schema)).toThrow("includes null or undefined");

      const rewritten = await extractRpcSchemaFromFile(
        createFixture({
          "define.ts": contractWithAliasOfNull.replace("next?: Maybe", "next?: Status | null"),
        }),
      );
      expect(generateGo(rewritten)["types.generated.go"]).toMatch(
        /Next\s+\*Status\s+`json:"next,omitempty"`/,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("members of ClientFunctions and ServerFunctions", () => {
  test(
    "a method signature is an RPC method, the same as its property form",
    async () => {
      const extracted = await extractInterfacesFromFile(
        createFixture({
          "define.ts": `
            export type Chain = { id: string };
            export type Reply = { ok: boolean };
            export interface ServerFunctions {
              asProperty: (chain: Chain, note?: string) => Reply;
              asMethod(chain: Chain, note?: string): Reply;
              ping(): void;
            }
            export interface ClientFunctions {
              notify(message: string): void;
            }
          `,
        }),
      );

      const [asProperty, asMethod, ping] = extracted.clientToServerFunctions;
      expect(extracted.clientToServerFunctions.map(({ name }) => name)).toEqual([
        "asProperty",
        "asMethod",
        "ping",
      ]);
      expect({ ...asMethod, name: "asProperty" }).toEqual(asProperty);
      expect(ping).toEqual({ name: "ping", params: [], returnType: "void", isVoid: true });
      expect(extracted.serverToClientFunctions.map(({ name }) => name)).toEqual(["notify"]);

      // Both forms reach the portable schema, with the same shape.
      const methods = extracted.schema?.methods ?? [];
      expect(methods.map(({ name }) => name)).toEqual(["asProperty", "asMethod", "ping", "notify"]);
      expect({ ...methods[1], name: "asProperty" }).toEqual(methods[0]);

      // The type imports are collected from method signatures too: `Reply` is
      // named by nothing but `asProperty` and `asMethod`.
      expect([...extracted.usedTypes.keys()].sort()).toEqual(["Chain", "Reply"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a member that is not an RPC method is reported by name, not dropped silently",
    async () => {
      const warn = spyOn(console, "error").mockImplementation(() => {});
      try {
        const extracted = await extractInterfacesFromFile(
          createFixture({
            "define.ts": `
              type Handler = (x: string) => void;
              export interface ServerFunctions {
                kept: (x: string) => string;
                optional?: (x: string) => void;
                optionalMethod?(x: string): void;
                viaAlias: Handler;
                version: string;
                (call: string): void;
                [key: string]: unknown;
              }
              export interface ClientFunctions {}
            `,
          }),
        );

        expect(extracted.clientToServerFunctions.map(({ name }) => name)).toEqual(["kept"]);

        const messages = warn.mock.calls.map(([message]) => String(message));
        expect(messages).toHaveLength(6);
        expect(messages[0]).toContain("'optional'");
        expect(messages[0]).toContain("optional");
        expect(messages[1]).toContain("'optionalMethod'");
        expect(messages[1]).toContain("optional");
        expect(messages[2]).toContain("'viaAlias'");
        expect(messages[2]).toContain("function type");
        expect(messages[3]).toContain("'version'");
        expect(messages[3]).toContain("function type");
        expect(messages[4]).toContain("call signature");
        expect(messages[5]).toContain("index signature");
      } finally {
        warn.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an overloaded method is refused: no one signature stands for the call",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
          export interface ServerFunctions {
            send(text: string): void;
            send(count: number): void;
          }
          export interface ClientFunctions {}
        `,
      });
      await expect(extractInterfacesFromFile(inputPath)).rejects.toThrow(/'send'.*overload/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a method a derived interface redeclares takes the derived signature, in the base's position",
    async () => {
      const extracted = await extractInterfacesFromFile(
        createFixture({
          "define.ts": `
            interface Base {
              first: (x: string) => string;
              second: (x: string) => string;
            }
            export interface ServerFunctions extends Base {
              first: (x: string | number) => string;
              third: () => void;
            }
            export interface ClientFunctions {}
          `,
        }),
      );

      const { clientToServerFunctions: functions } = extracted;
      expect(functions.map(({ name }) => name)).toEqual(["first", "second", "third"]);
      expect(functions[0]?.params[0]?.type).toBe("string | number");
      expect(functions[1]?.params[0]?.type).toBe("string");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the redeclaration closest to the contract wins, however deep the chain",
    async () => {
      const extracted = await extractInterfacesFromFile(
        createFixture({
          "define.ts": `
            interface Root { get: (id: string) => string }
            interface Mid extends Root { get: (id: string) => "a" | "b" }
            export interface ServerFunctions extends Mid {}
            export interface ClientFunctions {}
          `,
        }),
      );
      expect(extracted.clientToServerFunctions.map(({ name, returnType }) => [name, returnType])).toEqual([
        ["get", '"a" | "b"'],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a base reached by two paths is walked once, and the nearer redeclaration wins",
    async () => {
      const warn = spyOn(console, "error").mockImplementation(() => {});
      try {
        const extracted = await extractInterfacesFromFile(
          createFixture({
            "define.ts": `
              interface D { m: () => string; note: string }
              interface B extends D {}
              interface C extends D { m: () => "x" }
              export interface ServerFunctions extends B, C {}
              export interface ClientFunctions {}
            `,
          }),
        );
        expect(extracted.clientToServerFunctions.map(({ name, returnType }) => [name, returnType])).toEqual([
          ["m", '"x"'],
        ]);
        expect(warn.mock.calls.map(([message]) => String(message))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a method redeclared as something that is not a method is not generated from the base",
    async () => {
      const warn = spyOn(console, "error").mockImplementation(() => {});
      try {
        const extracted = await extractInterfacesFromFile(
          createFixture({
            "define.ts": `
              type Handler = (x: string | number) => void;
              interface Base { ping: (x: string) => void; kept: () => void }
              export interface ServerFunctions extends Base { ping: Handler }
              export interface ClientFunctions {}
            `,
          }),
        );
        // The warning says 'ping' is skipped, so the generated code must agree.
        expect(extracted.clientToServerFunctions.map(({ name }) => name)).toEqual(["kept"]);
        const messages = warn.mock.calls.map(([message]) => String(message));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("'ping'");
      } finally {
        warn.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "declarations of the same interface merge, as they do in TypeScript",
    async () => {
      const extracted = await extractInterfacesFromFile(
        createFixture({
          "define.ts": `
            export interface ServerFunctions { first: () => void }
            export interface ServerFunctions { second: () => void }
            export interface ClientFunctions {}
          `,
        }),
      );
      expect(extracted.clientToServerFunctions.map(({ name }) => name)).toEqual(["first", "second"]);
    },
    TEST_TIMEOUT_MS,
  );
});
