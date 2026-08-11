import {
  exportedIdentifier,
  isExportedGoIdentifier,
  isGoIdentifier,
  localIdentifier,
} from "./names";
import type {
  GoEmitterOptions,
  GoEmitterSchema,
  GoObjectDeclaration,
  GoRpcMethod,
  GoTypeRef,
} from "./schema";

const RESERVED_EVENTS = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
  "__rpc:error__",
]);

const CLIENT_RESERVED_METHODS = new Set([
  "Dispose",
  "Connected",
  "Done",
  "Socket",
]);

const LOCAL_RESERVED_NAMES = new Set([
  "ctx",
  "rawArgs",
  "ack",
  "reply",
  "result",
  "err",
  "zero",
]);

const RESERVED_DECLARATIONS = new Set([
  "RpcError",
  "RpcErrorCode",
  "ServerHandler",
  "ServerBinding",
  "Client",
  "ClientOptions",
]);

const RESERVED_PACKAGE_IDENTIFIERS = new Set([
  ...RESERVED_DECLARATIONS,
  "RPCErrorEvent",
  "CodeTimeout",
  "CodeDisposed",
  "CodeDisconnected",
  "CodeAborted",
  "CodeInternalError",
  "CodeInvalidArgument",
  "NewRpcError",
  "IsRpcError",
  "BindServer",
  "NewClient",
]);

function fail(path: string, message: string): never {
  throw new Error(`Invalid Go emitter schema at ${path}: ${message}`);
}

function isNullable(ref: GoTypeRef): boolean {
  return ref.kind === "nullable";
}

function validateTypeRef(
  ref: GoTypeRef,
  path: string,
  declarations: ReadonlySet<string>,
): void {
  if (!ref || typeof ref !== "object" || typeof ref.kind !== "string") {
    fail(path, "expected a structured type reference");
  }

  switch (ref.kind) {
    case "scalar":
      if (!["string", "boolean", "number", "integer"].includes(ref.name)) {
        fail(path, `unsupported scalar ${JSON.stringify(ref.name)}`);
      }
      return;
    case "named":
      if (!declarations.has(ref.name)) {
        fail(path, `unknown named type ${JSON.stringify(ref.name)}`);
      }
      return;
    case "array":
      validateTypeRef(ref.element, `${path}.element`, declarations);
      return;
    case "map":
      validateTypeRef(ref.value, `${path}.value`, declarations);
      return;
    case "nullable":
      if (ref.value.kind === "nullable") {
        fail(path, "nested nullable types are ambiguous");
      }
      validateTypeRef(ref.value, `${path}.value`, declarations);
      return;
    default:
      fail(path, `unsupported type kind ${JSON.stringify((ref as { kind: unknown }).kind)}`);
  }
}

function validateObject(
  declaration: GoObjectDeclaration,
  path: string,
  declarations: ReadonlySet<string>,
): void {
  const goNames = new Set<string>();
  const wireNames = new Set<string>();

  declaration.fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name)) {
      fail(`${fieldPath}.name`, "wire fields must be unquoted JavaScript identifiers");
    }
    if (wireNames.has(field.name)) fail(`${fieldPath}.name`, `duplicate field ${field.name}`);
    wireNames.add(field.name);

    const goName = field.goName ?? exportedIdentifier(field.name);
    if (!isExportedGoIdentifier(goName)) {
      fail(`${fieldPath}.goName`, `expected an exported Go identifier, got ${JSON.stringify(goName)}`);
    }
    if (goNames.has(goName)) fail(`${fieldPath}.goName`, `duplicate generated field ${goName}`);
    goNames.add(goName);

    if (field.optional && isNullable(field.type)) {
      fail(fieldPath, "optional and nullable cannot be combined because both map to nil");
    }
    validateTypeRef(field.type, `${fieldPath}.type`, declarations);
  });
}

function validateMethods(
  methods: readonly GoRpcMethod[],
  path: string,
  declarations: ReadonlySet<string>,
  clientSurface: boolean,
): void {
  const eventNames = new Set<string>();
  const goNames = new Set<string>();

  methods.forEach((method, index) => {
    const methodPath = `${path}[${index}]`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method.name)) {
      fail(`${methodPath}.name`, "event names must be unquoted JavaScript identifiers");
    }
    if (RESERVED_EVENTS.has(method.name)) {
      fail(`${methodPath}.name`, `${method.name} is reserved by Socket.IO/SocketRPC`);
    }
    if (eventNames.has(method.name)) fail(`${methodPath}.name`, `duplicate event ${method.name}`);
    eventNames.add(method.name);

    const goName = method.goName ?? exportedIdentifier(method.name);
    if (!isExportedGoIdentifier(goName)) {
      fail(`${methodPath}.goName`, `expected an exported Go identifier, got ${JSON.stringify(goName)}`);
    }
    if (clientSurface && CLIENT_RESERVED_METHODS.has(goName)) {
      fail(`${methodPath}.goName`, `${goName} collides with the generated Client API`);
    }
    if (goNames.has(goName)) fail(`${methodPath}.goName`, `duplicate generated method ${goName}`);
    goNames.add(goName);

    const paramNames = new Set<string>();
    method.params.forEach((param, paramIndex) => {
      const paramPath = `${methodPath}.params[${paramIndex}]`;
      if (param.optional) {
        fail(paramPath, "optional positional parameters are ambiguous with Socket.IO acknowledgements");
      }
      const paramName = param.goName ?? localIdentifier(param.name);
      if (!isGoIdentifier(paramName) || LOCAL_RESERVED_NAMES.has(paramName)) {
        fail(`${paramPath}.goName`, `invalid or reserved local Go identifier ${JSON.stringify(paramName)}`);
      }
      if (paramNames.has(paramName)) {
        fail(`${paramPath}.goName`, `duplicate generated parameter ${paramName}`);
      }
      paramNames.add(paramName);
      validateTypeRef(param.type, `${paramPath}.type`, declarations);
    });

    if (method.result) validateTypeRef(method.result, `${methodPath}.result`, declarations);
  });
}

