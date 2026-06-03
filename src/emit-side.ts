import * as path from "path";
import { CodeBlockWriter, Project, SourceFile, StructureKind } from "ts-morph";
import type { FunctionSignature, ResolvedConfig } from "./types";

/**
 * Adds type-only imports for every user-declared type referenced by the signatures.
 * The input file's imports are emitted before any dependency-file imports.
 */
function addCustomTypeImports(
  sourceFile: SourceFile,
  usedTypes: Map<string, SourceFile>,
  inputFile: SourceFile,
): void {
  if (usedTypes.size === 0) return;

  const typesByFile = new Map<SourceFile, string[]>();
  for (const [name, sf] of usedTypes) {
    const bucket = typesByFile.get(sf);
    if (bucket) bucket.push(name);
    else typesByFile.set(sf, [name]);
  }

  const inputBucket = typesByFile.get(inputFile);
  const depBuckets = [...typesByFile.entries()].filter(([sf]) => sf !== inputFile);

  const emit = (sf: SourceFile, names: string[]) => {
    sourceFile.addImportDeclaration({
      moduleSpecifier: `./${sf.getBaseNameWithoutExtension()}`,
      namedImports: names,
      isTypeOnly: true,
    });
  };

  if (inputBucket) emit(inputFile, inputBucket);
  for (const [sf, names] of depBuckets) emit(sf, names);
}

const RPC_ERROR_EVENT = "__rpc:error__";

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
 */
function generateEventMaps(
  sourceFile: SourceFile,
  clientCallable: FunctionSignature[],
  serverCallable: FunctionSignature[],
): void {
  sourceFile.addStatements(`\n// === SOCKET EVENT MAPS (optional typing aid) ===`);

  const errorProp = { name: `"${RPC_ERROR_EVENT}"`, type: "(error: RpcError) => void" };

  sourceFile.addInterface({
    name: "ClientToServerEvents",
    isExported: true,
    docs: ["Events the client emits and the server listens for. Apply to a typed Socket/Server."],
    properties: [...clientCallable.map(eventMapProperty), errorProp],
  });

  sourceFile.addInterface({
    name: "ServerToClientEvents",
    isExported: true,
    docs: ["Events the server emits and the client listens for. Apply to a typed Socket/Server."],
    properties: [...serverCallable.map(eventMapProperty), errorProp],
  });
}

/**
 * Emits the side-specific connection members (interface shape). Both sides expose
 * `connected`; the client adds connect/disconnect/reconnect hooks, the server only
 * the per-socket disconnect hook.
 */
