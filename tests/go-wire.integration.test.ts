import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

import { createRpcClient, type RpcClient } from "./fixtures/go-wire/client.generated";
import { isRpcError } from "./fixtures/go-wire/types.generated";

// Cross-language compatibility harness.
//
// tests/integration.test.ts proves the generated client and the generated server
// agree with each other — but both are emitted from the same templates, so they
// would agree even on a convention no other language could implement. This file
// closes that gap: the peer is a handcrafted Go Socket.IO server
// (fixtures/go-wire/goserver/main.go, github.com/zishang520/socket.io/servers/socket/v3)
// written from the interface definitions alone. Every assertion below is a claim
// about the wire, not about the generator.

const GO_SERVER_DIR = join(import.meta.dir, "fixtures", "go-wire", "goserver");
const READY_PREFIX = "LISTENING ";

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

// Built and started during module evaluation rather than in beforeAll: a cold Go
// compile-and-link runs well past bun:test's 5s hook budget, and hooks accept no
// timeout override.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-go-wire-"));
const binary = join(workDir, "go-wire-server");

// Build rather than `go run`: `go run` starts the real server as a grandchild,
// which survives killing the parent and leaks a listening process.
const build = Bun.spawnSync(["go", "build", "-o", binary, "."], {
  cwd: GO_SERVER_DIR,
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0) {
  throw new Error(`go build failed:\n${build.stderr.toString()}`);
}

// stderr is inherited so a Go-side panic lands in the test output instead of
// filling an undrained pipe.
const goServer = Bun.spawn([binary], { stdout: "pipe", stderr: "inherit", stdin: "pipe" });
const url = `http://${await waitForAddress(goServer, 15_000)}`;

const openClients: ClientSocket[] = [];

/**
 * Connect a fresh client to the Go server and wrap it in the generated RPC client.
 * Each test gets its own connection, so the per-socket state the Go server keeps
 * (the `note` log) starts empty. Reconnection is off so the disconnect test
 * observes a terminal close rather than a reconnect cycle.
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

  const rpc: RpcClient = createRpcClient(socket);

  // The Go server calls back into these during `roundTrip`.
  const notified: string[] = [];
  rpc.handle.notify(async (text) => {
    notified.push(text);
  });
  rpc.handle.ask(async (question) => `ts answered ${question}`);

  return { rpc, notified };
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

describe("generated TypeScript client against a handcrafted Go server", () => {
  test(
    "client→Go ack resolves to the decoded value",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.echo("u1", "hello");
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({ id: "u1", payload: "hello" });
    },
    T,
  );

  test(
    "a Go failure arrives as a branded RpcError with its code, method and data",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.failTyped("quota");
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("GO_REFUSED");
        expect(result.message).toBe("go server refused: quota");
        expect(result.method).toBe("failTyped");
        expect(result.data).toEqual({ reason: "quota" });
      }
    },
    T,
  );

  test(
    "a Go success shaped like an error is not misread — the brand decides",
    async () => {
      const { rpc } = await connect();
      const result = await rpc.server.receipt("inv-9");
      // Go serialized an ordinary struct that happens to carry `message` and `code`;
      // without the `__rpcError` brand it must stay a success.
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({ message: "receipt for inv-9", code: "PAID" });
    },
    T,
  );

  test(
    "void calls reach Go with no acknowledgement attached",
    async () => {
      const { rpc } = await connect();
      rpc.server.note("first");
      rpc.server.note("second");

      // Same connection, so socket.io preserves order and the Go server processes
      // both notes before this call — no sleep needed. The Go handler records
      // "UNEXPECTED_ACK:<text>" if an ack id rides along with a void signature, so
      // this equality also asserts the fire-and-forget encoding.
      const notes = await rpc.server.readNotes();
      expect(isRpcError(notes)).toBe(false);
      expect(notes).toEqual(["first", "second"]);
    },
    T,
  );

  test(
    "Go→TypeScript fire-and-forget and value-returning ack both round-trip",
    async () => {
      const { rpc, notified } = await connect();
      // `roundTrip` makes Go push `notify` (fire-and-forget) and then call `ask`
      // (value-returning), folding the client's answer into its own reply.
      const result = await rpc.server.roundTrip("ping");
      expect(isRpcError(result)).toBe(false);
      expect(result).toBe("go saw: ts answered ping");
      expect(notified).toEqual(["pushed:ping"]);
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
