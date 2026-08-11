import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { RPC_SCHEMA_VERSION, type ObjectField, type RpcMethod, type RpcSchema } from "../src/schema";
import { generateGo } from "../src/go";
import {
  CLIENT_METHOD_PREFIX,
  GENERATED_PREFIX,
  HANDLER_METHOD_PREFIX,
  clientMethodName,
  exportedIdentifier,
  handlerMethodName,
  isExportedGoIdentifier,
  isGoIdentifier,
  localIdentifier,
} from "../src/go/names";

/**
 * Guards the property the Go backend's collision-safety rests on.
 *
 * A hand-written list of reserved words has to be kept in step with the emitter
 * by whoever edits the emitter next, and shipped Go that did not compile once
 * that step was missed. This suite derives its adversarial contract *from the
 * emitter's own output* instead: it generates a package, harvests every Go
 * identifier in it, and feeds each one back through *every channel a contract
 * owns* — parameter names, method names in both directions, object field names
 * and declaration names. Adding an unprefixed identifier to the emitter
 * therefore breaks this test on the next run, with no list to remember.
 *
 * Each channel ends in one of two places, and the suite pins which: the
 * generated package compiles, or the contract is refused by name with a
 * diagnostic. Silent non-compiling Go is what this file exists to prevent.
 *
 * Every channel is vetted with the analyzer set `go vet` runs by default and no
 * exclusions, so an emitter change that reintroduces a name the standard library
 * has claimed fails here rather than in a consumer's build.
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
 * The wire names worth aiming at an emitter identifier.
 *
 * A contract name reaches Go through `localIdentifier` or `exportedIdentifier`,
 * so the harvest alone would only ever hit the emitter's lower-camel names. Both
 * projections of each harvested identifier are added, which is what turns the
 * `disconnect` the emitter writes as an event string into the `Disconnect` a
 * method name can actually produce.
 */
function candidateWireNames(sources: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const identifier of harvestIdentifiers(sources)) {
    candidates.add(identifier);
    candidates.add(exportedIdentifier(identifier));
    candidates.add(localIdentifier(identifier));
  }
  // Names the review found shipping broken Go, kept explicit so a change in the
  // emitter's wording can never quietly drop them from the corpus.
  for (const regression of ["Disconnect", "_disconnect", "MarshalJSON", "marshalJSON", "RpcError"]) {
    candidates.add(regression);
  }
  candidates.delete("");
  return [...candidates].sort();
}

/**
 * Narrows the corpus to names that survive the round trip a channel applies.
 *
 * Only fixed points are useful: a wire name whose projection differs from itself
 * aims at a Go identifier the emitter never wrote. `exportedIdentifier` and
 * `localIdentifier` split on every non-alphanumeric rune, which is exactly why
 * the `rpc_` prefix works — no wire name survives with an underscore intact.
 */
const reachableAs = {
  parameter: (name: string) => isGoIdentifier(name) && localIdentifier(name) === name,
  exported: (name: string) =>
    isExportedGoIdentifier(name) && exportedIdentifier(name) === name,
} as const;

/** Splits the harvest into methods small enough to stay readable when one fails. */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

interface Verdict {
  readonly accepted: string[];
  readonly refused: Map<string, string>;
}

/** Runs one name through one channel and records whether the backend took it. */
function verdictFor(names: readonly string[], build: (name: string) => RpcSchema): Verdict {
  const accepted: string[] = [];
  const refused = new Map<string, string>();
  for (const name of names) {
    try {
      generateGo(build(name));
      accepted.push(name);
    } catch (error) {
      refused.set(name, (error as Error).message);
    }
  }
  return { accepted, refused };
}

