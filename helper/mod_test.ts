/**
 * Copyright 2025 Bernd Amend. MIT license.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  DataReader,
  DataWriter,
  intoUint8Array,
  nanoid,
  toHexString,
} from "./mod.ts";

Deno.test("intoUint8Array works for Uint8Array", () => {
  const arr = new Uint8Array([1, 2, 3]);
  const result = intoUint8Array(arr);
  assertEquals(result, arr);
});

Deno.test("intoUint8Array works for ArrayBuffer", () => {
  const buf = new ArrayBuffer(3);
  const view = new Uint8Array(buf);
  view.set([1, 2, 3]);
  const result = intoUint8Array(buf);
  assertEquals(Array.from(result), [1, 2, 3]);
});

Deno.test("toHexString returns correct hex value", () => {
  const arr = [0, 15, 255];
  const hex = toHexString(arr);
  assertEquals(hex, "000fff");
});

Deno.test("nanoid returns correct length", () => {
  const id = nanoid(10);
  assertEquals(typeof id, "string");
  assertEquals(id.length, 10);
});

Deno.test("DataWriter and DataReader: all types roundtrip", () => {
  const writer = new DataWriter({
    bufferSize: 128,
    automaticallyExtendBuffer: true,
  });

  // Unsigned
  writer.addUint8(255);
  writer.addUint16(65535);
  writer.addUint32(0x89abcdef);
  writer.addUint64(Number.MAX_SAFE_INTEGER);

  // Signed
  writer.addInt8(-128);
  writer.addInt16(-32768);
  writer.addInt32(-2147483648);
  writer.addInt64(Number.MIN_SAFE_INTEGER);

  // BigInt
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigInt64(2n ** 62n);
  writer.addBigInt64(-(2n ** 62n));

  // BigUint for reading them with getBigUintOrUint64
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigUint64(2n ** 52n);
  // BigInt for reading them with getBigIntOrInt64
  writer.addBigInt64(2n ** 63n - 1n);
  writer.addBigInt64(2n ** 52n);
  writer.addBigInt64(-(2n ** 62n));
  writer.addBigInt64(-(2n ** 52n));

  // Float
  writer.addFloat32(1.2345);
  writer.addFloat64(-9.87654321);

  // String
  const str = "Hello, 世界";
  const encodedString = new TextEncoder().encode(str);
  writer.addArray(encodedString);

  // Array
  writer.addArray([10, 20, 30]);

  // Binary
  const bin = new Uint8Array([7, 8, 9]);
  writer.addArray(bin);

  const buf = writer.getBufferView();
  const reader = new DataReader(buf);

  // Unsigned
  assertEquals(reader.getUint8(), 255);
  assertEquals(reader.getUint16(), 65535);
  assertEquals(reader.getUint32(), 0x89abcdef);
  assertEquals(reader.getUint64(), Number.MAX_SAFE_INTEGER);

  // Signed
  assertEquals(reader.getInt8(), -128);
  assertEquals(reader.getInt16(), -32768);
  assertEquals(reader.getInt32(), -2147483648);
  assertEquals(reader.getInt64(), Number.MIN_SAFE_INTEGER);

  // BigInt / BigUint
  assertEquals(reader.getBigUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigInt64(), 2n ** 62n);
  assertEquals(reader.getBigInt64(), -(2n ** 62n));

  assertEquals(reader.getBigUintOrUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigUintOrUint64(), 2 ** 52);

  assertEquals(reader.getBigIntOrInt64(), 2n ** 63n - 1n);
  assertEquals(reader.getBigIntOrInt64(), 2 ** 52);
  assertEquals(reader.getBigIntOrInt64(), -(2n ** 62n));
  assertEquals(reader.getBigIntOrInt64(), -(2 ** 52));

  // Float
  assertEquals(Math.abs(reader.getFloat32() - 1.2345) < 1e-6, true);
  assertEquals(Math.abs(reader.getFloat64() + 9.87654321) < 1e-10, true);

  // String
  assertEquals(reader.getUTF8String(encodedString.length), str);

  // Array
  assertEquals(Array.from(reader.getUint8Array(3)), [10, 20, 30]);

  // Binary
  assertEquals(reader.getUint8Array(3), bin);
});

Deno.test("DataReader: getDataReader returns correct slice", () => {
  const arr = new Uint8Array([1, 2, 3, 4, 5]);
  const reader = new DataReader(arr);
  reader.getUint8();
  const sub = reader.getDataReader(2);
  assertEquals(sub.getUint8(), 2);
  assertEquals(sub.getUint8(), 3);
  assertEquals(sub.byteLength, 2);
});

Deno.test("DataReader: reading out of bounds throws", () => {
  const arr = new Uint8Array([1, 2, 3]);
  const reader = new DataReader(arr);
  assertThrows(() => reader.getUint32());
  assertThrows(() => reader.getFloat64());
  assertThrows(() => reader.getUTF8String(10));
  assertThrows(() => reader.getUint8Array(10));
  assertThrows(() => reader.getDataReader(10));
});

Deno.test("DataWriter: buffer grows automatically", () => {
  const writer = new DataWriter({
    bufferSize: 2,
    automaticallyExtendBuffer: true,
  });
  for (let i = 0; i < 100; ++i) {
    writer.addUint8(i);
  }
  const buf = writer.getBufferView();
  assertEquals(buf.length, 100);
  assertEquals(buf[0], 0);
  assertEquals(buf[99], 99);
});

Deno.test("DataWriter: buffer does not grow if not allowed", () => {
  const writer = new DataWriter({
    bufferSize: 2,
    automaticallyExtendBuffer: false,
  });
  writer.addUint16(1);
  assertThrows(() => writer.addUint8(2));
});

Deno.test("DataReader: subarray and slice", () => {
  const arr = new Uint8Array([1, 2, 3, 4, 5]);
  const reader = new DataReader(arr);
  const sub = reader.getUint8Array(3);
  assertEquals(Array.from(sub), [1, 2, 3]);
  assertEquals(reader.getUint8(), 4);
  assertEquals(reader.getUint8(), 5);
});
