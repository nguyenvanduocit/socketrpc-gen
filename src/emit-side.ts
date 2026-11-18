import * as path from "path";
import { CodeBlockWriter, Project, SourceFile, StructureKind } from "ts-morph";
import { addCustomTypeImports } from "./emit-imports";
import { methodHelperSuffix } from "./postcard";
import type { RpcDirection, RpcSchema } from "./schema";
import {
  regenerateCommand,
  RPC_ERROR_EVENT,
  type FunctionSignature,
  type ResolvedConfig,
} from "./types";

/**
 * Emits the side's `on*` subscription members (interface shape). Every member here
 * follows one convention: `on<Event>(handler) => Unsubscribe`, additive (registering
 * a second handler does not replace the first). RPC method handlers are the other
 * convention and live under `.handle`, where re-registering does replace.
 *
 * Both sides expose `connected`, `onDisconnect` and `onRpcError`; only the client
 * gets connect/reconnect hooks, since a server-side socket is already connected.
 */
function subscriptionInterfaceMembers(
  side: "client" | "server",
): { name: string; type?: string; isReadonly?: boolean; docs: string[] }[] {
  const members: { name: string; type?: string; isReadonly?: boolean; docs: string[] }[] = [
    {
      name: "connected",
      type: "boolean",
      isReadonly: true,
      docs: ["Whether the underlying socket is currently connected."],
    },
    {
      name: "onDisconnect",
      type: "(handler: (reason: string) => void) => Unsubscribe",
      docs: ["Run a handler whenever the socket disconnects. Returns an unsubscribe function."],
    },
  ];

  if (side === "client") {
    members.push(
      {
        name: "onConnect",
        type: "(handler: () => void) => Unsubscribe",
        docs: [
          "Run a handler on every (re)connect — use it to re-sync or re-authenticate. Returns an unsubscribe function.",
        ],
      },
      {
        name: "onReconnect",
        type: "(handler: (attempt: number) => void) => Unsubscribe",
        docs: ["Run a handler after a successful reconnect. Returns an unsubscribe function."],
      },
    );
  }

  members.push({
    name: "onRpcError",
    type: "(handler: (error: RpcError) => void) => Unsubscribe",
    docs: [
      "Run a handler for errors the peer reports from a fire-and-forget handler. Returns an unsubscribe function.",
    ],
  });

  return members;
}

/**
 * Emits the RpcClient/RpcServer TypeScript interface declarations for one side,
 * including the nested Handle and target-side Call shapes.
 */
function generateFactoryInterface(
  sourceFile: SourceFile,
  callFunctions: FunctionSignature[],
  handleFunctions: FunctionSignature[],
  side: "client" | "server",
  errorMode: ResolvedConfig["errorMode"],
): void {
  const interfaceName = side === "client" ? "RpcClient" : "RpcServer";
  const targetSide = side === "client" ? "server" : "client";

  sourceFile.addStatements(`\n// === ${interfaceName} INTERFACE ===`);

  const handleInterfaceName = `${interfaceName}Handle`;
  // Every member of this interface is a user-declared RPC method. There are no
  // built-ins here, so a method can be named anything a socket.io event can be named.
  const handleProperties = handleFunctions.map((func) => {
    const funcParams = func.params
      .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
      .join(", ");
    const returnType = func.isVoid ? "void" : func.returnType;
    return {
      name: func.name,
      type: `(handler: (${funcParams}) => Promise<${returnType}>) => Unsubscribe`,
      docs: [
        `Register the handler for '${func.name}', called by the ${targetSide}. Re-registering replaces the previous handler. Returns an unsubscribe function.`,
      ],
    };
  });

  sourceFile.addInterface({
    name: handleInterfaceName,
    isExported: true,
    docs: [`Handler registration methods - implement these to handle calls from ${targetSide}`],
    properties: handleProperties,
  });

  const callInterfaceName = `${interfaceName}Remote`;
  const callProperties = callFunctions.map((func) => {
    const funcParams = func.params
      .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
      .join(", ");
    const optsParam = funcParams ? ", opts?: RpcCallOptions" : "opts?: RpcCallOptions";
    const allParams = funcParams + optsParam;
    const returnType = func.isVoid
      ? "void"
      : errorMode === "throw"
        ? `Promise<${func.returnType}>`
        : `Promise<${func.returnType} | RpcError>`;
    return {
      name: func.name,
      type: `(${allParams}) => ${returnType}`,
      docs: [`Call ${targetSide}'s '${func.name}' method`],
    };
  });

  sourceFile.addInterface({
    name: callInterfaceName,
    isExported: true,
    docs: [`Methods to call ${targetSide}`],
    properties: callProperties,
  });

  sourceFile.addInterface({
    name: interfaceName,
    isExported: true,
    // One string, not two: ts-morph emits one `/** */` block per array entry, and a
    // second block would leave the first stranded above the declaration.
    docs: [
      `${side === "client" ? "Client" : "Server"} RPC interface with ergonomic API.\n\n` +
        `Use \`.handle\` to register handlers, \`.${targetSide}\` to call ${targetSide} methods, and \`.dispose()\` to cleanup.`,
    ],
    properties: [
      {
        name: "handle",
        type: handleInterfaceName,
        isReadonly: true,
        docs: [`Register handlers for calls from ${targetSide}`],
      },
      {
        name: targetSide,
        type: callInterfaceName,
        isReadonly: true,
        docs: [`Call ${targetSide} methods`],
      },
      {
        name: "socket",
        type: "Socket",
        isReadonly: true,
        docs: ["The underlying socket instance"],
      },
      ...subscriptionInterfaceMembers(side),
      {
        name: "disposed",
        type: "boolean",
        isReadonly: true,
        docs: ["Whether this instance has been disposed"],
      },
    ],
    methods: [
      {
        name: "dispose",
        returnType: "void",
        docs: [
          "Cleanup all registered handlers. Call this when done (e.g., in onBeforeUnmount or useEffect cleanup).",
        ],
      },
    ],
  });
}

