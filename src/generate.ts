import * as path from "path";
import { Project } from "ts-morph";
import { extractInterfacesFromFile, requireRpcSchema } from "./extract";
import type { RpcSchema } from "./schema";
import { generateSideFile } from "./emit-side";
import { generateTypesFile } from "./emit-types";
import { generateGoClientFiles, generateGoServerFiles, validateGoTarget } from "./emit-go";
import { generateRustFiles, validateRustTarget } from "./emit-rust";
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
  if (config.clientLanguages.has("go")) {
    const clientPackage = config.goClientPackageName ?? config.goPackageName;
    console.log(`🐹 Go client package '${clientPackage}' in ${config.goClientOutputDir ?? config.goOutputDir}`);
    console.log(`   Transport: ${config.goClientSocketImport}`);
  }
  const rustSides = [
    ...(config.serverLanguage === "rust" ? ["server (socketioxide)"] : []),
    ...(config.clientLanguages.has("rust") ? ["client (socketrpc-socketio-client)"] : []),
  ];
  if (rustSides.length > 0) {
    console.log(`🦀 Rust module in ${config.rustOutputDir}: ${rustSides.join(", ")}`);
  }

  const handled = (fns: FunctionSignature[]) =>
    fns.forEach((f) => console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")})`));
  const called = (fns: FunctionSignature[]) =>
    fns.forEach((f) =>
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")}) -> ${f.returnType}`),
    );

  for (const language of config.clientLanguages) {
    const clientHeading =
      language === "go"
        ? "Client API (Go ClientHandler / Conn)"
        : language === "rust"
          ? "Client API (Rust ClientHandler / Conn)"
          : "Client API (createRpcClient)";
    console.log(`\n📋 ${clientHeading}:`);
    if (serverToClientFunctions.length > 0) {
      console.log("   .handle (from server):");
      handled(serverToClientFunctions);
    }
    if (clientToServerFunctions.length > 0) {
      console.log("   .server (to server):");
      called(clientToServerFunctions);
    }
  }

  const serverHeading =
    config.serverLanguage === "go"
      ? "Server API (Go ServerHandler / Client)"
      : config.serverLanguage === "rust"
        ? "Server API (Rust ServerHandler / Client)"
        : "Server API (createRpcServer)";
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
 * Each side follows its language, and the client may be generated in several
 * languages from one run. TypeScript reads the string signatures as written;
 * Go and Rust read the portable `RpcSchema` IR and therefore refuse contracts the IR
 * cannot model. The TypeScript package — types, scaffold, and the TypeScript
 * sides — is written only when at least one side is TypeScript.
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
  const emitsGoClient = config.clientLanguages.has("go");
  if (config.serverLanguage === "go" || emitsGoClient) {
    goSchema = requireRpcSchema(extracted);
    validateGoTarget(goSchema, config);
  }
  let rustSchema: RpcSchema | undefined;
  if (config.serverLanguage === "rust" || config.clientLanguages.has("rust")) {
    rustSchema = goSchema ?? requireRpcSchema(extracted);
    validateRustTarget(rustSchema, config);
  }

  const emitsTypeScriptClient = config.clientLanguages.has("typescript");
  const emitsTypeScriptServer = config.serverLanguage === "typescript";
  const emittedFiles: string[] = [];

  if (emitsTypeScriptClient || emitsTypeScriptServer) {
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
    const sides = [
      ...(emitsTypeScriptClient ? (["client"] as const) : []),
      ...(emitsTypeScriptServer ? (["server"] as const) : []),
    ];
    for (const side of sides) {
      generateSideFile(
        side,
        outputProject,
        config.outputDir,
        clientToServerFunctions,
        serverToClientFunctions,
        config,
        usedTypes,
        inputFile,
      );
      emittedFiles.push(`${side}.generated.ts`);
    }
    emittedFiles.push("types.generated.ts");

    await outputProject.save();
  }

  if (goSchema && config.serverLanguage === "go") emittedFiles.push(...generateGoServerFiles(goSchema, config));
  if (goSchema && emitsGoClient) emittedFiles.push(...generateGoClientFiles(goSchema, config));
  if (rustSchema) emittedFiles.push(...generateRustFiles(rustSchema, config));

  logGenerationSummary(clientToServerFunctions, serverToClientFunctions, emittedFiles, config);
}
