import * as path from "path";
import { Project, SourceFile, VariableDeclarationKind } from "ts-morph";
import { addCustomTypeImports } from "./emit-imports";
import {
  regenerateCommand,
  RPC_ERROR_EVENT,
  type FunctionSignature,
  type ResolvedConfig,
} from "./types";

/**
 * Builds the socket.io event-map property for one signature. Void signatures map to
 * a plain listener; value-returning signatures append the ack callback so
 * `emitWithAck` and `socket.on` are correctly typed when the map is applied.
 */
function eventMapProperty(func: FunctionSignature): { name: string; type: string } {
  const params = func.params.map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
  if (func.isVoid) {
    return { name: func.name, type: `(${params.join(", ")}) => void` };
  }
  const ack = `ack: (result: ${func.returnType} | RpcError) => void`;
  return { name: func.name, type: `(${[...params, ack].join(", ")}) => void` };
}

/**
 * Emits the ClientToServerEvents / ServerToClientEvents maps. These are an optional
 * typing aid: apply them to your own `io<ServerToClientEvents, ClientToServerEvents>(url)`
 * (client) or `new Server<ClientToServerEvents, ServerToClientEvents>()` (server) to type
 * raw socket usage alongside the RPC layer.
 *
 * They live here rather than in the side files because they are side-agnostic: emitting
 * them into both client.generated.ts and server.generated.ts would export the same two
 * names twice, colliding in any module that imports both sides.
 */
function generateEventMaps(
  typesFile: SourceFile,
  clientToServerFunctions: FunctionSignature[],
  serverToClientFunctions: FunctionSignature[],
): void {
  typesFile.addStatements(`\n// === SOCKET EVENT MAPS (optional typing aid) ===`);

  const errorProp = { name: `"${RPC_ERROR_EVENT}"`, type: "(error: RpcError) => void" };

  typesFile.addInterface({
    name: "ClientToServerEvents",
    isExported: true,
    docs: ["Events the client emits and the server listens for. Apply to a typed Socket/Server."],
    properties: [...clientToServerFunctions.map(eventMapProperty), errorProp],
  });

  typesFile.addInterface({
    name: "ServerToClientEvents",
    isExported: true,
    docs: ["Events the server emits and the client listens for. Apply to a typed Socket/Server."],
    properties: [...serverToClientFunctions.map(eventMapProperty), errorProp],
  });
}

/**
 * Emits types.generated.ts — the shared RpcError + Unsubscribe vocabulary that the two
 * side files import from, plus the side-agnostic socket event maps.
 */
