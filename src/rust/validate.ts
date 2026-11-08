/**
 * Refuses every canonical `RpcSchema` the Rust backend cannot turn into sound
 * Rust, naming the offending path and what to declare instead.
 *
 * The accepted subset is the Go backend's portable subset: named objects and
 * string enums, scalars, arrays, string-keyed records, `T | null`, optional
 * fields, `unknown` and `void`. A contract that generates Go generates Rust.
 * Rust also accepts named discriminated unions, which Go refuses.
 */

import type { ObjectField, RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "../schema";
import { RPC_ERROR_EVENT } from "../types";
import { callMethodName, handlerMethodName, isRustIdentifier, rustTypeName, rustValueIdentifier, snakeCase } from "./names";
import type { RustBackendOptions } from "./options";
import { declarationsByName, enumVariantName, unboxedCycle, unwrapOptionality, type DeclarationScope } from "./project";

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
 * Type names a contract declaration cannot take.
 *
 * The generated modules import contract types by name next to these, so a
 * declaration spelled like one would either collide with the generated API or
 * shadow a prelude item the generated code relies on.
 */
const RESERVED_TYPE_NAMES = new Set([
  // types.rs
  "RpcError", "RpcErrorCode", "Unsubscribe",
  // server.rs and client.rs
  "ServerHandler", "ServerBinding", "Client", "Context", "ClientHandler", "Conn", "DialOptions",
  // std prelude and the std items the generated code names unqualified
  "Option", "Some", "None", "Result", "Ok", "Err", "String", "Vec", "Box", "Copy", "Clone",
  "Send", "Sync", "Sized", "Unpin", "Drop", "Fn", "FnMut", "FnOnce", "ToOwned", "ToString",
  "PartialEq", "PartialOrd", "Eq", "Ord", "AsRef", "AsMut", "Into", "From", "TryFrom",
  "TryInto", "Default", "Iterator", "IntoIterator", "Extend", "FromIterator",
  "DoubleEndedIterator", "ExactSizeIterator", "Debug", "Future", "Arc", "Duration", "Self",
]);

/** `ctx` is the context parameter every generated handler takes first. */
const RESERVED_PARAMETER_NAMES = new Set(["ctx"]);

const WIRE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Raised when a contract is valid TypeScript but has no sound Rust projection. */
export class RustSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Cannot generate Rust for ${path}: ${message}`);
    this.name = "RustSchemaError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new RustSchemaError(path, message);
}

function validateTypeRef(ref: TypeRef, path: string, declarations: DeclarationScope): void {
  if (!ref || typeof ref !== "object" || typeof ref.kind !== "string") {
    fail(path, "expected a structured type reference");
  }
  const { core } = unwrapOptionality(ref);
  switch (core.kind) {
    case "json":
      return;
    case "scalar":
      if (!["string", "number", "integer", "boolean"].includes(core.name)) {
        fail(path, `unsupported scalar ${JSON.stringify(core.name)}`);
      }
      return;
    case "named":
      if (!declarations.has(core.name)) {
        fail(
          path,
          `'${core.name}' is referenced but never declared in a form Rust can model. Declare it as an interface, type alias, or string enum in your define file — ambient types such as Error or Date have no portable wire shape.`,
        );
      }
      return;
    case "array":
      validateTypeRef(core.element, `${path}.element`, declarations);
      return;
    case "map":
      validateTypeRef(core.value, `${path}.value`, declarations);
      return;
    case "object":
      fail(path, "inline object literals have no Rust name. Extract the shape into a named interface or type alias.");
    case "enum":
      fail(
        path,
        "inline string-literal unions have no Rust name. Extract the union into a named type alias so it can become a Rust enum. If the contract already has one, TypeScript dropped its name: an alias that includes null or undefined is merged into any union it joins, so for `type Maybe = Status | null` a field written `n?: Maybe` reaches Rust as an inline union. Write the alias's own members instead: `n?: Status | null`.",
      );
    case "union":
      fail(path, "inline discriminated unions have no Rust name. Extract the union into a named type alias so it can become a Rust enum.");
    case "null":
      fail(path, "a bare null carries no value type. Use `T | null` so Rust can emit an Option<T>.");
    case "void":
      fail(path, "void is only meaningful as a whole method result, not as a value type.");
    default:
      fail(path, `unsupported type kind ${JSON.stringify((core as { kind: unknown }).kind)}`);
  }
}

function validateObjectFields(fields: readonly ObjectField[], path: string, declarations: DeclarationScope): void {
  const rustNames = new Map<string, string>();
  const wireNames = new Set<string>();
  fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    if (!WIRE_IDENTIFIER.test(field.name)) {
      fail(`${fieldPath}.name`, "wire fields must be unquoted JavaScript identifiers");
    }
    if (wireNames.has(field.name)) fail(`${fieldPath}.name`, `duplicate field ${field.name}`);
    wireNames.add(field.name);

    if (snakeCase(field.name) === "") {
      fail(`${fieldPath}.name`, `cannot derive a Rust field name from ${JSON.stringify(field.name)}`);
    }
    const rustName = rustValueIdentifier(field.name);
    const previous = rustNames.get(rustName);
    if (previous !== undefined) {
      fail(
        `${fieldPath}.name`,
        `${JSON.stringify(field.name)} and ${JSON.stringify(previous)} both map to the Rust field ${rustName}`,
      );
    }
    rustNames.set(rustName, field.name);
    validateTypeRef(field.type, `${fieldPath}.type`, declarations);
  });
}

/** Each literal must be distinct and derive its own Rust variant name. */
function validateVariantLiterals(values: readonly string[], valuePathOf: (index: number) => string): void {
  const literals = new Set<string>();
  const variants = new Map<string, string>();
  values.forEach((value, index) => {
    const valuePath = valuePathOf(index);
    if (literals.has(value)) fail(valuePath, `duplicate literal ${value}`);
    literals.add(value);
    const variant = enumVariantName(value);
    if (variant === "") {
      fail(valuePath, `cannot derive a Rust variant name from ${JSON.stringify(value)}: it holds no letter or digit`);
    }
    const previous = variants.get(variant);
    if (previous !== undefined) {
      fail(
        valuePath,
        `${JSON.stringify(value)} and ${JSON.stringify(previous)} both map to the Rust variant ${variant}`,
      );
    }
    variants.set(variant, value);
  });
}

function validateEnum(declaration: Extract<TypeDeclaration, { kind: "enum" }>, path: string): void {
  if (declaration.values.length === 0) fail(`${path}.values`, "enum must not be empty");
  validateVariantLiterals(declaration.values, (index) => `${path}.values[${index}]`);
}

function validateUnion(
  declaration: Extract<TypeDeclaration, { kind: "union" }>,
  path: string,
  declarations: DeclarationScope,
): void {
  if (declaration.variants.length === 0) fail(`${path}.variants`, "discriminated union must not be empty");
  if (!WIRE_IDENTIFIER.test(declaration.tag)) fail(`${path}.tag`, "the tag must be an unquoted JavaScript identifier");
  validateVariantLiterals(
    declaration.variants.map((variant) => variant.tag),
    (index) => `${path}.variants[${index}].tag`,
  );
  declaration.variants.forEach((variant, index) => {
    const variantPath = `${path}.variants[${index}]`;
    if (variant.fields.some((field) => field.name === declaration.tag)) {
      fail(`${variantPath}.fields`, `a field may not repeat the tag ${JSON.stringify(declaration.tag)}`);
    }
    validateObjectFields(variant.fields, variantPath, declarations);
  });
}

function validateDeclarationNames(schema: RpcSchema): void {
  const rustNames = new Map<string, string>();
  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}].name`;
    const rustName = rustTypeName(declaration.name);
    if (!isRustIdentifier(rustName)) {
      fail(path, `cannot derive a Rust type name from ${JSON.stringify(declaration.name)}`);
    }
    if (RESERVED_TYPE_NAMES.has(rustName)) {
      fail(
        path,
        `${JSON.stringify(declaration.name)} maps to the Rust type ${rustName}, which the generated module already uses. Rename the declaration.`,
      );
    }
    const previous = rustNames.get(rustName);
    if (previous !== undefined) {
      fail(path, `${JSON.stringify(declaration.name)} and ${JSON.stringify(previous)} both map to the Rust type ${rustName}`);
    }
    rustNames.set(rustName, declaration.name);
  });
}

