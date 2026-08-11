import * as fs from "fs";
import * as path from "path";
import { generateGo, validateGoSchema, type GoBackendOptions } from "./go";
import type { RpcSchema } from "./schema";
import type { ResolvedConfig } from "./types";

function goOptions(config: ResolvedConfig): GoBackendOptions {
  return {
    packageName: config.goPackageName,
    socketImport: config.goSocketImport,
    defaultTimeoutMs: config.defaultTimeout,
  };
}

/**
 * Refuses a contract the Go backend cannot model, without writing anything.
 *
 * Called before the TypeScript side is emitted so a rejected contract does not
 * leave a half-generated package on disk. Validation is pure, so running it here
 * and again inside `generateGo` costs nothing.
 */
export function validateGoTarget(schema: RpcSchema, config: ResolvedConfig): void {
  validateGoSchema(schema, goOptions(config));
}

/**
 * Writes the Go server package for a contract and returns the filenames it
 * produced, in the order they were written.
 *
 * Unlike the TypeScript side there is no ts-morph project to save through: the
 * Go emitter returns finished, gofmt-clean source, so this is the whole of the
 * imperative shell around it.
 */
export function generateGoServerFiles(schema: RpcSchema, config: ResolvedConfig): string[] {
  const files = generateGo(schema, goOptions(config));

  fs.mkdirSync(config.goOutputDir, { recursive: true });

  const written: string[] = [];
  for (const [filename, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(config.goOutputDir, filename), source);
    written.push(filename);
  }
  return written;
}
