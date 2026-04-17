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

/**
 * Emits the RpcClient/RpcServer TypeScript interface declarations for one side,
 * including the nested Handle and target-side Call shapes.
 */
function generateFactoryInterface(
  sourceFile: SourceFile,
  callFunctions: FunctionSignature[],
  handleFunctions: FunctionSignature[],
  side: "client" | "server",
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
    const returnType = func.isVoid ? "void | RpcError" : `${func.returnType} | RpcError`;
    return {
      name: func.name,
      type: `(handler: (${funcParams}) => Promise<${returnType}>) => void`,
      docs: [`Register handler for '${func.name}' - called by ${targetSide}`],
    };
  });

  handleProperties.push({
    name: "rpcError",
    type: "(handler: (error: RpcError) => void) => void",
    docs: ["Register handler for RPC errors"],
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
    const timeoutParam = !func.isVoid
      ? funcParams
        ? ", timeout?: number"
        : "timeout?: number"
      : "";
    const allParams = funcParams + timeoutParam;
    const returnType = func.isVoid ? "void" : `Promise<${func.returnType} | RpcError>`;
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
 * handler, wires it to socket.on, and records an unsubscriber. Void-returning
 * signatures become fire-and-forget listeners; signatures returning a value use
 * the socket.io acknowledgment callback.
 */
function writeHandleMethod(
  writer: CodeBlockWriter,
  func: FunctionSignature,
  trailingChar: string,
): void {
  const funcParams = func.params
    .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
    .join(", ");
  const returnType = func.isVoid ? "void | RpcError" : `${func.returnType} | RpcError`;
  const handlerParams = func.params.map((p) => p.name).join(", ");
  const typedParams = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");

  writer.writeLine(`${func.name}(handler: (${funcParams}) => Promise<${returnType}>) {`);
  writer.indent(() => {
    writer.writeLine("checkDisposed();");

    if (func.isVoid) {
      writer.writeLine(`const listener = async (${typedParams}) => {`);
      writer.indent(() => {
        writer.writeLine("try {");
        writer.indent(() => {
          writer.writeLine(`const handlerResult = await handler(${handlerParams});`);
          writer.writeLine(
            `if (handlerResult && typeof handlerResult === 'object' && 'code' in handlerResult && 'message' in handlerResult) {`,
          );
          writer.indent(() => {
            writer.writeLine(`socket.emit('rpcError', handlerResult);`);
          });
          writer.writeLine("}");
        });
        writer.writeLine("} catch (error) {");
        writer.indent(() => {
          writer.writeLine(`console.error('[${func.name}] Handler error:', error);`);
          writer.writeLine(
            `socket.emit('rpcError', { message: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR', data: undefined });`,
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
          writer.writeLine(`console.error('[${func.name}] Handler error:', error);`);
          writer.writeLine(
            `callback({ message: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR', data: undefined });`,
          );
        });
        writer.writeLine("}");
      });
      writer.writeLine("};");
    }

    writer.writeLine(`socket.on('${func.name}', listener);`);
    writer.writeLine(`unsubscribers.push(() => socket.off('${func.name}', listener));`);
  });
  writer.writeLine("}" + trailingChar);
}

/**
 * Writes the built-in rpcError listener entry for the handle object.
 */
function writeRpcErrorHandler(writer: CodeBlockWriter): void {
  writer.writeLine("rpcError(handler: (error: RpcError) => void) {");
  writer.indent(() => {
    writer.writeLine("checkDisposed();");
    writer.writeLine("const listener = (error: RpcError) => handler(error);");
    writer.writeLine(`socket.on('rpcError', listener);`);
    writer.writeLine(`unsubscribers.push(() => socket.off('rpcError', listener));`);
  });
  writer.writeLine("}");
}

/**
 * Writes one entry of the target-side call object — a method that fires an
 * outbound event. Void signatures use socket.emit (fire-and-forget); returning
 * signatures use socket.timeout(...).emitWithAck and translate any thrown error
 * into an RpcError value.
 */
function writeCallMethod(
  writer: CodeBlockWriter,
  func: FunctionSignature,
  trailingChar: string,
  defaultTimeout: number,
): void {
  const funcParams = func.params.map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
  if (!func.isVoid) {
    funcParams.push(`timeout: number = ${defaultTimeout}`);
  }
  const paramsString = funcParams.join(", ");
  const argsArray = func.params.map((p) => p.name);
  const argsString = argsArray.length > 0 ? `, ${argsArray.join(", ")}` : "";

  if (func.isVoid) {
    writer.writeLine(`${func.name}(${paramsString}) {`);
    writer.indent(() => {
      writer.writeLine(`socket.emit('${func.name}'${argsString});`);
    });
    writer.writeLine("}" + trailingChar);
  } else {
    writer.writeLine(
      `async ${func.name}(${paramsString}): Promise<${func.returnType} | RpcError> {`,
    );
    writer.indent(() => {
      writer.writeLine("try {");
      writer.indent(() => {
        writer.writeLine(
          `return await socket.timeout(timeout).emitWithAck('${func.name}'${argsString});`,
        );
      });
      writer.writeLine("} catch (err) {");
      writer.indent(() => {
        writer.writeLine(
          `return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };`,
        );
      });
      writer.writeLine("}");
    });
    writer.writeLine("}" + trailingChar);
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
 * writeCallMethod) so each concern lives in one small, focused helper.
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

  sourceFile.addStatements(`\n// === FACTORY FUNCTION ===`);

  const bodyWriter = (writer: CodeBlockWriter) => {
    // Shared closure state: listeners unsubscribed on dispose(), plus the dispose latch.
    writer.writeLine("const unsubscribers: Array<() => void> = [];");
    writer.writeLine("let _disposed = false;");
    writer.writeLine("");

    // Reusable disposed-check used by every handler registration.
    writer.writeLine("const checkDisposed = () => {");
    writer.indent(() => {
      writer.writeLine(`if (_disposed) throw new Error('${interfaceName} has been disposed');`);
    });
    writer.writeLine("};");
    writer.writeLine("");

    // handle: one method per server-to-client (or client-to-server) inbound function,
    // plus a catch-all rpcError listener.
    writer.writeLine("const handle: " + interfaceName + "Handle = {");
    writer.indent(() => {
      for (const func of handleFunctions) {
        writeHandleMethod(writer, func, ",");
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
        writeCallMethod(writer, func, trailing, config.defaultTimeout);
      });
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Returned interface: exposes handle/call/socket plus the dispose latch.
    writer.writeLine("return {");
    writer.indent(() => {
      writer.writeLine("handle,");
      writer.writeLine(`${targetSide},`);
      writer.writeLine("get socket() { return socket; },");
      writer.writeLine("get disposed() { return _disposed; },");
      writer.writeLine("dispose() {");
      writer.indent(() => {
        writer.writeLine("if (_disposed) return;");
        writer.writeLine("_disposed = true;");
        writer.writeLine("unsubscribers.forEach(fn => fn());");
        writer.writeLine("unsubscribers.length = 0;");
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

  sideFile.addImportDeclaration({
    moduleSpecifier: "./types.generated",
    namedImports: ["RpcError"],
    isTypeOnly: true,
  });

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

  generateFactoryInterface(sideFile, callFunctions, handleFunctions, side);
  generateFactoryFunction(sideFile, callFunctions, handleFunctions, side, config);

  sideFile.formatText();
}
