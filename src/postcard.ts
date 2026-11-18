/**
 * Emits the TypeScript Postcard binary wire codec into `types.generated.ts`.
 *
 * The wire format matches the Rust (`mod rpc_postcard`) and Go (`rpc_appendPostcard` /
 * `rpc_readPostcard`) backends byte for byte:
 * - Booleans: 1 byte (`0` or `1`)
 * - Signed 64-bit integers (`@int`): ZigZag + unsigned LEB128 varint
 * - Unsigned lengths / discriminants (`u32` / `usize`): unsigned LEB128 varint
 * - Numbers (`f64`): 8-byte little-endian IEEE 754 float64
 * - Strings: varint UTF-8 byte length + UTF-8 bytes
 * - JSON values (`unknown`): varint UTF-8 byte length + JSON text
 * - Single `Option<T>` (`optional` or `nullable`): `0` for absent/null, `1` + `T` for value
 * - Double `Option<Option<T>>` (`optional` and `nullable`): `0` for `undefined`, `1` + `T` for value, `2` for `null`
 * - Arrays / Maps: varint count + elements / `(key, value)` pairs
 * - Structs: fields in declaration order with zero field-name overhead
 * - Enums / Discriminated Unions: varint variant index (`0..N-1`) + variant fields in declaration order
 * - Acknowledgements (`Result<T, RpcError>`): `0` + `T` for `Ok`, `1` + `RpcError` for `Err`
 */

import type { ObjectField, RpcMethod, RpcSchema, TypeDeclaration, TypeRef } from "./schema";

type DeclarationMap = ReadonlyMap<string, TypeDeclaration>;

interface UnwrappedTsType {
  readonly core: TypeRef;
  readonly optional: boolean;
  readonly nullable: boolean;
}

function unwrapTsType(
  ref: TypeRef,
  declarations: DeclarationMap,
  seen: ReadonlySet<string> = new Set(),
): UnwrappedTsType {
  let core = ref;
  let optional = false;
  let nullable = false;
  while (true) {
    if (core.kind === "optional") {
      optional = true;
      core = core.type;
      continue;
    }
    if (core.kind === "nullable") {
      nullable = true;
      core = core.type;
      continue;
    }
    if (core.kind === "named" && !seen.has(core.name)) {
      const decl = declarations.get(core.name);
      if (decl?.kind === "alias") {
        seen = new Set([...seen, core.name]);
        core = decl.target;
        continue;
      }
    }
    break;
  }
  if (core.kind === "json") {
    nullable = false;
  }
  return { core, optional, nullable };
}

export function methodHelperSuffix(direction: RpcMethod["direction"], methodName: string): string {
  const dir = direction === "client-to-server" ? "c2s" : "s2c";
  return `${dir}_${methodName}`;
}

