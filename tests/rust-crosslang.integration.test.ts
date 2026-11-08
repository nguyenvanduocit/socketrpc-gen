import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { run, waitForAddress } from "./helpers/go-server";

// End-to-end harness for the Rust backend, both sides.
//
// fixtures/rust-crosslang/define.ts is generated twice through the CLI:
//   1. `--client typescript,rust --server rust`: the Rust module (server and
//      client) into a copy of fixtures/rust-crosslang/crate, plus the TypeScript
//      client package.
//   2. `--client rust --server typescript`: the TypeScript server package, and a
//      Rust client that must be byte for byte the one run 1 wrote.
// The crate's two binaries implement nothing but the generated ServerHandler and
// ClientHandler. They are driven in every pairing the backends allow:
//   - generated Rust client  -> generated Rust server
//   - generated TS client    -> generated Rust server
//   - generated Rust client  -> generated TS server (in this process)
// The Rust client prints one JSON line per check; the TS client is asserted here.

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "rust-crosslang");
const GENERATOR_PATH = join(ROOT, "index.ts");
// Persistent across runs and outside the temporary crate, so only the first run
// on a machine pays for compiling socketioxide, axum and tokio.
const CARGO_TARGET_DIR = join(ROOT, ".test-tmp", "cargo-target");
const T = 30_000;

// Generated, compiled and started during module evaluation rather than in
// beforeAll: a cold cargo build runs far past bun:test's 5s hook budget.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-rust-"));
const rustTsDir = join(workDir, "rust-server-ts");
const tsServerDir = join(workDir, "ts-server");
const crateDir = join(workDir, "crate");
for (const dir of [rustTsDir, tsServerDir]) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURE_DIR, "define.ts"), join(dir, "define.ts"));
}
cpSync(join(FIXTURE_DIR, "crate"), crateDir, { recursive: true });
writeFileSync(
  join(crateDir, "Cargo.toml"),
  `[package]
name = "rust-crosslang"
version = "0.0.0"
edition = "2021"
publish = false

[features]
# serde_json's preserve_order makes a Value an IndexMap, more than doubling its
# size: the generated code must stay clippy-clean either way.
preserve_order = ["serde_json/preserve_order"]

[dependencies]
axum = "0.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
socketioxide = "0.18"
socketrpc-socketio-client = { path = ${JSON.stringify(join(ROOT, "rust", "socketio-client"))} }
tokio = { version = "1", features = ["full"] }
`,
);

run(
  [
    "bun", GENERATOR_PATH, join(rustTsDir, "define.ts"),
    "--client", "typescript,rust", "--server", "rust", "--rust-out", join(crateDir, "src", "rpc"),
  ],
  workDir,
  "socketrpc-gen --client typescript,rust --server rust",
);
const secondRustOut = join(workDir, "rust-client-only");
run(
  [
    "bun", GENERATOR_PATH, join(tsServerDir, "define.ts"),
    "--client", "rust", "--server", "typescript", "--rust-out", secondRustOut,
  ],
  workDir,
  "socketrpc-gen --client rust --server typescript",
);

