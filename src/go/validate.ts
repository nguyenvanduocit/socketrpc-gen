/**
 * Refuses every canonical `RpcSchema` the Go backend cannot turn into sound Go.
 *
 * The IR is deliberately wider than Go: it keeps shapes TypeScript emission is
 * happy with (inline object literals, inline string-literal unions, bare null).
 * Rather than guessing a Go spelling for those, this pass names the offending
 * path and says what to declare instead.
 */

import type { ObjectField, RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "../schema";
import {
  GENERATED_PREFIX,
  GO_PREDECLARED,
  clientMethodName,
  exportedIdentifier,
  handlerMethodName,
  isExportedGoIdentifier,
  isGoIdentifier,
  localIdentifier,
} from "./names";
import { DEFAULT_GO_PACKAGE_NAME, type GoBackendOptions, type GoClientOptions } from "./options";
import { declarationsByName, goTypeName, unwrapOptionality } from "./project";
import { RPC_ERROR_EVENT } from "../types";

const RESERVED_EVENTS = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
  RPC_ERROR_EVENT,
]);

/**
 * The only parameter name the Go backend cannot accept.
 *
 * Every other identifier the emitter owns is out of a contract's reach by
 * construction rather than by this list: handler bodies bind their arguments to
 * positional locals and hold no contract identifier at all, and the emitter's
 * package-level helpers, receivers and locals all carry the `rpc_` prefix, which
 * `exportedIdentifier`/`localIdentifier` cannot produce because they split on
 * every non-alphanumeric rune.
 *
 * `ctx` is listed because it is not a body local: it is the context parameter of
 * the generated `ServerHandler` and `Client` signatures, where a second `ctx`
 * would be a duplicate parameter. Keeping it readable there is worth one
 * refusal, since that signature is the surface developers implement against.
 */
const RESERVED_PARAMETER_NAMES = new Set(["ctx"]);

/**
 * The exported identifiers a side adds to the package it is generated into.
 *
 * A contract declaration shares that package, so its Go name must avoid every
 * one of them. The types file is always there; the server or the client joins
 * it only when it is generated into the same package. A client generated into
 * its own package declares no contract types, so its API constrains nothing.
 */
const CORE_API = [
  "RpcError",
  "RpcErrorCode",
  "RPCErrorEvent",
  "CodeTimeout",
  "CodeDisposed",
  "CodeDisconnected",
  "CodeAborted",
  "CodeInternalError",
  "CodeInvalidArgument",
  "NewRpcError",
  "IsRpcError",
];
const SERVER_API = ["ServerHandler", "ServerBinding", "Client", "ClientOptions", "BindServer", "NewClient"];
const CLIENT_API = ["ClientHandler", "Conn", "Dial", "DialOptions"];

/** Which Go side a validation run is for. */
export type GoSideName = "server" | "client";

function reservedPackageIdentifiers(side: GoSideName, options: GoBackendOptions): Set<string> {
  if (side === "server") return new Set([...CORE_API, ...SERVER_API]);
  return new Set(options.client?.separate ? CORE_API : [...CORE_API, ...CLIENT_API]);
}

/**
 * The names the client file already resolves at file scope: the packages it
 * imports, and Go's predeclared identifiers, which an import of the same name
 * would shadow.
 *
 * A separate client imports the types package by its package name, so that
 * name must not be any of them, nor carry the generated prefix the client's
 * package-level identifiers are spelled with. Nothing else can meet it: the
 * client names the package only at file scope and in exported signatures,
 * whose parameters are scoped to the body, and every body reaches the types
 * package through `rpc_` aliases instead (`writeTypesBridge`).
 */
const CLIENT_FILE_NAMES = new Set([
  ...GO_PREDECLARED,
  "context",
  "errors",
  "fmt",
  "json",
  "reflect",
  "sync",
  "time",
  "url",
  "sioclient",
]);

