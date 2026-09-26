/**
 * Schema-driven binary serialization, ported from the original
 * BinaryBuilder / BinaryParser (ref/, 2017) so it runs in both Bun and browsers.
 *
 * A struct maps field names to type ids, in wire order:
 *
 *   const User = { id: Type.UInt16, name: Type.String, tags: Type.Array8, tags_Type: Type.UInt8 };
 *   const Room = { users: Type.Object16, users_Struct: User };
 *
 * - Object8 / Object16: array of nested structs, described by "<field>_Struct".
 * - Array8 / Array16:   array of primitives, element type in "<field>_Type".
 *
 * Differences from the original:
 * - Writes into one growable buffer with DataView instead of one Buffer per field.
 * - Structs are compiled once (cached) instead of re-walked with for-in per call.
 * - Strings are UTF-8 with a UInt16 byte-length prefix (was UTF-16, zero-terminated).
 * - Object16 added; counts that overflow throw instead of silently writing 0.
 * - Int64 / UInt64 use BigInt DataView accessors (the old math was lossy).
 * - Little-endian, the original default.
 */

export const Type = {
  Int8: 1,
  UInt8: 2,
  Int16: 3,
  UInt16: 4,
  Int32: 5,
  UInt32: 6,
  Int64: 7,
  UInt64: 8,
  Float: 9,
  Double: 10,
  String: 11,
  Object8: 12,
  Array8: 13,
  Array16: 14,
  Object16: 15,
} as const;

export type TypeId = (typeof Type)[keyof typeof Type];

export interface Struct {
  [field: string]: TypeId | Struct;
}

interface Field {
  name: string;
  type: TypeId;
  /** Nested fields for Object8 / Object16. */
  fields?: Field[];
  /** Element type for Array8 / Array16. */
  element?: TypeId;
}

const compiled = new WeakMap<Struct, Field[]>();