const cargoEnv = { ...process.env, CARGO_TARGET_DIR };
const cargo = (args: string[], label: string) => {
  const result = Bun.spawnSync(["cargo", ...args], { cwd: crateDir, env: cargoEnv, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`, label };
};
const build = cargo(["build", "--locked", "--bins"], "cargo build");
if (!build.ok) throw new Error(`cargo build failed:\n${build.output}`);
// -D warnings over the generated module and the program consuming it.
const clippy = cargo(["clippy", "--locked", "--bins", "--", "-D", "warnings"], "cargo clippy");
const clippyPreserveOrder = cargo(
  ["clippy", "--locked", "--bins", "--features", "preserve_order", "--", "-D", "warnings"],
  "cargo clippy --features preserve_order",
);

const binDir = join(CARGO_TARGET_DIR, "debug");
const rustServer = Bun.spawn([join(binDir, "server")], { stdout: "pipe", stderr: "inherit" });
const rustServerUrl = `http://${await waitForAddress(rustServer, 15_000)}`;

/** Runs the Rust client binary against `url` and returns its check lines by name. */
async function runRustClient(url: string): Promise<Map<string, { ok: boolean; detail: string }>> {
  const child = Bun.spawn([join(binDir, "client"), url], { stdout: "pipe", stderr: "inherit" });
  const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const output = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(kill);
  if (!output.includes("DONE")) throw new Error(`rust client did not finish (exit ${child.exitCode}):\n${output}`);
  const checks = new Map<string, { ok: boolean; detail: string }>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = JSON.parse(line);
    checks.set(parsed.check, { ok: parsed.ok, detail: parsed.detail });
  }
  return checks;
}

/**
 * The wire form of every `Outcome` variant, as TypeScript writes it. The Rust
 * server answers `outcome(kind)` with `sample_outcome` in the crate's lib.rs,
 * which must serialize to exactly these objects.
 */
const OUTCOMES: Record<string, unknown> = {
  ready: { kind: "ready", priority: "in-progress", stepCount: 3, note: "n" },
  needPhoto: { kind: "needPhoto", spoken: "one more angle", due: null },
  wrapped: { kind: "wrapped", inner: { kind: "empty" }, owner: null },
  empty: { kind: "empty" },
  raw: { kind: "raw", first: { x: 1 }, second: [1, "two"], third: null },
};

const RUST_CLIENT_CHECKS = [
  "echo_task", "outcome", "echo_outcome", "double", "add", "fail", "crash", "timeout", "ordering", "concurrent", "explode",
  "relay", "relay_refused", "push_notify", "server_disconnect", "dispose",
];

// --- In-process TypeScript server, from run 2 ---------------------------------

const { createRpcServer } = await import(join(tsServerDir, "server.generated.ts"));
const { isRpcError, rpcError } = await import(join(tsServerDir, "types.generated.ts"));

const httpServer = createServer();
const ioServer = new Server(httpServer);
ioServer.on("connection", (socket) => {
  const rpc = createRpcServer(socket);
  const history: number[] = [];
  let lastClientError: string | null = null;

  rpc.handle.echoTask(async (task: unknown) => task);
  rpc.handle.outcome(async (kind: string) => {
    if (!(kind in OUTCOMES)) throw rpcError("INVALID_ARGUMENT", `unknown kind ${kind}`);
    return OUTCOMES[kind];
  });
  rpc.handle.echoOutcome(async (outcome: unknown) => outcome);
  rpc.handle.double(async (n: number) => n * 2);
  rpc.handle.add(async (a: number, b: number) => a + b);
  rpc.handle.fail(async (code: string) => {
    throw rpcError(code, `refused: ${code}`, { code });
  });
  rpc.handle.crash(async () => {
    throw new Error("handler crashed");
  });
  rpc.handle.slow(async (ms: number) => {
    await Bun.sleep(ms);
    return ms;
  });
  rpc.handle.record(async (value: number) => {
    history.push(value);
  });
  rpc.handle.history(async () => history);
  rpc.handle.explode(async (reason: string) => {
    throw rpcError("EXPLODED", reason);
  });
  rpc.handle.relay(async (question: string) => {
    const answer = await rpc.client.ask(question);
    return isRpcError(answer) ? `error:${answer.code}` : answer;
  });
  rpc.handle.pushNotify(async (text: string) => {
    rpc.client.notify(text);
    return "sent";
  });
  rpc.handle.lastClientError(async () => lastClientError);
  rpc.handle.kick(async () => {
    setTimeout(() => socket.disconnect(true), 0);
  });
  rpc.onRpcError((error: { code: string }) => {
    lastClientError = error.code;
  });
  rpc.onDisconnect(() => rpc.dispose());
});
await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
const tsServerUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

// --- Generated TypeScript client, from run 1 ----------------------------------

const { createRpcClient } = await import(join(rustTsDir, "client.generated.ts"));
const openSockets: ClientSocket[] = [];

async function connectTs() {
  const socket = ioClient(rustServerUrl, { forceNew: true, transports: ["websocket"], reconnection: false });
  openSockets.push(socket);
  await new Promise<void>((done, fail) => {
    socket.once("connect", () => done());
    socket.once("connect_error", fail);
  });
  const rpc = createRpcClient(socket);
  rpc.handle.ask(async (question: string) => {
    if (question === "refuse") throw rpcError("INVALID_ARGUMENT", "refused by the ts client");
    return `ts answered ${question}`;
  });
  rpc.handle.notify(async (text: string) => {
    throw rpcError("NOTIFY_FAILED", text);
  });
  return { socket, rpc };
}

// Each pass dials its own connection, so the two runs share nothing but the server processes.
const rustToRust = await runRustClient(rustServerUrl);
const rustToTs = await runRustClient(tsServerUrl);

async function eventually(probe: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await Bun.sleep(20);
  }
  return false;
}

afterAll(async () => {
  for (const socket of openSockets) socket.disconnect();
  rustServer.kill();
  await rustServer.exited;
  ioServer.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("Rust backend generation", () => {
  test("the Rust client is the same bytes whatever the server language", () => {
    for (const file of ["client.rs", "types.rs"]) {
      expect(readFileSync(join(secondRustOut, file), "utf-8")).toBe(
        readFileSync(join(crateDir, "src", "rpc", file), "utf-8"),
      );
    }
  });

  test("the generated module and its consumer pass clippy with warnings denied", () => {
    expect(clippy.output).not.toContain("warning:");
    expect(clippy.ok).toBe(true);
  });

  test("they still pass with serde_json's preserve_order, which more than doubles a Value", () => {
    // A larger Value must not push RpcError past clippy::result_large_err, which
    // would fire on every user function returning Result<_, RpcError>.
    expect(clippyPreserveOrder.output).not.toContain("warning:");
    expect(clippyPreserveOrder.ok).toBe(true);
  });
});

describe("generated Rust client against the generated Rust server", () => {
  const checks = rustToRust;
  for (const name of RUST_CLIENT_CHECKS) {
    test(name, () => {
      expect(checks.get(name)).toEqual({ ok: true, detail: expect.any(String) });
    });
  }
});

describe("generated Rust client against the generated TypeScript server", () => {
  const checks = rustToTs;
  for (const name of RUST_CLIENT_CHECKS) {
    test(name, () => {
      expect(checks.get(name)).toEqual({ ok: true, detail: expect.any(String) });
    });
  }
});

describe("generated TypeScript client against the generated Rust server", () => {
  const task = {
    id: "t1",
    title: "child",
    priority: "in-progress",
    tags: ["a"],
    scores: { x: 1.5 },
    done: false,
    assignee: null,
    due: null,
    extra: { nested: [1, "two", null] },
    parent: {
      id: "p", title: "parent", priority: "low", tags: [], scores: {}, done: true,
      note: "kept", assignee: "ann", extra: 7, type: "epic",
    },
    type: "story",
  };

  test("every Task shape survives the round trip, explicit null kept apart from omitted", async () => {
    const { rpc } = await connectTs();
    expect(await rpc.server.echoTask(task)).toEqual(task);
  }, T);

  test("every Outcome variant the Rust server builds is the JSON TypeScript writes", async () => {
    const { rpc } = await connectTs();
    for (const [kind, wire] of Object.entries(OUTCOMES)) {
      // toStrictEqual: an omitted key must stay omitted, not arrive as null or undefined.
      expect(await rpc.server.outcome(kind)).toStrictEqual(wire);
      expect(await rpc.server.echoOutcome(wire)).toStrictEqual(wire);
    }
  }, T);

  test("an Outcome whose tag names no variant is refused as INVALID_ARGUMENT", async () => {
    const { rpc } = await connectTs();
    const result = await rpc.server.echoOutcome({ kind: "unknown" });
    expect(isRpcError(result)).toBe(true);
    expect(result.code).toBe("INVALID_ARGUMENT");
    expect(result.message).toContain("invalid argument outcome");
  }, T);

  test("an @int argument is an i64: a whole number is answered, a fraction refused as INVALID_ARGUMENT", async () => {
    const { rpc } = await connectTs();
    expect(await rpc.server.double(21)).toBe(42);
    const fraction = await rpc.server.double(1.5);
    expect(isRpcError(fraction)).toBe(true);
    expect(fraction.code).toBe("INVALID_ARGUMENT");
    expect(fraction.message).toContain("invalid argument n");
  }, T);

  test("a value outside the enum is refused as INVALID_ARGUMENT naming the argument", async () => {
    const { rpc } = await connectTs();
    const result = await rpc.server.echoTask({ ...task, priority: "urgent" });
    expect(isRpcError(result)).toBe(true);
    expect(result.code).toBe("INVALID_ARGUMENT");
    expect(result.method).toBe("echoTask");
    expect(result.message).toContain("invalid argument task");
  }, T);

  test("typed failures, panics and timeouts", async () => {
    const { rpc } = await connectTs();
    const failed = await rpc.server.fail("QUOTA");
    expect(failed).toEqual({ __rpcError: true, code: "QUOTA", message: "refused: QUOTA", method: "fail", data: { code: "QUOTA" } });
    const crashed = await rpc.server.crash();
    expect(crashed.code).toBe("INTERNAL_ERROR");
    expect(crashed.message).toBe("handler crashed");
    const late = await rpc.server.slow(500, { timeout: 50 });
    expect(late.code).toBe("TIMEOUT");
  }, T);

  test("fire-and-forget calls run in arrival order", async () => {
    const { rpc } = await connectTs();
    for (let value = 0; value < 50; value++) rpc.server.record(value);
    let history: number[] = [];
    await eventually(async () => {
      history = await rpc.server.history();
      return history.length === 50;
    });
    expect(history).toEqual(Array.from({ length: 50 }, (_, index) => index));
  }, T);

  test("a failing fire-and-forget handler reports through onRpcError", async () => {
    const { rpc } = await connectTs();
    const reported: Array<{ code: string; message: string; method?: string }> = [];
    rpc.onRpcError((error: { code: string; message: string; method?: string }) => reported.push(error));
    rpc.server.explode("kaboom");
    expect(await eventually(() => reported.length > 0)).toBe(true);
    expect(reported[0]).toMatchObject({ code: "EXPLODED", message: "kaboom", method: "explode" });
  }, T);

  test("the Rust server calls the TypeScript client back", async () => {
    const { rpc } = await connectTs();
    expect(await rpc.server.relay("hi")).toBe("ts answered hi");
    expect(await rpc.server.relay("refuse")).toBe("error:INVALID_ARGUMENT");
    expect(await rpc.server.pushNotify("n")).toBe("sent");
    expect(await eventually(async () => (await rpc.server.lastClientError()) === "NOTIFY_FAILED")).toBe(true);
  }, T);

  test("wrong arity, wrong types and a missing acknowledgement are answered, not dropped", async () => {
    const { socket } = await connectTs();
    const arity = await socket.timeout(2_000).emitWithAck("add", 1);
    expect(arity).toMatchObject({ __rpcError: true, code: "INVALID_ARGUMENT", message: "expected 2 arguments, got 1", method: "add" });
    const types = await socket.timeout(2_000).emitWithAck("add", "x", 2);
    expect(types).toMatchObject({ code: "INVALID_ARGUMENT", method: "add" });
    expect(types.message).toContain("invalid argument a");

    const reports: Array<{ message: string }> = [];
    socket.on("__rpc:error__", (error: { message: string }) => reports.push(error));
    socket.emit("add", 1, 2);
    expect(await eventually(() => reports.length > 0)).toBe(true);
    expect(reports[0]).toMatchObject({ code: "INVALID_ARGUMENT", message: "missing acknowledgement callback", method: "add" });
  }, T);

  test("the Rust server disconnecting the socket", async () => {
    const { socket, rpc } = await connectTs();
    const reasons: string[] = [];
    socket.on("disconnect", (reason) => reasons.push(reason));
    rpc.server.kick();
    expect(await eventually(() => reasons.length > 0)).toBe(true);
    expect(reasons[0]).toBe("io server disconnect");
  }, T);
});
