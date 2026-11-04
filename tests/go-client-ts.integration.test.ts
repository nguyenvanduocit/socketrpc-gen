import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Server } from "socket.io";
import { run, useLocalSocketio } from "./helpers/go-server";

// End-to-end harness for the generated Go *client* against the generated
// TypeScript *server* — the reverse of tests/go-crosslang.integration.test.ts.
//
// One CLI invocation (`--client go --server typescript`, layout 2: the Go client
// colocated with the Go types in --go-out) produces both sides from
// fixtures/go-client-ts/define.ts. The server is the generated createRpcServer,
// running in this process on the named namespace /runtime behind an auth
// middleware. The client is fixtures/go-client-ts/goclient/main.go, which
// implements nothing but the generated ClientHandler and calls the generated
// Dial/Conn; it prints one JSON line per check and exits when stdin closes.
//
// Every property is asserted from the side that can observe it: replies and
// error codes the Go caller received come from its result lines; reports that
// only the TypeScript server can see (its onRpcError, the handshakes its
// middleware read, the disconnect) come from in-process state.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "go-client-ts");
const GENERATOR_PATH = join(resolve(import.meta.dir, ".."), "index.ts");

const NAMESPACE = "/runtime";
const TOKEN = "go-client-secret";
const AUTH_REFUSAL = "invalid token: access denied";

/** Upper bound on the Go process's life; nothing in it should take this long. */
const HARD_KILL_MS = 120_000;

// Generated, compiled and started during module evaluation rather than in
// beforeAll: generation plus a cold Go compile-and-link runs well past
// bun:test's 5s hook budget, and hooks accept no timeout override.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-go-client-ts-"));
const tsDir = join(workDir, "ts");
const goDir = join(workDir, "goclient");
const goPkgDir = join(goDir, "rpc");
mkdirSync(tsDir, { recursive: true });
mkdirSync(goPkgDir, { recursive: true });

cpSync(join(FIXTURE_DIR, "define.ts"), join(tsDir, "define.ts"));
for (const file of ["go.mod", "go.sum", "main.go"]) {
  cpSync(join(FIXTURE_DIR, "goclient", file), join(goDir, file));
}
useLocalSocketio(goDir);

// Driving the real binary rather than the library keeps the flag surface
// (`--client go`, `--server typescript`, `--go-out`, `--go-package`) under test
// alongside the emitters.
run(
  [
    "bun",
    GENERATOR_PATH,
    join(tsDir, "define.ts"),
    "--client",
    "go",
    "--server",
    "typescript",
    "--go-out",
    goPkgDir,
    "--go-package",
    "rpc",
  ],
  workDir,
  "socketrpc-gen --client go --server typescript",
);

const gofmt = Bun.spawnSync(["gofmt", "-l", goPkgDir], { stdout: "pipe", stderr: "pipe" });
const unformatted = gofmt.stdout.toString().trim();

// Fetches the module graph first, so the vet report below is the analyzers
// speaking and nothing else: on a cold module cache the first Go command writes
// `go: downloading …` progress to the stderr the report is read from.
run(["go", "mod", "download"], goDir, "go mod download");

// The full analyzer set, with nothing excluded, over the generated client *and*
// the program that consumes it.
const vet = Bun.spawnSync(["go", "vet", "./..."], { cwd: goDir, stdout: "pipe", stderr: "pipe" });
const vetReport = `${vet.stdout.toString()}${vet.stderr.toString()}`.trim();

const binary = join(workDir, "go-client");
// Build rather than `go run`: `go run` starts the client as a grandchild, which
// survives killing the parent. -race makes a data race in the generated client
// fail the process (exit 66) under real network concurrency.
run(["go", "build", "-race", "-o", binary, "."], goDir, "go build -race");

const { createRpcServer } = await import(join(tsDir, "server.generated.ts"));
const { isRpcError, rpcError } = await import(join(tsDir, "types.generated.ts"));

// --- In-process TypeScript server -------------------------------------------

/** The auth payload of every handshake the middleware read, in order. */
const handshakes: unknown[] = [];
/** What the server's onRpcError observed: failures the Go client reported. */
const serverRpcErrors: Array<Record<string, unknown>> = [];
/** Disconnect reasons of accepted connections. */
const disconnects: string[] = [];

const httpServer = createServer();
const ioServer = new Server(httpServer);
const runtime = ioServer.of(NAMESPACE);

runtime.use((socket, next) => {
  const auth: Record<string, unknown> = socket.handshake.auth;
  handshakes.push(auth);
  if (auth.token === TOKEN) next();
  else next(new Error(AUTH_REFUSAL));
});

