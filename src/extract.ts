import * as path from "path";
import {
  InterfaceDeclaration,
  Node,
  Project,
  PropertySignature,
  SourceFile,
  Symbol as MorphSymbol,
  SyntaxKind,
  Type,
} from "ts-morph";
import {
  RPC_SCHEMA_VERSION,
  SchemaExtractionError,
  nullableType,
  optionalType,
  type ObjectField,
  type RpcDirection,
  type RpcMethod,
  type RpcSchema,
  type SchemaDiagnostic,
  type TypeDeclaration,
  type TypeRef,
} from "./schema";
import type { FunctionParam, FunctionSignature } from "./types";

function isValidJavaScriptIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

// Names that would collide with the generated RpcClient/RpcServer surface.
// If a user defines one of these on ClientFunctions/ServerFunctions, refuse.
const RESERVED_NAMES = new Set([
  "rpcError",
  "dispose",
  "disposed",
  "handle",
  "server",
  "client",
  "socket",
  "connected",
  "onConnect",
  "onDisconnect",
  "onReconnect",
]);

/**
 * Recursively collects all base interfaces from an interface, including those from imported files
 */
function getAllBaseInterfaces(
  interfaceDeclaration: InterfaceDeclaration,
): InterfaceDeclaration[] {
  const baseInterfaces: InterfaceDeclaration[] = [];
  const visited = new Set<string>();

  function collectBases(iface: InterfaceDeclaration): void {
    const key = `${iface.getSourceFile().getFilePath()}:${iface.getStart()}`;
    if (visited.has(key)) return;
    visited.add(key);

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

interface ParsedMethod {
  method: RpcMethod;
  /** Exact ts-morph text retained only for the existing TypeScript emitters. */
  compatibilitySignature: FunctionSignature;
}

interface PendingNamedType {
  key: string;
  name: string;
  symbol: MorphSymbol;
  location: Node;
}

interface SchemaParseContext {
  diagnostics: SchemaDiagnostic[];
  namedTypes: Map<string, PendingNamedType>;
  namedTypeQueue: string[];
}

function symbolKey(symbol: MorphSymbol): string {
  const declaration = symbol.getDeclarations()[0];
  if (!declaration) return symbol.getFullyQualifiedName();
  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
}

function isAnonymousSymbol(symbol: MorphSymbol | undefined): boolean {
  const name = symbol?.getName();
  return !name || name === "__type" || name === "__object";
}

function getPortableNamedSymbol(
  type: Type,
  ignoredSymbolKey?: string,
): MorphSymbol | undefined {
  const candidates = [type.getAliasSymbol(), type.getSymbol()];
  for (const symbol of candidates) {
    if (isAnonymousSymbol(symbol)) continue;
    if (ignoredSymbolKey && symbolKey(symbol!) === ignoredSymbolKey) continue;
    return symbol;
  }
  return undefined;
}

function isUserDeclaredSymbol(symbol: MorphSymbol): boolean {
  return symbol.getDeclarations().some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !sourceFile.isInNodeModules() && !sourceFile.isDeclarationFile();
  });
}

function registerNamedType(
  symbol: MorphSymbol,
  name: string,
  location: Node,
  context: SchemaParseContext,
  diagnosticPath: string,
): void {
  if (!isUserDeclaredSymbol(symbol)) return;

  const key = symbolKey(symbol);
  const existing = context.namedTypes.get(name);
  if (existing && existing.key !== key) {
    addDiagnostic(
      context,
      "DUPLICATE_TYPE_NAME",
      `Two referenced declarations are both named '${name}'. Portable schemas require globally unique type names.`,
      name,
      location,
      diagnosticPath,
    );
    return;
  }
  if (existing) return;

  context.namedTypes.set(name, { key, name, symbol, location });
  context.namedTypeQueue.push(name);
}

function typeText(type: Type, location: Node): string {
  try {
    return type.getText(location);
  } catch {
    return type.getText();
  }
}

