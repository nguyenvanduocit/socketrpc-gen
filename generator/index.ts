import * as fs from 'fs';
import * as path from 'path';
import { Project, InterfaceDeclaration, PropertySignature, SyntaxKind, TypeNode, Type } from 'ts-morph';

/**
 * Configuration options for the RPC generator
 */
interface GeneratorConfig {
  /** Path to the input TypeScript file containing interface definitions */
  inputPath?: string;
  /** Output directory for generated RPC package */
  outputDir?: string;
  /** Package name for the generated RPC package */
  packageName?: string;
  /** Default timeout for RPC calls in milliseconds */
  defaultTimeout?: number;
  /** Whether to generate JSDoc comments */
  generateJSDoc?: boolean;
  /** Whether to generate handler functions */
  generateHandlers?: boolean;
  /** Socket.io client import path */
  socketClientImport?: string;
  /** Socket.io server import path */
  socketServerImport?: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<GeneratorConfig> = {
  inputPath: '../pkg/rpc/define.ts',
  outputDir: '../pkg/rpc',
  packageName: '@socket-rpc/rpc',
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
 * Checks if a type is a built-in TypeScript type
 */
function isBuiltInType(typeName: string): boolean {
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
 * Cleans up type strings by removing import paths
 */
function cleanTypeString(typeString: string): string {
  // Remove import("..."). prefix from types
  return typeString.replace(/import\("[^"]+"\)\./g, '');
}

/**
 * Extracts and tracks custom types from a type string
 */
function trackCustomTypes(typeString: string): void {
  // Extract type names from complex type strings
  const typePattern = /\b[A-Z][a-zA-Z0-9]*\b/g;
  const matches = typeString.match(typePattern);

  if (matches) {
    for (const match of matches) {
      if (!isBuiltInType(match)) {
        customTypesUsed.add(match);
      }
    }
  }
}

/**
 * Extracts function signatures from a TypeScript interface using ts-morph
 */
function extractFunctionSignatures(interfaceDeclaration: InterfaceDeclaration): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];

  interfaceDeclaration.getProperties().forEach(property => {
    const typeNode = property.getTypeNode();

    if (typeNode && typeNode.getKind() === SyntaxKind.FunctionType) {
      const name = property.getName();
      const functionType = property.getType();
      const callSignatures = functionType.getCallSignatures();

      if (callSignatures.length > 0) {
        const signature = callSignatures[0];
        if (!signature) return;

        // Extract parameters
        const params: FunctionParam[] = signature.getParameters().map(param => {
          const paramType = param.getTypeAtLocation(property);
          let typeString = paramType.getText();

          // Clean up import paths in type strings
          typeString = cleanTypeString(typeString);
          trackCustomTypes(typeString);

          return {
            name: param.getName(),
            type: typeString,
            isOptional: param.isOptional()
          };
        });

        // Extract return type
        const returnType = signature.getReturnType();
        let returnTypeString = returnType.getText();
        returnTypeString = cleanTypeString(returnTypeString);
        const isVoid = returnTypeString === 'void';

        if (!isVoid) {
          trackCustomTypes(returnTypeString);
        }

        signatures.push({
          name,
          params,
          returnType: returnTypeString,
          isVoid
        });
      }
    }
  });

  return signatures;
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
 * Generates the index.ts file that exports all modules
 */
function generateIndexFile(config: Required<GeneratorConfig>): string {
  return `/**
 * @${config.packageName}
 * Auto-generated RPC package for Socket.IO
 */

// Export type definitions
export * from './define';

// Export client functions and handlers
export * from './client';

// Export server functions and handlers  
export * from './server';
`;
}

/**
 * Generates package.json for the RPC package
 */
function generatePackageJson(config: Required<GeneratorConfig>): object {
  return {
    name: config.packageName,
    version: "1.0.0",
    description: "Auto-generated RPC package for Socket.IO",
    main: "index.ts",
    module: "index.ts",
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

/**
 * Main generator function that reads define.ts and generates the entire RPC package
 */
function generateRpcPackage(userConfig?: GeneratorConfig): void {
  // Merge user config with defaults
  const config: Required<GeneratorConfig> = { ...DEFAULT_CONFIG, ...userConfig };

  // Reset custom types tracking for each generation
  customTypesUsed.clear();

  const inputPath = path.resolve(__dirname, config.inputPath);
  const outputDir = path.resolve(__dirname, config.outputDir);

  // Validate that input file exists
  if (!fs.existsSync(inputPath)) {
    console.error('❌ Error: Input file not found at', inputPath);
    console.error('💡 Please create a file with ClientFunctions and ServerFunctions interfaces');
    process.exit(1);
  }

  try {
    // Create a new ts-morph project
    const project = new Project({
      tsConfigFilePath: path.join(__dirname, 'tsconfig.json'),
      skipAddingFilesFromTsConfig: true
    });

    // Add the input file to the project
    const sourceFile = project.addSourceFileAtPath(inputPath);

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

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate client.ts
    const customTypeImports = customTypesUsed.size > 0
      ? `import type { ${Array.from(customTypesUsed).sort().join(', ')} } from './define';\n`
      : '';

    const clientImports = `import type { Socket } from '${config.socketClientImport}';
${customTypeImports}
/**
 * Auto-generated client functions from define.ts
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

    fs.writeFileSync(path.join(outputDir, 'client.ts'), clientCode);

    // Generate server.ts
    const serverImports = `import type { Socket } from '${config.socketServerImport}';
${customTypeImports}
/**
 * Auto-generated server functions from define.ts
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

    fs.writeFileSync(path.join(outputDir, 'server.ts'), serverCode);

    // Generate index.ts
    const indexCode = generateIndexFile(config);
    fs.writeFileSync(path.join(outputDir, 'index.ts'), indexCode);

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

    console.log('✅ Generated RPC package successfully!');
    console.log(`📦 Package location: ${outputDir}`);
    console.log(`📄 Generated files:`);
    console.log(`   - client.ts (${clientFunctions.length} call functions, ${serverFunctions.length} handler functions)`);
    console.log(`   - server.ts (${serverFunctions.length} call functions, ${clientFunctions.length} handler functions)`);
    console.log(`   - index.ts`);

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

    if (config.generateHandlers) {
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
    }
  } catch (error) {
    console.error('❌ Error generating RPC package:', error);
    process.exit(1);
  }
}

/**
 * Watches the input file for changes and regenerates on modification
 */
function watchMode(config?: GeneratorConfig): void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const inputPath = path.resolve(__dirname, mergedConfig.inputPath);

  console.log(`👀 Watching ${inputPath} for changes...`);

  // Initial generation
  generateRpcPackage(config);

  // Watch for changes
  fs.watchFile(inputPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
      console.log(`\n🔄 ${path.basename(inputPath)} changed, regenerating...`);
      try {
        generateRpcPackage(config);
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
    generateRpcPackage();
  }
}

// Export for programmatic use
export { generateRpcPackage, watchMode };
export type { GeneratorConfig };