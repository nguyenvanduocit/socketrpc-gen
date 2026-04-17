import * as path from "path";
import {
  InterfaceDeclaration,
  Project,
  PropertySignature,
  SourceFile,
  SyntaxKind,
  Type,
} from "ts-morph";
import type { FunctionParam, FunctionSignature } from "./types";

function isValidJavaScriptIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

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

    const baseTypes = iface.getBaseTypes();
    baseTypes.forEach((baseType) => {
      const symbol = baseType.getSymbol();
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      declarations.forEach((decl) => {
        if (decl.getKindName() === "InterfaceDeclaration") {
          const baseInterface = decl as InterfaceDeclaration;
          baseInterfaces.push(baseInterface);
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
  property: PropertySignature,
  processedNames: Set<string>,
): FunctionSignature | null {
  const typeNode = property.getTypeNode();
  const name = property.getName();

  // Skip if already processed (derived class overrides base)
  if (processedNames.has(name)) return null;

  if (!typeNode || typeNode.getKind() !== SyntaxKind.FunctionType) return null;

  if (!isValidJavaScriptIdentifier(name)) {
    console.error(`Warning: Skipping function '${name}' - not a valid JavaScript identifier`);
    return null;
  }

  const callSignatures = property.getType().getCallSignatures();
  const signature = callSignatures[0];
  if (!signature) return null;

  const params: FunctionParam[] = signature.getParameters().map((param) => {
    const paramType = param.getTypeAtLocation(property);
    return {
      name: param.getName(),
      type: paramType.getText(property),
      isOptional: param.isOptional(),
    };
  });

  const returnType = signature.getReturnType();
  const returnTypeString = returnType.getText(property);

  return {
    name,
    params,
    returnType: returnTypeString,
    isVoid: returnTypeString === "void",
  };
}

/**
 * Returns an interface plus its transitive base interfaces, in walk order
 * (bases first, then the derived interface).
 */
function getInterfaceChain(iface: InterfaceDeclaration): InterfaceDeclaration[] {
  return [...getAllBaseInterfaces(iface), iface];
}

/**
 * Extracts function signatures from a TypeScript interface using ts-morph.
 * Walks the entire inheritance chain so extended interfaces' methods are included.
 */
function extractFunctionSignatures(
  interfaceDeclaration: InterfaceDeclaration,
): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const processedNames = new Set<string>();

  for (const iface of getInterfaceChain(interfaceDeclaration)) {
    for (const property of iface.getProperties()) {
      const extracted = extractSignatureFromProperty(property, processedNames);
      if (extracted) {
        signatures.push(extracted);
        processedNames.add(extracted.name);
      }
    }
  }

  return signatures;
}

/**
 * Walks a ts-morph Type and records any referenced named symbols whose declaring
 * source file is part of the user's codebase (not node_modules, not ambient lib).
 */
function collectReferencedSymbols(
  type: Type,
  out: Map<string, SourceFile>,
  visited: Set<Type>,
): void {
  if (visited.has(type)) return;
  visited.add(type);

  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol) {
    const name = symbol.getName();
    const isAnonymous = !name || name === "__type" || name === "__object";
    if (!isAnonymous && !out.has(name)) {
      for (const decl of symbol.getDeclarations()) {
        const sf = decl.getSourceFile();
        if (!sf.isInNodeModules() && !sf.isDeclarationFile()) {
          out.set(name, sf);
          break;
        }
      }
    }
  }

  if (type.isUnion()) {
    type.getUnionTypes().forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  if (type.isIntersection()) {
    type.getIntersectionTypes().forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  if (type.isArray()) {
    const elem = type.getArrayElementType();
    if (elem) collectReferencedSymbols(elem, out, visited);
  }
  if (type.isTuple()) {
    type.getTupleElements().forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  type.getTypeArguments().forEach((t) => collectReferencedSymbols(t, out, visited));

  // Walk anonymous object shapes so nested named types are discovered.
  // Named object types' imports cover their own structure at the declaration site.
  if (!symbol) {
    for (const prop of type.getProperties()) {
      const propDecl = prop.getDeclarations()[0];
      if (propDecl) {
        collectReferencedSymbols(prop.getTypeAtLocation(propDecl), out, visited);
      }
    }
  }
}

/**
 * Walks every function-property type in an interface chain and accumulates the
 * map of named types referenced by those signatures.
 */
function collectUsedTypes(
  interfaceDeclaration: InterfaceDeclaration,
  out: Map<string, SourceFile>,
): void {
  const visited = new Set<Type>();

  for (const iface of getInterfaceChain(interfaceDeclaration)) {
    for (const property of iface.getProperties()) {
      const typeNode = property.getTypeNode();
      if (!typeNode || typeNode.getKind() !== SyntaxKind.FunctionType) continue;

      const signature = property.getType().getCallSignatures()[0];
      if (!signature) continue;

      for (const param of signature.getParameters()) {
        collectReferencedSymbols(param.getTypeAtLocation(property), out, visited);
      }
      collectReferencedSymbols(signature.getReturnType(), out, visited);
    }
  }
}

const PROJECT_TSCONFIG_PATH = path.resolve(import.meta.dir, "..", "tsconfig.json");

/**
 * Extracts interfaces and function signatures from the input file.
 * Also returns the map of every user-declared type referenced by those signatures,
 * so emission can add matching type-only imports.
 */
export async function extractInterfacesFromFile(inputPath: string): Promise<{
  clientFunctions: FunctionSignature[];
  serverFunctions: FunctionSignature[];
  usedTypes: Map<string, SourceFile>;
  inputFile: SourceFile;
}> {
  const inputProject = new Project({
    tsConfigFilePath: PROJECT_TSCONFIG_PATH,
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFile = inputProject.addSourceFileAtPath(inputPath);

  // Resolve all dependencies (imported files) so extended interfaces are available
  sourceFile.getReferencedSourceFiles().forEach((referencedFile) => {
    inputProject.addSourceFileAtPath(referencedFile.getFilePath());
  });

  const clientFunctionsInterface = sourceFile.getInterface("ClientFunctions");
  const serverFunctionsInterface = sourceFile.getInterface("ServerFunctions");

  if (!clientFunctionsInterface || !serverFunctionsInterface) {
    throw new Error(
      `Could not find ClientFunctions or ServerFunctions interfaces in ${inputPath}.`,
    );
  }

  const clientFunctions = extractFunctionSignatures(serverFunctionsInterface);
  const serverFunctions = extractFunctionSignatures(clientFunctionsInterface);

  // Walk every signature's types and collect every user-declared type they reference.
  // Order matters: server interface is walked first so that types appearing on
  // server-facing methods (which tend to be called first in generated client code)
  // are listed earliest in each import group.
  const usedTypes = new Map<string, SourceFile>();
  collectUsedTypes(serverFunctionsInterface, usedTypes);
  collectUsedTypes(clientFunctionsInterface, usedTypes);

  return { clientFunctions, serverFunctions, usedTypes, inputFile: sourceFile };
}
