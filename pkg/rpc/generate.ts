import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Configuration options for the RPC generator
 */
interface GeneratorConfig {
  /** Path to the input TypeScript file containing interface definitions */
  inputPath?: string;
  /** Output path for generated client functions */
  clientOutputPath?: string;
  /** Output path for generated server functions */
  serverOutputPath?: string;
  /** Default timeout for RPC calls in milliseconds */
  defaultTimeout?: number;
  /** Whether to generate JSDoc comments */
  generateJSDoc?: boolean;
  /** Whether to generate handler functions */
  generateHandlers?: boolean;
  /** Custom import path for Socket types */
  socketClientImport?: string;
  socketServerImport?: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<GeneratorConfig> = {
  inputPath: 'define.ts',
  clientOutputPath: 'client.ts',
  serverOutputPath: 'server.ts',
  defaultTimeout: 5000,
  generateJSDoc: true,
  generateHandlers: true,
  socketClientImport: 'socket.io-client',
  socketServerImport: 'socket.io'
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

/**
 * Set to track all custom types used in function signatures
 */
const customTypesUsed = new Set<string>();

/**
 * Checks if a type is a built-in TypeScript type using a comprehensive approach
 * This is more robust than maintaining a hard-coded list and uses TypeScript's own knowledge
 */
function isBuiltInType(typeName: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  // Try to resolve the type from the source file
  try {
    const typeSymbol = checker.getSymbolAtLocation(
      ts.factory.createIdentifier(typeName)
    );

    // If we can't find the symbol, it might be a built-in type
    if (!typeSymbol) {
      return isKnownBuiltInType(typeName);
    }

    // Check if the symbol comes from a declaration file (lib.*.d.ts)
    const declarations = typeSymbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const firstDeclaration = declarations[0];
      const fileName = firstDeclaration.getSourceFile().fileName;

      // If it's from lib.*.d.ts files, it's a built-in type
      if (fileName.includes('lib.') && fileName.endsWith('.d.ts')) {
        return true;
      }
    }

    return isKnownBuiltInType(typeName);
  } catch {
    // If any error occurs, fall back to known built-in types
    return isKnownBuiltInType(typeName);
  }
}

/**
 * Checks against a curated list of known built-in types
 * This serves as a fallback when TypeScript API checks fail
 */
function isKnownBuiltInType(typeName: string): boolean {
  // Primitive types
  const primitiveTypes = new Set([
    'string', 'number', 'boolean', 'void', 'undefined', 'any', 'unknown',
    'object', 'null', 'never', 'bigint', 'symbol'
  ]);

  // Utility types from TypeScript
  const utilityTypes = new Set([
    'Record', 'Partial', 'Required', 'Pick', 'Omit', 'Exclude', 'Extract',
    'NonNullable', 'ReturnType', 'Parameters', 'ConstructorParameters',
    'InstanceType', 'ThisParameterType', 'OmitThisParameter', 'ThisType',
    'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize'
  ]);

  // Global objects and constructors
  const globalTypes = new Set([
    'Error', 'Promise', 'Array', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap',
    'WeakSet', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Object',
    'Function', 'Symbol', 'BigInt', 'ArrayBuffer', 'DataView', 'Int8Array',
    'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'
  ]);

  // Third-party library types that shouldn't be imported from our types file
  const libraryTypes = new Set(['Socket']);

  return primitiveTypes.has(typeName) || utilityTypes.has(typeName) ||
    globalTypes.has(typeName) || libraryTypes.has(typeName);
}

/**
 * Extracts and tracks custom types from a type string
 */
function trackCustomTypes(typeString: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): void {
  // Extract type names from complex type strings
  const typePattern = /\b[A-Z][a-zA-Z0-9]*\b/g;
  const matches = typeString.match(typePattern);

  if (matches) {
    for (const match of matches) {
      if (!isBuiltInType(match, checker, sourceFile)) {
        customTypesUsed.add(match);
      }
    }
  }
}

/**
 * Extracts function signatures from a TypeScript interface using AST parsing
 */
function extractFunctionSignatures(interfaceDeclaration: ts.InterfaceDeclaration, checker: ts.TypeChecker, sourceFile: ts.SourceFile): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];

  for (const member of interfaceDeclaration.members) {
    if (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) {
      if (!member.name || !ts.isIdentifier(member.name)) {
        continue;
      }

      const name = member.name.text;

      // Extract parameters from function type
      const params: FunctionParam[] = [];
      if (member.type.parameters) {
        for (const param of member.type.parameters) {
          if (ts.isParameter(param) && param.name && ts.isIdentifier(param.name)) {
            const paramName = param.name.text;
            const isOptional = !!param.questionToken;
            let typeString = 'any';

            if (param.type) {
              typeString = getTypeStringFromNode(param.type);
              trackCustomTypes(typeString, checker, sourceFile);
            }

            params.push({
              name: paramName,
              type: typeString,
              isOptional
            });
          }
        }
      }

      // Extract return type
      let returnTypeString = 'void';
      let isVoid = true;

      if (member.type.type) {
        returnTypeString = getTypeStringFromNode(member.type.type);
        isVoid = returnTypeString === 'void';
        if (!isVoid) {
          trackCustomTypes(returnTypeString, checker, sourceFile);
        }
      }

      signatures.push({
        name,
        params,
        returnType: returnTypeString,
        isVoid
      });
    }
  }

  return signatures;
}