function emitEncodeCore(
  core: TypeRef,
  valExpr: string,
  declarations: DeclarationMap,
  depth: number,
): string {
  switch (core.kind) {
    case "scalar":
      switch (core.name) {
        case "string":
          return `w.string(${valExpr});`;
        case "number":
          return `w.f64(${valExpr});`;
        case "integer":
          return `w.i64(${valExpr});`;
        case "boolean":
          return `w.bool(${valExpr});`;
      }
    case "void":
      return "";
    case "null":
      return `if (${valExpr} !== null) throw new TypeError("expected null");`;
    case "json":
      return `w.json(${valExpr});`;
    case "named":
      return `_rpcEncode_${core.name}(w, ${valExpr});`;
    case "array": {
      const itemVar = `_item${depth}`;
      return [
        `if (!Array.isArray(${valExpr})) throw new TypeError("expected array");`,
        `w.u32(${valExpr}.length);`,
        `for (const ${itemVar} of ${valExpr}) {`,
        emitEncodeTypeRef(core.element, itemVar, declarations, depth + 1),
        `}`,
      ].join("\n");
    }
    case "map": {
      const entriesVar = `_entries${depth}`;
      const kVar = `_k${depth}`;
      const vVar = `_v${depth}`;
      return [
        `if (typeof ${valExpr} !== "object" || ${valExpr} === null || Array.isArray(${valExpr})) throw new TypeError("expected map object");`,
        `const ${entriesVar} = Object.entries(${valExpr});`,
        `w.u32(${entriesVar}.length);`,
        `for (const [${kVar}, ${vVar}] of ${entriesVar}) {`,
        `w.string(${kVar});`,
        emitEncodeTypeRef(core.value, vVar, declarations, depth + 1),
        `}`,
      ].join("\n");
    }
    case "enum": {
      const litArray = JSON.stringify(core.values);
      const idxVar = `_idx${depth}`;
      return [
        `const ${idxVar} = (${litArray} as readonly string[]).indexOf(${valExpr} as string);`,
        `if (${idxVar} < 0) throw new TypeError("invalid enum value: " + String(${valExpr}));`,
        `w.u32(${idxVar});`,
      ].join("\n");
    }
    case "object": {
      const objVar = `_obj${depth}`;
      return [
        `if (typeof ${valExpr} !== "object" || ${valExpr} === null || Array.isArray(${valExpr})) throw new TypeError("expected object");`,
        `const ${objVar} = ${valExpr} as Record<string, any>;`,
        ...core.fields.map((field) =>
          emitEncodeTypeRef(field.type, `${objVar}[${JSON.stringify(field.name)}]`, declarations, depth + 1),
        ),
      ].join("\n");
    }
    case "union": {
      const uVar = `_u${depth}`;
      const cases = core.variants.map((variant, index) =>
        [
          `case ${JSON.stringify(variant.tag)}:`,
          `w.u32(${index});`,
          ...variant.fields.map((field) =>
            emitEncodeTypeRef(field.type, `${uVar}[${JSON.stringify(field.name)}]`, declarations, depth + 1),
          ),
          `break;`,
        ].join("\n"),
      );
      return [
        `if (typeof ${valExpr} !== "object" || ${valExpr} === null || Array.isArray(${valExpr})) throw new TypeError("expected union object");`,
        `const ${uVar} = ${valExpr} as Record<string, any>;`,
        `switch (${uVar}[${JSON.stringify(core.tag)}]) {`,
        ...cases,
        `default: throw new TypeError("invalid union tag: " + String(${uVar}[${JSON.stringify(core.tag)}]));`,
        `}`,
      ].join("\n");
    }
    case "optional":
    case "nullable":
      return emitEncodeTypeRef(core, valExpr, declarations, depth);
  }
}

export function emitEncodeTypeRef(
  ref: TypeRef,
  valExpr: string,
  declarations: DeclarationMap,
  depth = 0,
): string {
  const { core, optional, nullable } = unwrapTsType(ref, declarations);
  const vVar = `_val${depth}`;
  if (core.kind === "json") {
    if (!optional) {
      return `w.json(${valExpr});`;
    }
    return [
      `{`,
      `const ${vVar} = ${valExpr};`,
      `if (${vVar} === undefined) { w.u8(0); } else { w.u8(1); w.json(${vVar}); }`,
      `}`,
    ].join("\n");
  }
  if (optional && nullable) {
    return [
      `{`,
      `const ${vVar} = ${valExpr};`,
      `if (${vVar} === undefined) {`,
      `w.u8(0);`,
      `} else if (${vVar} === null) {`,
      `w.u8(2);`,
      `} else {`,
      `w.u8(1);`,
      emitEncodeCore(core, vVar, declarations, depth + 1),
      `}`,
      `}`,
    ].join("\n");
  }
  if (optional) {
    return [
      `{`,
      `const ${vVar} = ${valExpr};`,
      `if (${vVar} === undefined) {`,
      `w.u8(0);`,
      `} else if (${vVar} === null) {`,
      `throw new TypeError("expected value or undefined, got null");`,
      `} else {`,
      `w.u8(1);`,
      emitEncodeCore(core, vVar, declarations, depth + 1),
      `}`,
      `}`,
    ].join("\n");
  }
  if (nullable) {
    return [
      `{`,
      `const ${vVar} = ${valExpr};`,
      `if (${vVar} === null) {`,
      `w.u8(0);`,
      `} else if (${vVar} === undefined) {`,
      `throw new TypeError("expected value or null, got undefined");`,
      `} else {`,
      `w.u8(1);`,
      emitEncodeCore(core, vVar, declarations, depth + 1),
      `}`,
      `}`,
    ].join("\n");
  }
  return emitEncodeCore(core, valExpr, declarations, depth);
}

function emitDecodeFields(
  fields: readonly ObjectField[],
  outVar: string,
  declarations: DeclarationMap,
  depth: number,
): string[] {
  return fields.map((field, index) => {
    const fVar = `_f${depth}_${index}`;
    return [
      `const ${fVar} = ${emitDecodeTypeRef(field.type, declarations, depth + 1)};`,
      `if (${fVar} !== undefined) ${outVar}[${JSON.stringify(field.name)}] = ${fVar};`,
    ].join("\n");
  });
}

