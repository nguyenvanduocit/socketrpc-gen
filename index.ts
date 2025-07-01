#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';
import {
  Project,
  InterfaceDeclaration,
  PropertySignature,
  SyntaxKind,
  TypeNode,
  Type,
  SourceFile,
  FunctionDeclaration,
  Writers,
  StructureKind
} from 'ts-morph';
import type {
  ParameterDeclaration,
  JSDocStructure,
  OptionalKind,
  FunctionDeclarationStructure,
  ImportDeclarationStructure,
  StatementStructures,
  ParameterDeclarationStructure,
  JSDocTagStructure
} from 'ts-morph';
import { Command } from 'commander';

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
}

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

/**
 * Creates a new file types.ts for custom types.
 * @param project The ts-morph project instance.
 * @param outputDir The output directory.
 */
function generateTypesFile(project: Project, outputDir: string): void {
  const typesFile = project.createSourceFile(
    path.join(outputDir, 'types.generated.ts'),
    '',
    { overwrite: true }
  );

  typesFile.insertText(0, `/**
 * Auto-generated types for the RPC package
 */

`);

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

/**
 * Creates function parameters structure for ts-morph
 */
function createFunctionParameters(
  func: FunctionSignature,
  includeSocket: boolean = true,
  includeTimeout: boolean = false,
  config?: Required<GeneratorConfig>
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
 * Generates client function using ts-morph AST
 */
function generateClientFunctionAST(
  func: FunctionSignature,
  config: Required<GeneratorConfig>
): FunctionDeclarationStructure {
  const params = createFunctionParameters(func, true, !func.isVoid, config);

  // Create function body based on whether it's void or not
  const bodyWriter = (writer: any) => {
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
        writer.writeLine(`return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };`);
      });
      writer.writeLine(`}`);
    }
  };

  const description = `CLIENT calls SERVER: Emits '${func.name}' event to server ${func.isVoid ? 'without' : 'with'
    } acknowledgment. Includes built-in error handling.`;
  const returnType = func.isVoid
    ? null
    : {
      type: `Promise<${func.returnType} | RpcError>`,
      description: 'A promise that resolves with the result from the server, or an RpcError if one occurred.'
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

/**
 * Generates server function using ts-morph AST
 */
function generateServerFunctionAST(
  func: FunctionSignature,
  config: Required<GeneratorConfig>
): FunctionDeclarationStructure {
  const params = createFunctionParameters(func, true, !func.isVoid, config);

  // Create function body based on whether it's void or not
  const bodyWriter = (writer: any) => {
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
        writer.writeLine(`return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };`);
      });
      writer.writeLine(`}`);
    }
  };

  const description = `SERVER calls CLIENT: Emits '${func.name}' event to client ${func.isVoid ? 'without' : 'with'
    } acknowledgment. Includes built-in error handling.`;
  const returnType = func.isVoid
    ? null
    : {
      type: `Promise<${func.returnType} | RpcError>`,
      description: 'A promise that resolves with the result from the client, or an RpcError if one occurred.'
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

/**
 * Generates client handler function using ts-morph AST
 */
function generateClientHandlerAST(
  func: FunctionSignature,
  config: Required<GeneratorConfig>
): FunctionDeclarationStructure | null {

  const handlerName = `handle${func.name.charAt(0).toUpperCase() + func.name.slice(1)}`;
  const handlerParamType = func.params.length > 0
    ? `(${func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ')}) => ${func.isVoid ? 'Promise<void>' : `Promise<${func.returnType} | RpcError>`}`
    : `() => ${func.isVoid ? 'Promise<void>' : `Promise<${func.returnType} | RpcError>`}`;

  const bodyWriter = (writer: any) => {
    const paramNames = func.params.map(p => p.name);
    const callbackParam = paramNames.length > 0 ? ', callback' : 'callback';
    const handlerArgs = paramNames.join(', ');

    writer.writeLine(`socket.on('${func.name}', async (${paramNames.join(', ')}${callbackParam}) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        if (func.isVoid) {
          writer.writeLine(`await handler(${handlerArgs});`);
        } else {
          writer.writeLine(`const result = await handler(${handlerArgs});`);
          writer.writeLine('callback(result);');
        }
      });
      writer.writeLine('} catch (error) {');
      writer.indent(() => {
        writer.writeLine(`console.error('[${func.name}] Handler error:', error);`);
        // emit the error to the client
        writer.writeLine(`socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);`);
        if (!func.isVoid) {
          writer.writeLine("callback({ message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);");
        }
      });
      writer.writeLine('}');
    });
    writer.writeLine('});');
  };

  const params: OptionalKind<ParameterDeclarationStructure>[] = [
    { name: 'socket', type: 'Socket' },
    { name: 'handler', type: handlerParamType }
  ];
  const description = `Sets up listener for '${func.name}' events from server${func.isVoid ? '' : ' with acknowledgment'
    }`;

  return {
    kind: StructureKind.Function,
    name: handlerName,
    isExported: true,
    parameters: params,
    returnType: 'void',
    statements: bodyWriter,
    docs: [createJSDoc(description, params, null)]
  };
}

/**
 * Generates server handler function using ts-morph AST
 */
function generateServerHandlerAST(
  func: FunctionSignature,
  config: Required<GeneratorConfig>
): FunctionDeclarationStructure | null {

  const handlerName = `handle${func.name.charAt(0).toUpperCase() + func.name.slice(1)}`;
  const handlerParamType = func.params.length > 0
    ? `(${func.params.map(p => `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`).join(', ')}) => ${func.isVoid ? 'Promise<void>' : `Promise<${func.returnType} | RpcError>`}`
    : `() => ${func.isVoid ? 'Promise<void>' : `Promise<${func.returnType} | RpcError>`}`;

  const bodyWriter = (writer: any) => {
    const paramNames = func.params.map(p => p.name);
    const callbackParam = paramNames.length > 0 ? ', callback' : 'callback';
    const handlerArgs = paramNames.join(', ');

    writer.writeLine(`socket.on('${func.name}', async (${paramNames.join(', ')}${callbackParam}) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        if (func.isVoid) {
          writer.writeLine(`await handler(${handlerArgs});`);
        } else {
          writer.writeLine(`const result = await handler(${handlerArgs});`);
          writer.writeLine('callback(result);');
        }
      });
      writer.writeLine('} catch (error) {');
      writer.indent(() => {
        writer.writeLine(`console.error('[${func.name}] Handler error:', error);`);
        // emit the error to the client
        writer.writeLine(`socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);`);
        if (!func.isVoid) {
          writer.writeLine("callback({ message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);");
        }
      });
      writer.writeLine('}');
    });
    writer.writeLine('});');
  };

  const params: OptionalKind<ParameterDeclarationStructure>[] = [
    { name: 'socket', type: 'Socket' },
    { name: 'handler', type: handlerParamType }
  ];
  const description = `Sets up listener for '${func.name}' events from client${func.isVoid ? '' : ' with acknowledgment'
    }`;

  return {
    kind: StructureKind.Function,
    name: handlerName,
    isExported: true,
    parameters: params,
    returnType: 'void',
    statements: bodyWriter,
    docs: [createJSDoc(description, params, null)]
  };
}