/**
 * Converts a TypeScript type node to a string representation
 */
function getTypeStringFromNode(typeNode: ts.TypeNode): string {
  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    case ts.SyntaxKind.VoidKeyword:
      return 'void';
    case ts.SyntaxKind.UndefinedKeyword:
      return 'undefined';
    case ts.SyntaxKind.NullKeyword:
      return 'null';
    case ts.SyntaxKind.AnyKeyword:
      return 'any';
    case ts.SyntaxKind.UnknownKeyword:
      return 'unknown';
    case ts.SyntaxKind.NeverKeyword:
      return 'never';
    case ts.SyntaxKind.ObjectKeyword:
      return 'object';
    case ts.SyntaxKind.SymbolKeyword:
      return 'symbol';
    case ts.SyntaxKind.BigIntKeyword:
      return 'bigint';
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text;

    // Handle generic types with type arguments (e.g., Record<string, any>)
    if (typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const typeArgs = typeNode.typeArguments.map(getTypeStringFromNode).join(', ');
      return `${typeName}<${typeArgs}>`;
    }

    return typeName;
  }

  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.map(getTypeStringFromNode).join(' | ');
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.map(getTypeStringFromNode).join(' & ');
  }

  if (ts.isArrayTypeNode(typeNode)) {
    return getTypeStringFromNode(typeNode.elementType) + '[]';
  }

  if (ts.isTupleTypeNode(typeNode)) {
    const elements = typeNode.elements.map(getTypeStringFromNode).join(', ');
    return `[${elements}]`;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    // For object types, return a simplified representation
    const members = typeNode.members.map(member => {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        const propName = member.name.text;
        const propType = member.type ? getTypeStringFromNode(member.type) : 'any';
        const optional = member.questionToken ? '?' : '';
        return `${propName}${optional}: ${propType}`;
      }
      return '';
    }).filter(Boolean).join('; ');

    return `{ ${members} }`;
  }

  if (ts.isLiteralTypeNode(typeNode)) {
    if (ts.isStringLiteral(typeNode.literal)) {
      return `'${typeNode.literal.text}'`;
    }
    if (ts.isNumericLiteral(typeNode.literal)) {
      return typeNode.literal.text;
    }
    if (typeNode.literal.kind === ts.SyntaxKind.TrueKeyword) {
      return 'true';
    }
    if (typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) {
      return 'false';
    }
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return `(${getTypeStringFromNode(typeNode.type)})`;
  }

  if (ts.isFunctionTypeNode(typeNode)) {
    const params = typeNode.parameters.map(p => {
      const name = p.name && ts.isIdentifier(p.name) ? p.name.text : '_';
      const type = p.type ? getTypeStringFromNode(p.type) : 'any';
      return `${name}: ${type}`;
    }).join(', ');
    const returnType = typeNode.type ? getTypeStringFromNode(typeNode.type) : 'void';
    return `(${params}) => ${returnType}`;
  }

  // Fallback for complex types
  return 'any';
}

/**
 * Generates client function code with emit calls
 */
function generateClientFunction(func: FunctionSignature, config: Required<GeneratorConfig>): string {
  const paramsList = func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ');
  const argsParams = func.params.map(p => p.name).join(', ');

  const jsDoc = config.generateJSDoc ? `/**
 * ${func.name} - Auto-generated client function
 * CLIENT calls SERVER: Emits '${func.name}' event to server ${func.isVoid ? 'without' : 'with'} acknowledgment
 */
` : '';

  if (func.isVoid) {
    // For void functions, emit without acknowledgment
    return `${jsDoc}export function ${func.name}(socket: Socket${paramsList ? ', ' + paramsList : ''}): void {
  socket.emit('${func.name}'${func.params.length > 0 ? `, ${argsParams}` : ''});
}`;
  } else {
    // For non-void functions, emit with acknowledgment
    return `${jsDoc}export async function ${func.name}(socket: Socket${paramsList ? ', ' + paramsList : ''}, timeout: number = ${config.defaultTimeout}): Promise<${func.returnType}> {
  return socket.timeout(timeout).emitWithAck('${func.name}'${func.params.length > 0 ? `, ${argsParams}` : ', undefined'});
}`;
  }
}

