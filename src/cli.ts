import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { generateRpcPackage } from "./generate";
import { DEFAULT_GO_CLIENT_SOCKET_IMPORT, DEFAULT_GO_PACKAGE_NAME, DEFAULT_GO_SOCKET_IMPORT } from "./go";
import { TARGET_LANGUAGES, type GeneratorConfig } from "./types";

/**
 * Watches the input file for changes and regenerates on modification.
 * Lives in the CLI layer because it owns process lifecycle concerns (SIGINT).
 */
async function watchMode(config: GeneratorConfig): Promise<void> {
  const { inputPath } = config;

  console.log(`👀 Watching ${inputPath} for changes...`);

  await generateRpcPackage(config);

  const watcher = fs.watch(inputPath, async (eventType) => {
    if (eventType !== "change") return;
    console.log(`\n🔄 ${path.basename(inputPath)} changed, regenerating...`);
    try {
      await generateRpcPackage(config);
    } catch (error) {
      console.error("❌ Error during regeneration:", error);
    }
  });

  process.on("SIGINT", () => {
    console.log("\n👋 Stopping watch mode...");
    watcher.close();
    process.exit(0);
  });
}

/**
 * Sets up commander, parses argv, and delegates to generateRpcPackage or
 * watchMode. This is the only module that translates errors into exit codes.
 */
export function runCli(argv: string[]): void {
  // Resolve package.json relative to the project root (one level up from src/).
  const packageJsonPath = path.resolve(import.meta.dir, "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const version = packageJson.version;

  const program = new Command();

  program
    .name("socketrpc-gen")
    .description("Generate Socket.IO RPC code from interface definitions.")
    .version(version);

  console.log(`🚀 socketrpc-gen v${version}`);

  program
    .argument("<path>", "Path to the input TypeScript file containing interface definitions")
    .option(
      "-p, --package-name <name>",
      "Package name for the generated RPC package",
      "@socket-rpc/rpc",
    )
    .option("-t, --timeout <ms>", "Default timeout for RPC calls in milliseconds", "5000")
    .option("-l, --error-logger <path>", "Custom error logger import path (e.g., '@/lib/logger')")
    .option(
      "-e, --error-mode <mode>",
      "How call methods surface failures: 'return' the RpcError or 'throw' it",
      "return",
    )
    .option(
      "-c, --client <languages>",
      `Language of the generated client (${TARGET_LANGUAGES.join(" | ")}), or a comma-separated list of distinct languages to generate a client in each`,
      "typescript",
    )
    .option(
      "-s, --server <language>",
      `Language of the generated server (${TARGET_LANGUAGES.join(" | ")})`,
      "typescript",
    )
    .option(
      "--go-package <name>",
      "Go package clause of the Go types package and the Go server",
      DEFAULT_GO_PACKAGE_NAME,
    )
    .option(
      "--go-out <dir>",
      "Directory of the Go types package and the Go server (defaults to the input file's directory)",
    )
    .option(
      "--go-socket-import <path>",
      "Go Socket.IO server import path the Go server is written against",
      DEFAULT_GO_SOCKET_IMPORT,
    )
    .option(
      "--go-client-out <dir>",
      "Directory of a Go client in its own package, importing the types in --go-out (required with --client go --server go)",
    )
    .option("--go-client-package <name>", "Go package clause of the client in --go-client-out")
    .option(
      "--go-client-socket-import <path>",
      "Go Socket.IO client import path the Go client is written against",
      DEFAULT_GO_CLIENT_SOCKET_IMPORT,
    )
    .option("-w, --watch", "Watch for changes and regenerate automatically", false)
    .action((filePath, options) => {
      const inputPath = path.resolve(process.cwd(), filePath);

      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        console.error(`❌ Error: Input file not found or is not a file at ${inputPath}`);
        process.exit(1);
      }

      const outputDir = path.dirname(inputPath);

      const errorMode = options.errorMode === "throw" ? "throw" : "return";

      const config: GeneratorConfig = {
        inputPath,
        outputDir,
        packageName: options.packageName,
        defaultTimeout: parseInt(options.timeout, 10),
        errorLogger: options.errorLogger,
        errorMode,
        clientLanguage: options.client.split(",").map((language: string) => language.trim()),
        serverLanguage: options.server,
        goOutputDir: options.goOut ? path.resolve(process.cwd(), options.goOut) : outputDir,
        goPackageName: options.goPackage,
        goSocketImport: options.goSocketImport,
        goClientOutputDir: options.goClientOut ? path.resolve(process.cwd(), options.goClientOut) : undefined,
        goClientPackageName: options.goClientPackage,
        goClientSocketImport: options.goClientSocketImport,
      };

      const run = options.watch ? watchMode(config) : generateRpcPackage(config);
      run.catch((error) => {
        console.error("❌ Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
    });

  program.parse(argv);
}