function emitDecodeCore(core: TypeRef, declarations: DeclarationMap, depth: number): string {
  switch (core.kind) {
    case "scalar":
      switch (core.name) {
        case "string":
          return "r.string()";
        case "number":
          return "r.f64()";
        case "integer":
          return "r.i64()";
        case "boolean":
          return "r.bool()";
      }
    case "void":
      return "undefined";
    case "null":
      return "null";
    case "json":
      return "r.json()";
    case "named":
      return `_rpcDecode_${core.name}(r)`;
    case "array": {
      const lenVar = `_len${depth}`;
      const arrVar = `_arr${depth}`;
      const iVar = `_i${depth}`;
      return [
        `(() => {`,
        `const ${lenVar} = r.u32();`,
        `const ${arrVar}: any[] = [];`,
        `for (let ${iVar} = 0; ${iVar} < ${lenVar}; ${iVar}++) {`,
        `${arrVar}.push(${emitDecodeTypeRef(core.element, declarations, depth + 1)});`,
        `}`,
        `return ${arrVar};`,
        `})()`,
      ].join("\n");
    }
    case "map": {
      const lenVar = `_len${depth}`;
      const mapVar = `_map${depth}`;
      const iVar = `_i${depth}`;
      const kVar = `_k${depth}`;
      return [
        `(() => {`,
        `const ${lenVar} = r.u32();`,
        `const ${mapVar}: Record<string, any> = {};`,
        `for (let ${iVar} = 0; ${iVar} < ${lenVar}; ${iVar}++) {`,
        `const ${kVar} = r.string();`,
        `${mapVar}[${kVar}] = ${emitDecodeTypeRef(core.value, declarations, depth + 1)};`,
        `}`,
        `return ${mapVar};`,
        `})()`,
      ].join("\n");
    }
    case "enum": {
      const litArray = JSON.stringify(core.values);
      const idxVar = `_idx${depth}`;
      const valsVar = `_vals${depth}`;
      return [
        `(() => {`,
        `const ${valsVar} = ${litArray} as const;`,
        `const ${idxVar} = r.u32();`,
        `if (${idxVar} >= ${valsVar}.length) throw new TypeError("invalid enum discriminant: " + String(${idxVar}));`,
        `return ${valsVar}[${idxVar}];`,
        `})()`,
      ].join("\n");
    }
    case "object": {
      const outVar = `_out${depth}`;
      return [
        `(() => {`,
        `const ${outVar}: Record<string, any> = {};`,
        ...emitDecodeFields(core.fields, outVar, declarations, depth),
        `return ${outVar};`,
        `})()`,
      ].join("\n");
    }
    case "union": {
      const tagVar = `_tag${depth}`;
      const outVar = `_out${depth}`;
      const cases = core.variants.map((variant, index) =>
        [
          `case ${index}: {`,
          `const ${outVar}: Record<string, any> = { ${JSON.stringify(core.tag)}: ${JSON.stringify(variant.tag)} };`,
          ...emitDecodeFields(variant.fields, outVar, declarations, depth + 1),
          `return ${outVar};`,
          `}`,
        ].join("\n"),
      );
      return [
        `(() => {`,
        `const ${tagVar} = r.u32();`,
        `switch (${tagVar}) {`,
        ...cases,
        `default: throw new TypeError("invalid union discriminant: " + String(${tagVar}));`,
        `}`,
        `})()`,
      ].join("\n");
    }
    case "optional":
    case "nullable":
      return emitDecodeTypeRef(core, declarations, depth);
  }
}

export function emitDecodeTypeRef(
  ref: TypeRef,
  declarations: DeclarationMap,
  depth = 0,
): string {
  const { core, optional, nullable } = unwrapTsType(ref, declarations);
  if (core.kind === "json") {
    if (!optional) {
      return "r.json()";
    }
    return `(r.bool() ? r.json() : undefined)`;
  }
  if (optional && nullable) {
    const tagVar = `_opt${depth}`;
    return [
      `(() => {`,
      `const ${tagVar} = r.u8();`,
      `if (${tagVar} === 0) return undefined;`,
      `if (${tagVar} === 2) return null;`,
      `if (${tagVar} === 1) return ${emitDecodeCore(core, declarations, depth + 1)};`,
      `throw new TypeError("invalid double option discriminant: " + String(${tagVar}));`,
      `})()`,
    ].join("\n");
  }
  if (optional) {
    return `(r.bool() ? ${emitDecodeCore(core, declarations, depth + 1)} : undefined)`;
  }
  if (nullable) {
    return `(r.bool() ? ${emitDecodeCore(core, declarations, depth + 1)} : null)`;
  }
  return emitDecodeCore(core, declarations, depth);
}

