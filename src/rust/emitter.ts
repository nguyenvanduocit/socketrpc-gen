/**
 * Entry point of the Rust backend: validates a schema and returns the files of
 * the generated module, keyed by filename. Pure — `src/emit-rust.ts` writes them.
 */

import type { RpcSchema } from "../schema";
import { emitClientFile } from "./emit-client";
import { emitServerFile } from "./emit-server";
import { emitTypesFile, header } from "./emit-types";
import {
  RUST_CLIENT_CRATE,
  RUST_CLIENT_FILENAME,
  RUST_MOD_FILENAME,
  RUST_SERVER_FILENAME,
  RUST_TYPES_FILENAME,
  resolveRustBackendOptions,
  type GeneratedRustFiles,
  type RustBackendOptions,
} from "./options";
import { declarationsByName } from "./project";
import { validateRustSchema } from "./validate";

/**
 * `mod.rs` declares the sides this run generated and re-exports the contract
 * types. Each file is `#[rustfmt::skip]`: generated code is regenerated, never
 * formatted by hand, and `cargo fmt` would otherwise rewrite it.
 */
function emitModFile(server: boolean, client: boolean): string {
  const dependencies = [
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'tokio = { version = "1", features = ["rt", "sync", "macros"] }',
    ...(server ? ['socketioxide = "0.18"'] : []),
    ...(client
      ? [
          `socketrpc-socketio-client = { git = "https://github.com/nguyenvanduocit/socketrpc-gen" }  # crate ${RUST_CLIENT_CRATE}`,
        ]
      : []),
  ];
  const modules = [
    ["types", "Contract types and RpcError."],
    ...(server ? [["server", "`bind_server`, `ServerHandler`, `Client`."]] : []),
    ...(client ? [["client", "`dial`, `ClientHandler`, `Conn`."]] : []),
  ];
  return [
    ...header("The generated RPC module. Mount it with `mod <dir>;`."),
    "//! Cargo dependencies this module needs:",
    "//!",
    "//! ```toml",
    ...dependencies.map((line) => `//! ${line}`),
    "//! ```",
    "",
    ...modules.flatMap(([name, doc]) => [`/// ${doc}`, "#[rustfmt::skip]", "#[allow(dead_code)]", `pub mod ${name};`, ""]),
    "#[allow(unused_imports)]",
    "pub use types::*;",
    "",
  ].join("\n");
}

export function generateRust(schema: RpcSchema, options: RustBackendOptions = {}): GeneratedRustFiles {
  validateRustSchema(schema, options);
  const resolved = resolveRustBackendOptions(options);
  const declarations = declarationsByName(schema);
  const files: Record<string, string> = {
    [RUST_MOD_FILENAME]: emitModFile(resolved.server, resolved.client),
    [RUST_TYPES_FILENAME]: emitTypesFile(schema, declarations),
  };
  if (resolved.server) {
    files[RUST_SERVER_FILENAME] = emitServerFile(schema, declarations, resolved.defaultTimeoutMs);
  }
  if (resolved.client) {
    files[RUST_CLIENT_FILENAME] = emitClientFile(schema, declarations, resolved.defaultTimeoutMs);
  }
  return files;
}
