import { DEFAULT_GO_PACKAGE_NAME, DEFAULT_GO_SOCKET_IMPORT } from "./go/options";

/**
 * Configuration options for the RPC generator
 */
/**
 * How generated call methods surface RPC failures.
 * - "return": calls resolve to `T | RpcError` (caller checks with `isRpcError`).
 * - "throw": calls resolve to `T` and reject with the RpcError (caller uses try/catch).
 */
export type ErrorMode = "return" | "throw";

/** A language a side of the contract can be generated in. */
export type TargetLanguage = "typescript" | "go";

export const TARGET_LANGUAGES: readonly TargetLanguage[] = ["typescript", "go"];

export interface GeneratorConfig {
  /** Path to the input TypeScript file containing interface definitions */
  inputPath: string;
  /** Output directory for generated RPC package */
  outputDir: string;
  /** Package name for the generated RPC package */
  packageName: string;
  /** Default timeout for RPC calls in milliseconds */
  defaultTimeout?: number;
  /** Custom error logger import path. The module must default-export `(message: string, ...args: unknown[]) => void` */
  errorLogger?: string;
  /** How call methods surface failures: "return" the RpcError (default) or "throw" it */
  errorMode?: ErrorMode;
  /** Language of the generated client. Defaults to "typescript". */
  clientLanguage?: TargetLanguage;
  /** Language of the generated server. Defaults to "typescript". */
  serverLanguage?: TargetLanguage;
  /** Directory for generated Go files. Defaults to `outputDir`. */
  goOutputDir?: string;
  /** Go package clause for the generated server. */
  goPackageName?: string;
  /** Import path of the Go Socket.IO server package the bindings are written against. */
  goSocketImport?: string;
}

/**
 * Internal config with all defaults applied
 */
export type ResolvedConfig = Required<Omit<GeneratorConfig, "errorLogger">> & {
  errorLogger: string | undefined;
};

/**
 * Represents a function parameter extracted from TypeScript interface
 */
export interface FunctionParam {
  name: string;
  type: string;
  isOptional: boolean;
}

/**
 * Represents a function signature extracted from TypeScript interface
 */
export interface FunctionSignature {
  name: string;
  params: FunctionParam[];
  returnType: string;
  isVoid: boolean;
}

function assertSupportedLanguages(config: ResolvedConfig): void {
  for (const [side, language] of [
    ["client", config.clientLanguage],
    ["server", config.serverLanguage],
  ] as const) {
    if (!TARGET_LANGUAGES.includes(language)) {
      throw new Error(
        `Unknown ${side} language '${language}'. Supported languages: ${TARGET_LANGUAGES.join(", ")}.`,
      );
    }
  }

  if (config.clientLanguage === "go") {
    throw new Error(
      "A Go client is not available yet. Generate the client in TypeScript and the server in Go: --client typescript --server go.",
    );
  }
}

/**
 * Resolves user config with defaults
 */
export function resolveConfig(userConfig: GeneratorConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    defaultTimeout: 5000,
    errorLogger: undefined,
    errorMode: "return",
    clientLanguage: "typescript",
    serverLanguage: "typescript",
    goPackageName: DEFAULT_GO_PACKAGE_NAME,
    goSocketImport: DEFAULT_GO_SOCKET_IMPORT,
    ...userConfig,
    goOutputDir: userConfig.goOutputDir ?? userConfig.outputDir,
  };

  assertSupportedLanguages(resolved);
  return resolved;
}