/**
 * Writes one entry of the `handle` object literal — a method that accepts a user
 * handler, wires it to the socket via `register` (which replaces any previous handler
 * for the same event), and returns an unsubscribe function. Void-returning signatures
 * become fire-and-forget listeners; signatures returning a value use the socket.io
 * acknowledgment callback.
 */
function writeHandleMethod(
  writer: CodeBlockWriter,
  func: FunctionSignature,
  trailingChar: string,
  logFn: string,
  handleDirection: RpcDirection,
  usePostcard: boolean,
): void {
  const funcParams = func.params
    .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
    .join(", ");
  const returnType = func.isVoid ? "void" : func.returnType;
  const handlerParams = func.params.map((p) => p.name).join(", ");
  const typedParams = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  const suffix = methodHelperSuffix(handleDirection, func.name);

  writer.writeLine(
    `${func.name}(handler: (${funcParams}) => Promise<${returnType}>): Unsubscribe {`,
  );
  writer.indent(() => {
    writer.writeLine("checkDisposed();");

    if (usePostcard) {
      if (func.isVoid) {
        writer.writeLine("const listener = async (...rawArgs: unknown[]) => {");
        writer.indent(() => {
          writer.writeLine("try {");
          writer.indent(() => {
            if (func.params.length > 0) {
              writer.writeLine(`const [${handlerParams}] = rpcDecodeArgs_${suffix}(rawArgs);`);
            } else {
              writer.writeLine(`rpcDecodeArgs_${suffix}(rawArgs);`);
            }
            writer.writeLine(`await handler(${handlerParams});`);
          });
          writer.writeLine("} catch (error) {");
          writer.indent(() => {
            writer.writeLine(`${logFn}('[${func.name}] Handler error:', error);`);
            writer.writeLine(
              `socket.emit('${RPC_ERROR_EVENT}', rpcEncodeErrorFrame(toRpcError(error, { method: '${func.name}' })));`,
            );
          });
          writer.writeLine("}");
        });
        writer.writeLine("};");
      } else {
        writer.writeLine("const listener = async (...rawArgs: unknown[]) => {");
        writer.indent(() => {
          writer.writeLine("const last = rawArgs[rawArgs.length - 1];");
          writer.writeLine("if (typeof last !== 'function') {");
          writer.indent(() => {
            writer.writeLine(
              `socket.emit('${RPC_ERROR_EVENT}', rpcEncodeErrorFrame({ __rpcError: true, code: 'INVALID_ARGUMENT', message: 'missing acknowledgement callback', method: '${func.name}' }));`,
            );
            writer.writeLine("return;");
          });
          writer.writeLine("}");
          writer.writeLine("const callback = last as (payload: Uint8Array) => void;");
          writer.writeLine("const args = rawArgs.slice(0, -1);");
          writer.writeLine("try {");
          writer.indent(() => {
            if (func.params.length > 0) {
              writer.writeLine(`const [${handlerParams}] = rpcDecodeArgs_${suffix}(args);`);
            } else {
              writer.writeLine(`rpcDecodeArgs_${suffix}(args);`);
            }
            writer.writeLine(`const handlerResult = await handler(${handlerParams});`);
            writer.writeLine(`callback(rpcEncodeResult_${suffix}(handlerResult));`);
          });
          writer.writeLine("} catch (error) {");
          writer.indent(() => {
            writer.writeLine(`${logFn}('[${func.name}] Handler error:', error);`);
            writer.writeLine(`callback(rpcEncodeErrorResult(toRpcError(error, { method: '${func.name}' })));`);
          });
          writer.writeLine("}");
        });
        writer.writeLine("};");
      }
    } else if (func.isVoid) {
      writer.writeLine(`const listener = async (${typedParams}) => {`);
      writer.indent(() => {
        writer.writeLine("try {");
        writer.indent(() => {
          writer.writeLine(`await handler(${handlerParams});`);
        });
        writer.writeLine("} catch (error) {");
        writer.indent(() => {
          writer.writeLine(`${logFn}('[${func.name}] Handler error:', error);`);
          writer.writeLine(
            `socket.emit('${RPC_ERROR_EVENT}', toRpcError(error, { method: '${func.name}' }));`,
          );
        });
        writer.writeLine("}");
      });
      writer.writeLine("};");
    } else {
      const callbackType = `(result: ${func.returnType} | RpcError) => void`;
      const fullParams = typedParams
        ? `${typedParams}, callback: ${callbackType}`
        : `callback: ${callbackType}`;
      writer.writeLine(`const listener = async (${fullParams}) => {`);
      writer.indent(() => {
        writer.writeLine("try {");
        writer.indent(() => {
          writer.writeLine(`const handlerResult = await handler(${handlerParams});`);
          writer.writeLine("callback(handlerResult);");
        });
        writer.writeLine("} catch (error) {");
        writer.indent(() => {
          writer.writeLine(`${logFn}('[${func.name}] Handler error:', error);`);
          writer.writeLine(`callback(toRpcError(error, { method: '${func.name}' }));`);
        });
        writer.writeLine("}");
      });
      writer.writeLine("};");
    }

    writer.writeLine(`return register('${func.name}', listener);`);
  });
  writer.writeLine("}" + trailingChar);
}

