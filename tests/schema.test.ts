import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import {
  extractInterfacesFromFile,
  extractRpcSchemaFromFile,
} from "../src/extract";
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
