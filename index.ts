#!/usr/bin/env bun

import * as fs from "fs";
import * as path from "path";
import { Project, InterfaceDeclaration, SyntaxKind, SourceFile, StructureKind } from "ts-morph";
import { Command } from "commander";

// ============================================
// TYPES & INTERFACES
// ============================================

/**
 * Configuration options for the RPC generator
 */
interface GeneratorConfig {
  /** Path to the input TypeScript file containing interface definitions */
  inputPath: string;
  /** Output directory for generated RPC package */
  outputDir: string;
  /** Package name for the generated RPC package */
  packageName: string;
  /** Default timeout for RPC calls in milliseconds */
  defaultTimeout?: number;
  /** Custom error logger import path (e.g., '@/lib/logger') */
  errorLogger?: string;
}

/**
 * Internal config with all defaults applied
 */
type ResolvedConfig = Required<Omit<GeneratorConfig, "errorLogger">> & {
  errorLogger: string | undefined;
};

/**
 * Represents a function parameter extracted from TypeScript interface
 */
interface FunctionParam {
  name: string;
  type: string;
  isOptional: boolean;
}

/**
 * Represents a function signature extracted from TypeScript interface
 */
interface FunctionSignature {
  name: string;
  params: FunctionParam[];
  returnType: string;
  isVoid: boolean;
}

// ============================================
// VALIDATION & UTILITY FUNCTIONS
// ============================================

/**
 * Validates that a function name is a valid JavaScript identifier
 */
function isValidJavaScriptIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

// ============================================
// INTERFACE EXTRACTION
// ============================================

/**
 * Recursively collects all base interfaces from an interface, including those from imported files
 */
function getAllBaseInterfaces(interfaceDeclaration: InterfaceDeclaration): InterfaceDeclaration[] {
  const baseInterfaces: InterfaceDeclaration[] = [];
  const visited = new Set<string>();

  function collectBases(iface: InterfaceDeclaration): void {
    const ifaceName = iface.getName();
    if (visited.has(ifaceName)) return;
    visited.add(ifaceName);

    // Get all extends expressions
    const baseTypes = iface.getBaseTypes();

    baseTypes.forEach((baseType) => {
      const symbol = baseType.getSymbol();
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      declarations.forEach((decl) => {
        if (decl.getKindName() === "InterfaceDeclaration") {
          const baseInterface = decl as InterfaceDeclaration;
          baseInterfaces.push(baseInterface);
          // Recursively collect bases of this base interface
          collectBases(baseInterface);
        }
      });
    });
  }

  collectBases(interfaceDeclaration);
  return baseInterfaces;
}

/**
 * Extracts signature from a single property if it's a valid function
 * Returns null if the property should be skipped
 */
function extractSignatureFromProperty(
  property: any,
  processedNames: Set<string>,
): FunctionSignature | null {
  const typeNode = property.getTypeNode();
  const name = property.getName();

  // Skip if already processed (derived class overrides base)
  if (processedNames.has(name)) {
    return null;
  }

  // Must be a function type
  if (!typeNode || typeNode.getKind() !== SyntaxKind.FunctionType) {
    return null;
  }

  // Validate function name
  if (!isValidJavaScriptIdentifier(name)) {
    console.error(`Warning: Skipping function '${name}' - not a valid JavaScript identifier`);
    return null;
  }

  const functionType = property.getType();
  const callSignatures = functionType.getCallSignatures();

  if (callSignatures.length === 0) {
    return null;
  }

  const signature = callSignatures[0];
  if (!signature) return null;

  // Extract parameters
  const params: FunctionParam[] = signature
    .getParameters()
    .map((param: import("ts-morph").Symbol) => {
      const paramType = param.getTypeAtLocation(property);
      const typeString = paramType.getText(property);

      return {
        name: param.getName(),
        type: typeString,
        isOptional: param.isOptional(),
      };
    });

  // Extract return type
  const returnType = signature.getReturnType();
  const returnTypeString = returnType.getText(property);
  const isVoid = returnTypeString === "void";

  return {
    name,
    params,
    returnType: returnTypeString,
    isVoid,
  };
}

/**
 * Extracts function signatures from a TypeScript interface using ts-morph
 * Supports interface extension - will extract properties from base interfaces too
 */
