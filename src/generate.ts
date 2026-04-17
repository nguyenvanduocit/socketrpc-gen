import * as path from "path";
import { Project } from "ts-morph";
import { extractInterfacesFromFile } from "./extract";
import { generateSideFile } from "./emit-side";
import { generateTypesFile } from "./emit-types";
import { ensurePackageStructure, validateInputFile } from "./emit-pkg";
import { resolveConfig, type FunctionSignature, type GeneratorConfig } from "./types";

/**
 * Logs a human-readable summary of the generated API surface to stdout.
 */
function logGenerationSummary(
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  outputDir: string,
): void {
  console.log("✅ Generated RPC package successfully!");
  console.log(`📦 Output: ${outputDir}`);
  console.log(`📄 Files: client.generated.ts, server.generated.ts, types.generated.ts`);

  console.log("\n📋 Client API (createRpcClient):");
  if (serverFunctions.length > 0) {
    console.log("   .handle (from server):");
    serverFunctions.forEach((f) => {
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")})`);
    });
  }
  if (clientFunctions.length > 0) {
    console.log("   .server (to server):");
    clientFunctions.forEach((f) => {
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")}) -> ${f.returnType}`);
    });
  }

  console.log("\n📋 Server API (createRpcServer):");
  if (clientFunctions.length > 0) {
    console.log("   .handle (from client):");
    clientFunctions.forEach((f) => {
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")})`);
    });
  }
  if (serverFunctions.length > 0) {
    console.log("   .client (to client):");
    serverFunctions.forEach((f) => {
      console.log(`     - ${f.name}(${f.params.map((p) => p.name).join(", ")}) -> ${f.returnType}`);
    });
  }
}

/**
 * Runs the full generation pipeline: parse input → extract signatures →
 * emit types/client/server files → write scaffold package.json/tsconfig.
 * Errors propagate to the caller (the CLI boundary handles exit codes).
 */
export async function generateRpcPackage(userConfig: GeneratorConfig): Promise<void> {
  const config = resolveConfig(userConfig);
  validateInputFile(config.inputPath);

  const { clientFunctions, serverFunctions, usedTypes, inputFile } =
    await extractInterfacesFromFile(config.inputPath);
  await ensurePackageStructure(config.outputDir, config);

  const outputProject = new Project({
    useInMemoryFileSystem: false,
    tsConfigFilePath: path.join(config.outputDir, "tsconfig.json"),
    compilerOptions: {
      outDir: path.join(config.outputDir, "dist"),
      rootDir: config.outputDir,
    },
  });

  generateTypesFile(outputProject, config.outputDir, config);
  generateSideFile(
    "client",
    outputProject,
    config.outputDir,
    clientFunctions,
    serverFunctions,
    config,
    usedTypes,
    inputFile,
  );
  generateSideFile(
    "server",
    outputProject,
    config.outputDir,
    clientFunctions,
    serverFunctions,
    config,
    usedTypes,
    inputFile,
  );

  await outputProject.save();
  logGenerationSummary(clientFunctions, serverFunctions, config.outputDir);
}
