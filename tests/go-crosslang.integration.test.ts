import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// End-to-end cross-language harness: both sides are generated.
//
// tests/go-wire.integration.test.ts drives the generated TypeScript client
// against a *handcrafted* Go server, proving the protocol is implementable
// outside TypeScript. This file closes the loop: the peer here is the Go server
// socketrpc-gen itself emits, produced by the same CLI invocation and from the
// same canonical RpcSchema as the client. fixtures/go-crosslang/goserver/main.go
// contributes only an implementation of the generated ServerHandler interface —
// no event names, no argument order, no acknowledgement handling.
//
// Everything below therefore asserts one of two things: that the two backends
// agree on the wire, or that the Go the generator emits is real Go (gofmt-clean,
// vet-clean, race-clean, compiling against the real zishang520/socket.io v3).

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "go-crosslang");
const GENERATOR_PATH = join(resolve(import.meta.dir, ".."), "index.ts");
const READY_PREFIX = "LISTENING ";

/** Runs a command to completion and fails loudly with both streams on error. */
function run(command: string[], cwd: string, label: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}):\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
}

/**
 * Reads the server's stdout until it announces the address it bound. The Go
 * server listens on 127.0.0.1:0 and prints the resolved host:port once the
 * listener is accepting, so there is no fixed port to collide on and no polling
 * race between "spawned" and "reachable".
 */
async function waitForAddress(proc: Bun.Subprocess, timeoutMs: number): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // Keep the trailing fragment: a half-received line must not be mistaken
      // for a complete address.
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(READY_PREFIX)) return line.slice(READY_PREFIX.length).trim();
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  throw new Error(`Go server did not report "${READY_PREFIX}" within ${timeoutMs}ms`);
}

// Generated, compiled and started during module evaluation rather than in
// beforeAll: generation plus a cold Go compile-and-link runs well past
// bun:test's 5s hook budget, and hooks accept no timeout override.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-go-crosslang-"));
const tsDir = join(workDir, "ts");
const goDir = join(workDir, "goserver");
const goPkgDir = join(goDir, "rpc");
mkdirSync(tsDir, { recursive: true });
mkdirSync(goPkgDir, { recursive: true });

cpSync(join(FIXTURE_DIR, "define.ts"), join(tsDir, "define.ts"));
for (const file of ["go.mod", "go.sum", "main.go"]) {
  cpSync(join(FIXTURE_DIR, "goserver", file), join(goDir, file));
}

// One CLI invocation produces both sides. Driving the real binary rather than
// the library keeps the flag surface (`--client`, `--server`, `--go-out`,
// `--go-package`) under test alongside the emitters.
run(
  [
    "bun",
    GENERATOR_PATH,
    join(tsDir, "define.ts"),
    "--client",
    "typescript",
    "--server",
    "go",
    "--go-out",
    goPkgDir,
    "--go-package",
    "rpc",
  ],
  workDir,
  "socketrpc-gen --server go",
);

const gofmt = Bun.spawnSync(["gofmt", "-l", goPkgDir], { stdout: "pipe", stderr: "pipe" });
const unformatted = gofmt.stdout.toString().trim();

// Fetches the module graph first, so the report below is the analyzers speaking
// and nothing else: on a cold module cache the first Go command to touch the
// module writes `go: downloading …` progress to the same stderr the report is
// read from, which is invisible on a developer's warm machine and fails on CI.
run(["go", "mod", "download"], goDir, "go mod download");

// The full analyzer set, with nothing excluded, over the generated package *and*
// the handler that implements it — `go test` runs only a subset, so a name the
// standard library has claimed (`stdmethods`) would otherwise pass unnoticed
// here even though a consumer's own `go vet` would report it.
const vet = Bun.spawnSync(["go", "vet", "./..."], { cwd: goDir, stdout: "pipe", stderr: "pipe" });
const vetReport = `${vet.stdout.toString()}${vet.stderr.toString()}`.trim();

cpSync(join(FIXTURE_DIR, "rpc_test.go"), join(goPkgDir, "rpc_test.go"));

// Compiles the generated package and the handler that consumes it, runs the
// generated package's own tests, and does it all under the race detector.
run(["go", "test", "-race", "./..."], goDir, "go test -race on generated bindings");

const binary = join(workDir, "crosslang-server");
// Build rather than `go run`: `go run` starts the real server as a grandchild,
// which survives killing the parent and leaks a listening process.
run(["go", "build", "-o", binary, "."], goDir, "go build");

// stderr is inherited so a Go-side panic lands in the test output instead of
// filling an undrained pipe.
const goServer = Bun.spawn([binary], { stdout: "pipe", stderr: "inherit", stdin: "pipe" });
const url = `http://${await waitForAddress(goServer, 15_000)}`;

const { createRpcClient } = await import(join(tsDir, "client.generated.ts"));
const { isRpcError } = await import(join(tsDir, "types.generated.ts"));

const openClients: ClientSocket[] = [];

