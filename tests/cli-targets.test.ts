import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
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

/**
 * Copies one define.ts into a scratch directory and runs the CLI against it
 * from that directory, so relative output flags land inside it. `prepare`
 * writes whatever else the run needs first, such as a go.mod.
 */
function generate(defineFile: string, flags: string[], prepare?: (directory: string) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-cli-"));
  temporaryDirectories.push(directory);
  cpSync(defineFile, path.join(directory, "define.ts"));
  prepare?.(directory);

  const result = spawnSync("bun", ["run", GENERATOR_PATH, path.join(directory, "define.ts"), ...flags], {
    cwd: directory,
    encoding: "utf-8",
  });

  return {
    directory,
    exitCode: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    files: readdirSync(directory).sort(),
    tree: filesUnder(directory).sort(),
  };
}

/** Every file under `directory`, as POSIX paths relative to it. */
function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

const GO_MODULE = "example.com/app";
const withGoModule = (directory: string) =>
  writeFileSync(path.join(directory, "go.mod"), `module ${GO_MODULE}\n\ngo 1.22\n`);

/** The flags that put a Go server and a Go client into two packages of one module. */
const SEPARATE_GO_CLIENT = [
  "--client",
  "go",
  "--server",
  "go",
  "--go-out",
  "./wire",
  "--go-package",
  "wire",
  "--go-client-out",
  "./wireclient",
  "--go-client-package",
  "wireclient",
];

/** The Go types + server in ./wire, and a Go client of its own in ./workerclient. */
const GO_SERVER_IN_WIRE = ["--server", "go", "--go-out", "./wire", "--go-package", "wire"];
const GO_CLIENT_IN_WORKERCLIENT = ["--go-client-out", "./workerclient", "--go-client-package", "workerclient"];

/** The contents of `files`, relative to `directory`, keyed by path. */
function contents(directory: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file, readFileSync(path.join(directory, file), "utf-8")]));
}

const PORTABLE = path.join(EXAMPLES, "05-go-server", "define.ts");
// Uses `Error` in a signature: valid TypeScript, no portable wire shape.
const UNPORTABLE = path.join(EXAMPLES, "00-full-app", "pkg", "rpc", "define.ts");

const TIMEOUT = 60_000;