function connectionInterfaceMembers(
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
      type: "(handler: (reason: string) => void) => UnsubscribeFunction",
      docs: ["Run a handler whenever the socket disconnects. Returns an unsubscribe function."],
    },
  ];

  if (side === "client") {
    members.push(
      {
        name: "onConnect",
        type: "(handler: () => void) => UnsubscribeFunction",
        docs: [
          "Run a handler on every (re)connect — use it to re-sync or re-authenticate. Returns an unsubscribe function.",
        ],
      },
      {
        name: "onReconnect",
        type: "(handler: (attempt: number) => void) => UnsubscribeFunction",
        docs: ["Run a handler after a successful reconnect. Returns an unsubscribe function."],
      },
    );
  }

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
  const targetSideCapitalized = targetSide.charAt(0).toUpperCase() + targetSide.slice(1);

  sourceFile.addStatements(`\n// === ${interfaceName.toUpperCase()} INTERFACE ===`);

  const handleInterfaceName = `${interfaceName}Handle`;
  const handleProperties = handleFunctions.map((func) => {
    const funcParams = func.params
      .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
      .join(", ");
    const returnType = func.isVoid ? "void" : func.returnType;
    return {
      name: func.name,
      type: `(handler: (${funcParams}) => Promise<${returnType}>) => UnsubscribeFunction`,
      docs: [`Register handler for '${func.name}' - called by ${targetSide}. Returns an unsubscribe function.`],
    };
  });

  handleProperties.push({
    name: "rpcError",
    type: "(handler: (error: RpcError) => void) => UnsubscribeFunction",
    docs: ["Register handler for RPC errors. Returns an unsubscribe function."],
  });

  sourceFile.addInterface({
    name: handleInterfaceName,
    isExported: true,
    docs: [`Handler registration methods - implement these to handle calls from ${targetSide}`],
    properties: handleProperties,
  });

  const callInterfaceName = `${interfaceName}${targetSideCapitalized}`;
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
    docs: [
      `${side === "client" ? "Client" : "Server"} RPC interface with ergonomic API.`,
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
      ...connectionInterfaceMembers(side),
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
): void {
  const funcParams = func.params
    .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
    .join(", ");
  const returnType = func.isVoid ? "void" : func.returnType;
  const handlerParams = func.params.map((p) => p.name).join(", ");
  const typedParams = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");

  writer.writeLine(
    `${func.name}(handler: (${funcParams}) => Promise<${returnType}>): UnsubscribeFunction {`,
  );
  writer.indent(() => {
    writer.writeLine("checkDisposed();");

    if (func.isVoid) {
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
            `socket.emit('${RPC_ERROR_EVENT}', toRpcError(error, { origin: '${func.name}' }));`,
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
          writer.writeLine(`callback(toRpcError(error, { origin: '${func.name}' }));`);
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
 * Writes the built-in rpcError listener entry for the handle object.
 */
function writeRpcErrorHandler(writer: CodeBlockWriter): void {
  writer.writeLine("rpcError(handler: (error: RpcError) => void): UnsubscribeFunction {");
  writer.indent(() => {
    writer.writeLine("checkDisposed();");
    writer.writeLine("const listener = (error: RpcError) => handler(error);");
    writer.writeLine(`return register('${RPC_ERROR_EVENT}', listener);`);
  });
  writer.writeLine("}");
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
): void {
  const funcParams = func.params.map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
  funcParams.push(`opts?: RpcCallOptions`);
  const paramsString = funcParams.join(", ");
  const argsArray = func.params.map((p) => p.name);
  const argsString = argsArray.length > 0 ? `, ${argsArray.join(", ")}` : "";

  if (func.isVoid) {
    writer.writeLine(`${func.name}(${paramsString}) {`);
    writer.indent(() => {
      writer.writeLine("if (_disposed) return;");
      writer.writeLine(`(opts?.volatile ? socket.volatile : socket).emit('${func.name}'${argsString});`);
    });
    writer.writeLine("}" + trailingChar);
    return;
  }

  const disposedError = `{ __rpcError: true, message: 'RPC instance has been disposed', code: 'DISPOSED', origin: '${func.name}' }`;
  const abortedError = `{ __rpcError: true, message: 'Request aborted', code: 'ABORTED', origin: '${func.name}' }`;
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
        writer.writeLine(`const ack = emitter.timeout(timeout).emitWithAck('${func.name}'${argsString});`);
        writer.writeLine(
          `result = await (opts?.signal ? Promise.race([ack, rpcWhenAborted(opts.signal, '${func.name}')]) : ack);`,
        );
      });
      writer.writeLine("} catch (err) {");
      writer.indent(() => {
        writer.writeLine(`throw toRpcError(err, { origin: '${func.name}' });`);
      });
      writer.writeLine("}");
      writer.writeLine("if (isRpcError(result)) throw result;");
      writer.writeLine("return result;");
    } else {
      writer.writeLine("try {");
      writer.indent(() => {
        writer.writeLine(`const ack = emitter.timeout(timeout).emitWithAck('${func.name}'${argsString});`);
        writer.writeLine(
          `return await (opts?.signal ? Promise.race([ack, rpcWhenAborted(opts.signal, '${func.name}')]) : ack);`,
        );
      });
      writer.writeLine("} catch (err) {");
      writer.indent(() => {
        writer.writeLine(`return toRpcError(err, { origin: '${func.name}' });`);
      });
      writer.writeLine("}");
    }
  });
  writer.writeLine("}" + trailingChar);
}