/**
 * Connect a fresh client to the generated Go server and wrap it in the generated
 * RPC client. Each test gets its own connection, so the per-socket state the Go
 * handler keeps (the note log) starts empty. Reconnection is off so the
 * disconnect test observes a terminal close rather than a reconnect cycle.
 */
async function connect() {
  const socket = ioClient(url, {
    forceNew: true,
    transports: ["websocket"],
    reconnection: false,
  });
  openClients.push(socket);

  if (!socket.connected) {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (err) => reject(err));
    });
  }

  const rpc = createRpcClient(socket);

  // The generated Go Client calls these during `roundTrip`.
  const notified: string[] = [];
  rpc.handle.notify(async (text: string) => {
    notified.push(text);
  });
  rpc.handle.ask(async (question: string) => `ts answered ${question}`);

  return { rpc, notified };
}

/**
 * Reads the Go handler's note log until it holds `expected` entries.
 *
 * Fire-and-forget calls carry no acknowledgement, so their delivery is only
 * observable through a later call — and `readNotes` is a different RPC method,
 * with its own dispatch queue, so it can be answered before the notes have been
 * handled. This waits for that visibility; it never reorders anything, so the
 * list it returns is exactly the order the `note` queue produced.
 */
/**
 * Reads the Go binding's out-of-band error log until it holds an entry.
 *
 * The client emits `__rpc:error__` after its rejected handler settles, so the
 * report races the reply to whatever call triggered it; polling waits for the
 * report to land without imposing an order on anything.
 */
async function rpcErrorsWhenVisible(rpc: any, expected: number): Promise<unknown> {
  let latest: unknown = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await rpc.server.readRpcErrors();
    if (Array.isArray(latest) && latest.length >= expected) return latest;
    await Bun.sleep(10);
  }
  return latest;
}

async function notesWhenVisible(rpc: any, expected: number): Promise<unknown> {
  let latest: unknown = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await rpc.server.readNotes();
    if (Array.isArray(latest) && latest.length >= expected) return latest;
    await Bun.sleep(10);
  }
  return latest;
}

afterEach(() => {
  for (const socket of openClients.splice(0)) socket.disconnect();
});

afterAll(async () => {
  // SIGTERM, which the Go server handles by shutting the listener down; awaiting
  // `exited` guarantees the port is released before the suite returns.
  goServer.kill();
  await goServer.exited;
  await rm(workDir, { recursive: true, force: true });
});

const T = 15_000;

describe("generated Go server emits real, well-formed Go", () => {
  test("every generated file is gofmt-clean", () => {
    expect(unformatted, `gofmt reported unformatted files:\n${unformatted}`).toBe("");
  });

  test("the generated package and its handler pass go vet with no exclusions", () => {
    expect(vetReport, `go vet reported:\n${vetReport}`).toBe("");
    expect(vet.exitCode).toBe(0);
  });

  test("the CLI emits no TypeScript server when the server is Go", async () => {
    expect(await Bun.file(join(tsDir, "client.generated.ts")).exists()).toBe(true);
    expect(await Bun.file(join(tsDir, "types.generated.ts")).exists()).toBe(true);
    expect(await Bun.file(join(tsDir, "server.generated.ts")).exists()).toBe(false);
    expect(await Bun.file(join(goPkgDir, "server.generated.go")).exists()).toBe(true);
    expect(await Bun.file(join(goPkgDir, "types.generated.go")).exists()).toBe(true);

    // The scaffold must not advertise an entry point that was never emitted.
    const scaffold = await Bun.file(join(tsDir, "package.json")).json();
    expect(Object.keys(scaffold.exports)).not.toContain("./server.generated");
    expect(Object.keys(scaffold.dependencies)).not.toContain("socket.io");
    expect(Object.keys(scaffold.dependencies)).toContain("socket.io-client");
  });
});