runtime.on("connection", (socket) => {
  const rpc = createRpcServer(socket);

  rpc.handle.greet(async (name: string) => ({ text: `hello ${name}`, from: "ts" }));

  rpc.handle.validate(async (value: string) => {
    throw rpcError("INVALID_ARGUMENT", `value ${value} is not allowed`, { field: "value" });
  });

  // Calls back into the Go client while the Go caller's own ack is pending.
  rpc.handle.relay(async (question: string) => {
    const answer = await rpc.client.ask(question);
    if (isRpcError(answer)) return `refused:${answer.code}:${answer.message}`;
    return `ts got: ${answer}`;
  });

  rpc.handle.pushNotify(async (text: string) => {
    rpc.client.notify(text);
    return "pushed";
  });

  rpc.handle.explode(async (reason: string) => {
    throw new Error(`ts explode failed: ${reason}`);
  });

  rpc.onRpcError((error: Record<string, unknown>) => serverRpcErrors.push(error));
  rpc.onDisconnect((reason: string) => {
    disconnects.push(reason);
    rpc.dispose();
  });
});

await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

// --- Go client process ---------------------------------------------------------

// stderr is inherited so a Go-side panic or race report lands in the test
// output instead of filling an undrained pipe.
const goClient = Bun.spawn([binary, url, TOKEN], { stdout: "pipe", stderr: "inherit", stdin: "pipe" });
const hardKill = setTimeout(() => goClient.kill("SIGKILL"), HARD_KILL_MS);

type CheckLine = Record<string, unknown>;
type Waiter = { name: string; resolve: (line: CheckLine) => void; reject: (error: Error) => void };

const results = new Map<string, CheckLine>();
const rawLines: string[] = [];
let waiters: Waiter[] = [];
let streamEnded = false;

function settleWaiters(): void {
  waiters = waiters.filter((waiter) => {
    const line = results.get(waiter.name);
    if (line) {
      waiter.resolve(line);
      return false;
    }
    if (streamEnded) {
      waiter.reject(
        new Error(`goclient exited before reporting "${waiter.name}"; it printed:\n${rawLines.join("\n")}`),
      );
      return false;
    }
    return true;
  });
}

/** Reads the Go client's stdout into `results`, one JSON line per check. */
async function pumpResults(): Promise<void> {
  const reader = goClient.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // A half-received line must not be parsed as a whole one.
      buffered = lines.pop() ?? "";
      for (const raw of lines) {
        if (raw.trim() === "") continue;
        rawLines.push(raw);
        const line: CheckLine = JSON.parse(raw);
        results.set(String(line.check), line);
      }
      settleWaiters();
    }
  } finally {
    streamEnded = true;
    settleWaiters();
  }
}
const pumping = pumpResults();

/** Resolves with the line the Go client printed for `name`. */
function check(name: string): Promise<CheckLine> {
  const line = results.get(name);
  if (line) return Promise.resolve(line);
  return new Promise((resolve, reject) => {
    waiters.push({ name, resolve, reject });
    settleWaiters();
  });
}

/** Polls in-process state that a peer's out-of-band report fills. */
async function eventually<T>(read: () => T[], expected: number): Promise<T[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read().length >= expected) break;
    await Bun.sleep(10);
  }
  return read();
}

afterAll(async () => {
  if (goClient.exitCode === null) {
    goClient.kill("SIGKILL");
    await goClient.exited;
  }
  clearTimeout(hardKill);
  await pumping.catch(() => undefined);
  ioServer.close();
  httpServer.close();
  await rm(workDir, { recursive: true, force: true });
});

const T = 20_000;

describe("generated Go client emits real, well-formed Go", () => {
  test("every generated Go file is gofmt-clean", () => {
    expect(unformatted, `gofmt reported unformatted files:\n${unformatted}`).toBe("");
  });

  test("the generated client and its consumer pass go vet with no exclusions", () => {
    expect(vetReport, `go vet reported:\n${vetReport}`).toBe("");
    expect(vet.exitCode).toBe(0);
  });

  test("the CLI writes a Go client beside the Go types and no TypeScript client", async () => {
    expect(await Bun.file(join(goPkgDir, "types.generated.go")).exists()).toBe(true);
    expect(await Bun.file(join(goPkgDir, "client.generated.go")).exists()).toBe(true);
    expect(await Bun.file(join(goPkgDir, "server.generated.go")).exists()).toBe(false);
    expect(await Bun.file(join(tsDir, "types.generated.ts")).exists()).toBe(true);
    expect(await Bun.file(join(tsDir, "server.generated.ts")).exists()).toBe(true);
    expect(await Bun.file(join(tsDir, "client.generated.ts")).exists()).toBe(false);

    // The scaffold must not advertise an entry point that was never emitted.
    const scaffold = await Bun.file(join(tsDir, "package.json")).json();
    expect(Object.keys(scaffold.exports)).not.toContain("./client.generated");
    expect(Object.keys(scaffold.exports)).toContain("./server.generated");
  });
});

