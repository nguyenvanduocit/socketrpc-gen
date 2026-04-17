#!/usr/bin/env bun

// Public library API
export { generateRpcPackage } from "./src/generate";
export type {
  FunctionParam,
  FunctionSignature,
  GeneratorConfig,
  ResolvedConfig,
} from "./src/types";

// Run the CLI when invoked directly (bunx socketrpc-gen ...)
import { runCli } from "./src/cli";

if (import.meta.main) {
  runCli(process.argv);
}
