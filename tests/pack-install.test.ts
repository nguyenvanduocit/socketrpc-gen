import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

// 7.0.0 shipped a tarball that installed cleanly and could not generate: the
// extractor loads the package's own tsconfig.json as the compiler options it
// parses a contract with, and the `files` allowlist did not carry it. Every gate
// in this suite passed, because every one of them ran the generator from the
// working tree — where that file is present whether or not it ships.
//
// So this test refuses to look at the working tree. It packs what npm would
// publish, installs that tarball into a directory outside the repository, and
// runs the binary the installation put on disk. What survives is the product.

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TIMEOUT = 300_000;

// A contract small enough to read in one breath, carrying one method in each
// direction so a run exercises both emitters rather than an empty schedule.
// Methods are properties with a function type, which is the shape the extractor
// reads; a method shorthand is not picked up.
const CONTRACT = `export interface ServerFunctions {
  greet: (name: string) => string;
}

export interface ClientFunctions {
  notify: (message: string) => void;
}
`;

/** Packs the publishable tarball into `destination` and returns its path. */
function pack(destination: string): string {
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: PROJECT_ROOT, encoding: "utf-8" },
  );

  if (result.error) {
    throw new Error(`npm is required to build the publishable tarball: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm pack failed (${result.status}):\n${result.stderr}`);
  }

  const stdout = result.stdout ?? "";
  const report = stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1);
  const [entry] = JSON.parse(report) as Array<{ filename: string }>;

  // npm reports the filename it wrote; scoped names arrive slashed while the file
  // on disk is flat, so the basename is the only spelling that always resolves.
  return path.join(destination, path.basename(entry.filename));
}

let installed: string | undefined;

/**
 * Packs, installs, and returns the consumer directory — once, on first use.
 *
 * Lazily rather than in `beforeAll` because packing and installing takes longer
 * than bun's five-second hook budget, and the per-test timeout is the only one
 * of the two that `@types/bun` lets a caller raise.
 */
function consumer(): string {
  if (installed) return installed;

  // Outside the repository, so nothing here can reach the working tree by a
  // relative path and quietly pass on a file that does not ship.
  const workspace = mkdtempSync(path.join(tmpdir(), "socketrpc-gen-install-"));
  const tarball = pack(workspace);

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "consumer", version: "0.0.0", private: true, type: "module" }, null, 2),
  );

  // The contract lives in its own directory: generation writes a package.json and
  // tsconfig.json scaffold beside the contract, which at the workspace root would
  // land on top of the consumer's own manifest.
  mkdirSync(path.join(workspace, "rpc"), { recursive: true });
  writeFileSync(path.join(workspace, "rpc", "define.ts"), CONTRACT);

  const install = spawnSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  if (install.status !== 0) {
    throw new Error(`installing the tarball failed (${install.status}):\n${install.stdout}\n${install.stderr}`);
  }

  installed = workspace;
  return workspace;
}

afterAll(() => {
  if (installed) rmSync(installed, { recursive: true, force: true });
});

/** Runs the CLI the installation put on disk, from the consumer's directory. */
function runInstalledCli(args: string[]): { status: number | null; output: string } {
  const workspace = consumer();
  const binary = path.join(workspace, "node_modules", ".bin", "socketrpc-gen");
  const result = spawnSync(binary, args, { cwd: workspace, encoding: "utf-8" });

  if (result.error) {
    throw new Error(`could not run the installed CLI: ${result.error.message}`);
  }
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("the installed package", () => {
  test(
    "puts the CLI on disk and reports the version being published",
    () => {
      const version = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8")).version;
      const { status, output } = runInstalledCli(["--version"]);

      expect(output).toContain(version);
      expect(status).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "generates a TypeScript package from a contract outside the repository",
    () => {
      const workspace = consumer();
      const { status, output } = runInstalledCli(["./rpc/define.ts"]);
      expect(output, "generation failed").not.toContain("Error:");
      expect(status).toBe(0);

      for (const generated of ["types.generated.ts", "client.generated.ts", "server.generated.ts"]) {
        expect(existsSync(path.join(workspace, "rpc", generated)), `${generated} was not written`).toBe(true);
      }

      // The contract's own vocabulary, so this asserts the extractor read the
      // input rather than that some file merely appeared.
      expect(readFileSync(path.join(workspace, "rpc", "client.generated.ts"), "utf-8")).toContain("greet");
      expect(readFileSync(path.join(workspace, "rpc", "server.generated.ts"), "utf-8")).toContain("notify");
    },
    TIMEOUT,
  );

  test(
    "generates a Go server from that same contract",
    () => {
      const workspace = consumer();
      const { status, output } = runInstalledCli([
        "./rpc/define.ts",
        "--client",
        "typescript",
        "--server",
        "go",
        "--go-out",
        "./rpc/gopkg",
        "--go-package",
        "rpc",
      ]);
      expect(output, "Go generation failed").not.toContain("Error:");
      expect(status).toBe(0);

      const server = path.join(workspace, "rpc", "gopkg", "server.generated.go");
      expect(existsSync(server), "server.generated.go was not written").toBe(true);

      // The inbound method reaches the handler interface under its own prefix,
      // which is the shape a consumer writes against.
      expect(readFileSync(server, "utf-8")).toContain("HandleGreet");
    },
    TIMEOUT,
  );
});