function directNamedDependency(ref: GoTypeRef, indirect = false): string | undefined {
  switch (ref.kind) {
    case "named":
      return indirect ? undefined : ref.name;
    case "nullable":
    case "array":
    case "map":
      return undefined;
    case "scalar":
      return undefined;
  }
}

function validateValueCycles(schema: GoEmitterSchema): void {
  const objects = new Map(
    schema.declarations
      .filter((declaration): declaration is GoObjectDeclaration => declaration.kind === "object")
      .map((declaration) => [declaration.name, declaration]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, trail: readonly string[]) => {
    if (visiting.has(name)) {
      fail("declarations", `recursive value types require nullable/array/map indirection: ${[...trail, name].join(" -> ")}`);
    }
    if (visited.has(name)) return;
    const declaration = objects.get(name);
    if (!declaration) return;

    visiting.add(name);
    for (const field of declaration.fields) {
      if (field.optional) continue;
      const dependency = directNamedDependency(field.type);
      if (dependency && objects.has(dependency)) visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of objects.keys()) visit(name, []);
}

export function validateGoEmitterSchema(
  schema: GoEmitterSchema,
  options: GoEmitterOptions = {},
): void {
  if (!schema || typeof schema !== "object") fail("schema", "expected an object");
  if (!/^[a-z_][a-z0-9_]*$/.test(schema.packageName) || !isGoIdentifier(schema.packageName)) {
    fail("packageName", "must be a lower-case Go package identifier");
  }
  if (options.socketImport !== undefined && !options.socketImport.trim()) {
    fail("options.socketImport", "must not be empty");
  }
  if (
    options.socketImport !== undefined &&
    !/^[A-Za-z0-9._~/-]+$/.test(options.socketImport)
  ) {
    fail("options.socketImport", "contains characters that are not valid in a Go import path");
  }
  if (
    options.defaultTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.defaultTimeoutMs) ||
      options.defaultTimeoutMs <= 0 ||
      options.defaultTimeoutMs > 9_223_372_036_854)
  ) {
    fail("options.defaultTimeoutMs", "must be a positive integer representable by time.Duration");
  }

  const declarationNames = new Set<string>();
  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}]`;
    if (!isExportedGoIdentifier(declaration.name)) {
      fail(`${path}.name`, "must be an exported Go identifier");
    }
    if (RESERVED_PACKAGE_IDENTIFIERS.has(declaration.name)) {
      fail(`${path}.name`, `${declaration.name} collides with the generated package API`);
    }
    if (declarationNames.has(declaration.name)) {
      fail(`${path}.name`, `duplicate declaration ${declaration.name}`);
    }
    declarationNames.add(declaration.name);
  });

  const packageIdentifiers = new Set<string>(RESERVED_PACKAGE_IDENTIFIERS);
  for (const declaration of schema.declarations) packageIdentifiers.add(declaration.name);

  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}]`;
    if (declaration.kind === "object") {
      validateObject(declaration, path, declarationNames);
      return;
    }
    if (declaration.kind === "enum") {
      if (declaration.values.length === 0) fail(`${path}.values`, "enum must not be empty");
      const literals = new Set<string>();
      const constants = new Set<string>();
      declaration.values.forEach((value, valueIndex) => {
        if (literals.has(value)) fail(`${path}.values[${valueIndex}]`, `duplicate literal ${value}`);
        literals.add(value);
        const constant = `${declaration.name}${exportedIdentifier(value)}`;
        if (!isExportedGoIdentifier(constant)) {
          fail(`${path}.values[${valueIndex}]`, "cannot derive an exported Go constant name");
        }
        if (constants.has(constant)) {
          fail(`${path}.values[${valueIndex}]`, `duplicate generated constant ${constant}`);
        }
        if (packageIdentifiers.has(constant)) {
          fail(`${path}.values[${valueIndex}]`, `${constant} collides with another package identifier`);
        }
        constants.add(constant);
        packageIdentifiers.add(constant);
      });
      return;
    }
    fail(`${path}.kind`, `unsupported declaration kind ${JSON.stringify((declaration as { kind: unknown }).kind)}`);
  });

  validateMethods(schema.clientToServer, "clientToServer", declarationNames, false);
  validateMethods(schema.serverToClient, "serverToClient", declarationNames, true);
  validateValueCycles(schema);
}