/**
 * Writes one entry of the target-side call object. Void signatures use socket.emit
 * (fire-and-forget); value-returning signatures use socket.timeout(...).emitWithAck.
 * Honors `opts.volatile` (drop instead of buffer while disconnected), `opts.signal`
 * (abort the wait), and the configured error mode (return the RpcError or throw it).
 */
function writeCallMethod(
  writer: CodeBlockWriter,
  func: FunctionSignature,
  trailingChar: string,
  defaultTimeout: number,
  errorMode: ResolvedConfig["errorMode"],
  callDirection: RpcDirection,
  usePostcard: boolean,
): void {
  const funcParams = func.params.map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
  funcParams.push(`opts?: RpcCallOptions`);
  const paramsString = funcParams.join(", ");
  const argsArray = func.params.map((p) => p.name);
  const argsString = argsArray.length > 0 ? `, ${argsArray.join(", ")}` : "";
  const suffix = methodHelperSuffix(callDirection, func.name);

  if (func.isVoid) {
    writer.writeLine(`${func.name}(${paramsString}) {`);
    writer.indent(() => {
      writer.writeLine("if (_disposed) return;");
      if (usePostcard) {
        writer.writeLine(`const encodedArgs = rpcEncodeArgs_${suffix}(${argsArray.join(", ")});`);
        writer.writeLine(`(opts?.volatile ? socket.volatile : socket).emit('${func.name}', ...encodedArgs);`);
      } else {
        writer.writeLine(`(opts?.volatile ? socket.volatile : socket).emit('${func.name}'${argsString});`);
      }
    });
    writer.writeLine("}" + trailingChar);
    return;
  }

  const disposedError = `{ __rpcError: true, message: 'RPC instance has been disposed', code: 'DISPOSED', method: '${func.name}' }`;
  const abortedError = `{ __rpcError: true, message: 'Request aborted', code: 'ABORTED', method: '${func.name}' }`;
  const returnType = errorMode === "throw" ? func.returnType : `${func.returnType} | RpcError`;

  writer.writeLine(`async ${func.name}(${paramsString}): Promise<${returnType}> {`);
  writer.indent(() => {
    if (errorMode === "throw") {
      writer.writeLine(`if (_disposed) throw ${disposedError} as RpcError;`);
      writer.writeLine(`if (opts?.signal?.aborted) throw ${abortedError} as RpcError;`);
    } else {
      writer.writeLine(`if (_disposed) return ${disposedError};`);
      writer.writeLine(`if (opts?.signal?.aborted) return ${abortedError};`);
    }
    writer.writeLine(`const timeout = opts?.timeout ?? ${defaultTimeout};`);
    writer.writeLine("const emitter = opts?.volatile ? socket.volatile : socket;");

    if (errorMode === "throw") {
      writer.writeLine(`let result: ${func.returnType} | RpcError;`);
      writer.writeLine("try {");
      writer.indent(() => {
        if (usePostcard) {
          writer.writeLine(`const encodedArgs = rpcEncodeArgs_${suffix}(${argsArray.join(", ")});`);
          writer.writeLine(
            `const ack = emitter.timeout(timeout).emitWithAck('${func.name}', ...encodedArgs).then((raw: unknown) => rpcDecodeResult_${suffix}(raw));`,
          );
        } else {
          writer.writeLine(`const ack = emitter.timeout(timeout).emitWithAck('${func.name}'${argsString});`);
        }
        writer.writeLine(
          `result = await (opts?.signal ? Promise.race([ack, rpcWhenAborted(opts.signal, '${func.name}')]) : ack);`,
        );
      });
      writer.writeLine("} catch (err) {");
      writer.indent(() => {
        writer.writeLine(`throw toRpcError(err, { method: '${func.name}' });`);
      });
      writer.writeLine("}");
      writer.writeLine("if (isRpcError(result)) throw result;");
      writer.writeLine("return result;");
    } else {
      writer.writeLine("try {");
      writer.indent(() => {
        if (usePostcard) {
          writer.writeLine(`const encodedArgs = rpcEncodeArgs_${suffix}(${argsArray.join(", ")});`);
          writer.writeLine(
            `const ack = emitter.timeout(timeout).emitWithAck('${func.name}', ...encodedArgs).then((raw: unknown) => rpcDecodeResult_${suffix}(raw));`,
          );
        } else {
          writer.writeLine(`const ack = emitter.timeout(timeout).emitWithAck('${func.name}'${argsString});`);
        }
        writer.writeLine(
          `return await (opts?.signal ? Promise.race([ack, rpcWhenAborted(opts.signal, '${func.name}')]) : ack);`,
        );
      });
      writer.writeLine("} catch (err) {");
      writer.indent(() => {
        writer.writeLine(`return toRpcError(err, { method: '${func.name}' });`);
      });
      writer.writeLine("}");
    }
  });
  writer.writeLine("}" + trailingChar);
}

