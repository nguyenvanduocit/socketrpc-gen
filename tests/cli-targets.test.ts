import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";

// The `--client` / `--server` flags decide which backends run, so their failure
// modes are part of the CLI contract: an unsupported combination must be refused
// by name, and a contract Go cannot model must be refused *before* anything is
// written. A generator that half-writes a package on failure is worse than one
// that refuses, because the next build reads stale files.

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const GENERATOR_PATH = path.join(PROJECT_ROOT, "index.ts");
const EXAMPLES = path.join(PROJECT_ROOT, "examples");

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/** Copies one define.ts into a scratch directory and runs the CLI against it. */
function generate(defineFile: string, flags: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-cli-"));
  temporaryDirectories.push(directory);
  cpSync(defineFile, path.join(directory, "define.ts"));

  const result = spawnSync("bun", ["run", GENERATOR_PATH, path.join(directory, "define.ts"), ...flags], {
    encoding: "utf-8",
  });

  return {
    directory,
    exitCode: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    files: readdirSync(directory).sort(),
  };
}

const PORTABLE = path.join(EXAMPLES, "05-go-server", "define.ts");
// Uses `Error` in a signature: valid TypeScript, no portable wire shape.
const UNPORTABLE = path.join(EXAMPLES, "00-full-app", "pkg", "rpc", "define.ts");

const TIMEOUT = 60_000;

describe("CLI target selection", () => {
  test(
    "refuses a Go client and names the combination that works",
    () => {
      const run = generate(PORTABLE, ["--client", "go", "--server", "go"]);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("A Go client is not available yet");
      expect(run.output).toContain("--client typescript --server go");
      expect(run.files).toEqual(["define.ts"]);
    },
    TIMEOUT,
  );

  test(
    "refuses an unknown language rather than silently defaulting",
    () => {
      const run = generate(PORTABLE, ["--server", "rust"]);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("Unknown server language 'rust'");
      expect(run.output).toContain("typescript, go");
      expect(run.files).toEqual(["define.ts"]);
    },
    TIMEOUT,
  );

  test(
    "refuses a contract Go cannot model without writing a half-generated package",
    () => {
      const run = generate(UNPORTABLE, ["--server", "go"]);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("'Error' is referenced but never declared");
      // The message must name the fix, not just the problem.
      expect(run.output).toContain("Declare it as an interface, type alias, or string enum");
      // Nothing written: no client, no types, no package scaffold.
      expect(run.files).toEqual(["define.ts"]);
    },
    TIMEOUT,
  );

  test(
    "still generates that same contract for an all-TypeScript target",
    () => {
      // The TypeScript backend reads the signatures as written, so a contract the
      // Go backend refuses must keep working on the default path. This is the
      // guard against the portable IR tightening TypeScript generation.
      const run = generate(UNPORTABLE, []);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.files).toContain("client.generated.ts");
      expect(run.files).toContain("server.generated.ts");
      expect(run.files).toContain("types.generated.ts");
    },
    TIMEOUT,
  );

  test(
    "defaults to an all-TypeScript package with no Go output",
    () => {
      const run = generate(PORTABLE, []);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.files).toContain("server.generated.ts");
      expect(run.files.some((file) => file.endsWith(".go"))).toBe(false);
      expect(existsSync(path.join(run.directory, "rpc"))).toBe(false);
    },
    TIMEOUT,
  );
});
