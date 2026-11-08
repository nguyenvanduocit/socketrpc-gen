import { describe, expect, test } from "bun:test";
import { RPC_SCHEMA_VERSION, type RpcSchema, type TypeDeclaration, type RpcMethod } from "../src/schema";
import { generateRust, RustSchemaError } from "../src/rust";

// The Rust backend's pure surface: what it refuses, and how it spells what it
// accepts. Whether the spelling compiles and talks to every peer is proven in
// tests/rust-crosslang.integration.test.ts, which builds and runs it.

const scalar = (name: "string" | "boolean" | "number") => ({ kind: "scalar", name }) as const;
const named = (name: string) => ({ kind: "named", name }) as const;
const VOID = { kind: "void" } as const;

function schemaOf(declarations: TypeDeclaration[], methods: RpcMethod[] = []): RpcSchema {
  return { version: RPC_SCHEMA_VERSION, declarations, methods };
}

function refusal(schema: RpcSchema): string {
  try {
    generateRust(schema, { server: true, client: true });
  } catch (error) {
    expect(error).toBeInstanceOf(RustSchemaError);
    return (error as Error).message;
  }
  throw new Error("expected the schema to be refused");
}

describe("Rust spelling", () => {
  const files = generateRust(
    schemaOf(
      [
        { kind: "enum", name: "Status", values: ["active", "pending-review", "1st"] },
        {
          kind: "object",
          name: "HTTPRecord",
          fields: [
            { name: "displayName", type: scalar("string") },
            { name: "type", type: scalar("string") },
            { name: "self", type: scalar("boolean") },
            { name: "note", type: { kind: "optional", type: scalar("string") } },
            { name: "owner", type: { kind: "nullable", type: scalar("string") } },
            { name: "due", type: { kind: "optional", type: { kind: "nullable", type: scalar("string") } } },
            { name: "extra", type: { kind: "json" } },
            { name: "scores", type: { kind: "map", value: scalar("number") } },
          ],
        },
      ],
      [
        { name: "save", direction: "client-to-server", params: [{ name: "record", type: named("HTTPRecord") }, { name: "status", type: named("Status") }], returnType: scalar("boolean") },
        { name: "ping", direction: "server-to-client", params: [{ name: "text", type: scalar("string") }], returnType: VOID },
      ],
    ),
    { server: true, client: true, defaultTimeoutMs: 1234 },
  );

  test("writes one module directory: mod.rs, types.rs and a file per side", () => {
    expect(Object.keys(files).sort()).toEqual(["client.rs", "mod.rs", "server.rs", "types.rs"]);
    expect(files["mod.rs"]).toContain("pub mod server;");
    expect(files["mod.rs"]).toContain("pub mod client;");
    const serverOnly = generateRust(schemaOf([]), { server: true });
    expect(Object.keys(serverOnly).sort()).toEqual(["mod.rs", "server.rs", "types.rs"]);
    expect(serverOnly["mod.rs"]).not.toContain("pub mod client;");
  });

  test("types are UpperCamelCase, fields snake_case, renamed back to the wire name", () => {
    const types = files["types.rs"] ?? "";
    expect(types).toContain("pub struct HttpRecord {");
    expect(types).toContain('    #[serde(rename = "displayName")]\n    pub display_name: String,');
    expect(types).toContain('    #[serde(rename = "type")]\n    pub r#type: String,');
    expect(types).toContain('    #[serde(rename = "self")]\n    pub self_: bool,');
  });

  test("absence: omitted, null, and both are three different spellings", () => {
    const types = files["types.rs"] ?? "";
    expect(types).toContain('    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub note: Option<String>,');
    expect(types).toContain("    pub owner: Option<String>,");
    expect(types).toContain(
      '    #[serde(default, skip_serializing_if = "Option::is_none", with = "rpc_double_option")]\n    pub due: Option<Option<String>>,',
    );
    expect(types).toContain("    #[serde(default)]\n    pub extra: ::serde_json::Value,");
    expect(types).toContain("    pub scores: ::std::collections::HashMap<String, f64>,");
  });

  test("string enums keep their literals and become Copy", () => {
    const types = files["types.rs"] ?? "";
    expect(types).toContain('    #[serde(rename = "pending-review")]\n    PendingReview,');
    expect(types).toContain('    #[serde(rename = "1st")]\n    V1st,');
    expect(types).toContain("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, ::serde::Serialize, ::serde::Deserialize)]");
  });

  test("handlers take owned values, callers lend them", () => {
    const server = files["server.rs"] ?? "";
    expect(server).toContain("    fn handle_save(\n        &self,\n        ctx: Context,\n        record: HttpRecord,\n        status: Status,\n    ) -> impl Future<Output = Result<bool, RpcError>> + Send;");
    expect(server).toContain("    pub fn call_ping(&self, text: &str) -> Result<(), RpcError> {");
    const client = files["client.rs"] ?? "";
    expect(client).toContain("    pub async fn call_save(&self, record: &HttpRecord, status: Status) -> Result<bool, RpcError> {");
    expect(client).toContain("    fn handle_ping(\n        &self,\n        ctx: Context,\n        text: String,\n    ) -> impl Future<Output = Result<(), RpcError>> + Send;");
  });

  test("the default timeout reaches both callers", () => {
    expect(files["server.rs"]).toContain("Duration::from_millis(1234)");
    expect(files["client.rs"]).toContain("timeout: Duration::from_millis(1234),");
  });
});

