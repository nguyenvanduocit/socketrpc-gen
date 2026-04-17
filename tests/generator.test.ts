import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, mkdirSync, rmSync, cpSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const GENERATOR_PATH = path.join(PROJECT_ROOT, "index.ts");

const GENERATED_FILES = [
  "client.generated.ts",
  "server.generated.ts",
  "types.generated.ts",
] as const;

type Example = { dir: string; deps: string[] };

// Each example's define.ts is the input. `deps` lists sibling .ts files the define.ts imports from.
const EXAMPLES: Example[] = [
  { dir: "examples/01-basic", deps: [] },
  { dir: "examples/02-single-extension", deps: ["base.define.ts"] },
  {
    dir: "examples/03-multi-level-extension",
    deps: ["framework.define.ts", "platform.define.ts"],
  },
  { dir: "examples/04-zod-integration", deps: [] },
  { dir: "examples/00-full-app/pkg/rpc", deps: [] },
];

// Generated headers embed the absolute input path (e.g. "bunx socketrpc-gen /abs/path/define.ts").
// Normalize to make snapshot comparisons path-independent.
function normalizeHeader(content: string): string {
  return content.replace(/bunx socketrpc-gen .+$/gm, "bunx socketrpc-gen <PATH>");
}

function runGenerator(inputFile: string): { exitCode: number; stderr: string; stdout: string } {
  const result = spawnSync("bun", ["run", GENERATOR_PATH, inputFile], {
    encoding: "utf-8",
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each test spawns `bun run index.ts`, which pays the ts-morph cold-start cost
// (typically 3-5s, occasionally more on first run after checkout).
const TEST_TIMEOUT_MS = 60_000;

describe("generator snapshot tests", () => {
  for (const ex of EXAMPLES) {
    test(
      ex.dir,
      () => {
      const exampleDir = path.join(PROJECT_ROOT, ex.dir);
      // tmp must live inside PROJECT_ROOT so ts-morph's module resolution can walk up
      // to the project's node_modules (needed for e.g. the zod example).
      const tmp = path.join(
        PROJECT_ROOT,
        ".test-tmp",
        `sockrpc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmp, { recursive: true });
      createdDirs.push(tmp);

      // Copy define.ts + any imported siblings
      for (const f of ["define.ts", ...ex.deps]) {
        cpSync(path.join(exampleDir, f), path.join(tmp, f));
      }

      const tmpInput = path.join(tmp, "define.ts");
      const { exitCode, stderr } = runGenerator(tmpInput);
      expect(exitCode, `generator failed for ${ex.dir}: ${stderr}`).toBe(0);

      for (const gen of GENERATED_FILES) {
        const actual = readFileSync(path.join(tmp, gen), "utf-8");
        const expected = readFileSync(path.join(exampleDir, gen), "utf-8");
        expect(normalizeHeader(actual), `drift in ${ex.dir}/${gen}`).toBe(
          normalizeHeader(expected),
        );
      }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
