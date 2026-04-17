import * as fs from "fs";
import * as path from "path";
import type { ResolvedConfig } from "./types";

/**
 * Validates that the input file exists. Throws on failure; the CLI boundary is
 * responsible for reporting the error and choosing the exit code.
 */
export function validateInputFile(inputPath: string): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `Input file not found at ${inputPath}. Create a file with ClientFunctions and ServerFunctions interfaces.`,
    );
  }
}

/**
 * Generates the package.json shape for the output RPC package.
 */
function generatePackageJson(config: ResolvedConfig): object {
  return {
    name: config.packageName,
    version: "1.0.0",
    description: "Auto-generated RPC package for Socket.IO",
    type: "module",
    scripts: {
      build: "tsc",
      dev: "tsc --watch",
    },
    dependencies: {
      "socket.io": "^4.8.1",
      "socket.io-client": "^4.8.1",
    },
    devDependencies: {
      "@types/node": "^20.0.0",
      typescript: "^5.0.0",
    },
    peerDependencies: {
      "socket.io": "^4.0.0",
      "socket.io-client": "^4.0.0",
    },
  };
}

/**
 * Generates the tsconfig.json shape for the output RPC package.
 */
function generateTsConfig(): object {
  return {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      lib: ["ES2020"],
      moduleResolution: "node",
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "./dist",
      rootDir: "./",
      composite: true,
    },
    include: ["**/*.ts"],
    exclude: ["node_modules", "dist"],
  };
}

/**
 * Ensures the output directory exists and writes package.json + tsconfig.json
 * on the first generator run. Both files are only created if absent, so users
 * can customize them without fear of being overwritten.
 */
export async function ensurePackageStructure(
  outputDir: string,
  config: ResolvedConfig,
): Promise<void> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const packageJsonPath = path.join(outputDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify(generatePackageJson(config), null, 2));
  }

  const tsConfigPath = path.join(outputDir, "tsconfig.json");
  if (!fs.existsSync(tsConfigPath)) {
    fs.writeFileSync(tsConfigPath, JSON.stringify(generateTsConfig(), null, 2));
  }
}