function extractFunctionSignatures(
  interfaceDeclaration: InterfaceDeclaration,
): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const processedNames = new Set<string>();

  // Collect all interfaces in the inheritance chain
  const baseInterfaces = getAllBaseInterfaces(interfaceDeclaration);
  const allInterfaces = [...baseInterfaces, interfaceDeclaration];

  // Process each interface in the chain
  allInterfaces.forEach((iface) => {
    iface.getProperties().forEach((property) => {
      const extracted = extractSignatureFromProperty(property, processedNames);
      if (extracted) {
        signatures.push(extracted);
        processedNames.add(extracted.name);
      }
    });
  });

  return signatures;
}

// ============================================
// AST GENERATION - TYPES FILE
// ============================================

/**
 * Creates a new file types.ts for custom types.
 * @param project The ts-morph project instance.
 * @param outputDir The output directory.
 */
function generateTypesFile(project: Project, outputDir: string, config: ResolvedConfig): void {
  const typesFile = project.createSourceFile(path.join(outputDir, "types.generated.ts"), "", {
    overwrite: true,
  });

  typesFile.insertText(
    0,
    `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 * 
 * Auto-generated types for the RPC package
 *
 * To regenerate this file, run:
 * bunx socketrpc-gen ${config.inputPath}
 */

`,
  );

  typesFile.addTypeAlias({
    name: "UnsubscribeFunction",
    type: "() => void",
    isExported: true,
    docs: ["Function to unsubscribe from an event listener. Call this to clean up the listener."],
  });

  typesFile.addInterface({
    name: "RpcError",
    isExported: true,
    docs: ["Represents an error that occurred during an RPC call."],
    properties: [
      {
        name: "message",
        type: "string",
        docs: ["The error message."],
      },
      {
        name: "code",
        type: "string",
        docs: ["The error code."],
      },
      {
        name: "data",
        type: "any",
        docs: ["The error data."],
      },
    ],
  });

  typesFile.addFunction({
    name: "isRpcError",
    isExported: true,
    docs: ["Type guard to check if an object is an RpcError."],
    parameters: [{ name: "obj", type: "any" }],
    returnType: "obj is RpcError",
    statements: `return !!obj && typeof (obj as RpcError).message === 'string' && typeof (obj as RpcError).code === 'string';`,
  });

  typesFile.formatText();
}

// ============================================
// TYPE EXTRACTION & IMPORTS
// ============================================

/**
 * Extracts custom types used in function signatures and adds them as type-only imports
 * Handles types from both the input file and its imported dependencies
 */
function addCustomTypeImports(
  sourceFile: any,
  functions: FunctionSignature[],
  inputFile: SourceFile,
  inputFilename: string,
): void {
  const usedTypes = new Set<string>();

  // Extract types from function parameters and return types
  functions.forEach((func) => {
    func.params.forEach((param) => {
      const typeNames = extractTypeNames(param.type);
      typeNames.forEach((typeName) => usedTypes.add(typeName));
    });

    const returnTypeNames = extractTypeNames(func.returnType);
    returnTypeNames.forEach((typeName) => usedTypes.add(typeName));
  });

  // Filter out primitive types and built-in types
  const customTypes = Array.from(usedTypes).filter(
    (type) =>
      ![
        "string",
        "number",
        "boolean",
        "void",
        "any",
        "unknown",
        "object",
        "Array",
        "Promise",
        "Error",
      ].includes(type) &&
      !type.includes("|") &&
      !type.includes("<") &&
      !type.includes("["),
  );

  if (customTypes.length === 0) return;

  // Group types by their source file
  const typesByFile = new Map<string, string[]>();
  const remainingTypes = new Set(customTypes);

  // Check main input file first
  const inputFileTypes = customTypes.filter((type) => {
    const exportedTypes = inputFile.getExportedDeclarations();
    return exportedTypes.has(type) || inputFile.getTypeAlias(type) || inputFile.getInterface(type);
  });

  if (inputFileTypes.length > 0) {
    typesByFile.set(inputFilename, inputFileTypes);
    inputFileTypes.forEach((t) => remainingTypes.delete(t));
  }

  // Check imported files for remaining types
  if (remainingTypes.size > 0) {
    const referencedFiles = inputFile.getReferencedSourceFiles();
    for (const refFile of referencedFiles) {
      const refFilename = path.basename(refFile.getFilePath(), path.extname(refFile.getFilePath()));
      const foundTypes: string[] = [];

      for (const type of remainingTypes) {
        const exportedTypes = refFile.getExportedDeclarations();
        if (exportedTypes.has(type) || refFile.getTypeAlias(type) || refFile.getInterface(type)) {
          foundTypes.push(type);
        }
      }

      if (foundTypes.length > 0) {
        typesByFile.set(refFilename, foundTypes);
        foundTypes.forEach((t) => remainingTypes.delete(t));
      }

      if (remainingTypes.size === 0) break;
    }
  }

  // Add import declarations for each file
  for (const [filename, types] of typesByFile) {
    sourceFile.addImportDeclaration({
      moduleSpecifier: `./${filename}`,
      namedImports: types,
      isTypeOnly: true,
    });
  }
}