function validateMethods(
  methods: readonly RpcMethod[],
  path: string,
  declarations: DeclarationScope,
  rustMethodName: (wireName: string) => string,
): void {
  const eventNames = new Set<string>();
  const rustNames = new Map<string, string>();
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

    if (snakeCase(method.name) === "") {
      fail(`${methodPath}.name`, `cannot derive a Rust method name from ${JSON.stringify(method.name)}`);
    }
    const rustName = rustMethodName(method.name);
    const previous = rustNames.get(rustName);
    if (previous !== undefined) {
      fail(
        `${methodPath}.name`,
        `${JSON.stringify(method.name)} and ${JSON.stringify(previous)} both map to the Rust method ${rustName}`,
      );
    }
    rustNames.set(rustName, method.name);

    const paramNames = new Set<string>();
    method.params.forEach((param, paramIndex) => {
      const paramPath = `${methodPath}.params[${paramIndex}]`;
      if (param.type.kind === "optional") {
        fail(
          paramPath,
          "optional positional parameters are ambiguous with Socket.IO acknowledgements. Make the parameter required, or move it into an object parameter where it can be omitted.",
        );
      }
      if (snakeCase(param.name) === "") {
        fail(`${paramPath}.name`, `cannot derive a Rust parameter name from ${JSON.stringify(param.name)}`);
      }
      const paramName = rustValueIdentifier(param.name);
      if (RESERVED_PARAMETER_NAMES.has(paramName)) {
        fail(
          `${paramPath}.name`,
          `${JSON.stringify(param.name)} maps to ${paramName}, which names the context parameter of the generated handler. Rename it — every other name is accepted.`,
        );
      }
      if (paramNames.has(paramName)) fail(`${paramPath}.name`, `duplicate generated parameter ${paramName}`);
      paramNames.add(paramName);
      validateTypeRef(param.type, `${paramPath}.type`, declarations);
    });

    if (method.returnType.kind !== "void") {
      validateTypeRef(method.returnType, `${methodPath}.returnType`, declarations);
    }
  });
}