function compile(struct: Struct): Field[] {
  const cached = compiled.get(struct);
  if (cached) return cached;
  const fields: Field[] = [];
  for (const name of Object.keys(struct)) {
    if (name.endsWith("_Struct") || name.endsWith("_Type")) continue;
    const type = struct[name] as TypeId;
    const field: Field = { name, type };
    if (type === Type.Object8 || type === Type.Object16) {
      const sub = struct[`${name}_Struct`];
      if (typeof sub !== "object") throw new Error(`Schema: ${name}_Struct is missing`);
      field.fields = compile(sub);
    } else if (type === Type.Array8 || type === Type.Array16) {
      const element = struct[`${name}_Type`];
      if (typeof element !== "number") throw new Error(`Schema: ${name}_Type is missing`);
      field.element = element as TypeId;
    }
    fields.push(field);
  }
  compiled.set(struct, fields);
  return fields;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ------------------------------------------------------------------ writing

class Writer {
  bytes = new Uint8Array(1024);
  view = new DataView(this.bytes.buffer);
  pos = 0;

  ensure(extra: number): void {
    if (this.pos + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  count(n: number, max: number, name: string): void {
    if (n > max) throw new RangeError(`Schema: ${name} has ${n} items, max ${max}`);
    if (max === 0xff) this.primitive(Type.UInt8, n);
    else this.primitive(Type.UInt16, n);
  }

  primitive(type: TypeId, v: unknown): void {
    const n = v as number;
    switch (type) {
      case Type.Int8:
        this.ensure(1);
        this.view.setInt8(this.pos, n);
        this.pos += 1;
        return;
      case Type.UInt8:
        this.ensure(1);
        this.view.setUint8(this.pos, n);
        this.pos += 1;
        return;
      case Type.Int16:
        this.ensure(2);
        this.view.setInt16(this.pos, n, true);
        this.pos += 2;
        return;
      case Type.UInt16:
        this.ensure(2);
        this.view.setUint16(this.pos, n, true);
        this.pos += 2;
        return;
      case Type.Int32:
        this.ensure(4);
        this.view.setInt32(this.pos, n, true);
        this.pos += 4;
        return;
      case Type.UInt32:
        this.ensure(4);
        this.view.setUint32(this.pos, n, true);
        this.pos += 4;
        return;
      case Type.Int64:
        this.ensure(8);
        this.view.setBigInt64(this.pos, BigInt(Math.trunc(n)), true);
        this.pos += 8;
        return;
      case Type.UInt64:
        this.ensure(8);
        this.view.setBigUint64(this.pos, BigInt(Math.trunc(n)), true);
        this.pos += 8;
        return;
      case Type.Float:
        this.ensure(4);
        this.view.setFloat32(this.pos, n, true);
        this.pos += 4;
        return;
      case Type.Double:
        this.ensure(8);
        this.view.setFloat64(this.pos, n, true);
        this.pos += 8;
        return;
      case Type.String: {
        const s = String(v);
        // UTF-8 needs at most 3 bytes per UTF-16 code unit.
        this.ensure(2 + s.length * 3);
        const { written } = utf8Encoder.encodeInto(s, this.bytes.subarray(this.pos + 2));
        if (written > 0xffff) throw new RangeError("Schema: string longer than 65535 bytes");
        this.view.setUint16(this.pos, written, true);
        this.pos += 2 + written;
        return;
      }
      default:
        throw new Error(`Schema: type ${type} is not a primitive`);
    }
  }

  struct(fields: Field[], data: Record<string, unknown>): void {
    for (const f of fields) {
      const value = data[f.name];
      if (value === undefined) throw new Error(`Schema: field ${f.name} is undefined`);
      if (f.fields) {
        const items = value as Record<string, unknown>[];
        this.count(items.length, f.type === Type.Object8 ? 0xff : 0xffff, f.name);
        for (const item of items) this.struct(f.fields, item);
      } else if (f.element) {
        const items = value as unknown[];
        this.count(items.length, f.type === Type.Array8 ? 0xff : 0xffff, f.name);
        for (const item of items) this.primitive(f.element, item);
      } else {
        this.primitive(f.type, value);
      }
    }
  }
}

// One scratch writer: encoding is synchronous, so it is never used re-entrantly.
const writer = new Writer();

/**
 * Serialize `data` with `struct`. When `prefix` is given it is written first
 * as a UInt8 (e.g. a message opcode). Returns a fresh, exactly-sized copy.
 */
export function encode(struct: Struct, data: object, prefix?: number): Uint8Array<ArrayBuffer> {
  writer.pos = 0;
  if (prefix !== undefined) writer.primitive(Type.UInt8, prefix);
  writer.struct(compile(struct), data as Record<string, unknown>);
  return writer.bytes.slice(0, writer.pos);
}

// ------------------------------------------------------------------ reading

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, offset: number) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  primitive(type: TypeId): unknown {
    const v = this.view;
    const p = this.pos;
    switch (type) {
      case Type.Int8:
        this.pos += 1;
        return v.getInt8(p);
      case Type.UInt8:
        this.pos += 1;
        return v.getUint8(p);
      case Type.Int16:
        this.pos += 2;
        return v.getInt16(p, true);
      case Type.UInt16:
        this.pos += 2;
        return v.getUint16(p, true);
      case Type.Int32:
        this.pos += 4;
        return v.getInt32(p, true);
      case Type.UInt32:
        this.pos += 4;
        return v.getUint32(p, true);
      case Type.Int64:
        this.pos += 8;
        return Number(v.getBigInt64(p, true));
      case Type.UInt64:
        this.pos += 8;
        return Number(v.getBigUint64(p, true));
      case Type.Float:
        this.pos += 4;
        return v.getFloat32(p, true);
      case Type.Double:
        this.pos += 8;
        return v.getFloat64(p, true);
      case Type.String: {
        const len = v.getUint16(p, true);
        const start = p + 2;
        if (start + len > this.bytes.byteLength) throw new RangeError("Schema: string past end of buffer");
        this.pos = start + len;
        return utf8Decoder.decode(this.bytes.subarray(start, start + len));
      }
      default:
        throw new Error(`Schema: type ${type} is not a primitive`);
    }
  }

  struct(fields: Field[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.fields) {
        const n = this.primitive(f.type === Type.Object8 ? Type.UInt8 : Type.UInt16) as number;
        const items = new Array(n);
        for (let i = 0; i < n; i++) items[i] = this.struct(f.fields);
        out[f.name] = items;
      } else if (f.element) {
        const n = this.primitive(f.type === Type.Array8 ? Type.UInt8 : Type.UInt16) as number;
        const items = new Array(n);
        for (let i = 0; i < n; i++) items[i] = this.primitive(f.element);
        out[f.name] = items;
      } else {
        out[f.name] = this.primitive(f.type);
      }
    }
    return out;
  }
}

/**
 * Parse `bytes` with `struct`, starting at `offset`. Throws RangeError on
 * truncated input, and on trailing bytes so malformed frames are rejected.
 */
export function decode<T>(struct: Struct, bytes: Uint8Array, offset = 0): T {
  const reader = new Reader(bytes, offset);
  const out = reader.struct(compile(struct));
  if (reader.pos !== bytes.byteLength) throw new RangeError("Schema: trailing bytes");
  return out as T;
}