/**
 * Extracts type names from a TypeScript type string
 * Handles complex types including generics, unions, and arrays
 */
function extractTypeNames(typeString: string): string[] {
  const types = new Set<string>();

  // Remove array brackets and extract types from arrays
  let cleanedType = typeString.replace(/\[\]/g, "");

  // Extract types from generics: Map<string, User[]> -> Map, string, User
  // This improved regex handles nested generics
  const genericRegex = /([A-Z][a-zA-Z0-9]*)<(.+)>/;
  const genericMatch = genericRegex.exec(cleanedType);

  if (genericMatch) {
    // Add the generic type itself (e.g., "Map")
    types.add(genericMatch[1]);

    // Recursively extract types from generic arguments
    const genericArgs = genericMatch[2];
    // Split by comma but respect nested generics
    const args = splitTypeArguments(genericArgs);
    args.forEach((arg) => {
      extractTypeNames(arg.trim()).forEach((t) => types.add(t));
    });

    // Process the rest of the type string
    cleanedType = cleanedType.replace(genericMatch[0], "");
  }

  // Extract types from unions: string | number | User
  const unionParts = cleanedType.split("|").map((p) => p.trim());
  unionParts.forEach((part) => {
    const typeRegex = /\b([A-Z][a-zA-Z0-9]*)\b/g;
    let match;
    while ((match = typeRegex.exec(part)) !== null) {
      types.add(match[1]);
    }
  });

  return Array.from(types);
}

/**
 * Splits generic type arguments respecting nested generics
 * Example: "string, Map<string, User[]>" -> ["string", "Map<string, User[]>"]
 */