/**
 * Generates server function code with emit calls
 */
function generateServerFunction(func: FunctionSignature, config: Required<GeneratorConfig>): string {
  const paramsList = func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ');
  const argsParams = func.params.map(p => p.name).join(', ');

  const jsDoc = config.generateJSDoc ? `/**
 * ${func.name} - Auto-generated server function
 * SERVER calls CLIENT: Emits '${func.name}' event to client ${func.isVoid ? 'without' : 'with'} acknowledgment
 */
` : '';

  if (func.isVoid) {
    // For void functions, emit without acknowledgment
    return `${jsDoc}export function ${func.name}(socket: Socket${paramsList ? ', ' + paramsList : ''}): void {
  socket.emit('${func.name}'${func.params.length > 0 ? `, ${argsParams}` : ''});
}`;
  } else {
    // For non-void functions, emit with acknowledgment
    return `${jsDoc}export async function ${func.name}(socket: Socket${paramsList ? ', ' + paramsList : ''}, timeout: number = ${config.defaultTimeout}): Promise<${func.returnType}> {
  return socket.timeout(timeout).emitWithAck('${func.name}'${func.params.length > 0 ? `, ${argsParams}` : ', undefined'});
}`;
  }
}

/**
 * Generates client handler function code for setting up event listeners
 */
function generateClientHandler(func: FunctionSignature, config: Required<GeneratorConfig>): string {
  if (!config.generateHandlers) return '';

  const paramsList = func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ');
  const handlerName = `handle${func.name.charAt(0).toUpperCase() + func.name.slice(1)}`;

  const jsDoc = config.generateJSDoc ? `/**
 * ${handlerName} - Auto-generated client handler
 * Sets up listener for '${func.name}' events from server${func.isVoid ? '' : ' with acknowledgment'}
 */
` : '';

  if (func.isVoid) {
    // For void functions, handler doesn't need to return anything
    return `${jsDoc}export function ${handlerName}(socket: Socket, handler: (${paramsList}) => void | Promise<void>): void {
  socket.on('${func.name}', handler);
}`;
  } else {
    // For non-void functions, handler must return the expected type
    return `${jsDoc}export function ${handlerName}(socket: Socket, handler: (${paramsList}) => ${func.returnType} | Promise<${func.returnType}>): void {
  socket.on('${func.name}', async (${func.params.map(p => p.name).join(', ')}${func.params.length > 0 ? ', ' : ''}callback) => {
    try {
      const result = await handler(${func.params.map(p => p.name).join(', ')});
      callback(result);
    } catch (error) {
      console.error('[${func.name}] Handler error:', error);
      callback({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}`;
  }
}

/**
 * Generates server handler function code for setting up event listeners
 */
function generateServerHandler(func: FunctionSignature, config: Required<GeneratorConfig>): string {
  if (!config.generateHandlers) return '';

  const paramsList = func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ');
  const handlerName = `handle${func.name.charAt(0).toUpperCase() + func.name.slice(1)}`;

  const jsDoc = config.generateJSDoc ? `/**
 * ${handlerName} - Auto-generated server handler  
 * Sets up listener for '${func.name}' events from client${func.isVoid ? '' : ' with acknowledgment'}
 */
` : '';

  if (func.isVoid) {
    // For void functions, handler doesn't need to return anything
    return `${jsDoc}export function ${handlerName}(socket: Socket, handler: (${paramsList}) => void | Promise<void>): void {
  socket.on('${func.name}', handler);
}`;
  } else {
    // For non-void functions, handler must return the expected type
    return `${jsDoc}export function ${handlerName}(socket: Socket, handler: (${paramsList}) => ${func.returnType} | Promise<${func.returnType}>): void {
  socket.on('${func.name}', async (${func.params.map(p => p.name).join(', ')}${func.params.length > 0 ? ', ' : ''}callback) => {
    try {
      const result = await handler(${func.params.map(p => p.name).join(', ')});
      callback(result);
    } catch (error) {
      console.error('[${func.name}] Handler error:', error);
      callback({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}`;
  }
}

/**
 * Main generator function that reads define.ts and generates client/server functions
 */