/**
 * Writes the side-specific connection members into the returned object literal:
 * a `connected` getter plus disconnect/connect/reconnect subscription helpers that
 * register through the shared unsubscriber list.
 */
function writeConnectionMembers(writer: CodeBlockWriter, side: "client" | "server"): void {
  writer.writeLine("get connected() { return socket.connected; },");

  const sub = (name: string, handlerSig: string, target: string, event: string) => {
    writer.writeLine(`${name}(handler: ${handlerSig}): UnsubscribeFunction {`);
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
 * is composed from named section writers (writeHandleMethod, writeRpcErrorHandler,
 * writeCallMethod, writeConnectionMembers) so each concern lives in one small helper.
 */
function generateFactoryFunction(
  sourceFile: SourceFile,
  callFunctions: FunctionSignature[],
  handleFunctions: FunctionSignature[],
  side: "client" | "server",
  config: ResolvedConfig,
): void {
  const factoryName = side === "client" ? "createRpcClient" : "createRpcServer";
  const interfaceName = side === "client" ? "RpcClient" : "RpcServer";
  const targetSide = side === "client" ? "server" : "client";
  const targetSideCapitalized = targetSide.charAt(0).toUpperCase() + targetSide.slice(1);
  const logFn = config.errorLogger ? "errorLogger" : "console.error";

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
      "const register = (event: string, listener: (...args: any[]) => void): UnsubscribeFunction => {",
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

    // handle: one method per inbound function, plus a catch-all rpcError listener.
    writer.writeLine("const handle: " + interfaceName + "Handle = {");
    writer.indent(() => {
      for (const func of handleFunctions) {
        writeHandleMethod(writer, func, ",", logFn);
      }
      writeRpcErrorHandler(writer);
    });
    writer.writeLine("};");
    writer.writeLine("");

    // target-side call object: one method per outbound function (void → emit, else → emitWithAck).
    writer.writeLine(`const ${targetSide}: ` + interfaceName + targetSideCapitalized + " = {");
    writer.indent(() => {
      callFunctions.forEach((func, index) => {
        const trailing = index < callFunctions.length - 1 ? "," : "";
        writeCallMethod(writer, func, trailing, config.defaultTimeout, config.errorMode);
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
      writeConnectionMembers(writer, side);
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
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  config: ResolvedConfig,
  usedTypes: Map<string, SourceFile>,
  inputFile: SourceFile,
): void {
  const socketModule = side === "client" ? "socket.io-client" : "socket.io";
  const fileName = `${side}.generated.ts`;
  const inputFilename = path.basename(config.inputPath, path.extname(config.inputPath));

  // Client calls serverFunctions and handles clientFunctions; server is the mirror.
  const callFunctions = side === "client" ? clientFunctions : serverFunctions;
  const handleFunctions = side === "client" ? serverFunctions : clientFunctions;

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

  sideFile.addImportDeclaration({
    moduleSpecifier: "./types.generated",
    namedImports: [
      { name: "RpcError", isTypeOnly: true },
      { name: "RpcCallOptions", isTypeOnly: true },
      { name: "UnsubscribeFunction", isTypeOnly: true },
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

  sideFile.insertText(
    0,
    `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 *
 * Auto-generated ${side} RPC from ${inputFilename}.ts
 *
 * Usage:
 *   const ${side} = create${side === "client" ? "RpcClient" : "RpcServer"}(socket);
 *   ${side}.handle.eventName(async (data) => { ... });
 *   ${side}.${targetSide}.methodName(args);
 *   ${side}.dispose();
 *
 * To regenerate: bunx socketrpc-gen ${config.inputPath}
 */

`,
  );

  generateEventMaps(sideFile, clientFunctions, serverFunctions);
  generateFactoryInterface(sideFile, callFunctions, handleFunctions, side, config.errorMode);
  generateFactoryFunction(sideFile, callFunctions, handleFunctions, side, config);

  sideFile.formatText();
}