function addDiagnostic(
  context: SchemaParseContext,
  code: string,
  message: string,
  unsupportedTypeText: string,
  location: Node,
  diagnosticPath: string,
): void {
  const sourceFile = location.getSourceFile();
  const position = sourceFile.getLineAndColumnAtPos(location.getStart());
  context.diagnostics.push({
    code,
    message,
    typeText: unsupportedTypeText,
    location: {
      file: sourceFile.getFilePath(),
      line: position.line,
      column: position.column,
      path: diagnosticPath,
    },
  });
}

function unsupportedType(
  context: SchemaParseContext,
  code: string,
  message: string,
  type: Type,
  location: Node,
  diagnosticPath: string,
): TypeRef {
  const text = typeText(type, location);
  addDiagnostic(context, code, message, text, location, diagnosticPath);

  // Parsing continues so callers receive all useful diagnostics in one pass.
  // The sentinel can never escape because extractRpcSchemaFromFile throws below.
  return { kind: "named", name: `__unsupported_${context.diagnostics.length}` };
}

function parseUnionType(
  type: Type,
  location: Node,
  context: SchemaParseContext,
  diagnosticPath: string,
): TypeRef {
  const members = type.getUnionTypes();
  const hasUndefined = members.some((member) => member.isUndefined());
  const hasNull = members.some((member) => member.isNull());
  const valueMembers = members.filter(
    (member) => !member.isUndefined() && !member.isNull(),
  );

  let ref: TypeRef;
  if (valueMembers.length === 0) {
    if (hasNull && !hasUndefined) return { kind: "null" };
    return unsupportedType(
      context,
      "UNSUPPORTED_UNDEFINED_TYPE",
      "A standalone undefined type cannot be represented on the wire.",
      type,
      location,
      diagnosticPath,
    );
  }

  const enumValues = stringEnumValuesFromMembers(valueMembers);
  if (enumValues) {
    ref = { kind: "enum", values: enumValues };
  } else if (valueMembers.length === 1) {
    ref = parseTypeRef(valueMembers[0]!, location, context, diagnosticPath);
  } else {
    return unsupportedType(
      context,
      "UNSUPPORTED_UNION_TYPE",
      "Only unions of string literals, plus optional undefined and nullable null modifiers, are portable.",
      type,
      location,
      diagnosticPath,
    );
  }

  if (hasNull) ref = nullableType(ref);
  if (hasUndefined) ref = optionalType(ref);
  return ref;
}

function stringEnumValuesFromMembers(members: Type[]): string[] | undefined {
  const values: string[] = [];
  for (const member of members) {
    const value = member.getLiteralValue();
    if (typeof value !== "string") return undefined;
    values.push(value);
  }
  return values;
}

function parseObjectFields(
  type: Type,
  location: Node,
  context: SchemaParseContext,
  diagnosticPath: string,
): ObjectField[] {
  return type.getProperties().map((property) => {
    const declaration = property.getDeclarations()[0] ?? location;
    let propertyType = parseTypeRef(
      property.getTypeAtLocation(declaration),
      declaration,
      context,
      `${diagnosticPath}.fields.${property.getName()}`,
    );
    if (property.isOptional()) propertyType = optionalType(propertyType);
    return { name: property.getName(), type: propertyType };
  });
}

