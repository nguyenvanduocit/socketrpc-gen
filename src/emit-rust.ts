import * as fs from "fs";
import * as path from "path";
import { generateRust, validateRustSchema, type RustBackendOptions } from "./rust";
import type { RpcSchema } from "./schema";
import type { ResolvedConfig } from "./types";

function rustOptions(config: ResolvedConfig): RustBackendOptions {
  return {
    defaultTimeoutMs: config.defaultTimeout,
    server: config.serverLanguage === "rust",
    client: config.clientLanguages.has("rust"),
  };
}

/**
 * Refuses a contract the Rust backend cannot model, without writing anything.
 * Called before the TypeScript side is emitted, like `validateGoTarget`.
 */
export function validateRustTarget(schema: RpcSchema, config: ResolvedConfig): void {
  validateRustSchema(schema, rustOptions(config));
}

/**
 * Writes the Rust module for every Rust side of the run into `--rust-out` and
 * returns the filenames it produced. The emitter returns finished source, so
 * this is the whole of the imperative shell around it.
 */
export function generateRustFiles(schema: RpcSchema, config: ResolvedConfig): string[] {
  const files = generateRust(schema, rustOptions(config));
  fs.mkdirSync(config.rustOutputDir, { recursive: true });
  for (const [filename, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(config.rustOutputDir, filename), source);
  }
  return Object.keys(files);
}