export function generateTypesFile(
  project: Project,
  outputDir: string,
  config: ResolvedConfig,
  clientToServerFunctions: FunctionSignature[],
  serverToClientFunctions: FunctionSignature[],
  usedTypes: Map<string, SourceFile>,
  inputFile: SourceFile,
): void {
  const typesFile = project.createSourceFile(path.join(outputDir, "types.generated.ts"), "", {
    overwrite: true,
  });

  // The event maps reference the user's own types, so this file needs the same
  // type-only imports the side files get.
  addCustomTypeImports(typesFile, usedTypes, inputFile);

  typesFile.addTypeAlias({
    name: "Unsubscribe",
    type: "() => void",
    isExported: true,
    docs: ["Function to unsubscribe from an event listener. Call this to clean up the listener."],
  });

  typesFile.addInterface({
    name: "RpcCallOptions",
    isExported: true,
    docs: ["Per-call options for RPC methods. Extensible — new fields can be added without breaking callers."],
    properties: [
      {
        name: "timeout",
        type: "number",
        hasQuestionToken: true,
        docs: ["Override the default timeout (ms) for this call. Ignored for fire-and-forget calls."],
      },
      {
        name: "signal",
        type: "AbortSignal",
        hasQuestionToken: true,
        docs: [
          "Abort the call. When the signal fires, the call settles with an ABORTED RpcError and stops awaiting the acknowledgement.",
        ],
      },
      {
        name: "volatile",
        type: "boolean",
        hasQuestionToken: true,
        docs: [
          "Drop the call instead of buffering it when the socket is disconnected. Use for real-time or non-idempotent calls that must not be replayed on reconnect.",
        ],
      },
    ],
  });

  typesFile.addVariableStatement({
    isExported: true,
    declarationKind: VariableDeclarationKind.Const,
    docs: ["Standard RPC error codes. Use these instead of ad-hoc strings."],
    declarations: [
      {
        name: "RpcErrorCodes",
        initializer: `{
    TIMEOUT: "TIMEOUT",
    DISPOSED: "DISPOSED",
    DISCONNECTED: "DISCONNECTED",
    ABORTED: "ABORTED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const`,
      },
    ],
  });

  typesFile.addTypeAlias({
    name: "RpcErrorCode",
    type: "typeof RpcErrorCodes[keyof typeof RpcErrorCodes]",
    isExported: true,
    docs: ["Union of all standard RPC error code string literals."],
  });

  typesFile.addInterface({
    name: "RpcError",
    isExported: true,
    docs: ["Represents an error that occurred during an RPC call."],
    properties: [
      {
        name: "__rpcError",
        type: "true",
        isReadonly: true,
        docs: [
          "Brand marking this object as an RpcError. Set by `toRpcError`/`rpcError`; checked by `isRpcError`. Distinguishes errors from successful results that happen to share the `{ message, code }` shape.",
        ],
      },
      { name: "message", type: "string", docs: ["The error message."] },
      {
        name: "code",
        type: "string",
        docs: ["The error code. Standard codes are in RpcErrorCodes."],
      },
      {
        name: "method",
        type: "string",
        hasQuestionToken: true,
        docs: ["Name of the RPC method where the error originated."],
      },
      {
        name: "data",
        type: "any",
        hasQuestionToken: true,
        docs: ["Optional error-specific payload."],
      },
    ],
  });

  typesFile.addFunction({
    name: "isRpcError",
    isExported: true,
    docs: [
      "Type guard to check if a value is an RpcError. Relies on the `__rpcError` brand, so successful results that share the `{ message, code }` shape are never misclassified.",
    ],
    parameters: [{ name: "obj", type: "any" }],
    returnType: "obj is RpcError",
    statements: `return !!obj && (obj as RpcError).__rpcError === true;`,
  });

  typesFile.addFunction({
    name: "rpcError",
    isExported: true,
    docs: [
      "Construct a branded RpcError. Use inside handlers to signal a typed failure, e.g. `throw rpcError('NOT_FOUND', 'User not found')`.",
    ],
    parameters: [
      { name: "code", type: "string" },
      { name: "message", type: "string" },
      { name: "data", type: "any", hasQuestionToken: true },
    ],
    returnType: "RpcError",
    statements: `return { __rpcError: true, code, message, data };`,
  });

  typesFile.addFunction({
    name: "toRpcError",
    isExported: true,
    docs: [
      "Normalize any thrown value into a branded RpcError. Passes existing RpcError values through unchanged, and maps socket.io's timeout and disconnect errors to the TIMEOUT and DISCONNECTED codes.",
    ],
    parameters: [
      { name: "err", type: "unknown" },
      { name: "opts", type: "{ code?: string; method?: string }", hasQuestionToken: true },
    ],
    returnType: "RpcError",
    statements: `if (isRpcError(err)) return err;
const message = err instanceof Error ? err.message : String(err);
const isTimeout = err instanceof Error && err.message === "operation has timed out";
const isDisconnected = err instanceof Error && err.message === "socket has been disconnected";
const code = opts?.code ?? (isTimeout
    ? RpcErrorCodes.TIMEOUT
    : isDisconnected
        ? RpcErrorCodes.DISCONNECTED
        : RpcErrorCodes.INTERNAL_ERROR);
return { __rpcError: true, message, code, method: opts?.method };`,
  });

  typesFile.addFunction({
    name: "rpcWhenAborted",
    isExported: true,
    docs: [
      "Resolve with an ABORTED RpcError when the signal fires. Internal helper raced against in-flight calls so an aborted call stops awaiting its acknowledgement.",
    ],
    parameters: [
      { name: "signal", type: "AbortSignal" },
      { name: "method", type: "string" },
    ],
    returnType: "Promise<RpcError>",
    statements: `return new Promise((resolve) => {
    const fire = () => resolve({ __rpcError: true, code: RpcErrorCodes.ABORTED, message: "Request aborted", method });
    if (signal.aborted) return fire();
    signal.addEventListener("abort", fire, { once: true });
});`,
  });

  generateEventMaps(typesFile, clientToServerFunctions, serverToClientFunctions);

  // Prepended last so it lands above the import declarations added at the top.
  typesFile.insertText(
    0,
    `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 *
 * Auto-generated types for the RPC package
 *
 * To regenerate this file, run:
 * ${regenerateCommand(config)}
 */

`,
  );

  typesFile.formatText();
}