function parseTypeRef(
  type: Type,
  location: Node,
  context: SchemaParseContext,
  diagnosticPath: string,
  ignoredSymbolKey?: string,
): TypeRef {
  if (type.isAny()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_ANY_TYPE",
      "The any type has no language-neutral wire representation.",
      type,
      location,
      diagnosticPath,
    );
  }
  if (type.isUnknown()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_UNKNOWN_TYPE",
      "The unknown type has no declared wire shape.",
      type,
      location,
      diagnosticPath,
    );
  }
  if (type.isNever()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_NEVER_TYPE",
      "The never type cannot cross the wire.",
      type,
      location,
      diagnosticPath,
    );
  }
  if (type.isVoid()) return { kind: "void" };
  if (type.isString()) return { kind: "scalar", name: "string" };
  if (type.isNumber()) return { kind: "scalar", name: "number" };
  if (type.isBoolean()) return { kind: "scalar", name: "boolean" };
  if (type.isNull()) return { kind: "null" };
  if (type.isUndefined()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_UNDEFINED_TYPE",
      "A standalone undefined type cannot be represented on the wire.",
      type,
      location,
      diagnosticPath,
    );
  }

  if (type.isStringLiteral()) {
    return { kind: "enum", values: [String(type.getLiteralValue())] };
  }
  if (type.isNumberLiteral()) return { kind: "scalar", name: "number" };
  if (type.isBooleanLiteral()) return { kind: "scalar", name: "boolean" };

  if (type.isArray()) {
    const element = type.getArrayElementType();
    if (element) {
      return {
        kind: "array",
        element: parseTypeRef(
          element,
          location,
          context,
          `${diagnosticPath}.element`,
        ),
      };
    }
  }
  if (type.isTuple()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_TUPLE_TYPE",
      "Tuples do not have a portable SocketRPC representation yet; use an object instead.",
      type,
      location,
      diagnosticPath,
    );
  }
  if (type.isIntersection()) {
    return unsupportedType(
      context,
      "UNSUPPORTED_INTERSECTION_TYPE",
      "Intersection types are ambiguous across target languages; declare a concrete object type.",
      type,
      location,
      diagnosticPath,
    );
  }

  const symbol = getPortableNamedSymbol(type, ignoredSymbolKey);
  const symbolName = symbol?.getName();
  const directTypeArguments = type.getTypeArguments();
  const typeArguments =
    directTypeArguments.length > 0
      ? directTypeArguments
      : type.getAliasTypeArguments();

  if (
    (symbolName === "Array" || symbolName === "ReadonlyArray") &&
    typeArguments.length === 1
  ) {
    return {
      kind: "array",
      element: parseTypeRef(
        typeArguments[0]!,
        location,
        context,
        `${diagnosticPath}.element`,
      ),
    };
  }

  if (symbolName === "Record" && typeArguments.length === 2) {
    if (!typeArguments[0]!.isString()) {
      return unsupportedType(
        context,
        "UNSUPPORTED_MAP_KEY_TYPE",
        "Record/map keys must be strings in the portable schema.",
        type,
        location,
        diagnosticPath,
      );
    }
    return {
      kind: "map",
      value: parseTypeRef(
        typeArguments[1]!,
        location,
        context,
        `${diagnosticPath}.value`,
      ),
    };
  }

  if (typeArguments.length > 0) {
    return unsupportedType(
      context,
      symbolName === "Promise"
        ? "UNSUPPORTED_PROMISE_TYPE"
        : "UNSUPPORTED_GENERIC_TYPE",
      symbolName === "Promise"
        ? "RPC methods must declare their wire result directly, not Promise<T>."
        : `Generic type '${symbolName ?? typeText(type, location)}' must be resolved to a concrete portable declaration.`,
      type,
      location,
      diagnosticPath,
    );
  }

  if (symbol && symbolName) {
    registerNamedType(symbol, symbolName, location, context, diagnosticPath);
    return { kind: "named", name: symbolName };
  }

  if (type.isUnion()) {
    return parseUnionType(type, location, context, diagnosticPath);
  }

  if (type.getCallSignatures().length > 0) {
    return unsupportedType(
      context,
      "UNSUPPORTED_FUNCTION_TYPE",
      "Function values cannot be serialized as RPC data.",
      type,
      location,
      diagnosticPath,
    );
  }

  if (type.isObject()) {
    const stringIndexType = type.getStringIndexType();
    const numberIndexType = type.getNumberIndexType();
    const properties = type.getProperties();

    if (numberIndexType) {
      return unsupportedType(
        context,
        "UNSUPPORTED_INDEX_SIGNATURE",
        "Numeric index signatures are ambiguous; use an array or a string-keyed record.",
        type,
        location,
        diagnosticPath,
      );
    }
    if (stringIndexType && properties.length === 0) {
      return {
        kind: "map",
        value: parseTypeRef(
          stringIndexType,
          location,
          context,
          `${diagnosticPath}.value`,
        ),
      };
    }
    if (stringIndexType) {
      return unsupportedType(
        context,
        "UNSUPPORTED_INDEX_SIGNATURE",
        "Objects that mix named fields with an index signature are not portable.",
        type,
        location,
        diagnosticPath,
      );
    }
    return {
      kind: "object",
      fields: parseObjectFields(type, location, context, diagnosticPath),
    };
  }

  return unsupportedType(
    context,
    "UNSUPPORTED_TYPE",
    `Type '${typeText(type, location)}' has no portable SocketRPC representation.`,
    type,
    location,
    diagnosticPath,
  );
}