describe("generated TypeScript client against the generated Go server", () => {
  test(
    "client→Go ack resolves to the decoded value, and an absent optional stays absent",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.echo("u1", "hello");
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({ id: "u1", payload: "hello" });
      // `note` is optional in the contract and nil in the handler; `omitempty`
      // must keep the key off the wire entirely rather than send null.
      expect(Object.keys(result as object)).not.toContain("note");
    },
    T,
  );

  test(
    "a Go handler error arrives as a branded RpcError with its code, origin and data",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.failTyped("quota");
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("GO_REFUSED");
        expect(result.message).toBe("go server refused: quota");
        // The handler left Origin empty; the generated binding fills in the
        // event name so the client can attribute the failure.
        expect(result.method).toBe("failTyped");
        expect(result.data).toEqual({ reason: "quota" });
      }
    },
    T,
  );

  test(
    "a panic in a Go handler becomes an INTERNAL_ERROR ack, not a dropped call",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.failPanic("boom");
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("INTERNAL_ERROR");
        expect(result.method).toBe("failPanic");
        expect(result.message).toContain("boom");
      }

      // The connection survives the panic: the recover is per-call.
      const after = await rpc.server.echo("u2", "still here");
      expect(isRpcError(after)).toBe(false);
    },
    T,
  );

  test(
    "a Go success shaped like an error is not misread — the brand decides",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.receipt("inv-9");
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({ message: "receipt for inv-9", code: "PAID" });
    },
    T,
  );

  test(
    "void calls reach Go with no ack attached, in the order Socket.IO delivered them",
    async () => {
      const { rpc } = await connect();
      const sent = [
        ["first", "high"],
        ["second", "low"],
        ["third", "high"],
        ["fourth", "low"],
        ["fifth", "high"],
      ] as const;
      for (const [text, priority] of sent) rpc.server.note(text, priority);

      // Two properties in one assertion.
      //
      // Order: the generated binding gives every RPC method its own serialized
      // dispatch queue, so repeated calls to `note` are handled in the order
      // Socket.IO delivered them — the same guarantee the TypeScript server
      // backend gives. This is exact equality, not a set comparison.
      //
      // Encoding: a void call must travel without an ack id. If one rode along,
      // the fire-and-forget handler would see an extra argument, reject the call
      // as INVALID_ARGUMENT and record nothing. The enum prefixes additionally
      // show `Priority` survived the hop through the generated UnmarshalJSON.
      const notes = await notesWhenVisible(rpc, sent.length);
      expect(isRpcError(notes)).toBe(false);
      expect(notes).toEqual([
        "high:first",
        "low:second",
        "high:third",
        "low:fourth",
        "high:fifth",
      ]);
    },
    T,
  );

  test(
    "a blocked handler stalls only its own method, never the connection",
    async () => {
      const { rpc } = await connect();

      // `neverAck` occupies its own queue until the binding is torn down.
      const hung = rpc.server.neverAck("u1", { timeout: 1_000 });

      // Other methods keep answering while it is stuck — per-method queues buy
      // ordering without reintroducing head-of-line blocking per connection.
      expect(isRpcError(await rpc.server.echo("u2", "not blocked"))).toBe(false);
      expect(isRpcError(await rpc.server.receipt("inv-1"))).toBe(false);

      const result = await hung;
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) expect(result.code).toBe("TIMEOUT");
    },
    T,
  );

  test(
    "an empty Go slice arrives as [], not the null a nil slice would encode to",
    async () => {
      const { rpc } = await connect();
      // Go's zero slice is nil and encoding/json writes nil as null, but the
      // contract declares `readNotes(): string[]` and the generated TypeScript
      // type says so too. The binding normalizes the result so the client is
      // never handed a value its own generated types rule out.
      const notes = await rpc.server.readNotes();
      expect(isRpcError(notes)).toBe(false);
      expect(notes).toEqual([]);
    },
    T,
  );

  test(
    "the generated Go client round-trips both fire-and-forget and value-returning calls",
    async () => {
      const { rpc, notified } = await connect();
      // `roundTrip` drives the generated rpc.Client: a `notify` push followed by
      // an `ask` acknowledgement, folded into its own reply.
      const result = await rpc.server.roundTrip("ping");
      expect(isRpcError(result)).toBe(false);
      expect(result).toBe("go saw: ts answered ping");
      expect(notified).toEqual(["pushed:ping"]);
    },
    T,
  );

  test(
    "a failed client handler for a fire-and-forget call reaches the Go binding",
    async () => {
      const { rpc } = await connect();

      // Nothing has been reported yet: the Go handler returns a nil slice here,
      // which must still arrive as [] because the client's type says string[].
      const before = await rpc.server.readRpcErrors();
      expect(before).toEqual([]);

      // Replaces the passing handler registered by connect(). A fire-and-forget
      // call has no acknowledgement, so the only channel back is __rpc:error__.
      rpc.handle.notify(async () => {
        throw new Error("client notify exploded");
      });

      const result = await rpc.server.roundTrip("boom");
      expect(isRpcError(result)).toBe(false);

      const reported = (await rpcErrorsWhenVisible(rpc, 1)) as string[];
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("client notify exploded");
      // Origin survives the hop, so the observer learns which call failed.
      expect(reported[0]).toContain("notify");
    },
    T,
  );

  test(
    "a call Go never acknowledges settles as TIMEOUT on the client's own clock",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.neverAck("u1", { timeout: 300 });
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("TIMEOUT");
        expect(result.method).toBe("neverAck");
      }

      // A hung handler holds only its own queue; see the isolation test above.
      const after = await rpc.server.echo("u3", "unblocked");
      expect(isRpcError(after)).toBe(false);
    },
    T,
  );

  test(
    "an in-flight call settles as DISCONNECTED when Go drops the socket",
    async () => {
      const { rpc } = await connect();
      // The Go handler closes the connection ~50ms in without answering, well
      // inside the call's own timeout, so DISCONNECTED wins over TIMEOUT.
      const result = await rpc.server.dropWhileInFlight("u1", { timeout: 5_000 });
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("DISCONNECTED");
        expect(result.method).toBe("dropWhileInFlight");
      }
    },
    T,
  );
});
