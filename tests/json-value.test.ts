import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { extractInterfacesFromFile, extractRpcSchemaFromFile } from "../src/extract";
import { generateGo } from "../src/go";
import { RPC_SCHEMA_VERSION, nullableType, type RpcSchema } from "../src/schema";

// The JSON-value node at the two levels the integration harness cannot reach
// cheaply: what extraction puts in the IR, and what the projection makes of it.
//
// The node exists because a contract sometimes carries data whose shape belongs
// to the data — a document's frontmatter, one key of a patch. Saying `unknown`
// states that and keeps TypeScript's checking: the receiver must narrow before
// it can do anything. Saying `any` would switch checking off at both ends, so
// the IR keeps refusing it.

const GENERATOR_PATH = path.join(path.resolve(import.meta.dir, ".."), "index.ts");

const fixtureRoot = path.join(
  import.meta.dir,
  "..",
  ".test-tmp",
  `json-value-${process.pid}-${Date.now()}`,
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

const JSON_VALUE = { kind: "json" } as const;

describe("extracting JSON values from TypeScript", () => {
  test(
    "unknown becomes a JSON value in every position, while any stays refused",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
        export type Frontmatter = Record<string, unknown>;

        export type Mutation = {
          key: string;
          value: unknown;
          previous?: unknown;
        };

        export interface ServerFunctions {
          applyMutation: (mutation: Mutation) => Frontmatter;
          readKey: (key: string) => unknown;
          history: () => unknown[];
          record: (payload: unknown) => void;
        }

        export interface ClientFunctions {
          changed: (frontmatter: Frontmatter) => void;
        }
      `,
      });

      const schema = await extractRpcSchemaFromFile(inputPath);

      expect(schema.declarations).toEqual([
        {
          kind: "object",
          name: "Mutation",
          fields: [
            { name: "key", type: { kind: "scalar", name: "string" } },
            { name: "value", type: JSON_VALUE },
            // Optional survives on the key even though the JSON value itself
            // already admits null: an absent key and a null one differ on the wire.
            { name: "previous", type: { kind: "optional", type: JSON_VALUE } },
          ],
        },
        { kind: "alias", name: "Frontmatter", target: { kind: "map", value: JSON_VALUE } },
      ]);

      const byName = new Map(schema.methods.map((method) => [method.name, method]));
      expect(byName.get("readKey")!.returnType).toEqual(JSON_VALUE);
      expect(byName.get("history")!.returnType).toEqual({ kind: "array", element: JSON_VALUE });
      expect(byName.get("record")!.params).toEqual([{ name: "payload", type: JSON_VALUE }]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "any is refused, and the refusal names unknown as the declaration to write",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
        export interface ServerFunctions {
          raw: (payload: any) => void;
        }

        export interface ClientFunctions {
          ping: () => void;
        }
      `,
      });

      const extracted = await extractInterfacesFromFile(inputPath);
      expect(extracted.schema).toBeUndefined();
      expect(extracted.diagnostics.map(({ code }) => code)).toEqual(["UNSUPPORTED_ANY_TYPE"]);
      expect(extracted.diagnostics[0]!.message).toContain("Declare unknown");
      expect(extracted.diagnostics[0]!.location.path).toBe("client-to-server.raw.params.payload");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the generated TypeScript is unchanged: `unknown` is written through as-is",
    async () => {
      const inputPath = createFixture({
        "define.ts": `
        export type Frontmatter = Record<string, unknown>;

        export interface ServerFunctions {
          readKey: (key: string) => unknown;
          record: (payload: unknown) => void;
          merge: (patch: Frontmatter) => Frontmatter;
        }

        export interface ClientFunctions {
          changed: (frontmatter: Frontmatter) => void;
        }
      `,
      });

      const extracted = await extractInterfacesFromFile(inputPath);

      // The TypeScript backend reads the string signatures, not the IR, so
      // teaching the IR about `unknown` must leave its output byte-identical to
      // what a pre-JSON-value generator wrote for the same file.
      expect(extracted.clientFunctions).toEqual([
        {
          name: "readKey",
          params: [{ name: "key", type: "string", isOptional: false }],
          returnType: "unknown",
          isVoid: false,
        },
        {
          name: "record",
          params: [{ name: "payload", type: "unknown", isOptional: false }],
          returnType: "void",
          isVoid: true,
        },
        {
          name: "merge",
          params: [{ name: "patch", type: "Frontmatter", isOptional: false }],
          returnType: "Frontmatter",
          isVoid: false,
        },
      ]);

      // And end to end on the default target, which is the case that used to
      // reach the emitters carrying a diagnostic: a TypeScript client *and*
      // server for a contract full of `unknown` must still be written.
      const generated = spawnSync("bun", ["run", GENERATOR_PATH, inputPath], {
        encoding: "utf-8",
      });
      expect(generated.status, `${generated.stdout}${generated.stderr}`).toBe(0);

      const outputDir = path.dirname(inputPath);
      expect(readdirSync(outputDir)).toContain("server.generated.ts");

      const client = readFileSync(path.join(outputDir, "client.generated.ts"), "utf8");
      expect(client).toContain(
        "readKey: (key: string, opts?: RpcCallOptions) => Promise<unknown | RpcError>",
      );
      expect(client).toContain("record: (payload: unknown, opts?: RpcCallOptions) => void");
      expect(client).toContain('import type { Frontmatter } from "./define"');

      const server = readFileSync(path.join(outputDir, "server.generated.ts"), "utf8");
      expect(server).toContain(
        "readKey: (handler: (key: string) => Promise<unknown>) => UnsubscribeFunction",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("projecting JSON values onto Go", () => {
  const schema: RpcSchema = {
    version: RPC_SCHEMA_VERSION,
    declarations: [
      { kind: "alias", name: "Frontmatter", target: { kind: "map", value: JSON_VALUE } },
      {
        kind: "object",
        name: "Mutation",
        fields: [
          { name: "key", type: { kind: "scalar", name: "string" } },
          { name: "value", type: JSON_VALUE },
          { name: "previous", type: { kind: "optional", type: JSON_VALUE } },
        ],
      },
    ],
    methods: [
      {
        name: "applyMutation",
        direction: "client-to-server",
        params: [{ name: "mutation", type: { kind: "named", name: "Mutation" } }],
        returnType: { kind: "named", name: "Frontmatter" },
      },
      {
        name: "readKey",
        direction: "client-to-server",
        params: [{ name: "key", type: { kind: "scalar", name: "string" } }],
        returnType: JSON_VALUE,
      },
      {
        name: "history",
        direction: "client-to-server",
        params: [],
        returnType: { kind: "array", element: JSON_VALUE },
      },
      {
        name: "changed",
        direction: "server-to-client",
        params: [{ name: "frontmatter", type: { kind: "named", name: "Frontmatter" } }],
        returnType: { kind: "void" },
      },
    ],
  };

  test("a JSON value is `any`, in fields, parameters, results and elements", () => {
    const generated = generateGo(schema);
    const types = generated["types.generated.go"];
    const server = generated["server.generated.go"];

    expect(types).toContain("type Frontmatter = map[string]any");
    expect(types).toContain("Value    any    `json:\"value\"`");
    expect(types).toContain("Previous any    `json:\"previous,omitempty\"`");

    expect(server).toContain("HandleReadKey(ctx context.Context, key string) (any, error)");
    expect(server).toContain("HandleHistory(ctx context.Context) ([]any, error)");
    expect(server).toContain("CallChanged(ctx context.Context, frontmatter Frontmatter) error");

    // `any` already holds nil, so an optional or nullable JSON value needs no
    // pointer — and a pointer would give the same absence two spellings.
    expect(types).not.toContain("*any");
    expect(server).not.toContain("*any");
  });

  test("a JSON value never gets a nil-normalizing marshaller of its own", () => {
    const generated = generateGo(schema);
    const types = generated["types.generated.go"];
    const server = generated["server.generated.go"];

    // A nil `any` encodes as JSON null, which is a value `unknown` accepts, so
    // there is nothing to normalize. Its *container* is a different matter: a
    // map or slice of JSON values still has to arrive as {} or [].
    expect(types).not.toContain("func (v Mutation) MarshalJSON()");
    expect(server).toContain("result = map[string]any{}");
    expect(server).toContain("result = []any{}");
  });

  test("`T | null` collapses on a JSON value, which already admits null", () => {
    expect(nullableType(JSON_VALUE)).toEqual(JSON_VALUE);

    // Constructed directly rather than through the collapse above, so the
    // projection is pinned even if an IR arrives from another producer.
    const nullable: RpcSchema = {
      version: RPC_SCHEMA_VERSION,
      declarations: [],
      methods: [
        {
          name: "readKey",
          direction: "client-to-server",
          params: [],
          returnType: { kind: "nullable", type: JSON_VALUE },
        },
      ],
    };
    expect(generateGo(nullable)["server.generated.go"]).toContain(
      "HandleReadKey(ctx context.Context) (any, error)",
    );
  });
});