/**
 * Extracts signature from a single property if it's a valid function
 * Returns null if the property should be skipped
 */
function extractMethodFromProperty(
  property: PropertySignature,
  processedNames: Set<string>,
  direction: RpcDirection,
  context: SchemaParseContext,
): ParsedMethod | null {
  const typeNode = property.getTypeNode();
  const name = property.getName();

  // Skip if already processed (derived class overrides base)
  if (processedNames.has(name)) return null;

  if (!typeNode || typeNode.getKind() !== SyntaxKind.FunctionType) return null;

  if (!isValidJavaScriptIdentifier(name)) {
    console.error(
      `Warning: Skipping function '${name}' - not a valid JavaScript identifier`,
    );
    return null;
  }

  if (RESERVED_NAMES.has(name)) {
    throw new Error(
      `Function name '${name}' is reserved by socket-rpc and collides with the generated RpcClient/RpcServer surface. Please rename it in your ClientFunctions/ServerFunctions interface.`,
    );
  }

  const callSignatures = property.getType().getCallSignatures();
  const signature = callSignatures[0];
  if (!signature) return null;

  const methodParams: RpcMethod["params"] = [];
  const params: FunctionParam[] = signature.getParameters().map((param) => {
    const paramType = param.getTypeAtLocation(property);
    const parameterDeclaration = param.getDeclarations()[0] ?? property;
    let structuredType = parseTypeRef(
      paramType,
      parameterDeclaration,
      context,
      `${direction}.${name}.params.${param.getName()}`,
    );
    if (param.isOptional()) structuredType = optionalType(structuredType);
    methodParams.push({ name: param.getName(), type: structuredType });
    return {
      name: param.getName(),
      type: paramType.getText(property),
      isOptional: param.isOptional(),
    };
  });

  const returnType = signature.getReturnType();
  const returnTypeString = returnType.getText(property);
  const structuredReturnType = parseTypeRef(
    returnType,
    property,
    context,
    `${direction}.${name}.returnType`,
  );

  return {
    method: {
      name,
      direction,
      params: methodParams,
      returnType: structuredReturnType,
    },
    compatibilitySignature: {
      name,
      params,
      returnType: returnTypeString,
      isVoid: returnTypeString === "void",
    },
  };
}

/**
 * Returns an interface plus its transitive base interfaces, in walk order
 * (bases first, then the derived interface).
 */
function getInterfaceChain(
  iface: InterfaceDeclaration,
): InterfaceDeclaration[] {
  return [...getAllBaseInterfaces(iface), iface];
}

/**
 * Extracts function signatures from a TypeScript interface using ts-morph.
 * Walks the entire inheritance chain so extended interfaces' methods are included.
 */
function extractInterfaceMethods(
  interfaceDeclaration: InterfaceDeclaration,
  direction: RpcDirection,
  context: SchemaParseContext,
): ParsedMethod[] {
  const methods: ParsedMethod[] = [];
  const processedNames = new Set<string>();

  for (const iface of getInterfaceChain(interfaceDeclaration)) {
    for (const property of iface.getProperties()) {
      const extracted = extractMethodFromProperty(
        property,
        processedNames,
        direction,
        context,
      );
      if (extracted) {
        methods.push(extracted);
        processedNames.add(extracted.method.name);
      }
    }
  }

  return methods;
}