function generateRpcFunctions(userConfig?: GeneratorConfig): void {
  // Merge user config with defaults
  const config: Required<GeneratorConfig> = { ...DEFAULT_CONFIG, ...userConfig };

  // Reset custom types tracking for each generation
  customTypesUsed.clear();

  const typesFilePath = path.join(__dirname, config.inputPath);
  const clientFilePath = path.join(__dirname, config.clientOutputPath);
  const serverFilePath = path.join(__dirname, config.serverOutputPath);

  // Validate that define.ts exists
  if (!fs.existsSync(typesFilePath)) {
    console.error('❌ Error: Input file not found at', typesFilePath);
    console.error('💡 Please create a file with ClientFunctions and ServerFunctions interfaces');
    process.exit(1);
  }

  try {
    // Read and parse the define.ts file
    const sourceCode = fs.readFileSync(typesFilePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      'define.ts',
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    // Create a TypeScript program and type checker
    const program = ts.createProgram([typesFilePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true
    });

    // Check for compilation errors
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      console.error('❌ TypeScript compilation errors in define.ts:');
      diagnostics.forEach(diagnostic => {
        if (diagnostic.file) {
          const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
          console.error(`  Line ${line + 1}, Column ${character + 1}: ${message}`);
        } else {
          console.error(`  ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
        }
      });
      process.exit(1);
    }

    const checker = program.getTypeChecker();

    let clientFunctions: FunctionSignature[] = [];
    let serverFunctions: FunctionSignature[] = [];

    // Visit each node in the AST
    function visit(node: ts.Node) {
      if (ts.isInterfaceDeclaration(node)) {
        const interfaceName = node.name.text;

        if (interfaceName === 'ClientFunctions') {
          // ClientFunctions are called by server to client, so generate server functions
          serverFunctions = extractFunctionSignatures(node, checker, sourceFile);
        } else if (interfaceName === 'ServerFunctions') {
          // ServerFunctions are called by client to server, so generate client functions
          clientFunctions = extractFunctionSignatures(node, checker, sourceFile);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    // Generate client functions file
    const customTypeImports = customTypesUsed.size > 0
      ? `import type { ${Array.from(customTypesUsed).sort().join(', ')} } from './define';\n`
      : '';

    const clientImports = `import type { Socket } from '${config.socketClientImport}';
${customTypeImports}
/**
 * Auto-generated client functions from ${config.inputPath}
 * These functions allow CLIENT to call SERVER functions (ServerFunctions interface)
 * and set up handlers for CLIENT functions (ClientFunctions interface)
 */
`;

    const clientCallFunctions = clientFunctions.map(f => generateClientFunction(f, config)).join('\n\n');
    const clientHandlerFunctions = serverFunctions.map(f => generateClientHandler(f, config)).join('\n\n');

    const clientCode = clientImports +
      '\n// === CLIENT CALLING SERVER FUNCTIONS ===\n' +
      clientCallFunctions +
      '\n\n// === CLIENT HANDLER FUNCTIONS ===\n' +
      clientHandlerFunctions;

    fs.writeFileSync(clientFilePath, clientCode);

    // Generate server functions file  
    const serverImports = `import type { Socket } from '${config.socketServerImport}';
${customTypeImports}
/**
 * Auto-generated server functions from ${config.inputPath}
 * These functions allow SERVER to call CLIENT functions (ClientFunctions interface)
 * and set up handlers for SERVER functions (ServerFunctions interface)
 */
`;

    const serverCallFunctions = serverFunctions.map(f => generateServerFunction(f, config)).join('\n\n');
    const serverHandlerFunctions = clientFunctions.map(f => generateServerHandler(f, config)).join('\n\n');

    const serverCode = serverImports +
      '\n// === SERVER CALLING CLIENT FUNCTIONS ===\n' +
      serverCallFunctions +
      '\n\n// === SERVER HANDLER FUNCTIONS ===\n' +
      serverHandlerFunctions;

    fs.writeFileSync(serverFilePath, serverCode);

    console.log('✅ Generated RPC functions:');
    console.log(`📄 Client functions: ${clientFilePath} (${clientFunctions.length} call functions, ${serverFunctions.length} handler functions)`);
    console.log(`📄 Server functions: ${serverFilePath} (${serverFunctions.length} call functions, ${clientFunctions.length} handler functions)`);

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
  } catch (error) {
    console.error('❌ Error generating RPC functions:', error);
    process.exit(1);
  }
}

/**
 * Watches the input file for changes and regenerates on modification
 */
function watchMode(config?: GeneratorConfig): void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const inputPath = path.join(__dirname, mergedConfig.inputPath);

  console.log(`👀 Watching ${inputPath} for changes...`);

  // Initial generation
  generateRpcFunctions(config);

  // Watch for changes
  fs.watchFile(inputPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
      console.log(`\n🔄 ${mergedConfig.inputPath} changed, regenerating...`);
      try {
        generateRpcFunctions(config);
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
  const args = process.argv.slice(2);
  const watchFlag = args.includes('--watch') || args.includes('-w');

  if (watchFlag) {
    watchMode();
  } else {
    generateRpcFunctions();
  }
}