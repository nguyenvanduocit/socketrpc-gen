import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// End-to-end harness for the JSON-value node of the IR.
//
// tests/go-crosslang.integration.test.ts proves the two backends agree on the
// closed part of the type system — named structs, string enums, scalars, slices.
// This file covers the open part: a contract that declares `unknown` where the
// data's shape belongs to the data, not to the contract. Both sides are still
// generated from one canonical RpcSchema, and goserver/main.go contributes only
// an implementation of the generated ServerHandler.
//
// Three properties are under test. That the Go the generator emits for a JSON
// value is real Go (gofmt-clean, vet-clean, race-clean). That every shape the
// JSON data model can express survives a round trip in both directions. And that
// a Go runtime value JSON cannot encode comes back as a typed INTERNAL_ERROR
// rather than as the silence that would strand the caller until it timed out.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "json-value");
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
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-json-value-"));
const tsDir = join(workDir, "ts");
const goDir = join(workDir, "goserver");
const goPkgDir = join(goDir, "rpc");
mkdirSync(tsDir, { recursive: true });
mkdirSync(goPkgDir, { recursive: true });

cpSync(join(FIXTURE_DIR, "define.ts"), join(tsDir, "define.ts"));
for (const file of ["go.mod", "go.sum", "main.go"]) {
  cpSync(join(FIXTURE_DIR, "goserver", file), join(goDir, file));
}

// One CLI invocation produces both sides, so a contract carrying `unknown` is
// proven to reach the Go backend through the real flag surface rather than only
// through a hand-built RpcSchema.
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

cpSync(join(FIXTURE_DIR, "rpc_test.go"), join(goPkgDir, "rpc_test.go"));

// `go test` runs a subset of vet; the full pass is what catches the kind of
// mistake an `any`-heavy projection could plausibly introduce, so it runs on its
// own before the tests.
run(["go", "vet", "./..."], goDir, "go vet on generated bindings");

// Compiles the generated package and the handler that consumes it, runs the
// generated package's own tests, and does it all under the race detector.
run(["go", "test", "-race", "./..."], goDir, "go test -race on generated bindings");

const binary = join(workDir, "json-value-server");
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
 * Every shape the JSON data model can express. The contract says `unknown`, so
 * each of these is a legal value for it and each has to survive the hop
 * unchanged — including the ones a language-specific encoding would be tempted
 * to normalize away, such as an empty object or an explicit null.
 */
const EVERY_JSON_SHAPE: readonly unknown[] = [
  null,
  "a string",
  42,
  3.5,
  true,
  false,
  [],
  ["a", 1, null, true],
  {},
  {
    nested: { deep: [1, { deeper: null }] },
    list: ["x", "y"],
  },
];

/**
 * Connect a fresh client to the generated Go server and wrap it in the generated
 * RPC client. Each test gets its own connection, so the per-socket document
 * store the Go handler keeps starts empty. Reconnection is off so a dropped
 * socket stays dropped.
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

  // The generated Go Client calls these during `syncBack`.
  const pushed: unknown[] = [];
  rpc.handle.documentChanged(async (path: string, frontmatter: unknown) => {
    pushed.push({ path, frontmatter });
  });
  rpc.handle.resolveConflict(async (key: string, incoming: unknown) => ({
    key,
    incoming,
    winner: "client",
  }));

  return { rpc, pushed };
}

/**
 * Reads the Go handler's event log until it holds `expected` entries.
 *
 * Fire-and-forget calls carry no acknowledgement, so their delivery is only
 * observable through a later call — and `readEvents` is a different RPC method,
 * with its own dispatch queue, so it can be answered before the events have been
 * handled. This waits for that visibility; it imposes no order of its own.
 */