function supportedTypeDeclaration(symbol: MorphSymbol): Node | undefined {
  return symbol
    .getDeclarations()
    .find(
      (declaration) =>
        Node.isTypeAliasDeclaration(declaration) ||
        Node.isInterfaceDeclaration(declaration) ||
        Node.isEnumDeclaration(declaration),
    );
}

function parseNamedDeclaration(
  pending: PendingNamedType,
  context: SchemaParseContext,
): TypeDeclaration | undefined {
  const declaration = supportedTypeDeclaration(pending.symbol);
  if (!declaration) {
    // Ambient and platform declarations (for example Error) remain external
    // named references. A target backend can explicitly map or reject them.
    if (!isUserDeclaredSymbol(pending.symbol)) return undefined;
    addDiagnostic(
      context,
      "UNSUPPORTED_TYPE_DECLARATION",
      `Named type '${pending.name}' must be a type alias, interface, or string enum.`,
      pending.name,
      pending.location,
      `declarations.${pending.name}`,
    );
    return undefined;
  }

  if (Node.isEnumDeclaration(declaration)) {
    const values: string[] = [];
    for (const member of declaration.getMembers()) {
      const value = member.getValue();
      if (typeof value !== "string") {
        addDiagnostic(
          context,
          "UNSUPPORTED_ENUM_TYPE",
          `Enum '${pending.name}' must contain only explicitly initialized string values.`,
          declaration.getText(),
          member,
          `declarations.${pending.name}`,
        );
        continue;
      }
      values.push(value);
    }
    return { kind: "enum", name: pending.name, values };
  }

  const rootType = declaration.getType();
  const target = parseTypeRef(
    rootType,
    declaration,
    context,
    `declarations.${pending.name}`,
    pending.key,
  );

  if (target.kind === "object") {
    return { kind: "object", name: pending.name, fields: target.fields };
  }
  if (target.kind === "enum") {
    return { kind: "enum", name: pending.name, values: target.values };
  }
  return { kind: "alias", name: pending.name, target };
}

