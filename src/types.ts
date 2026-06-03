/**
 * Configuration options for the RPC generator
 */
/**
 * How generated call methods surface RPC failures.
 * - "return": calls resolve to `T | RpcError` (caller checks with `isRpcError`).
 * - "throw": calls resolve to `T` and reject with the RpcError (caller uses try/catch).
 */
export type ErrorMode = "return" | "throw";

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

/**
 * Resolves user config with defaults
 */
export function resolveConfig(userConfig: GeneratorConfig): ResolvedConfig {
  return {
    defaultTimeout: 5000,
    errorLogger: undefined,
    errorMode: "return",
    ...userConfig,
  };
}
