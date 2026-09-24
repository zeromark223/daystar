import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode, Type, type Struct } from "./schema.ts";

const Item: Struct = { id: Type.UInt16, score: Type.Float, label: Type.String };
const All: Struct = {
  i8: Type.Int8,
  u8: Type.UInt8,
  i16: Type.Int16,
  u16: Type.UInt16,
  i32: Type.Int32,
  u32: Type.UInt32,
  i64: Type.Int64,
  u64: Type.UInt64,
  f: Type.Float,
  d: Type.Double,
  s: Type.String,
  items: Type.Object8,
  items_Struct: Item,
  nums: Type.Array16,
  nums_Type: Type.Int32,
};

test("every type round-trips", () => {
  const value = {
    i8: -100,
    u8: 250,
    i16: -30000,
    u16: 60000,
    i32: -2_000_000_000,
    u32: 4_000_000_000,
    i64: -9_007_199_254_740_991,
    u64: 2 ** 40 + 7,
    f: 1.5,
    d: Math.PI,
    s: "Xin chào 🦌",
    items: [
      { id: 1, score: 0.25, label: "a" },
      { id: 2, score: -8, label: "" },
    ],
    nums: [1, -2, 3],
  };
  assert.deepEqual(decode(All, encode(All, value)), value);
});

test("prefix byte is written first and skipped by offset", () => {
  const bytes = encode({ n: Type.UInt16 }, { n: 513 }, 42);
  assert.deepEqual([...bytes], [42, 1, 2]); // little-endian
  assert.deepEqual(decode({ n: Type.UInt16 }, bytes, 1), { n: 513 });
});

test("Object16 holds more than 255 items and Object8 refuses them", () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: i, score: i, label: String(i) }));
  const big: Struct = { items: Type.Object16, items_Struct: Item };
  assert.equal(decode<{ items: unknown[] }>(big, encode(big, { items: many })).items.length, 1000);
  assert.throws(() => encode({ items: Type.Object8, items_Struct: Item }, { items: many }), RangeError);
});

test("strings are UTF-8 with a length prefix", () => {
  const bytes = encode({ s: Type.String }, { s: "hi" });
  assert.deepEqual([...bytes], [2, 0, 104, 105]);
  // Embedded NUL survives (the old zero-terminated format would cut here).
  assert.deepEqual(decode({ s: Type.String }, encode({ s: Type.String }, { s: "a\u0000b" })), { s: "a\u0000b" });
});

test("large payloads grow the scratch buffer", () => {
  const s = "x".repeat(50_000);
  assert.equal(decode<{ s: string }>({ s: Type.String }, encode({ s: Type.String }, { s })).s, s);
});

test("malformed input throws", () => {
  const bytes = encode(Item, { id: 1, score: 2, label: "abc" });
  assert.throws(() => decode(Item, bytes.subarray(0, bytes.length - 1)), RangeError);
  assert.throws(() => decode(Item, new Uint8Array([...bytes, 0])), RangeError);
  assert.throws(() => encode(Item, { id: 1, score: 2 }), /label/);
  assert.throws(() => encode({ list: Type.Object8 }, { list: [] }), /list_Struct/);
});