describe("generated Go client against the generated TypeScript server", () => {
  test(
    "a refused handshake returns the middleware's message from Dial at once",
    async () => {
      const refused = await check("refused");
      expect(refused.code).toBe("DISCONNECTED");
      expect(refused.message).toBe(AUTH_REFUSAL);
      expect(refused.method).toBe("Dial");
      // Returned on the CONNECT_ERROR itself, not when Dial's 5s context ran out.
      expect(Number(refused.elapsedMs)).toBeLessThan(2_000);
    },
    T,
  );

  test(
    "Dial connects to the named namespace carrying the auth payload",
    async () => {
      const dial = await check("dial");
      expect(dial).toEqual({ check: "dial", ok: true, connected: true });
      // The refused attempt, then the accepted one; a retried refusal would add
      // a third entry here.
      expect(handshakes).toEqual([{ token: "wrong-token" }, { token: TOKEN }]);
    },
    T,
  );

  test(
    "Go -> TS ack resolves to the decoded value",
    async () => {
      const greet = await check("greet");
      expect(greet.value).toEqual({ text: "hello gopher", from: "ts" });
    },
    T,
  );

  test(
    "concurrent calls on one Conn each get their own reply",
    async () => {
      const concurrent = await check("concurrent");
      expect(concurrent.failures).toEqual([]);
      expect(concurrent.ok).toBe(true);
      expect(concurrent.calls).toBe(32);
    },
    T,
  );

  test(
    "an INVALID_ARGUMENT thrown by a TS handler arrives in Go with code, message and data intact",
    async () => {
      const invalid = await check("invalidArgument");
      expect(invalid.code).toBe("INVALID_ARGUMENT");
      expect(invalid.message).toBe("value forbidden is not allowed");
      expect(invalid.data).toEqual({ field: "value" });
      expect(invalid.isRpcError).toBe(true);
    },
    T,
  );

  test(
    "TS -> Go ack resolves while the Go caller's own call is in flight",
    async () => {
      const relay = await check("relay");
      expect(relay.value).toBe("ts got: go answered ping");
    },
    T,
  );

  test(
    "an RpcError returned by a Go handler reaches the TS caller with its code",
    async () => {
      const refused = await check("relayRefused");
      expect(refused.value).toBe("refused:INVALID_ARGUMENT:go refuses to answer");
    },
    T,
  );

  test(
    "a failed Go fire-and-forget handler is reported to the TS server's onRpcError",
    async () => {
      const pushed = await check("pushNotify");
      expect(pushed.value).toBe("pushed");

      // A fire-and-forget call has no ack, so __rpc:error__ is the only way back;
      // it races the pushNotify reply, hence the poll.
      const reported = await eventually(() => serverRpcErrors, 1);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        __rpcError: true,
        code: "GO_NOTIFY_REFUSED",
        message: "go refused notify: bell",
        method: "notify",
      });
    },
    T,
  );

  test(
    "a failed TS fire-and-forget handler is reported to the Go client's OnRpcError",
    async () => {
      const report = await check("rpcErrorFromServer");
      expect(report.ok).toBe(true);
      expect(report.code).toBe("INTERNAL_ERROR");
      expect(report.message).toBe("ts explode failed: kaboom");
      expect(report.method).toBe("explode");
    },
    T,
  );

  test(
    "closing stdin disposes the Conn: the Go process exits 0 and the server sees the disconnect",
    async () => {
      await check("done");
      goClient.stdin.end();

      const outcome = await Promise.race([
        goClient.exited.then((code) => ({ code })),
        Bun.sleep(10_000).then(() => ({ code: "still running after 10s" as const })),
      ]);
      expect(outcome.code).toBe(0);

      const reasons = await eventually(() => disconnects, 1);
      expect(reasons).toHaveLength(1);
      // Every check printed exactly once: a duplicate would have overwritten a
      // result above without failing it.
      expect(rawLines).toHaveLength(results.size);
    },
    T,
  );
});