/**
 * Generates handleRpcError function using ts-morph AST with async/await and try-catch
 */
function generateRpcErrorHandlerAST(): FunctionDeclarationStructure {
  const bodyWriter = (writer: any) => {
    writer.writeLine(`socket.on('rpcError', async (error: RpcError) => {`);
    writer.indent(() => {
      writer.writeLine('try {');
      writer.indent(() => {
        writer.writeLine('await handler(error);');
      });
      writer.writeLine('} catch (handlerError) {');
      writer.indent(() => {
        writer.writeLine(`console.error('[handleRpcError] Error in RPC error handler:', handlerError);`);
      });
      writer.writeLine('}');
    });
    writer.writeLine('});');
  };

  const params: OptionalKind<ParameterDeclarationStructure>[] = [
    { name: 'socket', type: 'Socket' },
    { name: 'handler', type: '(error: RpcError) => Promise<void>' }
  ];

  const description = `Sets up listener for 'rpcError' events with async/await and try-catch. This handler is called whenever an RPC error occurs during function execution.`;

  return {
    kind: StructureKind.Function,
    name: 'handleRpcError',
    isExported: true,
    parameters: params,
    returnType: 'void',
    statements: bodyWriter,
    docs: [createJSDoc(description, params, null)]
  };
}

/**
 * Generates client.ts file using ts-morph
 */