/** Builds, vets and gofmt-checks one generated package. */
function compile(label: string, sources: Record<string, string>): void {
  const directory = mkdtempSync(path.join(tmpdir(), "socketrpc-go-collisions-"));
  temporaryDirectories.push(directory);
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

  const built = spawnSync("go", ["build", "./..."], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(built.status, `${label}: ${built.stdout}\n${built.stderr}`).toBe(0);

  const vet = spawnSync("go", ["vet", "./..."], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(vet.status, `${label}: ${vet.stdout}\n${vet.stderr}`).toBe(0);

  const formatted = spawnSync("gofmt", ["-l", directory], { encoding: "utf8" });
  expect(formatted.stdout.trim(), `${label} is not gofmt-clean`).toBe("");
}

const corpus = candidateWireNames(Object.values(generateGo(probe)));

/**
 * The method names the standard library gives a fixed signature, as of Go 1.26
 * (`cmd/vendor/golang.org/x/tools/go/analysis/passes/stdmethods`).
 *
 * `go vet` objects to *any* method carrying one of these names with a different
 * signature — on any type, whoever declared it — and a contract is free to call
 * an RPC method `scan`, `seek` or `marshalJSON`. This list is the corpus this
 * suite aims at the emitter, never a rule the emitter consults: generation
 * derives nothing from it, so a later Go release adding a name cannot leave the
 * emitter stale. What closes the class is the shape of a generated method name,
 * which the test below pins against the whole family.
 */
const GO_STDMETHODS = [
  "As",
  "Format",
  "GobDecode",
  "GobEncode",
  "Is",
  "MarshalJSON",
  "MarshalXML",
  "ReadByte",
  "ReadFrom",
  "ReadRune",
  "Scan",
  "Seek",
  "UnmarshalJSON",
  "UnmarshalXML",
  "UnreadByte",
  "UnreadRune",
  "Unwrap",
  "WriteByte",
  "WriteTo",
] as const;

describe("Go identifier collision safety", () => {
  test("no identifier derived from a contract can contain the generated prefix", () => {
    const names = [
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

    for (const name of names) {
      expect(localIdentifier(name)).not.toContain("_");
      expect(exportedIdentifier(name)).not.toContain("_");
    }
    // The whole guarantee is that this prefix is unreachable from a wire name.
    expect(GENERATED_PREFIX).toContain("_");
  });

  test("every emitter-owned identifier survives being used as a parameter name", () => {
    const hostile = corpus.filter(reachableAs.parameter);

    // A harvest that collapsed to nothing would make this suite vacuous.
    expect(hostile.length).toBeGreaterThan(20);
    for (const regression of ["b", "c", "result", "err", "response", "fmt", "sync", "context"]) {
      expect(hostile, `${regression} is no longer covered by the harvest`).toContain(regression);
    }

    const { accepted, refused } = verdictFor(hostile, (name) => ({
      ...probe,
      methods: [
        {
          name: "probe",
          direction: "client-to-server",
          params: [{ name, type: scalar("string") }],
          returnType: VOID,
        },
      ],
    }));
    // `ctx` names the context parameter of the signature developers implement.
    expect([...refused.keys()]).toEqual(["ctx"]);
    expect(refused.get("ctx")).toContain("names the context parameter");

    const methods: RpcMethod[] = [];
    chunk(accepted, 10).forEach((group, index) => {
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

    compile("parameter names", generateGo({ ...probe, methods }));
  }, 90_000);

  test("every emitter-owned identifier survives being used as a method name", () => {
    const hostile = corpus.filter(reachableAs.exported);
    expect(hostile.length).toBeGreaterThan(20);
    // The inbound listener field and dispatch method are derived from the method
    // name, which is how `Disconnect` used to redeclare the emitter's own.
    for (const regression of ["Disconnect", "Handler", "Dispose", "Context", "MarshalJSON"]) {
      expect(hostile, `${regression} is no longer covered by the harvest`).toContain(regression);
    }

    const inbound = verdictFor(hostile, (name) => ({
      ...probe,
      methods: [{ name, direction: "client-to-server", params: [], returnType: VOID }],
    }));
    // A server-side method reaches Go as an unexported `listen…`/`handle…`
    // member, which the emitter's own members stay clear of by construction, so
    // nothing in the harvest is out of bounds here.
    expect([...inbound.refused.keys()]).toEqual([]);
    expect(inbound.accepted).toContain("Disconnect");

    // Socket.IO's own events remain refused, and that check is on the raw wire
    // name — `Disconnect` above is a different name that merely projects onto
    // the same Go identifier the emitter's disconnect listener once used.
    const reserved = verdictFor(["disconnect", "connect", "newListener", "removeListener"], (name) => ({
      ...probe,
      methods: [{ name, direction: "client-to-server", params: [], returnType: VOID }],
    }));
    expect(reserved.accepted).toEqual([]);
    for (const [name, message] of reserved.refused) {
      expect(message, `${name} was refused for an undocumented reason`).toContain(
        "is reserved by Socket.IO/SocketRPC",
      );
    }

    const outbound = verdictFor(hostile, (name) => ({
      ...probe,
      methods: [{ name, direction: "server-to-client", params: [], returnType: VOID }],
    }));
    // A client-side method reaches Go as `Call…`, which `Client`'s own exported
    // members — `Socket`, `Done`, `Connected`, `Dispose` — can never be spelled
    // as, so this channel refuses nothing either.
    expect([...outbound.refused.keys()]).toEqual([]);
    for (const previouslyReserved of ["Dispose", "Connected", "Done", "Socket"]) {
      expect(outbound.accepted, `${previouslyReserved} is no longer a legal method name`).toContain(
        previouslyReserved,
      );
    }

    compile("inbound method names", generateGo({
      ...probe,
      methods: inbound.accepted.map((name) => ({
        name,
        direction: "client-to-server",
        params: [{ name: "value", type: scalar("string") }],
        returnType: { kind: "named", name: "Record" },
      })),
    }));

    compile("outbound method names", generateGo({
      ...probe,
      methods: outbound.accepted.map((name) => ({
        name,
        direction: "server-to-client",
        params: [{ name: "value", type: scalar("string") }],
        returnType: scalar("string"),
      })),
    }));
  }, 120_000);

  test("no contract method name can reach a canonical standard library method name", () => {
    // Every generated method is a prefix followed by the contract's own name,
    // which validation admits only as an exported Go identifier — and which can
    // hold no underscore, because both projections split on non-alphanumerics.
    const shape = new RegExp(`^(${HANDLER_METHOD_PREFIX}|${CLIENT_METHOD_PREFIX})[A-Z][A-Za-z0-9]*$`);

    // The family is disjoint from that shape, so no wire name reaches it. This
    // is the whole argument, and it holds for the names of later Go releases as
    // much as for the ones pinned above: a canonical method is a bare standard
    // library verb, and a generated one never is.
    for (const canonical of GO_STDMETHODS) {
      expect(canonical, `${canonical} is shaped like a generated method name`).not.toMatch(shape);
    }

    for (const canonical of GO_STDMETHODS) {
      for (const projected of [handlerMethodName(canonical), clientMethodName(canonical)]) {
        expect(projected).toMatch(shape);
        expect(GO_STDMETHODS, `${canonical} still reaches ${projected}`).not.toContain(projected);
      }
      // The lower-camel wire spelling a define file actually writes.
      const wire = localIdentifier(canonical);
      expect(handlerMethodName(wire)).toBe(handlerMethodName(canonical));
      expect(clientMethodName(wire)).toBe(clientMethodName(canonical));
    }

    // …and the same names driven through the emitter, vetted with no exclusions.
    const inbound = generateGo({
      ...probe,
      methods: GO_STDMETHODS.map((canonical) => ({
        name: localIdentifier(canonical),
        direction: "client-to-server" as const,
        params: [{ name: "value", type: scalar("string") }],
        returnType: { kind: "named" as const, name: "Record" },
      })),
    });
    expect(inbound["server.generated.go"]).toContain(
      "HandleMarshalJSON(ctx context.Context, value string) (Record, error)",
    );
    compile("canonical method names, inbound", inbound);

    const outbound = generateGo({
      ...probe,
      methods: GO_STDMETHODS.map((canonical) => ({
        name: localIdentifier(canonical),
        direction: "server-to-client" as const,
        params: [{ name: "value", type: scalar("string") }],
        returnType: scalar("string"),
      })),
    });
    expect(outbound["server.generated.go"]).toContain("func (rpc_c *Client) CallSeek(");
    compile("canonical method names, outbound", outbound);
  }, 120_000);

  test("every emitter-owned identifier survives being used as an object field name", () => {
    const hostile = corpus.filter(reachableAs.exported);
    expect(hostile).toContain("MarshalJSON");

    // A struct's method namespace is the one the emitter cannot move behind the
    // `rpc_` prefix, because `encoding/json` dictates the spelling. No field is
    // refused for it: the struct gives the name up and normalizes per field.
    const { accepted, refused } = verdictFor(hostile, (name) => ({
      ...probe,
      declarations: [
        ...probe.declarations,
        { kind: "object", name: "Probe", fields: [{ name, type: scalar("string") }] },
      ],
    }));
    expect([...refused.keys()]).toEqual([]);

    const fields: ObjectField[] = accepted.map((name) => ({ name, type: scalar("string") }));
    compile("object field names", generateGo({
      ...probe,
      declarations: [
        ...probe.declarations,
        // The nilable fields are what makes the marshaller necessary, and a
        // conditional collision is what made the old failure so easy to miss.
        {
          kind: "object",
          name: "Probe",
          fields: [
            ...fields,
            { name: "tagsRequired", type: { kind: "array", element: scalar("string") } },
            { name: "countsRequired", type: { kind: "map", value: scalar("number") } },
            { name: "aliasedRequired", type: { kind: "named", name: "Names" } },
          ],
        },
      ],
      methods: [
        {
          name: "probeFields",
          direction: "client-to-server",
          params: [],
          returnType: { kind: "named", name: "Probe" },
        },
      ],
    }));
  }, 90_000);

  test("every emitter-owned identifier survives being used as a declaration name", () => {
    const hostile = corpus.filter(reachableAs.exported);

    const { accepted, refused } = verdictFor(hostile, (name) => ({
      ...probe,
      declarations: [{ kind: "object", name, fields: [{ name: "value", type: scalar("string") }] }],
      methods: [],
    }));
    for (const [name, message] of refused) {
      expect(message, `${name} was refused for an undocumented reason`).toContain(
        "collides with the generated package API",
      );
    }
    for (const reserved of ["ServerHandler", "ServerBinding", "Client", "ClientOptions"]) {
      expect(refused.get(reserved), `${reserved} no longer collides`).toBeDefined();
    }

    compile("declaration names", generateGo({
      ...probe,
      declarations: accepted.map((name) => ({
        kind: "object",
        name,
        fields: [{ name: "value", type: scalar("string") }],
      })),
      methods: [],
    }));
  }, 90_000);

  test("ServerBinding's own members stay inside the reserved namespace", () => {
    const server = generateGo(probe)["server.generated.go"]!;
    const struct = server.match(/type ServerBinding struct \{\n([\s\S]*?)\n\}/)?.[1];
    expect(struct, "ServerBinding is no longer a struct literal in the output").toBeDefined();

    const members = [
      ...[...struct!.matchAll(/^\t([A-Za-z_][A-Za-z0-9_]*)\s/gm)].map(([, name]) => name!),
      ...[...server.matchAll(/^func \(b \*ServerBinding\) ([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map(
        ([, name]) => name!,
      ),
    ];
    // The contract's own members are derived from a method name, so they can
    // never contain an underscore. Everything else the emitter puts on this type
    // therefore has to carry the prefix — or be part of the exported API, which
    // a `listen…`/`handle…` member can never be.
    const contractDerived = probe.methods
      .filter((method) => method.direction === "client-to-server")
      .flatMap((method) => [
        `listen${exportedIdentifier(method.name)}`,
        `handle${exportedIdentifier(method.name)}`,
      ]);
    expect(members.length).toBeGreaterThan(contractDerived.length);
    for (const member of members) {
      if (contractDerived.includes(member)) continue;
      expect(
        member.startsWith(GENERATED_PREFIX) || isExportedGoIdentifier(member),
        `ServerBinding.${member} is neither exported API nor in the ${GENERATED_PREFIX} namespace`,
      ).toBe(true);
    }
    for (const derived of contractDerived) {
      expect(members, `${derived} is no longer emitted`).toContain(derived);
    }
  });
});