describe("recursion", () => {
  test("a struct reaching itself through an optional field is boxed there", () => {
    const files = generateRust(
      schemaOf([
        { kind: "object", name: "Node", fields: [{ name: "next", type: { kind: "optional", type: named("Node") } }] },
      ]),
    );
    expect(files["types.rs"]).toContain("pub next: Option<Box<Node>>,");
  });

  test("a cycle with one optional hop is accepted, and only that hop is boxed", () => {
    const files = generateRust(
      schemaOf([
        { kind: "object", name: "A", fields: [{ name: "b", type: named("B") }] },
        { kind: "object", name: "B", fields: [{ name: "a", type: { kind: "nullable", type: named("A") } }] },
      ]),
    );
    expect(files["types.rs"]).toContain("pub b: B,");
    expect(files["types.rs"]).toContain("pub a: Option<Box<A>>,");
  });

  test("a Vec breaks a cycle without a Box", () => {
    const files = generateRust(
      schemaOf([
        { kind: "object", name: "Tree", fields: [{ name: "children", type: { kind: "array", element: named("Tree") } }] },
      ]),
    );
    expect(files["types.rs"]).toContain("pub children: Vec<Tree>,");
  });

  test("a cycle of required fields has no finite size and is refused with its trail", () => {
    expect(
      refusal(
        schemaOf([
          { kind: "object", name: "A", fields: [{ name: "b", type: named("B") }] },
          { kind: "object", name: "B", fields: [{ name: "a", type: named("A") }] },
        ]),
      ),
    ).toContain("A -> B -> A");
  });
});

describe("refusals", () => {
  const method = (overrides: Partial<RpcMethod>): RpcMethod => ({
    name: "go",
    direction: "client-to-server",
    params: [],
    returnType: VOID,
    ...overrides,
  });

  test("a declaration named like the generated API or the prelude", () => {
    expect(refusal(schemaOf([{ kind: "enum", name: "Context", values: ["a"] }]))).toContain("Rename the declaration");
    expect(refusal(schemaOf([{ kind: "enum", name: "Result", values: ["a"] }]))).toContain("Rust type Result");
  });

  test("two names that derive to one Rust name", () => {
    expect(
      refusal(
        schemaOf([{ kind: "object", name: "X", fields: [{ name: "fooBar", type: scalar("string") }, { name: "foo_bar", type: scalar("string") }] }]),
      ),
    ).toContain("both map to the Rust field foo_bar");
    expect(refusal(schemaOf([{ kind: "enum", name: "E", values: ["a-b", "a_b"] }]))).toContain("both map to the Rust variant AB");
    expect(refusal(schemaOf([], [method({ name: "getX" }), method({ name: "get_x" })]))).toContain("both map to the Rust method");
  });

  test("an enum literal with no letter or digit", () => {
    expect(refusal(schemaOf([{ kind: "enum", name: "E", values: ["-"] }]))).toContain("cannot derive a Rust variant name");
  });

  test("a parameter named ctx, and an optional positional parameter", () => {
    expect(refusal(schemaOf([], [method({ params: [{ name: "ctx", type: scalar("string") }] })]))).toContain(
      "context parameter",
    );
    expect(
      refusal(schemaOf([], [method({ params: [{ name: "a", type: { kind: "optional", type: scalar("string") } }] })])),
    ).toContain("optional positional parameters");
  });

  test("shapes outside the portable subset", () => {
    expect(refusal(schemaOf([], [method({ returnType: named("Date") })]))).toContain("never declared");
    expect(
      refusal(schemaOf([], [method({ params: [{ name: "a", type: { kind: "enum", values: ["x"] } }] })])),
    ).toContain("inline string-literal unions");
    expect(
      refusal(schemaOf([], [method({ params: [{ name: "a", type: { kind: "object", fields: [] } }] })])),
    ).toContain("inline object literals");
  });

  test("Socket.IO's reserved events", () => {
    expect(refusal(schemaOf([], [method({ name: "disconnect" })]))).toContain("reserved");
  });
});
