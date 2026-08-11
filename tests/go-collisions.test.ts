import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { RPC_SCHEMA_VERSION, type RpcMethod, type RpcSchema } from "../src/schema";
import { generateGo } from "../src/go";
import { GENERATED_PREFIX, exportedIdentifier, isGoIdentifier, localIdentifier } from "../src/go/names";

/**
 * Guards the property the Go backend's collision-safety rests on.
 *
 * A hand-written list of reserved words has to be kept in step with the emitter
 * by whoever edits the emitter next, and shipped Go that did not compile once
 * that step was missed. This suite derives its adversarial contract *from the
 * emitter's own output* instead: it generates a package, harvests every Go
 * identifier in it, keeps the ones a contract could actually name, and feeds
 * them back in as parameter names. Adding an unprefixed local to the emitter
 * therefore breaks this test on the next run, with no list to remember.
 */

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "go-emitter");
const temporaryDirectories: string[] = [];

const scalar = (name: "string" | "boolean" | "number") => ({ kind: "scalar", name }) as const;
const VOID = { kind: "void" } as const;

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/** A contract broad enough that the emitter writes every shape of body. */
const probe: RpcSchema = {
  version: RPC_SCHEMA_VERSION,
  declarations: [
    { kind: "enum", name: "Mode", values: ["fast", "slow"] },
    { kind: "alias", name: "Names", target: { kind: "array", element: scalar("string") } },
    {
      kind: "object",
      name: "Record",
      fields: [
        { name: "id", type: scalar("string") },
        { name: "names", type: { kind: "array", element: scalar("string") } },
        { name: "mode", type: { kind: "named", name: "Mode" } },
      ],
    },
  ],
  methods: [
    {
      name: "fetch",
      direction: "client-to-server",
      params: [{ name: "query", type: scalar("string") }],
      returnType: { kind: "named", name: "Record" },
    },
    { name: "touch", direction: "client-to-server", params: [], returnType: VOID },
    {
      name: "ask",
      direction: "server-to-client",
      params: [{ name: "question", type: scalar("string") }],
      returnType: scalar("boolean"),
    },
    { name: "push", direction: "server-to-client", params: [], returnType: VOID },
  ],
};

/** Every Go identifier the emitter puts on the page. */
function harvestIdentifiers(sources: readonly string[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const [identifier] of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) found.add(identifier);
  }
  return [...found].sort();
}

/**
 * Narrows the harvest to names a contract can actually hand the emitter.
 *
 * A parameter name reaches Go through `localIdentifier`, so only its fixed
 * points are reachable — which is exactly why the `rpc_` prefix works: no wire
 * name survives the round trip with an underscore intact. Go keywords are
 * refused by validation before the emitter sees them, and `ctx` is the one
 * documented reservation.
 */
function reachableAsParameterName(identifier: string): boolean {
  return (
    isGoIdentifier(identifier) && localIdentifier(identifier) === identifier && identifier !== "ctx"
  );
}

/** Splits the harvest into methods small enough to stay readable when one fails. */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function hostileSchema(names: readonly string[]): RpcSchema {
  const methods: RpcMethod[] = [];

  chunk(names, 10).forEach((group, index) => {
    const params = group.map((name) => ({ name, type: scalar("string") }));
    // All four body shapes the emitter writes: an inbound handler with and
    // without an acknowledgement, and a client method with and without a result.
    methods.push(
      {
        name: `inboundValue${index}`,
        direction: "client-to-server",
        params,
        returnType: { kind: "named", name: "Record" },
      },
      { name: `inboundVoid${index}`, direction: "client-to-server", params, returnType: VOID },
      {
        name: `outboundValue${index}`,
        direction: "server-to-client",
        params,
        returnType: scalar("string"),
      },
      { name: `outboundVoid${index}`, direction: "server-to-client", params, returnType: VOID },
    );
  });

  return { ...probe, methods };
}

describe("Go identifier collision safety", () => {
  test("no identifier derived from a contract can contain the generated prefix", () => {
    const corpus = [
      "rpc_call",
      "rpc call",
      "rpc-call",
      "rpc.call",
      "__proto__",
      "user_id",
      "_leading",
      "trailing_",
      "a_b_c",
      "$dollar",
      "mixed_Case-name.here",
    ];

    for (const name of corpus) {
      expect(localIdentifier(name)).not.toContain("_");
      expect(exportedIdentifier(name)).not.toContain("_");
    }
    // The whole guarantee is that this prefix is unreachable from a wire name.
    expect(GENERATED_PREFIX).toContain("_");
  });

  test("every emitter-owned identifier survives being used as a parameter name", () => {
    const generated = generateGo(probe);
    const harvested = harvestIdentifiers(Object.values(generated));
    const hostile = harvested.filter(reachableAsParameterName);

    // A harvest that collapsed to nothing would make this suite vacuous.
    expect(hostile.length).toBeGreaterThan(20);
    // The names the review found shipping broken Go must be in the corpus.
    for (const regression of ["b", "c", "result", "err", "response", "fmt", "sync", "context"]) {
      expect(hostile, `${regression} is no longer covered by the harvest`).toContain(regression);
    }

    const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-go-collisions-"));
    temporaryDirectories.push(directory);

    const sources = generateGo(hostileSchema(hostile));
    for (const [filename, source] of Object.entries(sources)) {
      writeFileSync(path.join(directory, filename), source);
    }
    writeFileSync(
      path.join(directory, "go.mod"),
      `module socketrpc.collisions.test

go 1.22

require github.com/zishang520/socket.io/servers/socket/v3 v3.0.0

replace github.com/zishang520/socket.io/servers/socket/v3 => ${JSON.stringify(path.join(FIXTURE_DIR, "socketstub"))}
`,
    );

    const build = spawnSync("go", ["build", "./..."], {
      cwd: directory,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    const vet = spawnSync("go", ["vet", "./..."], {
      cwd: directory,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(vet.status, `${vet.stdout}\n${vet.stderr}`).toBe(0);

    const formatted = spawnSync("gofmt", ["-l", directory], { encoding: "utf8" });
    expect(formatted.stdout.trim(), "hostile contract is not gofmt-clean").toBe("");
  }, 90_000);

  test("the context parameter stays the single documented reservation", () => {
    expect(() =>
      generateGo({
        ...probe,
        methods: [
          {
            name: "clash",
            direction: "client-to-server",
            params: [{ name: "ctx", type: scalar("string") }],
            returnType: VOID,
          },
        ],
      }),
    ).toThrow("names the context parameter");
  });
});
