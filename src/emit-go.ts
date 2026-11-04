import * as fs from "fs";
import * as path from "path";
import {
  generateGo,
  generateGoClient,
  goImportPath,
  validateGoSchema,
  type GoBackendOptions,
  type GoClientPackage,
} from "./go";
import type { RpcSchema } from "./schema";
import type { ResolvedConfig } from "./types";

/** The directory of the nearest go.mod at or above `directory`, which need not exist yet. */
function findModuleRoot(directory: string): string | undefined {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(path.join(current, "go.mod"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The package a separate Go client is generated as, with the import path it
 * reaches the types package in `--go-out` through. Go spells that path from the
 * module the directory belongs to, so it is read from the nearest go.mod.
 */
function separateClientPackage(config: ResolvedConfig): GoClientPackage | undefined {
  if (config.goClientOutputDir === undefined || config.goClientPackageName === undefined) return undefined;
  const moduleRoot = findModuleRoot(config.goOutputDir);
  if (moduleRoot === undefined) {
    throw new Error(
      `No go.mod at or above --go-out ${config.goOutputDir}. The Go client imports the types package by its module path, so --go-out must be inside a Go module: run \`go mod init\` there first.`,
    );
  }
  const goMod = fs.readFileSync(path.join(moduleRoot, "go.mod"), "utf-8");
  return {
    packageName: config.goClientPackageName,
    typesImport: goImportPath(goMod, moduleRoot, config.goOutputDir),
  };
}

function goOptions(config: ResolvedConfig): GoBackendOptions {
  return {
    packageName: config.goPackageName,
    socketImport: config.goSocketImport,
    defaultTimeoutMs: config.defaultTimeout,
    client: {
      socketImport: config.goClientSocketImport,
      separate: config.clientLanguages.has("go") ? separateClientPackage(config) : undefined,
    },
  };
}

/**
 * Refuses a contract the Go backend cannot model, or a Go layout it cannot
 * write, without writing anything.
 *
 * Called before the TypeScript side is emitted so a rejected contract does not
 * leave a half-generated package on disk. Validation is pure, so running it here
 * and again inside the generators costs nothing.
 */
export function validateGoTarget(schema: RpcSchema, config: ResolvedConfig): void {
  const options = goOptions(config);
  if (config.serverLanguage === "go") validateGoSchema(schema, options, "server");
  if (config.clientLanguages.has("go")) validateGoSchema(schema, options, "client");
}

function writeGoFiles(directory: string, files: Readonly<Record<string, string | undefined>>): string[] {
  fs.mkdirSync(directory, { recursive: true });

  const written: string[] = [];
  for (const [filename, source] of Object.entries(files)) {
    if (source === undefined) continue;
    fs.writeFileSync(path.join(directory, filename), source);
    written.push(filename);
  }
  return written;
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
  return writeGoFiles(config.goOutputDir, generateGo(schema, goOptions(config)));
}

/**
 * Writes the Go client and returns the filenames it produced: into its own
 * package when `--go-client-out` is set, otherwise into the types package in
 * `--go-out` together with the types file.
 */
export function generateGoClientFiles(schema: RpcSchema, config: ResolvedConfig): string[] {
  const directory = config.goClientOutputDir ?? config.goOutputDir;
  return writeGoFiles(directory, generateGoClient(schema, goOptions(config)));
}