/**
 * Writes the side's `on*` subscription members into the returned object literal:
 * a `connected` getter plus the disconnect/connect/reconnect/rpc-error helpers that
 * register through the shared unsubscriber list.
 *
 * These are additive — a second handler runs alongside the first — which is why they
 * bypass the `register` registry that `.handle` uses to enforce one handler per RPC method.
 */
function writeSubscriptionMembers(
  writer: CodeBlockWriter,
  side: "client" | "server",
  usePostcard: boolean,
): void {
  writer.writeLine("get connected() { return socket.connected; },");

  const sub = (name: string, handlerSig: string, target: string, event: string) => {
    writer.writeLine(`${name}(handler: ${handlerSig}): Unsubscribe {`);
    writer.indent(() => {
      writer.writeLine("checkDisposed();");
      writer.writeLine(`${target}.on('${event}', handler);`);
      writer.writeLine(`const unsubscribe = () => ${target}.off('${event}', handler);`);
      writer.writeLine("unsubscribers.push(unsubscribe);");
      writer.writeLine("return unsubscribe;");
    });
    writer.writeLine("},");
  };

  sub("onDisconnect", "(reason: string) => void", "socket", "disconnect");
  if (side === "client") {
    sub("onConnect", "() => void", "socket", "connect");
    sub("onReconnect", "(attempt: number) => void", "socket.io", "reconnect");
  }
  if (usePostcard) {
    writer.writeLine("onRpcError(handler: (error: RpcError) => void): Unsubscribe {");
    writer.indent(() => {
      writer.writeLine("checkDisposed();");
      writer.writeLine("const wrapped = (raw: unknown) => handler(rpcDecodeErrorFrame(raw));");
      writer.writeLine(`socket.on('${RPC_ERROR_EVENT}', wrapped);`);
      writer.writeLine(`const unsubscribe = () => socket.off('${RPC_ERROR_EVENT}', wrapped);`);
      writer.writeLine("unsubscribers.push(unsubscribe);");
      writer.writeLine("return unsubscribe;");
    });
    writer.writeLine("},");
  } else {
    sub("onRpcError", "(error: RpcError) => void", "socket", RPC_ERROR_EVENT);
  }
}

