import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { RPC_SCHEMA_VERSION, type RpcSchema } from "../src/schema";
import { DEFAULT_GO_SOCKET_IMPORT, generateGo } from "../src/go";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "go-emitter");
const temporaryDirectories: string[] = [];

const scalar = (name: "string" | "boolean" | "number") => ({ kind: "scalar", name }) as const;
const VOID = { kind: "void" } as const;

// The Go backend reads the same canonical IR the TypeScript backend does, so
// this fixture is written as an RpcSchema rather than a Go-shaped mirror of one.
const schema: RpcSchema = {
  version: RPC_SCHEMA_VERSION,
  declarations: [
    { kind: "enum", name: "Status", values: ["active", "pending-review"] },
    {
      kind: "object",
      name: "User",
      fields: [
        // `id` becomes `ID` without any per-field override: the emitter applies
        // Go's initialism conventions when deriving identifiers.
        { name: "id", type: scalar("string") },
        { name: "displayName", type: scalar("string") },
        { name: "score", type: { kind: "nullable", type: scalar("number") } },
        {
          name: "tags",
          type: { kind: "optional", type: { kind: "array", element: scalar("string") } },
        },
        { name: "attributes", type: { kind: "map", value: scalar("string") } },
        { name: "status", type: { kind: "named", name: "Status" } },
      ],
    },
  ],
  methods: [
    {
      name: "getUser",
      direction: "client-to-server",
      params: [
        { name: "userID", type: scalar("string") },
        { name: "includeDeleted", type: scalar("boolean") },
      ],
      returnType: { kind: "named", name: "User" },
    },
    {
      name: "deleteUser",
      direction: "client-to-server",
      params: [{ name: "userID", type: scalar("string") }],
      returnType: VOID,
    },
    {
      name: "confirm",
      direction: "server-to-client",
      params: [{ name: "question", type: scalar("string") }],
      returnType: scalar("boolean"),
    },
    {
      name: "notify",
      direction: "server-to-client",
      params: [{ name: "message", type: scalar("string") }],
      returnType: VOID,
    },
  ],
};

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("isolated Go emitter", () => {
  test("emits deterministic types matching the golden file", () => {
    const generated = generateGo(schema);
    const golden = readFileSync(path.join(FIXTURE_DIR, "types.generated.go"), "utf8");
    expect(generated["types.generated.go"]).toBe(golden);
    expect(generated["server.generated.go"]).toContain(
      `socket "${DEFAULT_GO_SOCKET_IMPORT}"`,
    );
  });

  test("emits gofmt-clean files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-go-format-"));
    temporaryDirectories.push(directory);
    const generated = generateGo(schema);
    for (const [filename, source] of Object.entries(generated)) {
      const file = path.join(directory, filename);
      writeFileSync(file, source);
      const formatted = spawnSync("gofmt", ["-d", file], { encoding: "utf8" });
      expect(formatted.status, formatted.stderr).toBe(0);
      expect(formatted.stdout, `${filename} is not gofmt-clean`).toBe("");
    }
  });

  test("refuses contracts that have no sound Go projection", () => {
    const withMethods = (methods: RpcSchema["methods"]): RpcSchema => ({ ...schema, methods });

    expect(() =>
      generateGo(
        withMethods([
          {
            name: "lookup",
            direction: "client-to-server",
            params: [{ name: "query", type: { kind: "optional", type: scalar("string") } }],
            returnType: scalar("string"),
          },
        ]),
      ),
    ).toThrow("optional positional parameters are ambiguous");

    expect(() =>
      generateGo({
        ...schema,
        declarations: [
          {
            kind: "object",
            name: "Node",
            fields: [{ name: "next", type: { kind: "named", name: "Node" } }],
          },
        ],
        methods: [],
      }),
    ).toThrow("recursive value types require");

    expect(() =>
      generateGo(
        withMethods([
          {
            name: "bad",
            direction: "client-to-server",
            params: [],
            returnType: { kind: "scalar", name: "unknown" } as never,
          },
        ]),
      ),
    ).toThrow('unsupported scalar "unknown"');

    // The IR keeps shapes TypeScript emission accepts but Go cannot name. Each
    // one is refused with the declaration the user should write instead.
    expect(() =>
      generateGo(
        withMethods([
          {
            name: "inlineObject",
            direction: "client-to-server",
            params: [
              { name: "filter", type: { kind: "object", fields: [{ name: "q", type: scalar("string") }] } },
            ],
            returnType: VOID,
          },
        ]),
      ),
    ).toThrow("Extract the shape into a named interface");

    expect(() =>
      generateGo(
        withMethods([
          {
            name: "inlineEnum",
            direction: "client-to-server",
            params: [{ name: "mode", type: { kind: "enum", values: ["a", "b"] } }],
            returnType: VOID,
          },
        ]),
      ),
    ).toThrow("Extract the union into a named type alias");

    // `Error` is the common real-world case: referenced by the contract but
    // never declared portably, so it reaches the backend without a declaration.
    expect(() =>
      generateGo(
        withMethods([
          {
            name: "showError",
            direction: "server-to-client",
            params: [{ name: "error", type: { kind: "named", name: "Error" } }],
            returnType: VOID,
          },
        ]),
      ),
    ).toThrow("'Error' is referenced but never declared");

    expect(() => generateGo(schema, { packageName: "Rpc" })).toThrow(
      "must be a lower-case Go package identifier",
    );
  });

  test("normalizes nil slice and map results so they never encode as null", () => {
    const listing: RpcSchema = {
      version: RPC_SCHEMA_VERSION,
      declarations: [],
      methods: [
        {
          name: "listNames",
          direction: "client-to-server",
          params: [],
          returnType: { kind: "array", element: scalar("string") },
        },
        {
          name: "listAttributes",
          direction: "client-to-server",
          params: [],
          returnType: { kind: "map", value: scalar("string") },
        },
        {
          name: "maybeNames",
          direction: "client-to-server",
          params: [],
          returnType: { kind: "nullable", type: { kind: "array", element: scalar("string") } },
        },
        {
          name: "count",
          direction: "client-to-server",
          params: [],
          returnType: scalar("number"),
        },
      ],
    };

    const server = generateGo(listing)["server.generated.go"];
    expect(server).toContain("result = []string{}");
    expect(server).toContain("result = map[string]string{}");
    // A nullable result means nil is a value the contract allows, so it stays.
    expect(server.match(/result == nil/g)).toHaveLength(2);
    // Scalars already encode their zero value correctly.
    expect(server).not.toContain("result = float64");
  });

  test("projects aliases, nested optionality, and empty structs", () => {
    const aliased: RpcSchema = {
      version: RPC_SCHEMA_VERSION,
      declarations: [
        { kind: "alias", name: "tagList", target: { kind: "array", element: scalar("string") } },
        { kind: "object", name: "Empty", fields: [] },
        {
          kind: "object",
          name: "Envelope",
          fields: [
            { name: "apiURL", type: scalar("string") },
            { name: "items", type: { kind: "named", name: "tagList" } },
            {
              name: "maybe",
              type: { kind: "optional", type: { kind: "nullable", type: scalar("number") } },
            },
          ],
        },
      ],
      methods: [
        {
          name: "wrap",
          direction: "client-to-server",
          params: [{ name: "envelope", type: { kind: "named", name: "Envelope" } }],
          returnType: { kind: "named", name: "Empty" },
        },
      ],
    };

    const types = generateGo(aliased)["types.generated.go"];
    expect(types).toContain("type TagList = []string");
    expect(types).toContain("type Empty struct{}");
    // Go's initialism conventions apply to derived field names.
    expect(types).toContain('APIURL string   `json:"apiURL"`');
    expect(types).toContain('Items  TagList  `json:"items"`');
    // Optional wrapping nullable is still a single pointer: both decode to nil.
    expect(types).toContain('Maybe  *float64 `json:"maybe,omitempty"`');

    const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-go-alias-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "types.generated.go");
    writeFileSync(file, types);
    const formatted = spawnSync("gofmt", ["-d", file], { encoding: "utf8" });
    expect(formatted.stdout, "alias projection is not gofmt-clean").toBe("");
  });

  test(
    "compiled bindings enforce ack, error, timeout, disconnect, and disposal behavior",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-go-compile-"));
      temporaryDirectories.push(directory);
      const generated = generateGo(schema);
      for (const [filename, source] of Object.entries(generated)) {
        writeFileSync(path.join(directory, filename), source);
      }
      cpSync(path.join(FIXTURE_DIR, "runtime_test.go"), path.join(directory, "runtime_test.go"));
      const stub = path.join(FIXTURE_DIR, "socketstub");
      writeFileSync(
        path.join(directory, "go.mod"),
        `module socketrpc.generated.test

go 1.22

require github.com/zishang520/socket.io/servers/socket/v3 v3.0.0

replace github.com/zishang520/socket.io/servers/socket/v3 => ${JSON.stringify(stub)}
`,
      );
      const result = spawnSync("go", ["test", "-race", "./..."], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
    35_000,
  );
});