/**
 * Validates a canonical schema against the Rust backend. Throws
 * `RustSchemaError` with the offending logical path on the first unsupported
 * shape. Both Rust sides accept the same contracts, so there is one pass.
 */
export function validateRustSchema(schema: RpcSchema, options: RustBackendOptions = {}): void {
  if (!schema || typeof schema !== "object") fail("schema", "expected an object");
  if (
    options.defaultTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0)
  ) {
    fail("options.defaultTimeoutMs", "must be a positive integer number of milliseconds");
  }

  validateDeclarationNames(schema);
  const declarations = declarationsByName(schema);
  schema.declarations.forEach((declaration, index) => {
    const path = `declarations[${index}]`;
    switch (declaration.kind) {
      case "object":
        validateObjectFields(declaration.fields, path, declarations);
        return;
      case "enum":
        validateEnum(declaration, path);
        return;
      case "union":
        validateUnion(declaration, path, declarations);
        return;
      case "alias":
        validateTypeRef(declaration.target, `${path}.target`, declarations);
        return;
      default:
        fail(`${path}.kind`, `unsupported declaration kind ${JSON.stringify((declaration as { kind: unknown }).kind)}`);
    }
  });

  validateMethods(
    schema.methods.filter((method) => method.direction === "client-to-server"),
    "clientToServer",
    declarations,
    handlerMethodName,
  );
  validateMethods(
    schema.methods.filter((method) => method.direction === "server-to-client"),
    "serverToClient",
    declarations,
    callMethodName,
  );

  const cycle = unboxedCycle(declarations);
  if (cycle) {
    fail(
      "declarations",
      `recursive value types need an optional, nullable, array or record hop on a field of an object type: ${cycle.join(" -> ")}`,
    );
  }
}
