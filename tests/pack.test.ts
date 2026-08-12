import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";

// What ships to npm is decided by `files` in package.json and by nothing else.
// That boundary is invisible in normal development: the leak it prevents only
// appears on a machine that has local state — an agent's scratch directory, a
// half-finished fixture — sitting next to the source. So the gate is the pack
// npm itself computes, read back and checked path by path.
//
// `npm pack --dry-run` resolves the manifest and prints the file list without
// writing a tarball, which is why this test can run inside the repo it packs.

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TIMEOUT = 60_000;

/** npm always ships these regardless of `files`, so the allowlist must tolerate them. */
const ALWAYS_PACKED = /^(package\.json|README(\..*)?|LICEN[SC]E(\..*)?)$/i;

/** Every packed path must be one of these; anything else is a leak. */
const ALLOWED = (packedPath: string) =>
  ALWAYS_PACKED.test(packedPath) ||
  packedPath === "index.ts" ||
  packedPath === "CHANGELOG.md" ||
  packedPath === "MIGRATION.md" ||
  packedPath === "tsconfig.json" ||
  packedPath.startsWith("src/");

// Local state that lives on a developer's machine and in no commit. Writing it
// before packing is what separates "the allowlist excludes it" from "it merely
// was not there": .test-tmp is git-ignored, so without an allowlist npm would
// carry it, exactly as it carried .omc/ before this boundary existed.
const SCRATCH_DIRECTORY = path.join(PROJECT_ROOT, ".test-tmp");
const SENTINEL = path.join(SCRATCH_DIRECTORY, `pack-sentinel-${process.pid}.json`);
const SENTINEL_PACKED_PATH = path.relative(PROJECT_ROOT, SENTINEL).split(path.sep).join("/");

beforeAll(() => {
  mkdirSync(SCRATCH_DIRECTORY, { recursive: true });
  writeFileSync(SENTINEL, '{"secret":"local-only"}');
});

afterAll(() => {
  rmSync(SENTINEL, { force: true });
});

/** Runs the pack npm would run on publish and returns the paths it would carry. */
function packedPaths(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
  });

  if (result.error) {
    // npm decides what publishing includes, so a missing npm makes this gate
    // unenforceable rather than passing.
    throw new Error(`npm is required to verify the package boundary: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed (${result.status}):\n${result.stderr}`);
  }

  // --json puts the report on stdout and its human-readable notice on stderr,
  // but slicing to the array survives an npm that also greets on stdout.
  const stdout = result.stdout ?? "";
  const report = stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1);
  const [entry] = JSON.parse(report) as Array<{ files: Array<{ path: string }> }>;

  return entry.files.map((file) => file.path);
}

/** Every source file under src/, as the pack would spell it. */
function sourceFiles(directory = path.join(PROJECT_ROOT, "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) return sourceFiles(absolute);
    return [path.relative(PROJECT_ROOT, absolute).split(path.sep).join("/")];
  });
}

/**
 * `path.resolve(import.meta.dir, "..", "x")` is how a module reaches a file that
 * ships beside src/ rather than inside it. Reading those names back out of the
 * source is what makes this gate cover a file the day it is first reached for.
 *
 * A list written by hand here would have the blind spot that shipped 7.0.0
 * unusable: `tsconfig.json` travelled in every earlier tarball only because the
 * package had no `files` allowlist at all, so when the allowlist arrived and
 * named the trees a reader thinks of as the product, the parser config the
 * extractor loads at runtime stopped shipping and nothing said so.
 */
function rootRelativeRuntimeFiles(): string[] {
  const readers = [path.join(PROJECT_ROOT, "index.ts"), ...sourceFiles().map((f) => path.join(PROJECT_ROOT, f))];
  const pattern = /import\.meta\.dir\s*,\s*"\.\."\s*,\s*"([^"]+)"/g;

  const names = new Set<string>();
  for (const reader of readers) {
    for (const [, name] of readFileSync(reader, "utf-8").matchAll(pattern)) {
      names.add(name as string);
    }
  }
  return [...names].sort();
}

describe("published package boundary", () => {
  test(
    "carries every file the CLI and library need at runtime",
    () => {
      const packed = packedPaths();
      const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));

      // Read from the manifest rather than hardcoded: an entrypoint that moves
      // without `files` moving with it fails here instead of on install.
      const entrypoints = [manifest.main, manifest.module, ...Object.values(manifest.bin)] as string[];
      for (const entrypoint of new Set(entrypoints)) {
        expect(packed, `entrypoint ${entrypoint} is missing from the tarball`).toContain(entrypoint);
      }

      // The package publishes TypeScript source, so every src/ file is runtime
      // code. Deriving the list from disk means a new module is covered the day
      // it is written.
      const sources = sourceFiles();
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect(packed, `source ${source} is missing from the tarball`).toContain(source);
      }

      // Files the running code opens beside src/ rather than inside it: cli.ts
      // reads ../package.json for --version, extract.ts loads ../tsconfig.json as
      // the compiler options it parses a contract with. Missing one of these
      // installs cleanly and then fails on the consumer's first run.
      const ancillary = rootRelativeRuntimeFiles();
      expect(ancillary, "no root-relative runtime file was detected — has the pattern changed?").toContain(
        "tsconfig.json",
      );
      for (const runtimeFile of ancillary) {
        expect(packed, `${runtimeFile} is read at runtime but missing from the tarball`).toContain(runtimeFile);
      }

      expect(packed).toContain("README.md");
      expect(packed).toContain("CHANGELOG.md");
    },
    TIMEOUT,
  );

  test(
    "carries nothing else",
    () => {
      const packed = packedPaths();

      // The named cases are the ones that have shipped or nearly shipped, kept
      // explicit so a failure says which boundary broke.
      const forbidden = [
        // Local agent and editor state — the leak this boundary exists for.
        (packedPath: string) => packedPath === SENTINEL_PACKED_PATH,
        (packedPath: string) => packedPath.startsWith(".omc/"),
        (packedPath: string) => packedPath.startsWith(".test-tmp/"),
        (packedPath: string) => packedPath.startsWith(".claude/"),
        (packedPath: string) => packedPath === "CLAUDE.md",
        // Development-only trees.
        (packedPath: string) => packedPath.startsWith("tests/"),
        (packedPath: string) => packedPath.startsWith("examples/"),
        (packedPath: string) => packedPath.startsWith(".github/"),
        (packedPath: string) => packedPath.includes("node_modules/"),
        // Repo-local tooling config, meaningless to a consumer. tsconfig.json is
        // absent here on purpose: the extractor reads it at runtime, so it is
        // product, not tooling, and the test above requires it.
        (packedPath: string) => packedPath === "bun.lock",
        (packedPath: string) => packedPath.endsWith(".tgz"),
      ];
      for (const packedPath of packed) {
        for (const isForbidden of forbidden) {
          expect(isForbidden(packedPath), `${packedPath} must not be published`).toBe(false);
        }
      }

      // The allowlist is the actual gate: an artifact nobody thought to name
      // above still has to be one of the four things this package publishes.
      const unexpected = packed.filter((packedPath) => !ALLOWED(packedPath));
      expect(unexpected, "unexpected paths in the tarball").toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "inspects the pack without leaving a tarball in the repo",
    () => {
      packedPaths();
      const tarballs = readdirSync(PROJECT_ROOT).filter((name) => name.endsWith(".tgz"));
      expect(tarballs).toEqual([]);
    },
    TIMEOUT,
  );
});
