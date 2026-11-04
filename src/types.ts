import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_GO_CLIENT_SOCKET_IMPORT,
  DEFAULT_GO_PACKAGE_NAME,
  DEFAULT_GO_SOCKET_IMPORT,
} from "./go/options";

/**
 * Wire event carrying an RpcError raised by a fire-and-forget handler back to the
 * peer, subscribed to via the generated `onRpcError` / `OnRpcError`. Namespaced so
 * it can never collide with a user-declared RPC method name.
 *
 * Every backend spells the same string, so it is declared once here rather than as
 * a literal per emitter.
 */
export const RPC_ERROR_EVENT = "__rpc:error__";

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
  /**
   * Language of the generated client, or a list of distinct languages to
   * generate one client in each from the same run. Defaults to "typescript".
   */
  clientLanguage?: TargetLanguage | readonly TargetLanguage[];
  /** Language of the generated server. Defaults to "typescript". */
  serverLanguage?: TargetLanguage;
  /** Directory of the Go types package, and of the Go server. Defaults to `outputDir`. */
  goOutputDir?: string;
  /** Go package clause of the types package and the Go server. */
  goPackageName?: string;
  /** Import path of the Go Socket.IO server package the bindings are written against. */
  goSocketImport?: string;
  /**
   * Directory of a Go client generated into its own package, importing the
   * types package in `goOutputDir`. Required when both sides are Go; without it
   * a Go client shares the types package.
   */
  goClientOutputDir?: string;
  /** Go package clause of the client in `goClientOutputDir`. */
  goClientPackageName?: string;
  /** Import path of the Go Socket.IO client package the client is written against. */
  goClientSocketImport?: string;
}

/** The config keys that stay optional once defaults are applied. */
type OptionalConfigKey = "errorLogger" | "goClientOutputDir" | "goClientPackageName";

/**
 * Internal config with all defaults applied
 */
export type ResolvedConfig = Required<Omit<GeneratorConfig, OptionalConfigKey | "clientLanguage">> & {
  /** Every language a client is generated in: at least one, each once. */
  clientLanguages: ReadonlySet<TargetLanguage>;
  errorLogger: string | undefined;
  goClientOutputDir: string | undefined;
  goClientPackageName: string | undefined;
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

function isTargetLanguage(language: string): language is TargetLanguage {
  return TARGET_LANGUAGES.some((supported) => supported === language);
}

const SUPPORTED_LANGUAGES = `Supported languages: ${TARGET_LANGUAGES.join(", ")}.`;

/**
 * Parses `--client` into the set of client languages, refusing an empty list,
 * an unknown language and a language named twice — each by the flag.
 */
function resolveClientLanguages(requested: TargetLanguage | readonly TargetLanguage[]): ReadonlySet<TargetLanguage> {
  const list: readonly string[] = typeof requested === "string" ? [requested] : requested;
  if (list.length === 0) {
    throw new Error(`--client needs at least one language. ${SUPPORTED_LANGUAGES}`);
  }
  const languages = new Set<TargetLanguage>();
  for (const language of list) {
    if (!isTargetLanguage(language)) {
      throw new Error(`Unknown client language '${language}' in --client. ${SUPPORTED_LANGUAGES}`);
    }
    if (languages.has(language)) {
      throw new Error(
        `--client lists '${language}' twice. Name each client language once, e.g. --client ${TARGET_LANGUAGES.join(",")}.`,
      );
    }
    languages.add(language);
  }
  return languages;
}

/** A contract has one server, so `--server` takes exactly one language. */
function assertServerLanguage(language: string): void {
  if (!isTargetLanguage(language)) {
    throw new Error(
      `Unknown server language '${language}' in --server. ${SUPPORTED_LANGUAGES} --server takes one language.`,
    );
  }
}

/**
 * The directory `directory` names once it exists, folded so that two spellings
 * of one directory compare equal: the nearest existing ancestor through
 * `realpath` (symlinks, `..`, on-disk case), the rest appended as written, then
 * Unicode-normalized and lower-cased.
 *
 * Folding case is right on every filesystem, not only case-insensitive ones:
 * a client package imports the types package, so both are in every build of
 * the client, and `go build` refuses two packages whose import paths differ
 * only in case ("case-insensitive import collision").
 *
 * Reads the filesystem; writes nothing.
 */
function directoryIdentity(directory: string): string {
  let existing = path.resolve(directory);
  const remainder: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...remainder).normalize("NFC").toLowerCase();
}