function generateClientFile(
  project: Project,
  outputDir: string,
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  config: Required<GeneratorConfig>
): void {
  const clientFile = project.createSourceFile(
    path.join(outputDir, 'client.generated.ts'),
    '',
    { overwrite: true }
  );

  // Add imports
  clientFile.addImportDeclaration({
    moduleSpecifier: 'socket.io-client',
    namedImports: ['Socket'],
    isTypeOnly: true
  });

  // Always add RpcError import since we generate handleRpcError by default
  clientFile.addImportDeclaration({
    moduleSpecifier: './types.generated',
    namedImports: ['RpcError'],
    isTypeOnly: true
  });

  // Add file header comment
  clientFile.insertText(0, `/**
 * Auto-generated client functions from define.ts
 * These functions allow CLIENT to call SERVER functions (ServerFunctions interface)
 * and set up handlers for CLIENT functions (ClientFunctions interface)
 */

`);

  // Add section comment for client calling server functions
  clientFile.addStatements('\n// === CLIENT CALLING SERVER FUNCTIONS ===');

  // Add client call functions
  clientFunctions.forEach(func => {
    const functionStructure = generateClientFunctionAST(func, config);
    clientFile.addFunction(functionStructure);
  });

  // Add section comment for client handler functions
  clientFile.addStatements('\n// === CLIENT HANDLER FUNCTIONS ===');

  // Add client handler functions
  serverFunctions.forEach(func => {
    const handlerStructure = generateClientHandlerAST(func, config);
    if (handlerStructure) {
      clientFile.addFunction(handlerStructure);
    }
  });

  // Add handleRpcError function
  const rpcErrorHandlerStructure = generateRpcErrorHandlerAST();
  clientFile.addFunction(rpcErrorHandlerStructure);

  // Format and save
  clientFile.formatText();
  clientFile.fixMissingImports();
}

/**
 * Generates server.ts file using ts-morph
 */
function generateServerFile(
  project: Project,
  outputDir: string,
  clientFunctions: FunctionSignature[],
  serverFunctions: FunctionSignature[],
  config: Required<GeneratorConfig>
): void {
  const serverFile = project.createSourceFile(
    path.join(outputDir, 'server.generated.ts'),
    '',
    { overwrite: true }
  );

  // Add imports
  serverFile.addImportDeclaration({
    moduleSpecifier: 'socket.io',
    namedImports: ['Socket'],
    isTypeOnly: true
  });

  // Always add RpcError import since we generate handleRpcError by default
  serverFile.addImportDeclaration({
    moduleSpecifier: './types.generated',
    namedImports: ['RpcError'],
    isTypeOnly: true
  });

  // Add file header comment
  serverFile.insertText(0, `/**
 * Auto-generated server functions from define.ts
 * These functions allow SERVER to call CLIENT functions (ClientFunctions interface)
 * and set up handlers for SERVER functions (ServerFunctions interface)
 */

`);

  // Add section comment for server calling client functions
  serverFile.addStatements('\n// === SERVER CALLING CLIENT FUNCTIONS ===');

  // Add server call functions
  serverFunctions.forEach(func => {
    const functionStructure = generateServerFunctionAST(func, config);
    serverFile.addFunction(functionStructure);
  });

  // Add section comment for server handler functions
  serverFile.addStatements('\n// === SERVER HANDLER FUNCTIONS ===');

  // Add server handler functions
  clientFunctions.forEach(func => {
    const handlerStructure = generateServerHandlerAST(func, config);
    if (handlerStructure) {
      serverFile.addFunction(handlerStructure);
    }
  });

  // Add handleRpcError function
  const rpcErrorHandlerStructure = generateRpcErrorHandlerAST();
  serverFile.addFunction(rpcErrorHandlerStructure);

  // Format and save
  serverFile.formatText();
  serverFile.fixMissingImports();
}