const WIRE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Raised when a contract is valid TypeScript but has no sound Go projection. */
export class GoSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Cannot generate Go for ${path}: ${message}`);
    this.name = "GoSchemaError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new GoSchemaError(path, message);
}

interface ValidationScope {
  readonly declarations: Map<string, TypeDeclaration>;
}

function validateTypeRef(ref: TypeRef, path: string, scope: ValidationScope): void {
  if (!ref || typeof ref !== "object" || typeof ref.kind !== "string") {
    fail(path, "expected a structured type reference");
  }

  const { core } = unwrapOptionality(ref);

  switch (core.kind) {
    // An arbitrary JSON value is `any`, which holds every shape the wire can
    // carry — including the null the JSON data model already contains.
    case "json":
      return;
    case "scalar":
      if (!["string", "number", "integer", "boolean"].includes(core.name)) {
        fail(path, `unsupported scalar ${JSON.stringify(core.name)}`);
      }
      return;
    case "named":
      if (!scope.declarations.has(core.name)) {
        fail(
          path,
          `'${core.name}' is referenced but never declared in a form Go can model. Declare it as an interface, type alias, or string enum in your define file — ambient types such as Error or Date have no portable wire shape.`,
        );
      }
      return;
    case "array":
      validateTypeRef(core.element, `${path}.element`, scope);
      return;
    case "map":
      validateTypeRef(core.value, `${path}.value`, scope);
      return;
    case "object":
      fail(
        path,
        "inline object literals have no Go name. Extract the shape into a named interface or type alias.",
      );
    case "enum":
      fail(
        path,
        "inline string-literal unions have no Go name. Extract the union into a named type alias so it can become a Go string enum. If the contract already has one, TypeScript dropped its name: an alias that includes null or undefined is merged into any union it joins, so for `type Maybe = Status | null` a field written `n?: Maybe` reaches Go as an inline union. Write the alias's own members instead: `n?: Status | null`.",
      );
    case "union":
      fail(
        path,
        "discriminated unions have no Go projection; they are supported by the TypeScript and Rust backends. For a Go side, declare one object type with the tag field and every variant's fields optional.",
      );
    case "null":
      fail(path, "a bare null carries no value type. Use `T | null` so Go can emit a *T.");
    case "void":
      fail(path, "void is only meaningful as a whole method result, not as a value type.");
    default:
      fail(path, `unsupported type kind ${JSON.stringify((core as { kind: unknown }).kind)}`);
  }
}

function validateObjectFields(
  fields: readonly ObjectField[],
  path: string,
  scope: ValidationScope,
): void {
  const goNames = new Set<string>();
  const wireNames = new Set<string>();

  fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    if (!WIRE_IDENTIFIER.test(field.name)) {
      fail(`${fieldPath}.name`, "wire fields must be unquoted JavaScript identifiers");
    }
    if (wireNames.has(field.name)) fail(`${fieldPath}.name`, `duplicate field ${field.name}`);
    wireNames.add(field.name);

    const goName = exportedIdentifier(field.name);
    if (!isExportedGoIdentifier(goName)) {
      fail(
        `${fieldPath}.name`,
        `cannot derive an exported Go field name from ${JSON.stringify(field.name)}`,
      );
    }
    if (goNames.has(goName)) {
      fail(
        `${fieldPath}.name`,
        `${JSON.stringify(field.name)} and another field both map to the Go field ${goName}`,
      );
    }
    goNames.add(goName);

    validateTypeRef(field.type, `${fieldPath}.type`, scope);
  });
}

/**
 * Validates one direction of a contract.
 *
 * `goMethodName` is the projection that direction's methods reach Go through —
 * `Handle…` for the interface a server implements, `Call…` for the client it is
 * called through. Uniqueness is checked on the projected name, which is what a
 * developer reads in the generated package.
 */
function validateMethods(
  methods: readonly RpcMethod[],
  path: string,
  scope: ValidationScope,
  goMethodName: (wireName: string) => string,
): void {
  const eventNames = new Set<string>();
  const goNames = new Set<string>();

  methods.forEach((method, index) => {
    const methodPath = `${path}[${index}]`;
    if (!WIRE_IDENTIFIER.test(method.name)) {
      fail(`${methodPath}.name`, "event names must be unquoted JavaScript identifiers");
    }
    if (RESERVED_EVENTS.has(method.name)) {
      fail(`${methodPath}.name`, `${method.name} is reserved by Socket.IO/SocketRPC`);
    }
    if (eventNames.has(method.name)) fail(`${methodPath}.name`, `duplicate event ${method.name}`);
    eventNames.add(method.name);

    // The derived name is checked before the prefix is applied: `Handle` in
    // front of it would make anything a valid Go identifier, including the empty
    // derivation a name of only separators produces.
    if (!isExportedGoIdentifier(exportedIdentifier(method.name))) {
      fail(
        `${methodPath}.name`,
        `cannot derive an exported Go method name from ${JSON.stringify(method.name)}`,
      );
    }
    const goName = goMethodName(method.name);
    if (goNames.has(goName)) {
      fail(`${methodPath}.name`, `duplicate generated method ${goName}`);
    }
    goNames.add(goName);

    const paramNames = new Set<string>();
    method.params.forEach((param, paramIndex) => {
      const paramPath = `${methodPath}.params[${paramIndex}]`;
      if (param.type.kind === "optional") {
        fail(
          paramPath,
          "optional positional parameters are ambiguous with Socket.IO acknowledgements. Make the parameter required, or move it into an object parameter where it can be omitted.",
        );
      }
      const paramName = localIdentifier(param.name);
      if (!isGoIdentifier(paramName)) {
        fail(
          `${paramPath}.name`,
          `${JSON.stringify(param.name)} maps to ${JSON.stringify(paramName)}, which is not a Go identifier`,
        );
      }
      if (RESERVED_PARAMETER_NAMES.has(paramName)) {
        fail(
          `${paramPath}.name`,
          `${JSON.stringify(param.name)} maps to ${JSON.stringify(paramName)}, which names the context parameter of the generated signature. Rename it — every other name is accepted.`,
        );
      }
      if (paramNames.has(paramName)) {
        fail(`${paramPath}.name`, `duplicate generated parameter ${paramName}`);
      }
      paramNames.add(paramName);
      validateTypeRef(param.type, `${paramPath}.type`, scope);
    });

    if (method.returnType.kind !== "void") {
      validateTypeRef(method.returnType, `${methodPath}.returnType`, scope);
    }
  });
}

/**
 * Resolves the named type a field embeds by value, following alias hops.
 * Pointers, slices and maps break the chain because they are already indirect.
 */
function directNamedDependency(
  ref: TypeRef,
  scope: ValidationScope,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const { core, nilable } = unwrapOptionality(ref);
  if (nilable || core.kind !== "named") return undefined;

  const declaration = scope.declarations.get(core.name);
  if (declaration?.kind === "alias") {
    if (seen.has(core.name)) return core.name;
    return directNamedDependency(declaration.target, scope, new Set([...seen, core.name]));
  }
  return core.name;
}

/**
 * A Go struct that embeds itself by value has no finite size. Recursion is fine
 * as long as one hop on the cycle is a pointer, slice or map.
 */
function validateValueCycles(schema: RpcSchema, scope: ValidationScope): void {
  const objects = new Map(
    schema.declarations
      .filter((declaration) => declaration.kind === "object")
      .map((declaration) => [declaration.name, declaration] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, trail: readonly string[]): void => {
    if (visiting.has(name)) {
      fail(
        "declarations",
        `recursive value types require nullable, array, or map indirection: ${[...trail, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;
    const declaration = objects.get(name);
    if (!declaration) return;

    visiting.add(name);
    for (const field of declaration.fields) {
      const dependency = directNamedDependency(field.type, scope);
      if (dependency && objects.has(dependency)) visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of objects.keys()) visit(name, []);
}

function validateDeclarationNames(schema: RpcSchema, reserved: ReadonlySet<string>): Set<string> {
  const goNames = new Map<string, string>();

  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}]`;
    const goName = goTypeName(declaration.name);
    if (!isExportedGoIdentifier(goName)) {
      fail(
        `${path}.name`,
        `cannot derive an exported Go type name from ${JSON.stringify(declaration.name)}`,
      );
    }
    if (reserved.has(goName)) {
      fail(`${path}.name`, `${goName} collides with the generated package API`);
    }
    const previous = goNames.get(goName);
    if (previous !== undefined) {
      fail(
        `${path}.name`,
        `${JSON.stringify(declaration.name)} and ${JSON.stringify(previous)} both map to the Go type ${goName}`,
      );
    }
    goNames.set(goName, declaration.name);
  });

  return new Set(goNames.keys());
}

function validateEnumConstants(
  declaration: Extract<TypeDeclaration, { kind: "enum" }>,
  path: string,
  packageIdentifiers: Set<string>,
): void {
  if (declaration.values.length === 0) fail(`${path}.values`, "enum must not be empty");
  const literals = new Set<string>();
  const goName = goTypeName(declaration.name);

  declaration.values.forEach((value, valueIndex) => {
    const valuePath = `${path}.values[${valueIndex}]`;
    if (literals.has(value)) fail(valuePath, `duplicate literal ${value}`);
    literals.add(value);

    const constant = `${goName}${exportedIdentifier(value)}`;
    if (!isExportedGoIdentifier(constant)) {
      fail(valuePath, `cannot derive an exported Go constant name from ${JSON.stringify(value)}`);
    }
    if (packageIdentifiers.has(constant)) {
      fail(valuePath, `${constant} collides with another package identifier`);
    }
    packageIdentifiers.add(constant);
  });
}

function validatePackageName(packageName: string, path: string): void {
  // The blank identifier matches the pattern but is no package name at all.
  if (!/^[a-z_][a-z0-9_]*$/.test(packageName) || !isGoIdentifier(packageName) || packageName === "_") {
    fail(path, "must be a lower-case Go package identifier");
  }
}

function validateImportPath(importPath: string, path: string): void {
  if (!importPath.trim()) fail(path, "must not be empty");
  if (!/^[A-Za-z0-9._~/-]+$/.test(importPath)) {
    fail(path, "contains characters that are not valid in a Go import path");
  }
}

/**
 * Refuses client options that cannot produce a compiling client file. Each
 * message names the CLI flag that sets the value.
 */
function validateGoClientOptions(client: GoClientOptions, typesPackageName: string | undefined): void {
  if (client.socketImport !== undefined) {
    validateImportPath(client.socketImport, "options.client.socketImport (--go-client-socket-import)");
  }
  const separate = client.separate;
  if (!separate) return;
  validatePackageName(separate.packageName, "options.client.separate.packageName (--go-client-package)");
  validateImportPath(separate.typesImport, "options.client.separate.typesImport (derived from --go-out)");
  const typesName = typesPackageName ?? DEFAULT_GO_PACKAGE_NAME;
  if (separate.packageName === typesName) {
    fail(
      "options.client.separate.packageName (--go-client-package)",
      `must differ from the types package ${JSON.stringify(typesName)} (--go-package): the client is a separate package that imports it`,
    );
  }
  if (CLIENT_FILE_NAMES.has(typesName) || typesName.startsWith(GENERATED_PREFIX)) {
    fail(
      "options.packageName (--go-package)",
      `the client file imports the types package as ${JSON.stringify(typesName)}, a name that file already uses for an import, a predeclared Go identifier or its own ${GENERATED_PREFIX} identifiers. Choose another --go-package`,
    );
  }
}

/**
 * Validates a canonical schema against the Go backend. Throws `GoSchemaError`
 * with the offending logical path on the first unsupported shape.
 *
 * `side` names the Go file being generated, which decides the identifiers a
 * contract declaration must avoid: those of the server, or those of a client
 * that shares the types package.
 */
export function validateGoSchema(
  schema: RpcSchema,
  options: GoBackendOptions = {},
  side: GoSideName = "server",
): void {
  if (!schema || typeof schema !== "object") fail("schema", "expected an object");

  if (options.packageName !== undefined) validatePackageName(options.packageName, "options.packageName (--go-package)");
  if (options.socketImport !== undefined) validateImportPath(options.socketImport, "options.socketImport");
  if (side === "client") validateGoClientOptions(options.client ?? {}, options.packageName);
  if (
    options.defaultTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.defaultTimeoutMs) ||
      options.defaultTimeoutMs <= 0 ||
      options.defaultTimeoutMs > 9_223_372_036_854)
  ) {
    fail("options.defaultTimeoutMs", "must be a positive integer representable by time.Duration");
  }

  const reserved = reservedPackageIdentifiers(side, options);
  const goDeclarationNames = validateDeclarationNames(schema, reserved);
  const scope: ValidationScope = { declarations: declarationsByName(schema) };

  const packageIdentifiers = new Set<string>([...reserved, ...goDeclarationNames]);

  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}]`;
    switch (declaration.kind) {
      case "object":
        validateObjectFields(declaration.fields, path, scope);
        return;
      case "enum":
        validateEnumConstants(declaration, path, packageIdentifiers);
        return;
      case "alias":
        validateTypeRef(declaration.target, `${path}.target`, scope);
        return;
      case "union":
        fail(
          path,
          `'${declaration.name}' is a discriminated union, which has no Go projection. Discriminated unions are supported by the TypeScript and Rust backends; for a Go side, declare one object type with the tag field and every variant's fields optional.`,
        );
      default:
        fail(
          `${path}.kind`,
          `unsupported declaration kind ${JSON.stringify((declaration as { kind: unknown }).kind)}`,
        );
    }
  });

  const inbound = schema.methods.filter((method) => method.direction === "client-to-server");
  const outbound = schema.methods.filter((method) => method.direction === "server-to-client");
  validateMethods(inbound, "clientToServer", scope, handlerMethodName);
  validateMethods(outbound, "serverToClient", scope, clientMethodName);
  validateValueCycles(schema, scope);
}
