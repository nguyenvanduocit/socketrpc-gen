import * as path from "path";
import { Project } from "ts-morph";
import { extractInterfacesFromFile, requireRpcSchema } from "./extract";
import type { RpcSchema } from "./schema";
import { generateSideFile } from "./emit-side";
import { generateTypesFile } from "./emit-types";
import { generateGoServerFiles, validateGoTarget } from "./emit-go";
import { ensurePackageStructure, validateInputFile } from "./emit-pkg";
import { resolveConfig, type FunctionSignature, type ResolvedConfig, type GeneratorConfig } from "./types";

/**
 * Logs a human-readable summary of the generated API surface to stdout.
 */
function logGenerationSummary(
  clientToServerFunctions: FunctionSignature[],
  serverToClientFunctions: FunctionSignature[],
  emittedFiles: string[],
  config: ResolvedConfig,
): void {
  console.log("✅ Generated RPC package successfully!");
  console.log(`📦 Output: ${config.outputDir}`);
  console.log(`📄 Files: ${emittedFiles.join(", ")}`);
  if (config.serverLanguage === "go") {
    console.log(`🐹 Go server package '${config.goPackageName}' in ${config.goOutputDir}`);
    console.log(`   Transport: ${config.goSocketImport}`);
  }

  const handled = (fns: FunctionSignature[]) =>
    fns.forEach((f) => console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")})`));
  const called = (fns: FunctionSignature[]) =>
    fns.forEach((f) =>
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")}) -> ${f.returnType}`),
    );

  console.log("\n📋 Client API (createRpcClient):");
  if (serverToClientFunctions.length > 0) {
    console.log("   .handle (from server):");
    handled(serverToClientFunctions);
  }
  if (clientToServerFunctions.length > 0) {
    console.log("   .server (to server):");
    called(clientToServerFunctions);
  }

  const serverHeading =
    config.serverLanguage === "go" ? "Server API (Go ServerHandler / Client)" : "Server API (createRpcServer)";
  console.log(`\n📋 ${serverHeading}:`);
  if (clientToServerFunctions.length > 0) {
    console.log("   .handle (from client):");
    handled(clientToServerFunctions);
  }
  if (serverToClientFunctions.length > 0) {
    console.log("   .client (to client):");
    called(serverToClientFunctions);
  }
}

/**
 * Runs the full generation pipeline: parse input → extract signatures →
 * emit types/client/server files → write scaffold package.json/tsconfig.
 *
 * The TypeScript client is always emitted. The server follows
 * `config.serverLanguage`: TypeScript reads the same string signatures the
 * client does, while Go reads the portable `RpcSchema` IR and therefore refuses
 * contracts the IR cannot model.
 *
 * Errors propagate to the caller (the CLI boundary handles exit codes).
 */
export async function generateRpcPackage(userConfig: GeneratorConfig): Promise<void> {
  const config = resolveConfig(userConfig);
  validateInputFile(config.inputPath);

  const extracted = await extractInterfacesFromFile(config.inputPath);
  const { clientToServerFunctions, serverToClientFunctions, usedTypes, inputFile } = extracted;

  // Resolve *and* validate the portable schema before writing anything, so a
  // contract Go cannot model fails without leaving a half-generated package
  // behind. The IR is deliberately wider than Go, so both checks are needed:
  // `requireRpcSchema` rejects what the IR cannot model at all, and
  // `validateGoTarget` rejects what it models but Go cannot spell.
  let goSchema: RpcSchema | undefined;
  if (config.serverLanguage === "go") {
    goSchema = requireRpcSchema(extracted);
    validateGoTarget(goSchema, config);
  }

  await ensurePackageStructure(config.outputDir, config);

  const outputProject = new Project({
    useInMemoryFileSystem: false,
    tsConfigFilePath: path.join(config.outputDir, "tsconfig.json"),
    compilerOptions: {
      outDir: path.join(config.outputDir, "dist"),
      rootDir: config.outputDir,
    },
  });

  generateTypesFile(
    outputProject,
    config.outputDir,
    config,
    clientToServerFunctions,
    serverToClientFunctions,
    usedTypes,
    inputFile,
  );
  generateSideFile(
    "client",
    outputProject,
    config.outputDir,
    clientToServerFunctions,
    serverToClientFunctions,
    config,
    usedTypes,
    inputFile,
  );

  const emitsTypeScriptServer = config.serverLanguage === "typescript";
  if (emitsTypeScriptServer) {
    generateSideFile(
      "server",
      outputProject,
      config.outputDir,
      clientToServerFunctions,
      serverToClientFunctions,
      config,
      usedTypes,
      inputFile,
    );
  }

  const emittedFiles = [
    "client.generated.ts",
    ...(emitsTypeScriptServer ? ["server.generated.ts"] : []),
    "types.generated.ts",
  ];

  await outputProject.save();

  if (goSchema) emittedFiles.push(...generateGoServerFiles(goSchema, config));

  logGenerationSummary(clientToServerFunctions, serverToClientFunctions, emittedFiles, config);
}
