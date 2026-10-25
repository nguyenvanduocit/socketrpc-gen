import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { run, waitForAddress } from "./helpers/go-server";

// End-to-end harness for optional and nullable booleans and named enums.
//
// tests/schema.test.ts proves the schema reads `verified?: boolean` and
// `status?: Status` as what the author wrote, and checks the Go text with regular
// expressions. This file proves the other half: that the Go the generator emits
// for them is real Go (gofmt-clean, vet-clean), and that the values survive a
// round trip through a live Socket.IO server, which no regular expression can say.
//
// The trap is `false`. A bool field tagged `omitempty` drops `false` and would
// answer "absent" for "no"; the generator spells it `*bool`, and "answers false
// as false, not as absent" below fails if that ever stops being true.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "optional-nullable");
const GENERATOR_PATH = join(resolve(import.meta.dir, ".."), "index.ts");

// Generated, compiled and started during module evaluation rather than in
// beforeAll: generation plus a cold Go compile-and-link runs well past
// bun:test's 5s hook budget, and hooks accept no timeout override.
const workDir = await mkdtemp(join(tmpdir(), "socketrpc-optional-nullable-"));
const tsDir = join(workDir, "ts");
const goDir = join(workDir, "goserver");
const goPkgDir = join(goDir, "rpc");
mkdirSync(tsDir, { recursive: true });
mkdirSync(goPkgDir, { recursive: true });

cpSync(join(FIXTURE_DIR, "define.ts"), join(tsDir, "define.ts"));
for (const file of ["go.mod", "go.sum", "main.go"]) {
  cpSync(join(FIXTURE_DIR, "goserver", file), join(goDir, file));
}

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

// The full vet pass with no analyzer excluded, run before the build so a mistake
// in the projection of a pointer-wrapped type is reported as itself.
run(["go", "vet", "./..."], goDir, "go vet on generated bindings");

const binary = join(workDir, "optional-nullable-server");
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

/** Connect a fresh client to the generated Go server and wrap it in the generated RPC client. */
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

  return createRpcClient(socket);
}

/** An account whose required fields hold their quietest values. */
function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    suspended: null,
    previous: null,
    mentor: null,
    history: [],
    switches: {},
    ...overrides,
  };
}

afterEach(() => {
  for (const socket of openClients.splice(0)) socket.close();
});

afterAll(async () => {
  // SIGTERM, which the Go server handles by shutting the listener down; awaiting
  // `exited` guarantees the port is released before the suite returns.
  goServer.kill();
  await goServer.exited;
  await rm(workDir, { recursive: true, force: true });
});

const T = 15_000;

describe("the Go emitted for optional and nullable booleans and enums is real Go", () => {
  test("every generated file is gofmt-clean", () => {
    expect(unformatted, `gofmt reported unformatted files:\n${unformatted}`).toBe("");
  });
});

describe("an optional boolean", () => {
  test(
    "answers false as false, not as absent",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account({ verified: false }));
      expect(isRpcError(result)).toBe(false);
      expect(result.verified).toBe(false);
    },
    T,
  );

  test(
    "answers true as true",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account({ verified: true }));
      expect(result.verified).toBe(true);
    },
    T,
  );

  test(
    "stays out of the reply when it never went in",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account());
      expect(isRpcError(result)).toBe(false);
      expect(result).not.toHaveProperty("verified");
    },
    T,
  );
});

describe("a nullable boolean", () => {
  test(
    "keeps null, true and false apart",
    async () => {
      const rpc = await connect();
      const nothing = await rpc.server.echo(account({ suspended: null }));
      const yes = await rpc.server.echo(account({ suspended: true }));
      const no = await rpc.server.echo(account({ suspended: false }));
      expect(nothing.suspended).toBeNull();
      expect(yes.suspended).toBe(true);
      expect(no.suspended).toBe(false);
    },
    T,
  );

  test(
    "reaches a handler parameter as nil, true or false",
    async () => {
      const rpc = await connect();
      expect(await rpc.server.describe(null, null)).toBe("flag=nil status=nil");
      expect(await rpc.server.describe(true, null)).toBe("flag=true status=nil");
      expect(await rpc.server.describe(false, null)).toBe("flag=false status=nil");
    },
    T,
  );
});

describe("an optional nullable boolean", () => {
  test(
    "keeps a value and comes back without the key for null, which Go cannot tell from absent",
    async () => {
      const rpc = await connect();
      const value = await rpc.server.echo(account({ reviewed: false }));
      const nothing = await rpc.server.echo(account({ reviewed: null }));
      expect(value.reviewed).toBe(false);
      // An RpcError has no `reviewed` either, so say outright that this is a reply.
      expect(isRpcError(nothing)).toBe(false);
      expect(nothing).not.toHaveProperty("reviewed");
    },
    T,
  );
});

describe("a named string union behind a modifier", () => {
  test(
    "round-trips optional, nullable and optional nullable values",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(
        account({ status: "archived", previous: "active", next: "active" }),
      );
      expect(result.status).toBe("archived");
      expect(result.previous).toBe("active");
      expect(result.next).toBe("active");
    },
    T,
  );

  test(
    "leaves an omitted optional out and keeps a nullable null",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account());
      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("next");
      expect(result.previous).toBeNull();
    },
    T,
  );

  test(
    "reaches a handler parameter as nil or its value",
    async () => {
      const rpc = await connect();
      expect(await rpc.server.describe(null, "active")).toBe("flag=nil status=active");
      expect(await rpc.server.describe(false, "archived")).toBe("flag=false status=archived");
    },
    T,
  );

  test(
    "refuses a value outside the declared set",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account({ status: "bogus" }));
      expect(isRpcError(result)).toBe(true);
      expect((result as { code: string }).code).toBe("INVALID_ARGUMENT");
    },
    T,
  );
});

describe("a TypeScript enum behind a modifier", () => {
  test(
    "round-trips optional and nullable values",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account({ role: "owner", mentor: "guest" }));
      expect(result.role).toBe("owner");
      expect(result.mentor).toBe("guest");
    },
    T,
  );

  test(
    "leaves an omitted optional out and keeps a nullable null",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(account());
      expect(result).not.toHaveProperty("role");
      expect(result.mentor).toBeNull();
    },
    T,
  );
});

describe("a nullable element inside an array or a map", () => {
  test(
    "round-trips null next to values",
    async () => {
      const rpc = await connect();
      const result = await rpc.server.echo(
        account({
          history: ["active", null, "archived"],
          switches: { on: true, off: false, unset: null },
        }),
      );
      expect(result.history).toEqual(["active", null, "archived"]);
      expect(result.switches).toEqual({ on: true, off: false, unset: null });
    },
    T,
  );
});