const POSTCARD_RUNTIME_TS = `
// === POSTCARD BINARY CODEC ===
const _rpcTextEncoder = new TextEncoder();
const _rpcTextDecoder = new TextDecoder("utf-8", { fatal: true });

export class RpcPostcardWriter {
    private buf = new Uint8Array(64);
    private view = new DataView(this.buf.buffer);
    private pos = 0;

    private ensure(extra: number): void {
        if (this.pos + extra <= this.buf.length) return;
        let next = this.buf.length * 2;
        while (next < this.pos + extra) next *= 2;
        const grown = new Uint8Array(next);
        grown.set(this.buf.subarray(0, this.pos));
        this.buf = grown;
        this.view = new DataView(this.buf.buffer);
    }

    u8(v: number): void {
        this.ensure(1);
        this.buf[this.pos++] = v & 0xff;
    }

    bool(v: boolean): void {
        if (typeof v !== "boolean") throw new TypeError("expected boolean");
        this.u8(v ? 1 : 0);
    }

    u32(v: number): void {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
            throw new TypeError("expected u32");
        }
        let n = v >>> 0;
        while (n >= 0x80) {
            this.u8((n & 0x7f) | 0x80);
            n >>>= 7;
        }
        this.u8(n);
    }

    i64(v: number): void {
        if (typeof v !== "number" || !Number.isInteger(v)) {
            throw new TypeError("expected integer");
        }
        const big = BigInt(v);
        if (big < -9223372036854775808n || big > 9223372036854775807n) {
            throw new TypeError("integer out of i64 range");
        }
        let u = BigInt.asUintN(64, (big << 1n) ^ (big >> 63n));
        while (u >= 0x80n) {
            this.u8(Number(u & 0x7fn) | 0x80);
            u >>= 7n;
        }
        this.u8(Number(u));
    }

    f64(v: number): void {
        if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new TypeError("expected finite number");
        }
        this.ensure(8);
        this.view.setFloat64(this.pos, v, true);
        this.pos += 8;
    }

    string(v: string): void {
        if (typeof v !== "string") throw new TypeError("expected string");
        const bytes = _rpcTextEncoder.encode(v);
        this.u32(bytes.length);
        this.ensure(bytes.length);
        this.buf.set(bytes, this.pos);
        this.pos += bytes.length;
    }

    json(v: unknown): void {
        const encoded = v === undefined ? "null" : JSON.stringify(v);
        if (encoded === undefined) throw new TypeError("value is not JSON-encodable");
        this.string(encoded);
    }

    finish(): Uint8Array {
        return this.buf.slice(0, this.pos);
    }
}

export class RpcPostcardReader {
    private readonly buf: Uint8Array;
    private readonly view: DataView;
    private pos = 0;

    constructor(input: unknown) {
        if (input instanceof Uint8Array) {
            this.buf = input;
        } else if (input instanceof ArrayBuffer) {
            this.buf = new Uint8Array(input);
        } else if (ArrayBuffer.isView(input)) {
            this.buf = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        } else {
            throw new TypeError("expected binary postcard payload");
        }
        this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    }

    u8(): number {
        if (this.pos >= this.buf.length) throw new RangeError("unexpected end of postcard buffer");
        return this.buf[this.pos++]!;
    }

    bool(): boolean {
        const b = this.u8();
        if (b === 0) return false;
        if (b === 1) return true;
        throw new TypeError("invalid postcard bool discriminant: " + String(b));
    }

    u32(): number {
        let result = 0;
        let shift = 0;
        while (true) {
            if (shift >= 35) throw new RangeError("postcard u32 varint overflow");
            const b = this.u8();
            const low = b & 0x7f;
            if (shift === 28 && low > 0x0f) throw new RangeError("postcard u32 varint overflow");
            result = (result | (low << shift)) >>> 0;
            if ((b & 0x80) === 0) return result;
            shift += 7;
        }
    }

    i64(): number {
        let u = 0n;
        let shift = 0n;
        while (true) {
            if (shift >= 70n) throw new RangeError("postcard i64 varint overflow");
            const b = this.u8();
            const low = BigInt(b & 0x7f);
            if (shift === 63n && low > 1n) throw new RangeError("postcard i64 varint overflow");
            u |= low << shift;
            if ((b & 0x80) === 0) break;
            shift += 7n;
        }
        const signed = BigInt.asIntN(64, (u >> 1n) ^ (-(u & 1n)));
        return Number(signed);
    }

    f64(): number {
        if (this.pos + 8 > this.buf.length) throw new RangeError("unexpected end of postcard buffer");
        const v = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        if (!Number.isFinite(v)) throw new TypeError("non-finite float64 in postcard buffer");
        return v;
    }

    string(): string {
        const len = this.u32();
        if (this.pos + len > this.buf.length) throw new RangeError("unexpected end of postcard buffer");
        const sub = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return _rpcTextDecoder.decode(sub);
    }

    json(): unknown {
        return JSON.parse(this.string());
    }

    done(): void {
        if (this.pos !== this.buf.length) {
            throw new RangeError("trailing bytes in postcard buffer: " + String(this.buf.length - this.pos));
        }
    }
}

export function rpcEncodeError(w: RpcPostcardWriter, err: RpcError): void {
    w.string(err.code);
    w.string(err.message);
    if (err.method === undefined || err.method === "") {
        w.u8(0);
    } else {
        w.u8(1);
        w.string(err.method);
    }
    if (err.data === undefined) {
        w.u8(0);
    } else {
        w.u8(1);
        w.json(err.data);
    }
}

export function rpcDecodeError(r: RpcPostcardReader): RpcError {
    const code = r.string();
    const message = r.string();
    const method = r.bool() ? r.string() : undefined;
    const data = r.bool() ? r.json() : undefined;
    const out: RpcError = { __rpcError: true, code, message };
    if (method !== undefined) out.method = method;
    if (data !== undefined) out.data = data;
    return out;
}

export function rpcEncodeErrorFrame(err: RpcError): Uint8Array {
    const w = new RpcPostcardWriter();
    rpcEncodeError(w, err);
    return w.finish();
}

export function rpcDecodeErrorFrame(raw: unknown, fallbackMethod?: string): RpcError {
    if (isRpcError(raw)) return raw;
    try {
        const r = new RpcPostcardReader(raw);
        const err = rpcDecodeError(r);
        r.done();
        if (fallbackMethod !== undefined && err.method === undefined) err.method = fallbackMethod;
        return err;
    } catch (err) {
        return toRpcError(err, { code: RpcErrorCodes.INTERNAL_ERROR, method: fallbackMethod });
    }
}

export function rpcEncodeErrorResult(err: RpcError): Uint8Array {
    const w = new RpcPostcardWriter();
    w.u32(1);
    rpcEncodeError(w, err);
    return w.finish();
}
`;

