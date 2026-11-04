import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { run, useLocalSocketio } from "./helpers/go-server";

// The generated Go client against the generated Go server, both from one
// contract and one CLI invocation, in one Go module.
//
// The CLI writes `wire` (the contract types and the server) and `wireclient`
// (the client, which imports `wire` for every contract type) into a copy of
// fixtures/go-client. The checked-in fixtures/go-client/e2e_test.go then runs
// both sides in one process under the race detector: namespaces, auth and its
// refusal, reconnect after a kill and after a graceful close, ctx-first calls,
// per-method ordering on the client's handlers, Dial under load, and the
// payload limit. That file contributes only the handler implementations and a
// server harness; everything on the wire comes from generated code.
//
// Each Go test is reported here as its own bun test, so a failure names the
// requirement it belongs to and carries that test's own output.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "go-client");
const GENERATOR_PATH = join(resolve(import.meta.dir, ".."), "index.ts");
const GO_MODULE = "socketrpc.goclient.test";
const SOCKETIO_CLIENT_IMPORT = "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket";

// Generated, compiled and run during module evaluation rather than in
// beforeAll: generation plus a cold Go compile and a race-enabled run go far
// past bun:test's 5s hook budget, and hooks accept no timeout override.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-go-client-"));
const moduleDir = join(workDir, "module");
const wireDir = join(moduleDir, "wire");
const clientDir = join(moduleDir, "wireclient");
mkdirSync(moduleDir, { recursive: true });

cpSync(join(FIXTURE_DIR, "define.ts"), join(workDir, "define.ts"));
for (const file of ["go.mod", "go.sum", "e2e_test.go"]) {
  cpSync(join(FIXTURE_DIR, file), join(moduleDir, file));
}
useLocalSocketio(moduleDir);

// Both sides Go: the types and the server go to --go-out, the client to its own
// package, which reaches the types through the import path the generator
// derives from the go.mod above --go-out. `--timeout` is the default every call
// falls back to; e2e_test.go asserts it as `generatedTimeout`.
run(
  [
    "bun",
    GENERATOR_PATH,
    join(workDir, "define.ts"),
    "--client",
    "go",
    "--server",
    "go",
    "--go-out",
    wireDir,
    "--go-package",
    "wire",
    "--go-client-out",
    clientDir,
    "--go-client-package",
    "wireclient",
    "--timeout",
    "1500",
  ],
  workDir,
  "socketrpc-gen --client go --server go",
);

const gofmt = Bun.spawnSync(["gofmt", "-l", wireDir, clientDir], { stdout: "pipe", stderr: "pipe" });
const unformatted = `${gofmt.stdout.toString()}${gofmt.stderr.toString()}`.trim();

// Fetches the module graph first, so the vet report below holds the analyzers'
// findings and no `go: downloading …` progress from a cold module cache.
run(["go", "mod", "download"], moduleDir, "go mod download");

// The full analyzer set, nothing excluded, over both generated packages and the
// test that consumes them: `go test` runs only a subset.
const vet = Bun.spawnSync(["go", "vet", "./..."], { cwd: moduleDir, stdout: "pipe", stderr: "pipe" });
const vetReport = `${vet.stdout.toString()}${vet.stderr.toString()}`.trim();

const goTest = Bun.spawnSync(["go", "test", "-race", "-count=1", "-timeout", "10m", "-json", "./..."], {
  cwd: moduleDir,
  stdout: "pipe",
  stderr: "pipe",
});
const goTestStderr = goTest.stderr.toString();

type GoTestEvent = { Action: string; Test?: string; Output?: string };

function isGoTestEvent(value: unknown): value is GoTestEvent {
  if (typeof value !== "object" || value === null) return false;
  const action: unknown = Reflect.get(value, "Action");
  const name: unknown = Reflect.get(value, "Test");
  const output: unknown = Reflect.get(value, "Output");
  return (
    typeof action === "string" &&
    (name === undefined || typeof name === "string") &&
    (output === undefined || typeof output === "string")
  );
}

/** The top-level Go test a (sub)test name belongs to. */
const topLevel = (name: string): string => name.split("/")[0] ?? name;

const outcomes = new Map<string, string>();
const outputs = new Map<string, string>();
let unattributed = "";
for (const line of goTest.stdout.toString().split("\n")) {
  if (line.trim() === "") continue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    unattributed += `${line}\n`;
    continue;
  }
  if (!isGoTestEvent(parsed)) continue;
  if (parsed.Test === undefined) {
    unattributed += parsed.Output ?? "";
    continue;
  }
  const owner = topLevel(parsed.Test);
  if (parsed.Output !== undefined) outputs.set(owner, (outputs.get(owner) ?? "") + parsed.Output);
  if (parsed.Test === owner && ["pass", "fail", "skip"].includes(parsed.Action)) {
    outcomes.set(owner, parsed.Action);
  }
}

// Read from the source, so a test added to e2e_test.go is reported here the
// day it is written, and one that never ran is a failure rather than a gap.
const goTests = [
  ...readFileSync(join(FIXTURE_DIR, "e2e_test.go"), "utf8").matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm),
].map((match) => match[1] ?? "");

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("one contract generates a Go server and a Go client into one module", () => {
  test("the types are written once, into the server package, and nothing else is written", () => {
    expect(readdirSync(wireDir).sort()).toEqual(["server.generated.go", "types.generated.go"]);
    expect(readdirSync(clientDir).sort()).toEqual(["client.generated.go"]);
    // No TypeScript output and no package scaffold next to the contract.
    expect(readdirSync(workDir).sort()).toEqual(["define.ts", "module"]);
  });

  test("the client imports the server package for every contract type and the socket under an alias", () => {
    const source = readFileSync(join(clientDir, "client.generated.go"), "utf8");
    expect(source).toMatch(/^package wireclient$/m);
    expect(source).toMatch(new RegExp(`^\\s*(wire )?"${GO_MODULE.replaceAll(".", "\\.")}/wire"$`, "m"));
    expect(source).toContain(`sioclient "${SOCKETIO_CLIENT_IMPORT}"`);
    expect(source).not.toMatch(/^type (Session|Job|JobResult|RpcError|RpcErrorCode) /m);
    expect(source).toContain("wire.JobResult");
  });

  test("every generated file is gofmt-clean", () => {
    expect(unformatted, `gofmt reported:\n${unformatted}`).toBe("");
  });

  test("both packages and the test that uses them pass go vet with no exclusions", () => {
    expect(vetReport, `go vet reported:\n${vetReport}`).toBe("");
    expect(vet.exitCode).toBe(0);
  });
});

describe("generated Go client against the generated Go server (go test -race)", () => {
  test("e2e_test.go declares tests, and the run exits cleanly", () => {
    expect(goTests.length).toBeGreaterThan(0);
    expect(goTest.exitCode, `go test exited ${goTest.exitCode}:\n${unattributed}\n${goTestStderr}`).toBe(0);
  });

  for (const name of goTests) {
    test(name, () => {
      const report = outputs.get(name) ?? `${name} never ran:\n${unattributed}\n${goTestStderr}`;
      expect(outcomes.get(name), report).toBe("pass");
    });
  }
});