/**
 * Refuses a Go package layout that cannot be generated, before anything is
 * written. The types package always lives in `--go-out`; a Go client either
 * shares it or, with `--go-client-out`, is its own package importing it — which
 * is the only layout in which a Go server and a Go client can coexist, since
 * both declare the same unexported runtime.
 */
function assertGoLayout(config: ResolvedConfig): void {
  const { goClientOutputDir, goClientPackageName } = config;
  const goClient = config.clientLanguages.has("go");
  const bothGo = goClient && config.serverLanguage === "go";

  if (goClientOutputDir === undefined) {
    if (bothGo) {
      throw new Error(
        "A Go client and a Go server need separate packages. Pass --go-client-out <dir> and --go-client-package <name>; the client imports the types package in --go-out.",
      );
    }
    if (goClientPackageName !== undefined) {
      throw new Error(
        "--go-client-package names the package in --go-client-out. Pass --go-client-out too, or drop --go-client-package to generate the client into --go-out.",
      );
    }
    return;
  }

  if (!goClient) {
    throw new Error("--go-client-out is only meaningful when --client includes go.");
  }
  if (!bothGo) {
    throw new Error(
      "--go-client-out separates the Go client from a Go server. With --server typescript, drop it: the client is generated into --go-out alongside the types.",
    );
  }
  if (directoryIdentity(goClientOutputDir) === directoryIdentity(config.goOutputDir)) {
    throw new Error(
      "--go-client-out must differ from --go-out: the client is a separate package that imports the types and server package in --go-out.",
    );
  }
  if (goClientPackageName === undefined) {
    throw new Error("--go-client-out needs --go-client-package <name>, the Go package clause of the client.");
  }
  if (goClientPackageName === config.goPackageName) {
    throw new Error(
      `--go-client-package must differ from --go-package ('${goClientPackageName}'): the client imports the types package under its package name.`,
    );
  }
}

/**
 * Resolves user config with defaults
 */
export function resolveConfig(userConfig: GeneratorConfig): ResolvedConfig {
  const { clientLanguage = "typescript", ...rest } = userConfig;
  const resolved: ResolvedConfig = {
    defaultTimeout: 5000,
    errorLogger: undefined,
    errorMode: "return",
    serverLanguage: "typescript",
    goPackageName: DEFAULT_GO_PACKAGE_NAME,
    goSocketImport: DEFAULT_GO_SOCKET_IMPORT,
    goClientSocketImport: DEFAULT_GO_CLIENT_SOCKET_IMPORT,
    goClientOutputDir: undefined,
    goClientPackageName: undefined,
    ...rest,
    clientLanguages: resolveClientLanguages(clientLanguage),
    goOutputDir: userConfig.goOutputDir ?? userConfig.outputDir,
  };

  assertServerLanguage(resolved.serverLanguage);
  assertGoLayout(resolved);
  return resolved;
}

/**
 * The regenerate hint written into every generated header.
 *
 * The path is relative to the output directory, and always POSIX-separated,
 * because the header is committed next to the file it describes: an absolute
 * path would bake in whichever machine last ran the generator, so `bun run
 * generate:examples` would report a diff on every checkout and could never serve
 * as the drift gate it is documented to be.
 */
export function regenerateCommand(config: ResolvedConfig): string {
  const relative = path.relative(config.outputDir, config.inputPath).split(path.sep).join("/");
  return `bunx socketrpc-gen ${relative.startsWith(".") ? relative : `./${relative}`}`;
}