function splitTypeArguments(args: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < args.length; i++) {
    const char = args[i];

    if (char === "<") {
      depth++;
      current += char;
    } else if (char === ">") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// ============================================
// FACTORY PATTERN GENERATION (Ergonomic API)
// ============================================

/**
 * Generates the RpcClient or RpcServer interface with .handle and .client/.server namespaces
 */
function generateFactoryInterface(
  sourceFile: any,
  callFunctions: FunctionSignature[],
  handleFunctions: FunctionSignature[],
  side: "client" | "server",
  config: ResolvedConfig,
): void {
  const interfaceName = side === "client" ? "RpcClient" : "RpcServer";
  const targetSide = side === "client" ? "server" : "client";
  const targetSideCapitalized = targetSide.charAt(0).toUpperCase() + targetSide.slice(1);

  sourceFile.addStatements(`\n// === ${interfaceName.toUpperCase()} INTERFACE ===`);

  // Generate the Handle interface (for registering handlers)
  const handleInterfaceName = `${interfaceName}Handle`;
  const handleProperties = handleFunctions.map((func) => {
    const funcParams = func.params
      .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
      .join(", ");
    const returnType = func.isVoid ? "void | RpcError" : `${func.returnType} | RpcError`;
    const handlerType = `(handler: (${funcParams}) => Promise<${returnType}>) => void`;
    return {
      name: func.name,
      type: handlerType,
      docs: [`Register handler for '${func.name}' - called by ${targetSide}`],
    };
  });

  // Add rpcError handler to Handle interface
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

  // Generate the target-side Call interface (e.g., RpcClientServer or RpcServerClient)
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

  // Generate main interface
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
 * Generates the createRpcClient or createRpcServer factory function
 * This is the main API - all socket logic is inlined here
 */
function generateFactoryFunction(
  sourceFile: any,
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

  const bodyWriter = (writer: any) => {
    // Track unsubscribers
    writer.writeLine("const unsubscribers: Array<() => void> = [];");
    writer.writeLine("let _disposed = false;");
    writer.writeLine("");

    // Helper to check disposed
    writer.writeLine("const checkDisposed = () => {");
    writer.indent(() => {
      writer.writeLine(`if (_disposed) throw new Error('${interfaceName} has been disposed');`);
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Build the handle object with inlined handler logic
    writer.writeLine("const handle: " + interfaceName + "Handle = {");
    writer.indent(() => {
      handleFunctions.forEach((func, index) => {
        const funcParams = func.params
          .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`)
          .join(", ");
        const returnType = func.isVoid ? "void | RpcError" : `${func.returnType} | RpcError`;
        const handlerParams = func.params.map((p) => p.name).join(", ");
        const typedParams = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");

        writer.writeLine(`${func.name}(handler: (${funcParams}) => Promise<${returnType}>) {`);
        writer.indent(() => {
          writer.writeLine("checkDisposed();");

          // Inline the listener logic
          if (func.isVoid) {
            // Fire-and-forget handler
            writer.writeLine(`const listener = async (${typedParams}) => {`);
            writer.indent(() => {
              writer.writeLine("try {");
              writer.indent(() => {
                writer.writeLine(`const result = await handler(${handlerParams});`);
                writer.writeLine(
                  `if (result && typeof result === 'object' && 'code' in result && 'message' in result) {`,
                );
                writer.indent(() => {
                  writer.writeLine(`socket.emit('rpcError', result);`);
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
            // Acknowledgment handler
            const callbackType = `(result: ${func.returnType} | RpcError) => void`;
            const fullParams = typedParams
              ? `${typedParams}, callback: ${callbackType}`
              : `callback: ${callbackType}`;
            writer.writeLine(`const listener = async (${fullParams}) => {`);
            writer.indent(() => {
              writer.writeLine("try {");
              writer.indent(() => {
                writer.writeLine(`const result = await handler(${handlerParams});`);
                writer.writeLine("callback(result);");
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
        writer.writeLine("}" + (index < handleFunctions.length - 1 ? "," : ","));
      });

      // Add rpcError handler
      writer.writeLine("rpcError(handler: (error: RpcError) => void) {");
      writer.indent(() => {
        writer.writeLine("checkDisposed();");
        writer.writeLine("const listener = (error: RpcError) => handler(error);");
        writer.writeLine(`socket.on('rpcError', listener);`);
        writer.writeLine(`unsubscribers.push(() => socket.off('rpcError', listener));`);
      });
      writer.writeLine("}");
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Build the target-side call object (e.g., "server" for client, "client" for server)
    writer.writeLine(`const ${targetSide}: ` + interfaceName + targetSideCapitalized + " = {");
    writer.indent(() => {
      callFunctions.forEach((func, index) => {
        const funcParams = func.params.map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
        if (!func.isVoid) {
          funcParams.push(`timeout: number = ${config.defaultTimeout}`);
        }
        const paramsString = funcParams.join(", ");
        const argsArray = func.params.map((p) => p.name);
        const argsString = argsArray.length > 0 ? `, ${argsArray.join(", ")}` : "";

        if (func.isVoid) {
          // Fire-and-forget call
          writer.writeLine(`${func.name}(${paramsString}) {`);
          writer.indent(() => {
            writer.writeLine(`socket.emit('${func.name}'${argsString});`);
          });
          writer.writeLine("}" + (index < callFunctions.length - 1 ? "," : ""));
        } else {
          // Acknowledgment call
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
          writer.writeLine("}" + (index < callFunctions.length - 1 ? "," : ""));
        }
      });
    });
    writer.writeLine("};");
    writer.writeLine("");

    // Return the interface object
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
        description: `Create a ${side} RPC instance.\n\nUsage:\n\`\`\`typescript\nconst ${side} = ${factoryName}(socket);\n\n// Register handlers for calls from ${targetSide}\n${side}.handle.${handleFunctions[0]?.name || "eventName"}(async (${handleFunctions[0]?.params.map((p) => p.name).join(", ") || "data"}) => {\n  // handle event\n});\n\n// Call ${targetSide} methods\n${callFunctions[0] ? (callFunctions[0].isVoid ? `${side}.${targetSide}.${callFunctions[0].name}(${callFunctions[0].params.map((p) => "...").join(", ")});` : `const result = await ${side}.${targetSide}.${callFunctions[0].name}(${callFunctions[0].params.map((p) => "...").join(", ")});`) : "// ..."}\n\n// Cleanup when done\n${side}.dispose();\n\`\`\``,
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
 * Generates client.ts or server.ts file using ts-morph
 * Unified function that works for both sides
 */
function generateSideFile(
  side: "client" | "server",
  project: Project,
  outputDir: string,
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  config: ResolvedConfig,
  inputFile: SourceFile,
): void {
  const socketModule = side === "client" ? "socket.io-client" : "socket.io";
  const fileName = `${side}.generated.ts`;

  // Client calls serverFunctions and handles clientFunctions
  // Server calls clientFunctions and handles serverFunctions
  const callFunctions = side === "client" ? clientFunctions : serverFunctions;
  const handleFunctions = side === "client" ? serverFunctions : clientFunctions;

  const sideFile = project.createSourceFile(path.join(outputDir, fileName), "", {
    overwrite: true,
  });

  // Add Socket import (not type-only since we use it at runtime)
  sideFile.addImportDeclaration({
    moduleSpecifier: socketModule,
    namedImports: ["Socket"],
    isTypeOnly: true,
  });

  // Add RpcError import from types
  sideFile.addImportDeclaration({
    moduleSpecifier: "./types.generated",
    namedImports: ["RpcError"],
    isTypeOnly: true,
  });

  // Add custom type imports from input file
  const inputFilename = path.basename(config.inputPath, path.extname(config.inputPath));
  addCustomTypeImports(
    sideFile,
    [...clientFunctions, ...serverFunctions],
    inputFile,
    inputFilename,
  );

  const targetSide = side === "client" ? "server" : "client";

  // Add file header comment
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

  // Generate interfaces and factory function
  generateFactoryInterface(sideFile, callFunctions, handleFunctions, side, config);
  generateFactoryFunction(sideFile, callFunctions, handleFunctions, side, config);

  // Format and save
  sideFile.formatText();
}

/**
 * Generates package.json for the RPC package
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
 * Generates tsconfig.json for the RPC package
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

// ============================================
// MAIN GENERATOR
// ============================================

/**
 * Resolves user config with defaults
 */
function resolveConfig(userConfig: GeneratorConfig): ResolvedConfig {
  return {
    defaultTimeout: 5000,
    errorLogger: undefined,
    ...userConfig,
  };
}

/**
 * Validates that the input file exists
 */
function validateInputFile(inputPath: string): void {
  if (!fs.existsSync(inputPath)) {
    console.error("❌ Error: Input file not found at", inputPath);
    console.error("💡 Please create a file with ClientFunctions and ServerFunctions interfaces");
    process.exit(1);
  }
}

/**
 * Extracts interfaces and function signatures from the input file
 */
async function extractInterfacesFromFile(inputPath: string): Promise<{
  clientFunctions: FunctionSignature[];
  serverFunctions: FunctionSignature[];
  sourceFile: SourceFile;
}> {
  // Create a new ts-morph project for reading input
  const inputProject = new Project({
    tsConfigFilePath: path.join(__dirname, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  // Add the input file to the project
  const sourceFile = inputProject.addSourceFileAtPath(inputPath);

  // Resolve all dependencies (imported files)
  // This ensures that extended interfaces from other files are available
  sourceFile.getReferencedSourceFiles().forEach((referencedFile) => {
    inputProject.addSourceFileAtPath(referencedFile.getFilePath());
  });

  // Find the interfaces
  const clientFunctionsInterface = sourceFile.getInterface("ClientFunctions");
  const serverFunctionsInterface = sourceFile.getInterface("ServerFunctions");

  if (!clientFunctionsInterface || !serverFunctionsInterface) {
    console.error("❌ Error: Could not find ClientFunctions or ServerFunctions interfaces");
    process.exit(1);
  }

  // Extract function signatures
  const clientFunctions = extractFunctionSignatures(serverFunctionsInterface);
  const serverFunctions = extractFunctionSignatures(clientFunctionsInterface);

  return { clientFunctions, serverFunctions, sourceFile };
}

/**
 * Ensures output directory exists and creates package files if needed
 */
async function ensurePackageStructure(outputDir: string, config: ResolvedConfig): Promise<void> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate package.json if it doesn't exist
  const packageJsonPath = path.join(outputDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    const packageJson = generatePackageJson(config);
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  }

  // Generate tsconfig.json if it doesn't exist
  const tsConfigPath = path.join(outputDir, "tsconfig.json");
  if (!fs.existsSync(tsConfigPath)) {
    const tsConfig = generateTsConfig();
    fs.writeFileSync(tsConfigPath, JSON.stringify(tsConfig, null, 2));
  }
}

/**
 * Logs generation summary to console
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
 * Main generator function that orchestrates the entire RPC package generation
 */
async function generateRpcPackage(userConfig: GeneratorConfig): Promise<void> {
  const config = resolveConfig(userConfig);
  validateInputFile(config.inputPath);

  try {
    const { clientFunctions, serverFunctions, sourceFile } = await extractInterfacesFromFile(
      config.inputPath,
    );
    await ensurePackageStructure(config.outputDir, config);

    // Create a new ts-morph project for generating output files
    const outputProject = new Project({
      useInMemoryFileSystem: false,
      tsConfigFilePath: path.join(config.outputDir, "tsconfig.json"),
      compilerOptions: {
        outDir: path.join(config.outputDir, "dist"),
        rootDir: config.outputDir,
      },
    });

    // Generate files using ts-morph
    generateTypesFile(outputProject, config.outputDir, config);
    generateSideFile(
      "client",
      outputProject,
      config.outputDir,
      clientFunctions,
      serverFunctions,
      config,
      sourceFile,
    );
    generateSideFile(
      "server",
      outputProject,
      config.outputDir,
      clientFunctions,
      serverFunctions,
      config,
      sourceFile,
    );

    // Save all generated files
    await outputProject.save();

    logGenerationSummary(clientFunctions, serverFunctions, config.outputDir);
  } catch (error) {
    console.error("❌ Error generating RPC package:", error);
    process.exit(1);
  }
}

// ============================================
// WATCH MODE & CLI
// ============================================

/**
 * Watches the input file for changes and regenerates on modification
 */
async function watchMode(config: GeneratorConfig): Promise<void> {
  const mergedConfig = { ...{ defaultTimeout: 5000 }, ...config };
  const { inputPath } = mergedConfig;

  console.log(`👀 Watching ${inputPath} for changes...`);

  // Initial generation
  await generateRpcPackage(config);

  // Watch for changes
  fs.watchFile(inputPath, { interval: 1000 }, async (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
      console.log(`\n🔄 ${path.basename(inputPath)} changed, regenerating...`);
      try {
        await generateRpcPackage(config);
      } catch (error) {
        console.error("❌ Error during regeneration:", error);
      }
    }
  });

  // Handle process termination
  process.on("SIGINT", () => {
    console.log("\n👋 Stopping watch mode...");
    fs.unwatchFile(inputPath);
    process.exit(0);
  });
}

// Run the generator if this file is executed directly
if (require.main === module) {
  // Read version from package.json
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
  const version = packageJson.version;

  const program = new Command();

  program
    .name("socketrpc-gen")
    .description("Generate Socket.IO RPC code from interface definitions.")
    .version(version);

  // Display the current version when the program starts
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
    .option("-w, --watch", "Watch for changes and regenerate automatically", false)

    .action((filePath, options) => {
      const inputPath = path.resolve(process.cwd(), filePath);

      // Validate input path
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        console.error(`❌ Error: Input file not found or is not a file at ${inputPath}`);
        process.exit(1);
      }

      // Auto-determine output directory from the input file's path
      const outputDir = path.dirname(inputPath);

      const config: GeneratorConfig = {
        inputPath: inputPath,
        outputDir: outputDir,
        packageName: options.packageName,
        defaultTimeout: parseInt(options.timeout, 10),
        errorLogger: options.errorLogger,
      };

      if (options.watch) {
        watchMode(config).catch(console.error);
      } else {
        generateRpcPackage(config).catch(console.error);
      }
    });

  program.parse(process.argv);
}
