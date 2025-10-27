#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';
import {
  Project,
  InterfaceDeclaration,
  SyntaxKind,
  SourceFile,

  StructureKind
} from 'ts-morph';
import type {
  JSDocStructure,
  OptionalKind,
  FunctionDeclarationStructure,
  ParameterDeclarationStructure,
  JSDocTagStructure
} from 'ts-morph';
import { Command } from 'commander';

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
type ResolvedConfig = Required<Omit<GeneratorConfig, 'errorLogger'>> & {
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

/**
 * Creates a consistent RpcError creation expression for generated code
 */
function createRpcErrorExpression(errorVar: string): string {
  return `{ message: ${errorVar} instanceof Error ? ${errorVar}.message : String(${errorVar}), code: 'INTERNAL_ERROR', data: undefined }`;
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

    baseTypes.forEach(baseType => {
      const symbol = baseType.getSymbol();
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      declarations.forEach(decl => {
        if (decl.getKindName() === 'InterfaceDeclaration') {
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
  processedNames: Set<string>
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
  const params: FunctionParam[] = signature.getParameters().map(param => {
    const paramType = param.getTypeAtLocation(property);
    const typeString = paramType.getText(property);

    return {
      name: param.getName(),
      type: typeString,
      isOptional: param.isOptional()
    };
  });

  // Extract return type
  const returnType = signature.getReturnType();
  const returnTypeString = returnType.getText(property);
  const isVoid = returnTypeString === 'void';

  return {
    name,
    params,
    returnType: returnTypeString,
    isVoid
  };
}

/**
 * Extracts function signatures from a TypeScript interface using ts-morph
 * Supports interface extension - will extract properties from base interfaces too
 */
function extractFunctionSignatures(interfaceDeclaration: InterfaceDeclaration): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const processedNames = new Set<string>();

  // Collect all interfaces in the inheritance chain
  const baseInterfaces = getAllBaseInterfaces(interfaceDeclaration);
  const allInterfaces = [...baseInterfaces, interfaceDeclaration];

  // Process each interface in the chain
  allInterfaces.forEach(iface => {
    iface.getProperties().forEach(property => {
      const extracted = extractSignatureFromProperty(property, processedNames);
      if (extracted) {
        signatures.push(extracted);
        processedNames.add(extracted.name);
      }
    });
  });

  return signatures;
}

/**
 * Creates JSDoc structure for generated functions
 * @param description - The main description for the function.
 * @param params - An array of parameter structures for the function.
 * @param returnType - An object describing the return type of the function, or null if void.
 * @returns A JSDoc structure object.
 */
function createJSDoc(
  description: string,
  params: OptionalKind<ParameterDeclarationStructure>[],
  returnType: { type: string; description?: string } | null
): JSDocStructure {
  const tags: OptionalKind<JSDocTagStructure>[] = [];

  params.forEach(param => {
    let paramDescription = '';
    if (param.name === 'socket') {
      paramDescription = 'The socket instance for communication.';
    } else if (param.name === 'handler') {
      paramDescription = 'The handler function to process incoming events.';
    } else if (param.name === 'timeout') {
      paramDescription = 'The timeout for the acknowledgment in milliseconds.';
    }

    tags.push({
      kind: StructureKind.JSDocTag,
      tagName: 'param',
      text: `{${param.type as string}} ${param.name} ${paramDescription}`.trim()
    });
  });

  if (returnType) {
    tags.push({
      kind: StructureKind.JSDocTag,
      tagName: 'returns',
      text: `{${returnType.type}} ${returnType.description || ''}`.trim()
    });
  }

  return {
    kind: StructureKind.JSDoc,
    description: `${description}`,
    tags
  };
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
  const typesFile = project.createSourceFile(
    path.join(outputDir, 'types.generated.ts'),
    '',
    { overwrite: true }
  );

  typesFile.insertText(0, `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 * 
 * Auto-generated types for the RPC package
 *
 * To regenerate this file, run:
 * bunx socketrpc-gen ${config.inputPath}
 */

`);

  typesFile.addTypeAlias({
    name: 'UnsubscribeFunction',
    type: '() => void',
    isExported: true,
    docs: ['Function to unsubscribe from an event listener. Call this to clean up the listener.']
  });

  typesFile.addInterface({
    name: 'RpcError',
    isExported: true,
    docs: ['Represents an error that occurred during an RPC call.'],
    properties: [
      {
        name: 'message',
        type: 'string',
        docs: ['The error message.']
      },
      {
        name: 'code',
        type: 'string',
        docs: ['The error code.']
      },
      {
        name: 'data',
        type: 'any',
        docs: ['The error data.']
      }
    ]
  });

  typesFile.addFunction({
    name: 'isRpcError',
    isExported: true,
    docs: ['Type guard to check if an object is an RpcError.'],
    parameters: [{ name: 'obj', type: 'any' }],
    returnType: 'obj is RpcError',
    statements: `return !!obj && typeof (obj as RpcError).message === 'string' && typeof (obj as RpcError).code === 'string';`
  });

  typesFile.formatText();
}

// ============================================
// AST GENERATION - RPC FUNCTIONS
// ============================================

/**
 * Creates function parameters structure for ts-morph
 */
function createFunctionParameters(
  func: FunctionSignature,
  includeSocket: boolean = true,
  includeTimeout: boolean = false,
  config?: ResolvedConfig
): OptionalKind<ParameterDeclarationStructure>[] {
  const params: OptionalKind<ParameterDeclarationStructure>[] = [];

  // Add socket parameter if needed
  if (includeSocket) {
    params.push({
      name: 'socket',
      type: 'Socket'
    });
  }

  // Add function-specific parameters
  func.params.forEach(param => {
    params.push({
      name: param.name,
      type: param.type,
      hasQuestionToken: param.isOptional
    });
  });

  // Add timeout parameter if needed
  if (includeTimeout && config) {
    params.push({
      name: 'timeout',
      type: 'number',
      initializer: config.defaultTimeout.toString()
    });
  }

  return params;
}

/**
 * Creates common RPC function body writer (shared between client and server)
 */
function createRpcFunctionBodyWriter(func: FunctionSignature): (writer: any) => void {
  return (writer: any) => {
    if (func.isVoid) {
      // For void functions, emit without acknowledgment
      const argsArray = func.params.map(p => p.name);
      const argsString = argsArray.length > 0 ? `, ${argsArray.join(', ')}` : '';
      writer.writeLine(`socket.emit('${func.name}'${argsString});`);
    } else {
      // For non-void functions, emit with acknowledgment and error handling
      const argsArray = func.params.map(p => p.name);
      const argsString = argsArray.length > 0 ? `, ${argsArray.join(', ')}` : '';
      writer.writeLine(`try {`);
      writer.indent(() => {
        writer.writeLine(`return await socket.timeout(timeout).emitWithAck('${func.name}'${argsString});`);
      });
      writer.writeLine(`} catch (err) {`);
      writer.indent(() => {
        writer.writeLine(`return ${createRpcErrorExpression('err')};`);
      });
      writer.writeLine(`}`);
    }
  };
}

/**
 * Generates RPC function using ts-morph AST with shared body logic
 * Works for both client->server and server->client calls
 */
function generateRpcFunctionAST(
  func: FunctionSignature,
  config: ResolvedConfig,
  side: 'client' | 'server'
): FunctionDeclarationStructure {
  const params = createFunctionParameters(func, true, !func.isVoid, config);
  const bodyWriter = createRpcFunctionBodyWriter(func);

  const caller = side === 'client' ? 'CLIENT' : 'SERVER';
  const target = side === 'client' ? 'SERVER' : 'CLIENT';
  const targetLower = target.toLowerCase();

  const description = `${caller} calls ${target}: Emits '${func.name}' event to ${targetLower} ${func.isVoid ? 'without' : 'with'
    } acknowledgment. Includes built-in error handling.`;
  const returnType = func.isVoid
    ? null
    : {
      type: `Promise<${func.returnType} | RpcError>`,
      description: `A promise that resolves with the result from the ${targetLower}, or an RpcError if one occurred.`
    };

  return {
    kind: StructureKind.Function,
    name: func.name,
    isExported: true,
    isAsync: !func.isVoid,
    parameters: params,
    returnType: func.isVoid ? 'void' : `Promise<${func.returnType} | RpcError>`,
    statements: bodyWriter,
    docs: [createJSDoc(description, params, returnType)]
  };
}

// ============================================
// AST GENERATION - HANDLERS
// ============================================

/**
 * Creates body writer for void (fire-and-forget) handlers
 */
function createVoidHandlerBodyWriter(func: FunctionSignature, config: ResolvedConfig): (writer: any) => void {
  return (writer: any) => {
    const loggerCall = config.errorLogger
      ? `logger.error('[${func.name}] Handler error:', error);`
      : `console.error('[${func.name}] Handler error:', error);`;
    const paramNames = func.params.map(p => p.name);
    const handlerArgs = paramNames.length > 0 ? `socket, ${paramNames.join(', ')}` : 'socket';
    const typedParams = func.params.map(p => `${p.name}: ${p.type}`).join(', ');

    writer.writeLine(`const listener = async (${typedParams}) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        writer.writeLine(`const result = await handler(${handlerArgs});`);
        writer.writeLine('if (result && typeof result === \'object\' && \'code\' in result && \'message\' in result) {');
        writer.indent(() => {
          writer.writeLine('socket.emit(\'rpcError\', result);');
        });
        writer.writeLine('}');
      });
      writer.writeLine('} catch (error) {');
      writer.indent(() => {
        writer.writeLine(loggerCall);
        writer.writeLine(`socket.emit('rpcError', ${createRpcErrorExpression('error')});`);
      });
      writer.writeLine('}');
    });
    writer.writeLine('};');
    writer.writeLine(`socket.on('${func.name}', listener);`);
    writer.writeLine(`return () => socket.off('${func.name}', listener);`);
  };
}

/**
 * Creates body writer for handlers that expect acknowledgment
 */
function createAckHandlerBodyWriter(func: FunctionSignature, config: ResolvedConfig): (writer: any) => void {
  return (writer: any) => {
    const loggerCall = config.errorLogger
      ? `logger.error('[${func.name}] Handler error:', error);`
      : `console.error('[${func.name}] Handler error:', error);`;
    const paramNames = func.params.map(p => p.name);
    const handlerArgs = paramNames.length > 0 ? `socket, ${paramNames.join(', ')}` : 'socket';
    const typedParams = func.params.map(p => `${p.name}: ${p.type}`).join(', ');
    const callbackType = `(result: ${func.returnType} | RpcError) => void`;
    const fullParams = typedParams ? `${typedParams}, callback: ${callbackType}` : `callback: ${callbackType}`;

    writer.writeLine(`const listener = async (${fullParams}) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        writer.writeLine(`const result = await handler(${handlerArgs});`);
        writer.writeLine('callback(result);');
      });
      writer.writeLine('} catch (error) {');
      writer.indent(() => {
        writer.writeLine(loggerCall);
        writer.writeLine(`callback(${createRpcErrorExpression('error')});`);
      });
      writer.writeLine('}');
    });
    writer.writeLine('};');
    writer.writeLine(`socket.on('${func.name}', listener);`);
    writer.writeLine(`return () => socket.off('${func.name}', listener);`);
  };
}

/**
 * Creates handler function body writer - dispatches to void or acknowledgment writer
 */
function createHandlerBodyWriter(func: FunctionSignature, config: ResolvedConfig): (writer: any) => void {
  return func.isVoid
    ? createVoidHandlerBodyWriter(func, config)
    : createAckHandlerBodyWriter(func, config);
}

/**
 * Generates handler function using ts-morph AST (shared logic for client and server)
 */
function generateHandlerAST(
  func: FunctionSignature,
  config: ResolvedConfig,
  eventSource: 'server' | 'client',
  useExportedType: boolean = false
): FunctionDeclarationStructure | null {
  const handlerName = `handle${func.name.charAt(0).toUpperCase() + func.name.slice(1)}`;
  const handlerTypeName = `${func.name.charAt(0).toUpperCase() + func.name.slice(1)}Handler`;
  const handlerParamType = useExportedType
    ? handlerTypeName
    : func.params.length > 0
      ? `(${func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ')}) => ${func.isVoid ? 'Promise<void | RpcError>' : `Promise<${func.returnType} | RpcError>`}`
      : `() => ${func.isVoid ? 'Promise<void | RpcError>' : `Promise<${func.returnType} | RpcError>`}`;

  const bodyWriter = createHandlerBodyWriter(func, config);

  const params: OptionalKind<ParameterDeclarationStructure>[] = [
    { name: 'socket', type: 'Socket' },
    { name: 'handler', type: handlerParamType }
  ];
  const description = `Sets up listener for '${func.name}' events from ${eventSource}${func.isVoid ? '' : ' with acknowledgment'}. Returns a function to remove the listener.`;

  return {
    kind: StructureKind.Function,
    name: handlerName,
    isExported: true,
    parameters: params,
    returnType: 'UnsubscribeFunction',
    statements: bodyWriter,
    docs: [createJSDoc(description, params, { type: 'UnsubscribeFunction', description: 'A function that removes the event listener when called' })]
  };
}

/**
 * Generates handleRpcError function using ts-morph AST with async/await and try-catch
 */
function generateRpcErrorHandlerAST(): FunctionDeclarationStructure {
  const bodyWriter = (writer: any) => {
    writer.writeLine(`const listener = async (error: RpcError) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        writer.writeLine('await handler(socket, error);');
      });
      writer.writeLine('} catch (handlerError) {');
      writer.indent(() => {
        writer.writeLine(`console.error('[handleRpcError] Error in RPC error handler:', handlerError);`);
      });
      writer.writeLine('}');
    });
    writer.writeLine('};');
    writer.writeLine(`socket.on('rpcError', listener);`);
    writer.writeLine(`return () => socket.off('rpcError', listener);`);
  };

  const params: OptionalKind<ParameterDeclarationStructure>[] = [
    { name: 'socket', type: 'Socket' },
    { name: 'handler', type: '(socket: Socket, error: RpcError) => Promise<void>' }
  ];

  const description = `Sets up listener for 'rpcError' events with async/await and try-catch. This handler is called whenever an RPC error occurs during function execution. Returns a function to remove the listener.`;

  return {
    kind: StructureKind.Function,
    name: 'handleRpcError',
    isExported: true,
    parameters: params,
    returnType: 'UnsubscribeFunction',
    statements: bodyWriter,
    docs: [createJSDoc(description, params, { type: 'UnsubscribeFunction', description: 'A function that removes the event listener when called' })]
  };
}

/**
 * Creates standard import declarations for generated files
 */
function createStandardImports(sourceFile: any, socketModule: string): void {
  // Add Socket import
  sourceFile.addImportDeclaration({
    moduleSpecifier: socketModule,
    namedImports: ['Socket'],
    isTypeOnly: true
  });

  // Always add RpcError and UnsubscribeFunction imports since we generate handleRpcError by default
  sourceFile.addImportDeclaration({
    moduleSpecifier: './types.generated',
    namedImports: ['RpcError', 'UnsubscribeFunction'],
    isTypeOnly: true
  });
}

/**
 * Adds custom logger import if specified in config
 */
function addLoggerImport(sourceFile: any, config: ResolvedConfig): void {
  if (config.errorLogger) {
    sourceFile.addImportDeclaration({
      moduleSpecifier: config.errorLogger,
      namedImports: ['logger'],
      isTypeOnly: false
    });
  }
}

// ============================================
// TYPE EXTRACTION & IMPORTS
// ============================================

/**
 * Extracts custom types used in function signatures and adds them as type-only imports
 */
function addCustomTypeImports(
  sourceFile: any,
  functions: FunctionSignature[],
  inputFile: SourceFile,
  inputFilename: string
): void {
  const usedTypes = new Set<string>();

  // Extract types from function parameters and return types
  functions.forEach(func => {
    func.params.forEach(param => {
      // Extract type names from complex types like GetPlanRequest, Plan[], etc.
      const typeNames = extractTypeNames(param.type);
      typeNames.forEach(typeName => usedTypes.add(typeName));
    });

    // Extract types from return types
    const returnTypeNames = extractTypeNames(func.returnType);
    returnTypeNames.forEach(typeName => usedTypes.add(typeName));
  });

  // Filter out primitive types and built-in types
  const customTypes = Array.from(usedTypes).filter(type =>
    !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'object', 'Array', 'Promise', 'Error'].includes(type) &&
    !type.includes('|') && // Skip union types for now
    !type.includes('<') && // Skip generic types for now
    !type.includes('[') // Skip array types for now
  );

  if (customTypes.length > 0) {
    // Check if these types are exported from the input file
    const exportedTypes = inputFile.getExportedDeclarations();
    const availableTypes = customTypes.filter(type => {
      return exportedTypes.has(type) ||
        inputFile.getTypeAlias(type) ||
        inputFile.getInterface(type);
    });

    if (availableTypes.length > 0) {
      sourceFile.addImportDeclaration({
        moduleSpecifier: `./${inputFilename}`,
        namedImports: availableTypes,
        isTypeOnly: true
      });
    }
  }
}

/**
 * Extracts type names from a TypeScript type string
 * Handles complex types including generics, unions, and arrays
 */
function extractTypeNames(typeString: string): string[] {
  const types = new Set<string>();

  // Remove array brackets and extract types from arrays
  let cleanedType = typeString.replace(/\[\]/g, '');

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
    args.forEach(arg => {
      extractTypeNames(arg.trim()).forEach(t => types.add(t));
    });

    // Process the rest of the type string
    cleanedType = cleanedType.replace(genericMatch[0], '');
  }

  // Extract types from unions: string | number | User
  const unionParts = cleanedType.split('|').map(p => p.trim());
  unionParts.forEach(part => {
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
  let current = '';
  let depth = 0;

  for (let i = 0; i < args.length; i++) {
    const char = args[i];

    if (char === '<') {
      depth++;
      current += char;
    } else if (char === '>') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
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
// FILE GENERATION
// ============================================

/**
 * Generates handler type exports for a side (client or server)
 * @param sourceFile - The file to add types to
 * @param functions - Functions that will be handled
 * @param side - Which side is handling ('client' or 'server')
 */
function generateHandlerTypes(
  sourceFile: any,
  functions: FunctionSignature[],
  side: 'client' | 'server'
): void {
  const sideName = side.toUpperCase();
  const eventSource = side === 'client' ? 'server' : 'client';

  // Add section comment for handler types
  sourceFile.addStatements(`\n// === ${sideName} HANDLER TYPES ===`);

  // Generate type alias for each handler
  functions.forEach(func => {
    const handlerName = `${func.name.charAt(0).toUpperCase() + func.name.slice(1)}Handler`;
    const socketParam = 'socket: Socket';
    const funcParams = func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ');
    const allParams = funcParams ? `${socketParam}, ${funcParams}` : socketParam;
    const handlerType = `(${allParams}) => ${func.isVoid ? 'Promise<void | RpcError>' : `Promise<${func.returnType} | RpcError>`}`;

    sourceFile.addTypeAlias({
      name: handlerName,
      type: handlerType,
      isExported: true,
      docs: [`Handler type for processing '${func.name}' events from ${eventSource}`]
    });
  });
}

/**
 * Generates client.ts or server.ts file using ts-morph
 * Unified function that works for both sides
 */
function generateSideFile(
  side: 'client' | 'server',
  project: Project,
  outputDir: string,
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  config: ResolvedConfig,
  inputFile: SourceFile
): void {
  const sideName = side.toUpperCase();
  const targetName = side === 'client' ? 'SERVER' : 'CLIENT';
  const socketModule = side === 'client' ? 'socket.io-client' : 'socket.io';
  const fileName = `${side}.generated.ts`;

  // Client calls serverFunctions and handles clientFunctions
  // Server calls clientFunctions and handles serverFunctions
  const callFunctions = side === 'client' ? clientFunctions : serverFunctions;
  const handleFunctions = side === 'client' ? serverFunctions : clientFunctions;

  const sideFile = project.createSourceFile(
    path.join(outputDir, fileName),
    '',
    { overwrite: true }
  );

  // Add standard imports using optimized function
  createStandardImports(sideFile, socketModule);

  // Add logger import if configured
  addLoggerImport(sideFile, config);

  // Add custom type imports from input file
  const inputFilename = path.basename(config.inputPath, path.extname(config.inputPath));
  addCustomTypeImports(sideFile, [...clientFunctions, ...serverFunctions], inputFile, inputFilename);

  // Add file header comment
  const targetInterface = side === 'client' ? 'ServerFunctions' : 'ClientFunctions';
  const handlerInterface = side === 'client' ? 'ClientFunctions' : 'ServerFunctions';

  sideFile.insertText(0, `/**
 * ⚠️  DO NOT EDIT THIS FILE - IT IS AUTO-GENERATED ⚠️
 *
 * Auto-generated ${side} functions from ${inputFilename}.ts
 * These functions allow ${sideName} to call ${targetName} functions (${targetInterface} interface)
 * and set up handlers for ${sideName} functions (${handlerInterface} interface)
 *
 * To regenerate this file, run:
 * bunx socketrpc-gen ${config.inputPath}
 */

`);

  // Generate handler type exports
  generateHandlerTypes(sideFile, handleFunctions, side);

  // Add section comment for calling functions
  sideFile.addStatements(`\n// === ${sideName} CALLING ${targetName} FUNCTIONS ===`);

  // Add call functions
  callFunctions.forEach(func => {
    const functionStructure = generateRpcFunctionAST(func, config, side);
    sideFile.addFunction(functionStructure);
  });

  // Add section comment for handler functions
  sideFile.addStatements(`\n// === ${sideName} HANDLER FUNCTIONS ===`);

  // Add handler functions
  handleFunctions.forEach(func => {
    const handlerStructure = generateHandlerAST(func, config, side === 'client' ? 'server' : 'client', true);
    if (handlerStructure) {
      sideFile.addFunction(handlerStructure);
    }
  });

  // Add handleRpcError function
  const rpcErrorHandlerStructure = generateRpcErrorHandlerAST();
  sideFile.addFunction(rpcErrorHandlerStructure);

  // Format and save
  sideFile.formatText();
  sideFile.fixMissingImports();
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
      "build": "tsc",
      "dev": "tsc --watch"
    },
    dependencies: {
      "socket.io": "^4.8.1",
      "socket.io-client": "^4.8.1"
    },
    devDependencies: {
      "@types/node": "^20.0.0",
      "typescript": "^5.0.0"
    },
    peerDependencies: {
      "socket.io": "^4.0.0",
      "socket.io-client": "^4.0.0"
    }
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
      composite: true
    },
    include: ["**/*.ts"],
    exclude: ["node_modules", "dist"]
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
    ...userConfig
  };
}

/**
 * Validates that the input file exists
 */
function validateInputFile(inputPath: string): void {
  if (!fs.existsSync(inputPath)) {
    console.error('❌ Error: Input file not found at', inputPath);
    console.error('💡 Please create a file with ClientFunctions and ServerFunctions interfaces');
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
    tsConfigFilePath: path.join(__dirname, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true
  });

  // Add the input file to the project
  const sourceFile = inputProject.addSourceFileAtPath(inputPath);

  // Resolve all dependencies (imported files)
  // This ensures that extended interfaces from other files are available
  sourceFile.getReferencedSourceFiles().forEach(referencedFile => {
    inputProject.addSourceFileAtPath(referencedFile.getFilePath());
  });

  // Find the interfaces
  const clientFunctionsInterface = sourceFile.getInterface('ClientFunctions');
  const serverFunctionsInterface = sourceFile.getInterface('ServerFunctions');

  if (!clientFunctionsInterface || !serverFunctionsInterface) {
    console.error('❌ Error: Could not find ClientFunctions or ServerFunctions interfaces');
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
  const packageJsonPath = path.join(outputDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    const packageJson = generatePackageJson(config);
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  }

  // Generate tsconfig.json if it doesn't exist
  const tsConfigPath = path.join(outputDir, 'tsconfig.json');
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
  outputDir: string
): void {
  console.log('✅ Generated RPC package successfully using ts-morph AST!');
  console.log(`📦 Package location: ${outputDir}`);
  console.log(`📄 Generated files:`);
  console.log(`   - client.generated.ts (${clientFunctions.length} call functions, ${serverFunctions.length} handler functions)`);
  console.log(`   - server.generated.ts (${serverFunctions.length} call functions, ${clientFunctions.length} handler functions)`);
  console.log(`   - types.generated.ts`);

  // Log generated functions
  if (clientFunctions.length > 0) {
    console.log('\n📋 Generated client->server functions:');
    clientFunctions.forEach(f => {
      console.log(`  - ${f.name}(${f.params.map(p => p.name).join(', ')}) -> ${f.returnType}`);
    });
  }

  if (serverFunctions.length > 0) {
    console.log('\n📋 Generated server->client functions:');
    serverFunctions.forEach(f => {
      console.log(`  - ${f.name}(${f.params.map(p => p.name).join(', ')}) -> ${f.returnType}`);
    });
  }

  if (serverFunctions.length > 0) {
    console.log('\n📋 Generated client handler functions:');
    serverFunctions.forEach(f => {
      const handlerName = `handle${f.name.charAt(0).toUpperCase() + f.name.slice(1)}`;
      console.log(`  - ${handlerName}(socket, handler)`);
    });
  }

  if (clientFunctions.length > 0) {
    console.log('\n📋 Generated server handler functions:');
    clientFunctions.forEach(f => {
      const handlerName = `handle${f.name.charAt(0).toUpperCase() + f.name.slice(1)}`;
      console.log(`  - ${handlerName}(socket, handler)`);
    });
  }

  console.log('\n📋 Generated default handler functions (always included):');
  console.log('  - handleRpcError(socket, handler) - handles RPC errors from both client and server');
}

/**
 * Main generator function that orchestrates the entire RPC package generation
 */
async function generateRpcPackage(userConfig: GeneratorConfig): Promise<void> {
  const config = resolveConfig(userConfig);
  validateInputFile(config.inputPath);

  try {
    const { clientFunctions, serverFunctions, sourceFile } = await extractInterfacesFromFile(config.inputPath);
    await ensurePackageStructure(config.outputDir, config);

    // Create a new ts-morph project for generating output files
    const outputProject = new Project({
      useInMemoryFileSystem: false,
      tsConfigFilePath: path.join(config.outputDir, 'tsconfig.json'),
      compilerOptions: {
        outDir: path.join(config.outputDir, 'dist'),
        rootDir: config.outputDir
      }
    });

    // Generate files using ts-morph
    generateTypesFile(outputProject, config.outputDir, config);
    generateSideFile('client', outputProject, config.outputDir, clientFunctions, serverFunctions, config, sourceFile);
    generateSideFile('server', outputProject, config.outputDir, clientFunctions, serverFunctions, config, sourceFile);

    // Save all generated files
    await outputProject.save();

    logGenerationSummary(clientFunctions, serverFunctions, config.outputDir);

  } catch (error) {
    console.error('❌ Error generating RPC package:', error);
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
        console.error('❌ Error during regeneration:', error);
      }
    }
  });

  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n👋 Stopping watch mode...');
    fs.unwatchFile(inputPath);
    process.exit(0);
  });
}

// Run the generator if this file is executed directly
if (require.main === module) {
  // Read version from package.json
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const version = packageJson.version;

  const program = new Command();

  program
    .name("socketrpc-gen")
    .description("Generate Socket.IO RPC code from interface definitions.")
    .version(version);

  // Display the current version when the program starts
  console.log(`🚀 socketrpc-gen v${version}`);

  program
    .argument(
      "<path>",
      "Path to the input TypeScript file containing interface definitions"
    )
    .option(
      "-p, --package-name <name>",
      "Package name for the generated RPC package",
      "@socket-rpc/rpc"
    )
    .option(
      "-t, --timeout <ms>",
      "Default timeout for RPC calls in milliseconds",
      "5000"
    )
    .option(
      "-l, --error-logger <path>",
      "Custom error logger import path (e.g., '@/lib/logger')"
    )
    .option(
      "-w, --watch",
      "Watch for changes and regenerate automatically",
      false
    )

    .action((filePath, options) => {
      const inputPath = path.resolve(process.cwd(), filePath);

      // Validate input path
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        console.error(
          `❌ Error: Input file not found or is not a file at ${inputPath}`
        );
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