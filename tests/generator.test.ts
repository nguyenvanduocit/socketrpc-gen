import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, mkdirSync, rmSync, cpSync, writeFileSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const GENERATOR_PATH = path.join(PROJECT_ROOT, "index.ts");

const GENERATED_FILES = [
  "client.generated.ts",
  "server.generated.ts",
  "types.generated.ts",
] as const;

type Example = {
  dir: string;
  deps: string[];
  /** Extra CLI flags. Absent means the default all-TypeScript invocation. */
  flags?: string[];
  /** Generated files to compare, relative to the example directory. */
  files?: readonly string[];
};

// Each example's define.ts is the input. `deps` lists sibling .ts files the define.ts imports from.
const EXAMPLES: Example[] = [
  { dir: "examples/01-basic", deps: [] },
  { dir: "examples/02-single-extension", deps: ["base.define.ts"] },
  {
    dir: "examples/03-multi-level-extension",
    deps: ["framework.define.ts", "platform.define.ts"],
  },
  { dir: "examples/04-zod-integration", deps: [] },
  { dir: "examples/00-full-app/pkg/rpc", deps: [] },
  {
    // TypeScript client + Go server. No server.generated.ts is emitted, and the
    // Go package lands in its own directory so its name matches the folder.
    dir: "examples/05-go-server",
    deps: [],
    flags: ["--client", "typescript", "--server", "go", "--go-out", "rpc"],
    files: [
      "client.generated.ts",
      "types.generated.ts",
      "rpc/types.generated.go",
      "rpc/server.generated.go",
    ],
  },
];

// Generated headers embed the CLI invocation with the absolute input path
// (e.g. "bunx @nguyenvanduocit/socketrpc-gen /abs/path/define.ts"). Normalize
// both the path and the package identifier so snapshot comparisons stay stable
// across local + CI machines and across scope renames.
function normalizeHeader(content: string): string {
  return content.replace(/bunx (@[\w-]+\/)?socketrpc-gen .+$/gm, "bunx socketrpc-gen <PATH>");
}

function runGenerator(
  inputFile: string,
  flags: string[] = [],
): { exitCode: number; stderr: string; stdout: string } {
  const result = spawnSync("bun", ["run", GENERATOR_PATH, inputFile, ...flags], {
    encoding: "utf-8",
    cwd: path.dirname(inputFile),
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each test spawns `bun run index.ts`, which pays the ts-morph cold-start cost
// (typically 3-5s, occasionally more on first run after checkout).
const TEST_TIMEOUT_MS = 60_000;

describe("generator snapshot tests", () => {
  for (const ex of EXAMPLES) {
    test(
      ex.dir,
      () => {
      const exampleDir = path.join(PROJECT_ROOT, ex.dir);
      // tmp must live inside PROJECT_ROOT so ts-morph's module resolution can walk up
      // to the project's node_modules (needed for e.g. the zod example).
      const tmp = path.join(
        PROJECT_ROOT,
        ".test-tmp",
        `sockrpc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmp, { recursive: true });
      createdDirs.push(tmp);

      // Copy define.ts + any imported siblings
      for (const f of ["define.ts", ...ex.deps]) {
        cpSync(path.join(exampleDir, f), path.join(tmp, f));
      }

      const tmpInput = path.join(tmp, "define.ts");
      const { exitCode, stderr } = runGenerator(tmpInput, ex.flags);
      expect(exitCode, `generator failed for ${ex.dir}: ${stderr}`).toBe(0);

      for (const gen of ex.files ?? GENERATED_FILES) {
        const actual = readFileSync(path.join(tmp, gen), "utf-8");
        const expected = readFileSync(path.join(exampleDir, gen), "utf-8");
        expect(normalizeHeader(actual), `drift in ${ex.dir}/${gen}`).toBe(
          normalizeHeader(expected),
        );
      }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("generated API shape", () => {
  // Snapshots would absorb a regression here as "just a diff". These assert the intent.
  const EXAMPLE = path.join(PROJECT_ROOT, "examples/01-basic");
  const read = (f: string) => readFileSync(path.join(EXAMPLE, f), "utf-8");

  test("event maps are declared once, in types.generated.ts", () => {
    // Both side files exporting them collides in any module that imports client + server.
    expect(read("types.generated.ts")).toContain("export interface ClientToServerEvents");
    expect(read("client.generated.ts")).not.toContain("interface ClientToServerEvents");
    expect(read("server.generated.ts")).not.toContain("interface ServerToClientEvents");
  });

  test("`handle` holds only user-declared RPC methods", () => {
    // Keeping built-ins out of `handle` is what frees every method name for the user.
    const handleBlock = read("client.generated.ts").match(
      /export interface RpcClientHandle \{[^}]*\}/,
    )?.[0];
    expect(handleBlock).toBeDefined();
    expect(handleBlock).toContain("onMessage:");
    expect(handleBlock).not.toContain("rpcError:");
  });

  test("every subscription is a top-level `on*` returning Unsubscribe", () => {
    const client = read("client.generated.ts");
    for (const name of ["onConnect", "onDisconnect", "onReconnect", "onRpcError"]) {
      expect(client).toContain(`${name}: (handler:`);
    }
    expect(client).toContain("=> Unsubscribe;");
  });
});

/** Writes a throwaway define.ts and returns the generator's result for it. */
function generateFromSource(source: string, flags: string[] = []) {
  const tmp = path.join(
    PROJECT_ROOT,
    ".test-tmp",
    `sockrpc-src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmp, { recursive: true });
  createdDirs.push(tmp);
  const input = path.join(tmp, "define.ts");
  writeFileSync(input, source);
  return { ...runGenerator(input, flags), dir: tmp };
}

describe("method name validation", () => {
  // socket.io throws `"<name>" is a reserved event name` from emit(), so a method with one
  // of these names would only fail once the app is running. The Go backend already refused
  // them in src/go/validate.ts; this closes the same gap on the TypeScript path.
  for (const reserved of [
    "connect",
    "connect_error",
    "disconnect",
    "disconnecting",
    "newListener",
    "removeListener",
  ]) {
    test(
      `rejects '${reserved}' — a socket.io reserved event name`,
      () => {
        const { exitCode, stderr } = generateFromSource(
          `export interface ServerFunctions { ${reserved}: (reason: string) => void; }\n` +
            `export interface ClientFunctions { ping: () => void; }\n`,
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain(`'${reserved}' is a socket.io reserved event name`);
      },
      TEST_TIMEOUT_MS,
    );
  }

  // These were reserved when `handle` and the call namespaces still held built-in
  // members. They no longer do, so a domain method may legitimately use these names.
  test(
    "accepts names that collide only with the top-level RpcClient/RpcServer surface",
    () => {
      const { exitCode, stderr, dir } = generateFromSource(
        `export interface ServerFunctions {\n` +
          `  handle: (id: string) => void;\n` +
          `  dispose: (id: string) => void;\n` +
          `  connected: () => boolean;\n` +
          `  socket: (id: string) => string;\n` +
          `  client: (id: string) => string;\n` +
          `  server: (id: string) => string;\n` +
          `  onRpcError: (message: string) => void;\n` +
          `}\n` +
          `export interface ClientFunctions { ping: () => void; }\n`,
      );
      expect(exitCode, stderr).toBe(0);
      const client = readFileSync(path.join(dir, "client.generated.ts"), "utf-8");
      expect(client).toContain("dispose: (id: string, opts?: RpcCallOptions) => void;");
      expect(client).toContain("connected: (opts?: RpcCallOptions) => Promise<boolean | RpcError>;");
    },
    TEST_TIMEOUT_MS,
  );
});