/**
 * Builds the JSDoc description block shown above the generated factory function.
 * Renders a minimal usage example using the first handle + call signatures (or
 * placeholders when the interface has none).
 */
function buildFactoryJsDoc(
  factoryName: string,
  side: "client" | "server",
  targetSide: "client" | "server",
  handleFunctions: FunctionSignature[],
  callFunctions: FunctionSignature[],
): string {
  const sampleHandle = handleFunctions[0];
  const handleName = sampleHandle?.name || "eventName";
  // `||` (not `??`) so zero-param handles fall back to "data" — matches
  // the pre-extract inline template's fallback semantics exactly.
  const handleArgs = sampleHandle?.params.map((p) => p.name).join(", ") || "data";

  const sampleCall = callFunctions[0];
  let callExample = "// ...";
  if (sampleCall) {
    const callArgs = sampleCall.params.map(() => "...").join(", ");
    const callExpr = `${side}.${targetSide}.${sampleCall.name}(${callArgs})`;
    callExample = sampleCall.isVoid ? `${callExpr};` : `const result = await ${callExpr};`;
  }

  return [
    `Create a ${side} RPC instance.`,
    "",
    "Usage:",
    "```typescript",
    `const ${side} = ${factoryName}(socket);`,
    "",
    `// Register handlers for calls from ${targetSide}`,
    `${side}.handle.${handleName}(async (${handleArgs}) => {`,
    "  // handle event",
    "});",
    "",
    `// Call ${targetSide} methods`,
    callExample,
    "",
    "// Cleanup when done",
    `${side}.dispose();`,
    "```",
  ].join("\n");
}

/**
 * Emits the createRpcClient / createRpcServer factory function. The function body
 * is composed from named section writers (writeHandleMethod, writeCallMethod,
 * writeSubscriptionMembers) so each concern lives in one small helper.
 */
