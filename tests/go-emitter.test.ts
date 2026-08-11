import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  DEFAULT_GO_SOCKET_IMPORT,
  generateGo,
  type GoEmitterSchema,
} from "../src/go";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "go-emitter");
const temporaryDirectories: string[] = [];

const scalar = (name: "string" | "boolean" | "number" | "integer") =>
  ({ kind: "scalar", name }) as const;

const schema: GoEmitterSchema = {
  packageName: "rpc",
  declarations: [
    { kind: "enum", name: "Status", values: ["active", "pending-review"] },
    {
      kind: "object",
      name: "User",
      fields: [
        { name: "id", goName: "ID", type: scalar("string") },
        { name: "displayName", type: scalar("string") },
        { name: "score", type: { kind: "nullable", value: scalar("number") } },
        { name: "tags", type: { kind: "array", element: scalar("string") }, optional: true },
        { name: "attributes", type: { kind: "map", value: scalar("string") } },
        { name: "status", type: { kind: "named", name: "Status" } },
      ],
    },
  ],
  clientToServer: [
    {
      name: "getUser",
      params: [
        { name: "userID", type: scalar("string") },
        { name: "includeDeleted", type: scalar("boolean") },
      ],
      result: { kind: "named", name: "User" },
    },
    { name: "deleteUser", params: [{ name: "userID", type: scalar("string") }] },
  ],
  serverToClient: [
    {
      name: "confirm",
      params: [{ name: "question", type: scalar("string") }],
      result: scalar("boolean"),
    },
    { name: "notify", params: [{ name: "message", type: scalar("string") }] },
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

  test("rejects ambiguous and unsupported schema shapes", () => {
    expect(() =>
      generateGo({
        ...schema,
        clientToServer: [
          {
            name: "lookup",
            params: [{ name: "query", type: scalar("string"), optional: true }],
            result: scalar("string"),
          },
        ],
      }),
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
        clientToServer: [],
        serverToClient: [],
      }),
    ).toThrow("recursive value types require");

    expect(() =>
      generateGo({
        ...schema,
        clientToServer: [
          {
            name: "bad",
            params: [],
            result: { kind: "scalar", name: "unknown" } as never,
          },
        ],
      }),
    ).toThrow('unsupported scalar "unknown"');
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
