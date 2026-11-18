import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { extractRpcSchemaFromFile } from "../src/extract";
import { RPC_SCHEMA_VERSION } from "../src/schema";

// `--schema-out` publishes the portable IR as JSON, so a tool that is not
// written in TypeScript can read a contract without a TypeScript toolchain.
// The file must be the IR itself, and a contract the IR cannot model must be
// refused before anything is written: a stale schema beside a fresh package
// would tell a consumer the contract is something it no longer is.

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const GENERATOR_PATH = path.join(PROJECT_ROOT, "index.ts");
const PORTABLE = path.join(PROJECT_ROOT, "examples", "05-go-server", "define.ts");
// Uses `Error` in a signature: valid TypeScript, no portable wire shape.
const UNPORTABLE = path.join(PROJECT_ROOT, "examples", "00-full-app", "pkg", "rpc", "define.ts");

const TIMEOUT = 60_000;
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function generate(defineFile: string, flags: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-schema-out-"));
  temporaryDirectories.push(directory);
  cpSync(defineFile, path.join(directory, "define.ts"));
  const result = spawnSync("bun", ["run", GENERATOR_PATH, path.join(directory, "define.ts"), ...flags], {
    cwd: directory,
    encoding: "utf-8",
  });
  return {
    directory,
    exitCode: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    files: readdirSync(directory).sort(),
  };
}

describe("--schema-out", () => {
  test(
    "writes the contract's RpcSchema as JSON, relative to the working directory",
    async () => {
      const run = generate(PORTABLE, ["--schema-out", "./contract.schema.json"]);
      expect(run.exitCode).toBe(0);

      const written: unknown = JSON.parse(readFileSync(path.join(run.directory, "contract.schema.json"), "utf-8"));
      const expected = await extractRpcSchemaFromFile(PORTABLE);
      expect(written).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(expected.version).toBe(RPC_SCHEMA_VERSION);
    },
    TIMEOUT,
  );

  test(
    "refuses a contract the IR cannot model, writing neither the schema nor the package",
    () => {
      const run = generate(UNPORTABLE, ["--schema-out", "./contract.schema.json"]);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("SocketRPC schema extraction failed");
      expect(existsSync(path.join(run.directory, "contract.schema.json"))).toBe(false);
      expect(run.files).toEqual(["define.ts"]);
    },
    TIMEOUT,
  );
});