function generateFactoryFunction(
  sourceFile: SourceFile,
  callFunctions: FunctionSignature[],
  handleFunctions: FunctionSignature[],
  side: "client" | "server",
  config: ResolvedConfig,
  usePostcard: boolean,
): void {
  const factoryName = side === "client" ? "createRpcClient" : "createRpcServer";
  const interfaceName = side === "client" ? "RpcClient" : "RpcServer";
  const targetSide = side === "client" ? "server" : "client";
  const logFn = config.errorLogger ? "errorLogger" : "console.error";
  const callDirection: RpcDirection = side === "client" ? "client-to-server" : "server-to-client";
  const handleDirection: RpcDirection = side === "client" ? "server-to-client" : "client-to-server";

  sourceFile.addStatements(`\n// === FACTORY FUNCTION ===`);

  const bodyWriter = (writer: CodeBlockWriter) => {
    // Shared closure state: listeners unsubscribed on dispose(), the dispose latch,
    // and a registry of the current inbound listener per event (for replace-on-reregister).
    writer.writeLine("const unsubscribers: Array<() => void> = [];");
    writer.writeLine("const handlerRegistry = new Map<string, (...args: any[]) => void>();");
    writer.writeLine("let _disposed = false;");
    writer.writeLine("");

    // Reusable disposed-check used by every handler registration.
    writer.writeLine("const checkDisposed = () => {");
    writer.indent(() => {
      writer.writeLine(`if (_disposed) throw new Error('${interfaceName} has been disposed');`);
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Register an inbound listener, replacing any previous listener for the same event
    // so re-registration (HMR, StrictMode, remount) never double-fires acks.
    writer.writeLine(
      "const register = (event: string, listener: (...args: any[]) => void): Unsubscribe => {",
    );
    writer.indent(() => {
      writer.writeLine("const prev = handlerRegistry.get(event);");
      writer.writeLine("if (prev) socket.off(event, prev);");
      writer.writeLine("handlerRegistry.set(event, listener);");
      writer.writeLine("socket.on(event, listener);");
      writer.writeLine("const unsubscribe = () => {");
      writer.indent(() => {
        writer.writeLine("if (handlerRegistry.get(event) === listener) {");
        writer.indent(() => {
          writer.writeLine("handlerRegistry.delete(event);");
          writer.writeLine("socket.off(event, listener);");
        });
        writer.writeLine("}");
      });
      writer.writeLine("};");
      writer.writeLine("unsubscribers.push(unsubscribe);");
      writer.writeLine("return unsubscribe;");
    });
    writer.writeLine("};");
    writer.writeLine("");

    // handle: one method per inbound RPC function, nothing else.
    writer.writeLine("const handle: " + interfaceName + "Handle = {");
    writer.indent(() => {
      handleFunctions.forEach((func, index) => {
        const trailing = index < handleFunctions.length - 1 ? "," : "";
        writeHandleMethod(writer, func, trailing, logFn, handleDirection, usePostcard);
      });
    });
    writer.writeLine("};");
    writer.writeLine("");

    // target-side call object: one method per outbound function (void → emit, else → emitWithAck).
    writer.writeLine(`const ${targetSide}: ` + interfaceName + "Remote = {");
    writer.indent(() => {
      callFunctions.forEach((func, index) => {
        const trailing = index < callFunctions.length - 1 ? "," : "";
        writeCallMethod(
          writer,
          func,
          trailing,
          config.defaultTimeout,
          config.errorMode,
          callDirection,
          usePostcard,
        );
      });
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Returned interface: exposes handle/call/socket, connection helpers, plus the dispose latch.
    writer.writeLine("return {");
    writer.indent(() => {
      writer.writeLine("handle,");
      writer.writeLine(`${targetSide},`);
      writer.writeLine("get socket() { return socket; },");
      writeSubscriptionMembers(writer, side, usePostcard);
      writer.writeLine("get disposed() { return _disposed; },");
      writer.writeLine("dispose() {");
      writer.indent(() => {
        writer.writeLine("if (_disposed) return;");
        writer.writeLine("_disposed = true;");
        writer.writeLine("unsubscribers.forEach(fn => fn());");
        writer.writeLine("unsubscribers.length = 0;");
        writer.writeLine("handlerRegistry.clear();");
      });
      writer.writeLine("}");
    });
    writer.writeLine("};");
  };

  sourceFile.addFunction({
    name: factoryName,
    isExported: true,
    parameters: [{ name: "socket", type: "Socket" }],
    returnType: interfaceName,
    statements: bodyWriter,
    docs: [
      {
        kind: StructureKind.JSDoc,
        description: buildFactoryJsDoc(
          factoryName,
          side,
          targetSide,
          handleFunctions,
          callFunctions,
        ),
        tags: [
          { kind: StructureKind.JSDocTag, tagName: "param", text: "socket The socket instance" },
          {
            kind: StructureKind.JSDocTag,
            tagName: "returns",
            text: `${interfaceName} instance with .handle, .${targetSide}, and .dispose()`,
          },
        ],
      },
    ],
  });
}

/**
 * Emits client.generated.ts or server.generated.ts for the given side.
 */
export function generateSideFile(
  side: "client" | "server",
  project: Project,
  outputDir: string,
  clientToServerFunctions: FunctionSignature[],
  serverToClientFunctions: FunctionSignature[],
  config: ResolvedConfig,
  usedTypes: Map<string, SourceFile>,
  inputFile: SourceFile,
  schema?: RpcSchema,
): void {
  const socketModule = side === "client" ? "socket.io-client" : "socket.io";
  const fileName = `${side}.generated.ts`;
  const inputFilename = path.basename(config.inputPath, path.extname(config.inputPath));
  const usePostcard = schema !== undefined;

  // The client calls what the server provides and handles what it itself provides;
  // the server is the mirror image.
  const callFunctions = side === "client" ? clientToServerFunctions : serverToClientFunctions;
  const handleFunctions = side === "client" ? serverToClientFunctions : clientToServerFunctions;
  const callDirection: RpcDirection = side === "client" ? "client-to-server" : "server-to-client";
  const handleDirection: RpcDirection = side === "client" ? "server-to-client" : "client-to-server";

  const sideFile = project.createSourceFile(path.join(outputDir, fileName), "", {
    overwrite: true,
  });

  sideFile.addImportDeclaration({
    moduleSpecifier: socketModule,
    namedImports: ["Socket"],
    isTypeOnly: true,
  });

  // Value imports needed by the generated body. `rpcWhenAborted` is only used when there
  // are value-returning calls; `isRpcError` only when throw mode needs to rethrow acks.
  const hasValueCall = callFunctions.some((f) => !f.isVoid);
  const valueImports = ["toRpcError"];
  if (hasValueCall) valueImports.push("rpcWhenAborted");
  if (hasValueCall && config.errorMode === "throw") valueImports.push("isRpcError");
  if (usePostcard) {
    valueImports.push("rpcDecodeErrorFrame");
    if (handleFunctions.length > 0) valueImports.push("rpcEncodeErrorFrame");
    if (handleFunctions.some((f) => !f.isVoid)) valueImports.push("rpcEncodeErrorResult");
    for (const func of handleFunctions) {
      const suffix = methodHelperSuffix(handleDirection, func.name);
      valueImports.push(`rpcDecodeArgs_${suffix}`);
      if (!func.isVoid) valueImports.push(`rpcEncodeResult_${suffix}`);
    }
    for (const func of callFunctions) {
      const suffix = methodHelperSuffix(callDirection, func.name);
      valueImports.push(`rpcEncodeArgs_${suffix}`);
      if (!func.isVoid) valueImports.push(`rpcDecodeResult_${suffix}`);
    }
  }

  sideFile.addImportDeclaration({
    moduleSpecifier: "./types.generated",
    namedImports: [
      { name: "RpcError", isTypeOnly: true },
      { name: "RpcCallOptions", isTypeOnly: true },
      { name: "Unsubscribe", isTypeOnly: true },
      ...valueImports.map((name) => ({ name })),
    ],
  });

  if (config.errorLogger) {
    sideFile.addImportDeclaration({
      moduleSpecifier: config.errorLogger,
      defaultImport: "errorLogger",
    });
  }

  addCustomTypeImports(sideFile, usedTypes, inputFile);

  const targetSide = side === "client" ? "server" : "client";
  // Show this API's own method names rather than `eventName`/`methodName` placeholders,
  // so the header matches the factory's JSDoc example.
  const sample = (func: FunctionSignature | undefined, fallback: string) =>
    func ? `${func.name}(${func.params.map((p) => p.name).join(", ")})` : `${fallback}(...)`;
  const sampleHandle = handleFunctions[0];
  const sampleHandleCall = sampleHandle
    ? `${sampleHandle.name}(async (${sampleHandle.params.map((p) => p.name).join(", ")}) => { ... })`
    : "eventName(async (...) => { ... })";
  const sampleCall = sample(callFunctions[0], "methodName");

  sideFile.insertText(
    0,
    `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 *
 * Auto-generated ${side} RPC from ${inputFilename}.ts
 *
 * Usage:
 *   const ${side} = create${side === "client" ? "RpcClient" : "RpcServer"}(socket);
 *   ${side}.handle.${sampleHandleCall};
 *   ${side}.${targetSide}.${sampleCall};
 *   ${side}.dispose();
 *
 * To regenerate: ${regenerateCommand(config)}
 */

`,
  );

  generateFactoryInterface(sideFile, callFunctions, handleFunctions, side, config.errorMode);
  generateFactoryFunction(sideFile, callFunctions, handleFunctions, side, config, usePostcard);

  sideFile.formatText();
}