describe("CLI target selection", () => {
  test(
    "refuses a Go client and a Go server sharing one package, naming the flags that separate them",
    () => {
      const run = generate(PORTABLE, ["--client", "go", "--server", "go"], withGoModule);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("--go-client-out");
      expect(run.output).toContain("--go-client-package");
      expect(run.files).toEqual(["define.ts", "go.mod"]);
    },
    TIMEOUT,
  );

  test(
    "refuses every Go client layout that cannot be written, before writing anything",
    () => {
      const refusals: [string[], string, ((directory: string) => void) | undefined][] = [
        // The client cannot be its own package in the server's directory.
        [
          [...SEPARATE_GO_CLIENT.slice(0, 8), "--go-client-out", "./wire", "--go-client-package", "wireclient"],
          "--go-client-out must differ from --go-out",
          withGoModule,
        ],
        [SEPARATE_GO_CLIENT.slice(0, 10), "--go-client-out needs --go-client-package", withGoModule],
        [
          [...SEPARATE_GO_CLIENT.slice(0, 10), "--go-client-package", "wire"],
          "--go-client-package must differ from --go-package",
          withGoModule,
        ],
        // Two spellings of one directory: the same on a case-insensitive filesystem,
        // and refused by `go build` as a case-insensitive import collision on any.
        [
          [...SEPARATE_GO_CLIENT.slice(0, 4), "--go-out", "./Wire", "--go-package", "wire", "--go-client-out", "./wire", "--go-client-package", "wireclient"],
          "--go-client-out must differ from --go-out",
          withGoModule,
        ],
        // A Go client in a list still needs its own package beside a Go server.
        [["--client", "typescript,go", ...GO_SERVER_IN_WIRE], "--go-client-out <dir> and --go-client-package <name>", withGoModule],
        [
          ["--client", "typescript,go", "--go-out", "./goclient", ...GO_CLIENT_IN_WORKERCLIENT],
          "--go-client-out separates the Go client from a Go server",
          undefined,
        ],
        // --client is a list of distinct, known languages; --server is one language.
        [["--client", "typescript,typescript"], "--client lists 'typescript' twice", undefined],
        [["--client", "typescript,rust"], "Unknown client language 'rust' in --client", undefined],
        [["--client", "typescript,"], "Unknown client language '' in --client", undefined],
        [["--server", "typescript,go"], "--server takes one language", undefined],
        // The client imports the types package by its module path.
        [SEPARATE_GO_CLIENT, "No go.mod at or above --go-out", undefined],
        [["--client", "go", "--go-client-package", "wireclient"], "--go-client-package names the package in --go-client-out", undefined],
        [
          ["--client", "go", "--go-client-out", "./wireclient", "--go-client-package", "wireclient"],
          "--go-client-out separates the Go client from a Go server",
          undefined,
        ],
      ];

      for (const [flags, message, prepare] of refusals) {
        const run = generate(PORTABLE, flags, prepare);
        expect(run.exitCode, `${flags.join(" ")}\n${run.output}`).toBe(1);
        expect(run.output).toContain(message);
        expect(run.files, `${flags.join(" ")} wrote files`).toEqual(
          prepare ? ["define.ts", "go.mod"] : ["define.ts"],
        );
      }
    },
    TIMEOUT,
  );

  test(
    "writes a Go client beside a TypeScript server, sharing one Go types package",
    () => {
      const run = generate(PORTABLE, ["--client", "go", "--server", "typescript", "--go-out", "./goclient"]);
      expect(run.exitCode, run.output).toBe(0);
      // The TypeScript side has only the server; the Go side has the client and
      // the types it shares a package with.
      expect(run.tree).toEqual([
        "define.ts",
        "goclient/client.generated.go",
        "goclient/types.generated.go",
        "package.json",
        "server.generated.ts",
        "tsconfig.json",
        "types.generated.ts",
      ]);
      const manifest = JSON.parse(readFileSync(path.join(run.directory, "package.json"), "utf-8"));
      expect(Object.keys(manifest.exports)).not.toContain("./client.generated");
      expect(manifest.dependencies).not.toHaveProperty("socket.io-client");
    },
    TIMEOUT,
  );

  test(
    "writes a Go server and a Go client as two packages of one module, and no TypeScript",
    () => {
      const run = generate(PORTABLE, SEPARATE_GO_CLIENT, withGoModule);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.tree).toEqual([
        "define.ts",
        "go.mod",
        "wire/server.generated.go",
        "wire/types.generated.go",
        "wireclient/client.generated.go",
      ]);
      // The import path is the module's, read from the go.mod above --go-out.
      const client = readFileSync(path.join(run.directory, "wireclient", "client.generated.go"), "utf-8");
      expect(client).toContain(`wire "${GO_MODULE}/wire"`);
      expect(client).toMatch(/^package wireclient$/m);
    },
    TIMEOUT,
  );

  test(
    "refuses --go-client-out reaching --go-out through a symlink",
    () => {
      const run = generate(
        PORTABLE,
        [...SEPARATE_GO_CLIENT.slice(0, 8), "--go-client-out", "./alias", "--go-client-package", "wireclient"],
        (directory) => {
          withGoModule(directory);
          mkdirSync(path.join(directory, "wire"));
          symlinkSync(path.join(directory, "wire"), path.join(directory, "alias"));
        },
      );
      expect(run.exitCode, run.output).toBe(1);
      expect(run.output).toContain("--go-client-out must differ from --go-out");
      expect(readdirSync(path.join(run.directory, "wire"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "writes a TypeScript client, a Go server and a separate Go client from one run",
    () => {
      const run = generate(
        PORTABLE,
        ["--client", "typescript,go", ...GO_SERVER_IN_WIRE, ...GO_CLIENT_IN_WORKERCLIENT],
        withGoModule,
      );
      expect(run.exitCode, run.output).toBe(0);
      expect(run.tree).toEqual([
        "client.generated.ts",
        "define.ts",
        "go.mod",
        "package.json",
        "tsconfig.json",
        "types.generated.ts",
        "wire/server.generated.go",
        "wire/types.generated.go",
        "workerclient/client.generated.go",
      ]);
      const client = readFileSync(path.join(run.directory, "workerclient", "client.generated.go"), "utf-8");
      expect(client).toContain(`wire "${GO_MODULE}/wire"`);
      expect(client).toMatch(/^package workerclient$/m);
      // The TypeScript package advertises the client it holds, and no server.
      const manifest = JSON.parse(readFileSync(path.join(run.directory, "package.json"), "utf-8"));
      expect(Object.keys(manifest.exports)).toContain("./client.generated");
      expect(Object.keys(manifest.exports)).not.toContain("./server.generated");
    },
    TIMEOUT,
  );

  test(
    "writes byte for byte what the two single-client runs write",
    () => {
      const typescriptClient = generate(PORTABLE, ["--client", "typescript", ...GO_SERVER_IN_WIRE], withGoModule);
      const goClient = generate(PORTABLE, ["--client", "go", ...GO_SERVER_IN_WIRE, ...GO_CLIENT_IN_WORKERCLIENT], withGoModule);
      const both = generate(
        PORTABLE,
        ["--client", "typescript,go", ...GO_SERVER_IN_WIRE, ...GO_CLIENT_IN_WORKERCLIENT],
        withGoModule,
      );
      for (const run of [typescriptClient, goClient, both]) expect(run.exitCode, run.output).toBe(0);

      const goServer = ["wire/server.generated.go", "wire/types.generated.go"];
      const goServerFiles = contents(both.directory, goServer);
      expect(contents(typescriptClient.directory, goServer)).toEqual(goServerFiles);
      expect(contents(goClient.directory, goServer)).toEqual(goServerFiles);

      const goClientFile = ["workerclient/client.generated.go"];
      expect(contents(both.directory, goClientFile)).toEqual(contents(goClient.directory, goClientFile));

      const typescript = ["client.generated.ts", "package.json", "tsconfig.json", "types.generated.ts"];
      expect(contents(both.directory, typescript)).toEqual(contents(typescriptClient.directory, typescript));
    },
    TIMEOUT,
  );

  test(
    "colocates a Go client beside its types in --go-out when the server is TypeScript, as a single --client go does",
    () => {
      const goClientFlags = ["--server", "typescript", "--go-out", "./goclient"];
      const alone = generate(PORTABLE, ["--client", "go", ...goClientFlags]);
      const both = generate(PORTABLE, ["--client", "typescript,go", ...goClientFlags]);
      for (const run of [alone, both]) expect(run.exitCode, run.output).toBe(0);

      expect(both.tree).toEqual([
        "client.generated.ts",
        "define.ts",
        "goclient/client.generated.go",
        "goclient/types.generated.go",
        "package.json",
        "server.generated.ts",
        "tsconfig.json",
        "types.generated.ts",
      ]);
      const goFiles = ["goclient/client.generated.go", "goclient/types.generated.go"];
      expect(contents(both.directory, goFiles)).toEqual(contents(alone.directory, goFiles));
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