export function emitTypeScriptPostcardCodec(schema: RpcSchema): string {
  const declarations: DeclarationMap = new Map(schema.declarations.map((d) => [d.name, d]));
  const declBlocks: string[] = [];

  for (const decl of schema.declarations) {
    switch (decl.kind) {
      case "enum":
        declBlocks.push(
          [
            `function _rpcEncode_${decl.name}(w: RpcPostcardWriter, v: any): void {`,
            emitEncodeCore({ kind: "enum", values: decl.values }, "v", declarations, 0),
            `}`,
            `function _rpcDecode_${decl.name}(r: RpcPostcardReader): any {`,
            `return ${emitDecodeCore({ kind: "enum", values: decl.values }, declarations, 0)};`,
            `}`,
          ].join("\n"),
        );
        break;
      case "object":
        declBlocks.push(
          [
            `function _rpcEncode_${decl.name}(w: RpcPostcardWriter, v: any): void {`,
            emitEncodeCore({ kind: "object", fields: decl.fields }, "v", declarations, 0),
            `}`,
            `function _rpcDecode_${decl.name}(r: RpcPostcardReader): any {`,
            `return ${emitDecodeCore({ kind: "object", fields: decl.fields }, declarations, 0)};`,
            `}`,
          ].join("\n"),
        );
        break;
      case "union":
        declBlocks.push(
          [
            `function _rpcEncode_${decl.name}(w: RpcPostcardWriter, v: any): void {`,
            emitEncodeCore({ kind: "union", tag: decl.tag, variants: decl.variants }, "v", declarations, 0),
            `}`,
            `function _rpcDecode_${decl.name}(r: RpcPostcardReader): any {`,
            `return ${emitDecodeCore({ kind: "union", tag: decl.tag, variants: decl.variants }, declarations, 0)};`,
            `}`,
          ].join("\n"),
        );
        break;
      case "alias":
        declBlocks.push(
          [
            `function _rpcEncode_${decl.name}(w: RpcPostcardWriter, v: any): void {`,
            emitEncodeTypeRef(decl.target, "v", declarations, 0),
            `}`,
            `function _rpcDecode_${decl.name}(r: RpcPostcardReader): any {`,
            `return ${emitDecodeTypeRef(decl.target, declarations, 0)};`,
            `}`,
          ].join("\n"),
        );
        break;
    }
  }

  const methodBlocks: string[] = [];
  for (const method of schema.methods) {
    const suffix = methodHelperSuffix(method.direction, method.name);
    const paramArgs = method.params.map((_, idx) => `_p${idx}: any`).join(", ");
    const encodeParams = method.params.map((param, idx) =>
      [
        `let _b${idx}: Uint8Array;`,
        `try {`,
        `const w = new RpcPostcardWriter();`,
        emitEncodeTypeRef(param.type, `_p${idx}`, declarations, 0),
        `_b${idx} = w.finish();`,
        `} catch (err) {`,
        `throw { __rpcError: true, code: RpcErrorCodes.INVALID_ARGUMENT, message: "invalid argument ${param.name}: " + (err instanceof Error ? err.message : String(err)), method: ${JSON.stringify(method.name)} } as RpcError;`,
        `}`,
      ].join("\n"),
    );
    const decodeParams = method.params.map((param, idx) =>
      [
        `let _a${idx}: any;`,
        `try {`,
        `const r = new RpcPostcardReader(rawArgs[${idx}]);`,
        `_a${idx} = ${emitDecodeTypeRef(param.type, declarations, 0)};`,
        `r.done();`,
        `} catch (err) {`,
        `throw { __rpcError: true, code: RpcErrorCodes.INVALID_ARGUMENT, message: "invalid argument ${param.name}: " + (err instanceof Error ? err.message : String(err)), method: ${JSON.stringify(method.name)} } as RpcError;`,
        `}`,
      ].join("\n"),
    );

    methodBlocks.push(
      [
        `export function rpcEncodeArgs_${suffix}(${paramArgs}): Uint8Array[] {`,
        ...encodeParams,
        `return [${method.params.map((_, idx) => `_b${idx}`).join(", ")}];`,
        `}`,
        `export function rpcDecodeArgs_${suffix}(rawArgs: unknown[]): any[] {`,
        `if (rawArgs.length !== ${method.params.length}) {`,
        `throw { __rpcError: true, code: RpcErrorCodes.INVALID_ARGUMENT, message: "expected ${method.params.length} arguments, got " + String(rawArgs.length), method: ${JSON.stringify(method.name)} } as RpcError;`,
        `}`,
        ...decodeParams,
        `return [${method.params.map((_, idx) => `_a${idx}`).join(", ")}];`,
        `}`,
      ].join("\n"),
    );

    if (method.returnType.kind !== "void") {
      methodBlocks.push(
        [
          `export function rpcEncodeResult_${suffix}(value: any): Uint8Array {`,
          `const w = new RpcPostcardWriter();`,
          `w.u32(0);`,
          emitEncodeTypeRef(method.returnType, "value", declarations, 0),
          `return w.finish();`,
          `}`,
          `export function rpcDecodeResult_${suffix}(raw: unknown): any {`,
          `if (isRpcError(raw)) return raw;`,
          `try {`,
          `const r = new RpcPostcardReader(raw);`,
          `const tag = r.u32();`,
          `if (tag === 0) {`,
          `const val = ${emitDecodeTypeRef(method.returnType, declarations, 0)};`,
          `r.done();`,
          `return val;`,
          `}`,
          `if (tag === 1) {`,
          `const err = rpcDecodeError(r);`,
          `r.done();`,
          `if (err.method === undefined) err.method = ${JSON.stringify(method.name)};`,
          `return err;`,
          `}`,
          `throw new TypeError("invalid result discriminant: " + String(tag));`,
          `} catch (err) {`,
          `return { __rpcError: true, code: RpcErrorCodes.INVALID_ARGUMENT, message: "invalid acknowledgement payload: " + (err instanceof Error ? err.message : String(err)), method: ${JSON.stringify(method.name)} } as RpcError;`,
          `}`,
          `}`,
        ].join("\n"),
      );
    }
  }

  return [POSTCARD_RUNTIME_TS, ...declBlocks, ...methodBlocks].join("\n\n");
}