function buildTypeDeclarations(context: SchemaParseContext): TypeDeclaration[] {
  const declarations: TypeDeclaration[] = [];
  for (let index = 0; index < context.namedTypeQueue.length; index += 1) {
    const name = context.namedTypeQueue[index]!;
    const pending = context.namedTypes.get(name)!;
    const declaration = parseNamedDeclaration(pending, context);
    if (declaration) declarations.push(declaration);
  }
  return declarations;
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
  const name = symbol?.getName();
  const isAnonymous =
    !symbol || !name || name === "__type" || name === "__object";

  if (!isAnonymous && !out.has(name!)) {
    for (const decl of symbol!.getDeclarations()) {
      const sf = decl.getSourceFile();
      if (!sf.isInNodeModules() && !sf.isDeclarationFile()) {
        out.set(name!, sf);
        break;
      }
    }
  }

  if (type.isUnion()) {
    type
      .getUnionTypes()
      .forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  if (type.isIntersection()) {
    type
      .getIntersectionTypes()
      .forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  if (type.isArray()) {
    const elem = type.getArrayElementType();
    if (elem) collectReferencedSymbols(elem, out, visited);
  }
  if (type.isTuple()) {
    type
      .getTupleElements()
      .forEach((t) => collectReferencedSymbols(t, out, visited));
  }
  type
    .getTypeArguments()
    .forEach((t) => collectReferencedSymbols(t, out, visited));

  // Walk anonymous object shapes so nested named types are discovered.
  // Named object types' imports cover their own structure at the declaration site.
  if (isAnonymous) {
    for (const prop of type.getProperties()) {
      const propDecl = prop.getDeclarations()[0];
      if (propDecl) {
        collectReferencedSymbols(
          prop.getTypeAtLocation(propDecl),
          out,
          visited,
        );
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
        collectReferencedSymbols(
          param.getTypeAtLocation(property),
          out,
          visited,
        );
      }
      collectReferencedSymbols(signature.getReturnType(), out, visited);
    }
  }
}

const PROJECT_TSCONFIG_PATH = path.resolve(
  import.meta.dir,
  "..",
  "tsconfig.json",
);

export interface ExtractedInterfaces {
  clientFunctions: FunctionSignature[];
  serverFunctions: FunctionSignature[];
  usedTypes: Map<string, SourceFile>;
  inputFile: SourceFile;
  /**
   * Portable IR for non-TypeScript backends. Undefined whenever `diagnostics`
   * is non-empty, so unsupported-type sentinels can never reach a consumer.
   */
  schema: RpcSchema | undefined;
  /** Every reason the contract is not portable. Empty when `schema` is set. */
  diagnostics: SchemaDiagnostic[];
}

/**
 * Extracts interfaces and function signatures from the input file.
 * Also returns the map of every user-declared type referenced by those signatures,
 * so emission can add matching type-only imports.
 *
 * TypeScript emission accepts every type TypeScript itself accepts: it reads only
 * the string signatures below, so a contract the portable IR cannot model is
 * reported through `diagnostics` rather than raised. Backends that need the IR
 * call extractRpcSchemaFromFile, which refuses those contracts.
 */
export async function extractInterfacesFromFile(
  inputPath: string,
): Promise<ExtractedInterfaces> {
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

  const schemaContext: SchemaParseContext = {
    diagnostics: [],
    namedTypes: new Map(),
    namedTypeQueue: [],
  };

  // Interface names describe the side that implements each method. The schema
  // direction describes the side that initiates the call.
  const clientToServer = extractInterfaceMethods(
    serverFunctionsInterface,
    "client-to-server",
    schemaContext,
  );
  const serverToClient = extractInterfaceMethods(
    clientFunctionsInterface,
    "server-to-client",
    schemaContext,
  );

  // Resolving declarations can surface further diagnostics, so it runs before
  // the portability check below.
  const declarations = buildTypeDeclarations(schemaContext);
  const { diagnostics } = schemaContext;

  const schema: RpcSchema | undefined =
    diagnostics.length > 0
      ? undefined
      : {
          version: RPC_SCHEMA_VERSION,
          methods: [
            ...clientToServer.map(({ method }) => method),
            ...serverToClient.map(({ method }) => method),
          ],
          declarations,
        };

  // Compatibility projection for the current TypeScript emitters. These keep
  // ts-morph's exact historical type text, so generated output does not drift.
  const clientFunctions = clientToServer.map(
    ({ compatibilitySignature }) => compatibilitySignature,
  );
  const serverFunctions = serverToClient.map(
    ({ compatibilitySignature }) => compatibilitySignature,
  );

  // Walk every signature's types and collect every user-declared type they reference.
  // Order matters: server interface is walked first so that types appearing on
  // server-facing methods (which tend to be called first in generated client code)
  // are listed earliest in each import group.
  const usedTypes = new Map<string, SourceFile>();
  collectUsedTypes(serverFunctionsInterface, usedTypes);
  collectUsedTypes(clientFunctionsInterface, usedTypes);

  return {
    clientFunctions,
    serverFunctions,
    usedTypes,
    inputFile: sourceFile,
    schema,
    diagnostics,
  };
}

/**
 * Extract only the language-neutral schema for non-TypeScript backends.
 * Throws SchemaExtractionError when the contract cannot be modelled portably.
 */
export async function extractRpcSchemaFromFile(
  inputPath: string,
): Promise<RpcSchema> {
  const { schema, diagnostics } = await extractInterfacesFromFile(inputPath);
  if (!schema) throw new SchemaExtractionError(diagnostics);
  return schema;
}