async function eventsWhenVisible(rpc: any, expected: number): Promise<unknown> {
  let latest: unknown = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await rpc.server.readEvents();
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

describe("a contract carrying JSON values still emits real, well-formed Go", () => {
  test("every generated file is gofmt-clean", () => {
    expect(unformatted, `gofmt reported unformatted files:\n${unformatted}`).toBe("");
  });

  test("`unknown` is projected as Go's `any`, never as a pointer to one", async () => {
    const types = await Bun.file(join(goPkgDir, "types.generated.go")).text();
    const server = await Bun.file(join(goPkgDir, "server.generated.go")).text();

    // Record<string, unknown>, a required JSON field, and an optional one.
    expect(types).toContain("Frontmatter map[string]any `json:\"frontmatter\"`");
    expect(types).toContain("Value any    `json:\"value\"`");
    expect(types).toContain("LastError   any            `json:\"lastError,omitempty\"`");
    expect(types).toContain("type Frontmatter = map[string]any");

    // Parameters, results and slice elements.
    expect(server).toContain(
      "HandleReadKey(ctx context.Context, path string, key string) (any, error)",
    );
    expect(server).toContain("HandleRecordEvent(ctx context.Context, name string, payload any) error");
    expect(server).toContain("HandleHistory(ctx context.Context, path string) ([]any, error)");

    // Go's `any` is already nil-able, so nothing in either file spells `*any`.
    expect(types).not.toContain("*any");
    expect(server).not.toContain("*any");
  });

  test("a required Record<string, unknown> result is normalized away from nil", async () => {
    const server = await Bun.file(join(goPkgDir, "server.generated.go")).text();
    // The contract says Frontmatter and unknown[], neither of which admits null.
    expect(server).toContain("result = map[string]any{}");
    expect(server).toContain("result = []any{}");
  });
});

describe("JSON values across the generated TypeScript client and Go server", () => {
  test(
    "an untouched document arrives with {} frontmatter and no optional key",
    async () => {
      const { rpc } = await connect();
      const document = await rpc.server.readDocument("notes.md");
      expect(isRpcError(document)).toBe(false);
      // The Go handler's map is nil here; the client's type says
      // Record<string, unknown>, which null does not satisfy.
      expect(document).toEqual({ path: "notes.md", frontmatter: {}, body: "body of notes.md" });
      expect(Object.keys(document as object)).not.toContain("lastError");
    },
    T,
  );

  test(
    "every JSON shape survives the round trip through a struct field and back",
    async () => {
      const { rpc } = await connect();

      for (const [index, shape] of EVERY_JSON_SHAPE.entries()) {
        const key = `k${index}`;
        const written = await rpc.server.applyMutation({
          path: "notes.md",
          key,
          value: shape,
        });
        expect(isRpcError(written)).toBe(false);
        expect((written as { frontmatter: Record<string, unknown> }).frontmatter[key]).toEqual(
          shape,
        );

        // Read back through a bare `unknown` result rather than a struct field,
        // so both projections of the same node are covered.
        const readBack = await rpc.server.readKey("notes.md", key);
        expect(isRpcError(readBack)).toBe(false);
        expect(readBack).toEqual(shape);
      }

      // A key that was never written answers null, which `unknown` accepts.
      expect(await rpc.server.readKey("notes.md", "absent")).toBeNull();
    },
    T,
  );

  test(
    "a named Record<string, unknown> travels in both directions of one call",
    async () => {
      const { rpc } = await connect();

      const first = await rpc.server.mergeFrontmatter("notes.md", {
        title: "Draft",
        tags: ["a", "b"],
        meta: { pinned: true, weight: 2.5 },
      });
      expect(isRpcError(first)).toBe(false);
      expect(first).toEqual({
        title: "Draft",
        tags: ["a", "b"],
        meta: { pinned: true, weight: 2.5 },
      });

      // A patch key set to null overwrites rather than deletes: null is a value
      // in the JSON data model, and the contract's `unknown` includes it.
      const second = await rpc.server.mergeFrontmatter("notes.md", { title: null });
      expect(second).toEqual({
        title: null,
        tags: ["a", "b"],
        meta: { pinned: true, weight: 2.5 },
      });

      // An empty patch is a legal object, not an absent one.
      expect(await rpc.server.mergeFrontmatter("empty.md", {})).toEqual({});
    },
    T,
  );

  test(
    "an empty history arrives as [], not the null a nil []any would encode to",
    async () => {
      const { rpc } = await connect();
      const history = await rpc.server.history("notes.md");
      expect(isRpcError(history)).toBe(false);
      expect(history).toEqual([]);

      await rpc.server.applyMutation({ path: "notes.md", key: "title", value: { v: 1 } });
      await rpc.server.applyMutation({ path: "notes.md", key: "title", value: null });
      expect(await rpc.server.history("notes.md")).toEqual([{ v: 1 }, null]);
    },
    T,
  );

  test(
    "a fire-and-forget call carries a JSON payload with no ack attached",
    async () => {
      const { rpc } = await connect();
      rpc.server.recordEvent("opened", { path: "notes.md", cursor: [1, 4] });
      rpc.server.recordEvent("closed", null);

      // An ack riding along would make the fire-and-forget handler see an extra
      // argument and reject the call, leaving the log empty.
      const events = (await eventsWhenVisible(rpc, 2)) as string[];
      expect(events).toHaveLength(2);
      expect(events[0]).toContain("opened=");
      expect(events[0]).toContain("cursor");
      expect(events[1]).toBe("closed=<nil>");
    },
    T,
  );

  test(
    "a Go value JSON cannot encode answers INTERNAL_ERROR instead of timing out",
    async () => {
      const { rpc } = await connect();

      // The handler returns a channel inside the result's `any`. Socket.IO's
      // write path discards encoding failures without reporting them, so without
      // the generated preflight this call would never be answered at all.
      const result = await rpc.server.unencodableValue({ timeout: 3_000 });
      expect(isRpcError(result)).toBe(true);
      if (isRpcError(result)) {
        expect(result.code).toBe("INTERNAL_ERROR");
        expect(result.code).not.toBe("TIMEOUT");
        expect(result.method).toBe("unencodableValue");
        expect(result.message).toContain("cannot encode payload");
      }

      // The refusal is per-call: the connection keeps working afterwards.
      expect(isRpcError(await rpc.server.readDocument("notes.md"))).toBe(false);
    },
    T,
  );

  test(
    "the generated Go client pushes and receives JSON values through the client",
    async () => {
      const { rpc, pushed } = await connect();
      await rpc.server.applyMutation({
        path: "notes.md",
        key: "title",
        value: { text: "Draft", revision: 3 },
      });

      // syncBack drives the generated rpc.Client: a `documentChanged` push
      // carrying a JSON map, then a `resolveConflict` acknowledgement whose
      // result is whatever JSON this client chose to answer with.
      const result = await rpc.server.syncBack("notes.md");
      expect(isRpcError(result)).toBe(false);
      expect(result).toEqual({
        path: "notes.md",
        resolved: {
          key: "title",
          incoming: { text: "Draft", revision: 3 },
          winner: "client",
        },
      });

      expect(pushed).toEqual([
        { path: "notes.md", frontmatter: { title: { text: "Draft", revision: 3 } } },
      ]);
    },
    T,
  );
});