/**
 * Generates the index.ts file using ts-morph
 */
function generateIndexFile(project: Project, outputDir: string, config: Required<GeneratorConfig>): void {
  const indexFile = project.createSourceFile(
    path.join(outputDir, 'index.ts'),
    '',
    { overwrite: true }
  );

  // Add file header comment
  indexFile.insertText(0, `/**
 * @${config.packageName}
 * Auto-generated RPC package for Socket.IO
 */

`);

  // Add export statements
  indexFile.addExportDeclarations([
    { moduleSpecifier: './define' },
    { moduleSpecifier: './client.generated' },
    { moduleSpecifier: './server.generated' },
    { moduleSpecifier: './types.generated' }
  ]);

  // Format and save
  indexFile.formatText();
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
 * Main generator function that reads define.ts and generates the entire RPC package using ts-morph
 */
async function generateRpcPackage(userConfig: GeneratorConfig): Promise<void> {
  // Merge user config with defaults
  const config: Required<GeneratorConfig> = {
    defaultTimeout: 5000,
    ...userConfig
  };

  const { inputPath, outputDir } = config;

  // Validate that input file exists
  if (!fs.existsSync(inputPath)) {
    console.error('❌ Error: Input file not found at', inputPath);
    console.error('💡 Please create a file with ClientFunctions and ServerFunctions interfaces');
    process.exit(1);
  }

  try {
    // Create a new ts-morph project for reading input
    const inputProject = new Project({
      tsConfigFilePath: path.join(__dirname, 'tsconfig.json'),
      skipAddingFilesFromTsConfig: true
    });

    // Add the input file to the project
    const sourceFile = inputProject.addSourceFileAtPath(inputPath);

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

    // Create a new ts-morph project for generating output files
    const outputProject = new Project({
      useInMemoryFileSystem: false,
      tsConfigFilePath: path.join(outputDir, 'tsconfig.json'),
      compilerOptions: {
        outDir: path.join(outputDir, 'dist'),
        rootDir: outputDir
      }
    });

    // Generate files using ts-morph
    generateTypesFile(outputProject, outputDir);
    generateClientFile(outputProject, outputDir, clientFunctions, serverFunctions, config);
    generateServerFile(outputProject, outputDir, clientFunctions, serverFunctions, config);
    generateIndexFile(outputProject, outputDir, config);

    // Save all generated files
    await outputProject.save();

    console.log('✅ Generated RPC package successfully using ts-morph AST!');
    console.log(`📦 Package location: ${outputDir}`);
    console.log(`📄 Generated files:`);
    console.log(`   - client.generated.ts (${clientFunctions.length} call functions, ${serverFunctions.length} handler functions)`);
    console.log(`   - server.generated.ts (${serverFunctions.length} call functions, ${clientFunctions.length} handler functions)`);
    console.log(`   - types.generated.ts`);
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
  } catch (error) {
    console.error('❌ Error generating RPC package:', error);
    process.exit(1);
  }
}

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
  const program = new Command();

  program
    .name("socketrpc-gen")
    .description("Generate Socket.IO RPC code from interface definitions.")
    .version("1.0.0");

  // Display the current version when the program starts
  console.log(`🚀 socketrpc-gen v${program.version()}`);

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
      };

      if (options.watch) {
        watchMode(config).catch(console.error);
      } else {
        generateRpcPackage(config).catch(console.error);
      }
    });

  program.parse(process.argv);
}