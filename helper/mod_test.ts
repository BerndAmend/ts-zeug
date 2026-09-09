/**
 * Copyright 2023-2026 Bernd Amend. MIT license.
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
  writer.addUint64(0x89abcdef);
  writer.addUint64(Number.MAX_SAFE_INTEGER);

  // Signed
  writer.addInt8(127);
  writer.addInt16(32767);
  writer.addInt32(0x77abcdef);
  writer.addInt64(0x77abcdef);
  writer.addInt64(Number.MAX_SAFE_INTEGER);
  writer.addInt8(-128);
  writer.addInt16(-32768);
  writer.addInt32(-2147483648);
  writer.addInt64(-2147483648);
  writer.addInt64(Number.MIN_SAFE_INTEGER);

  // BigInt
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigInt64(2n ** 62n);
  writer.addBigInt64(-(2n ** 62n));

  // BigUint for reading them with getBigUintOrUint64
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigUint64(2n ** 52n);
  writer.addBigUint64(2n ** 53n - 1n);
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
  assertEquals(reader.getUint64(), 0x89abcdef);
  assertEquals(reader.getUint64(), Number.MAX_SAFE_INTEGER);

  // Signed
  assertEquals(reader.getInt8(), 127);
  assertEquals(reader.getInt16(), 32767);
  assertEquals(reader.getInt32(), 0x77abcdef);
  assertEquals(reader.getInt64(), 0x77abcdef);
  assertEquals(reader.getInt64(), Number.MAX_SAFE_INTEGER);
  assertEquals(reader.getInt8(), -128);
  assertEquals(reader.getInt16(), -32768);
  assertEquals(reader.getInt32(), -2147483648);
  assertEquals(reader.getInt64(), -2147483648);
  assertEquals(reader.getInt64(), Number.MIN_SAFE_INTEGER);

  // BigInt / BigUint
  assertEquals(reader.getBigUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigInt64(), 2n ** 62n);
  assertEquals(reader.getBigInt64(), -(2n ** 62n));

  assertEquals(reader.getBigUintOrUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigUintOrUint64(), 2 ** 52);
  assertEquals(reader.getBigUintOrUint64(), 2 ** 53 - 1);

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

Deno.test("intoUint8Array works for SharedArrayBuffer", () => {
  const sab = new SharedArrayBuffer(4);
  const view = new Uint8Array(sab);
  view.set([10, 20, 30, 40]);
  const result = intoUint8Array(sab);
  assertEquals(Array.from(result), [10, 20, 30, 40]);
});

Deno.test("DataWriter and DataReader: large buffer handling", () => {
  const size = 100_000;
  const writer = new DataWriter({
    bufferSize: 16,
    automaticallyExtendBuffer: true,
  });

  // Write a large amount of data
  for (let i = 0; i < size; i++) {
    writer.addUint8(i & 0xff);
  }

  assertEquals(writer.pos, size);
  const buf = writer.getBufferView();
  assertEquals(buf.length, size);

  const reader = new DataReader(buf);
  for (let i = 0; i < size; i++) {
    assertEquals(reader.getUint8(), i & 0xff);
  }
  assertEquals(reader.hasMoreData, false);
});

Deno.test("DataWriter and DataReader: big-endian is the default", () => {
  const writer = new DataWriter({ bufferSize: 8 });
  assertEquals(writer.littleEndian, false);
  writer.addUint16(0x0102);
  writer.addUint16(0x0304);
  writer.addUint16(0x0506);
  writer.addUint16(0x0708);
  assertEquals(Array.from(writer.getBufferView()), [1, 2, 3, 4, 5, 6, 7, 8]);

  const reader = new DataReader(writer.getBufferView());
  assertEquals(reader.littleEndian, false);
  assertEquals(reader.getUint16(), 0x0102);
  assertEquals(reader.getUint16(), 0x0304);
  assertEquals(reader.getUint16(), 0x0506);
  assertEquals(reader.getUint16(), 0x0708);

  // buffer does not grow by default when writing beyond its capacity
  assertThrows(() => writer.addUint8(1));
});

Deno.test("DataWriter littleEndian: bytes are the reverse of big-endian", () => {
  const writes: Array<(w: DataWriter) => void> = [
    (w) => w.addUint16(0x1234),
    (w) => w.addInt16(-2),
    (w) => w.addUint32(0x89abcdef),
    (w) => w.addInt32(-2147483648),
    (w) => w.addUint64(Number.MAX_SAFE_INTEGER),
    (w) => w.addInt64(Number.MIN_SAFE_INTEGER),
    (w) => w.addFloat32(1.0),
    (w) => w.addFloat64(-1.5),
    (w) => w.addBigUint64(0x0102030405060708n),
    (w) => w.addBigInt64(-0x0102030405060708n),
  ];
  for (const add of writes) {
    const be = new DataWriter({
      bufferSize: 16,
      automaticallyExtendBuffer: true,
    });
    add(be);
    const le = new DataWriter({
      bufferSize: 16,
      automaticallyExtendBuffer: true,
      littleEndian: true,
    });
    add(le);
    const beBytes = Array.from(be.getBufferView());
    const leBytes = Array.from(le.getBufferView());
    assertEquals(leBytes, beBytes.slice().reverse());
    assertEquals(beBytes.length, leBytes.length);
  }
});

Deno.test("DataReader littleEndian: reads hand-crafted little-endian bytes", () => {
  const bytes = new Uint8Array([
    0x34,
    0x12, // uint16 0x1234
    0xfe,
    0xff, // int16 -2
    0x78,
    0x56,
    0x34,
    0x12, // uint32 0x12345678
    0x18,
    0xfc,
    0xff,
    0xff, // int32 -1000
    0x00,
    0x00,
    0x80,
    0x3f, // float32 1.0
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xf8,
    0xbf, // float64 -1.5
  ]);
  const reader = new DataReader(bytes, undefined, undefined, true);
  assertEquals(reader.getUint16(), 0x1234);
  assertEquals(reader.getInt16(), -2);
  assertEquals(reader.getUint32(), 0x12345678);
  assertEquals(reader.getInt32(), -1000);
  assertEquals(reader.getFloat32(), 1.0);
  assertEquals(reader.getFloat64(), -1.5);
  assertEquals(reader.pos, 24);
  assertEquals(reader.hasMoreData, false);

  // the same buffer interpreted as big-endian gives complementary results
  const beReader = new DataReader(bytes);
  assertEquals(beReader.getUint16(), 0x3412);
  assertEquals(beReader.getInt16(), -257);
});

Deno.test("DataReader littleEndian: reads 64-bit values", () => {
  // 0x0102030405060708 stored little-endian (least significant byte first)
  const a = new DataReader(
    new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    undefined,
    undefined,
    true,
  );
  assertEquals(a.getBigUint64(), 0x0102030405060708n);

  // -2 as little-endian
  const b = new DataReader(
    new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    undefined,
    undefined,
    true,
  );
  assertEquals(b.getBigInt64(), -2n);
  const bNum = new DataReader(
    new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    undefined,
    undefined,
    true,
  );
  assertEquals(bNum.getInt64(), -2);

  // 2^63 has the sign bit set: unsigned vs signed interpretation differs
  const signBitBytes = new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x80,
  ]);
  const c = new DataReader(signBitBytes, undefined, undefined, true);
  assertEquals(c.getBigUint64(), 2n ** 63n);
  const d = new DataReader(signBitBytes, undefined, undefined, true);
  assertEquals(d.getBigInt64(), -(2n ** 63n));

  // Number.MAX_SAFE_INTEGER stored little-endian
  const e = new DataReader(
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00]),
    undefined,
    undefined,
    true,
  );
  assertEquals(e.getUint64(), Number.MAX_SAFE_INTEGER);
});

Deno.test(
  "DataReader littleEndian: getBigUintOrUint64/getBigIntOrInt64 always return BigInt",
  () => {
    const writer = new DataWriter({
      bufferSize: 64,
      automaticallyExtendBuffer: true,
      littleEndian: true,
    });
    writer.addUint64(5);
    writer.addInt64(-3);
    writer.addUint64(2 ** 53 - 1);
    writer.addInt64(-(2 ** 53 - 1));
    const reader = new DataReader(
      writer.getBufferView(),
      undefined,
      undefined,
      true,
    );
    assertEquals(reader.getBigUintOrUint64(), 5n);
    assertEquals(reader.getBigIntOrInt64(), -3n);
    assertEquals(reader.getBigUintOrUint64(), BigInt(2 ** 53 - 1));
    assertEquals(reader.getBigIntOrInt64(), BigInt(-(2 ** 53 - 1)));
  },
);

Deno.test("DataReader littleEndian: getDataReader inherits endianness", () => {
  const writer = new DataWriter({
    bufferSize: 16,
    littleEndian: true,
  });
  writer.addUint16(0x0102);
  writer.addUint32(0x01020304);
  const reader = new DataReader(
    writer.getBufferView(),
    undefined,
    undefined,
    true,
  );
  const sub = reader.getDataReader(2);
  assertEquals(sub.littleEndian, true);
  assertEquals(sub.getUint16(), 0x0102);
  // parent reader continues little-endian after the sub-reader
  assertEquals(reader.getUint32(), 0x01020304);
});

Deno.test("DataWriter littleEndian: buffer grows while keeping byte order", () => {
  const writer = new DataWriter({
    bufferSize: 8,
    automaticallyExtendBuffer: true,
    littleEndian: true,
  });
  writer.addUint8(0xaa);
  writer.addUint16(0x1234);
  writer.addBigUint64(0x0102030405060708n);
  writer.addUint64(Number.MAX_SAFE_INTEGER);
  writer.addInt64(Number.MIN_SAFE_INTEGER);
  const reader = new DataReader(
    writer.getBufferView(),
    undefined,
    undefined,
    true,
  );
  assertEquals(reader.getUint8(), 0xaa);
  assertEquals(reader.getUint16(), 0x1234);
  assertEquals(reader.getBigUint64(), 0x0102030405060708n);
  assertEquals(reader.getUint64(), Number.MAX_SAFE_INTEGER);
  assertEquals(reader.getInt64(), Number.MIN_SAFE_INTEGER);
  assertEquals(reader.hasMoreData, false);
});

Deno.test("DataWriter and DataReader: little-endian roundtrip", () => {
  const writer = new DataWriter({
    bufferSize: 128,
    automaticallyExtendBuffer: true,
    littleEndian: true,
  });

  // Unsigned
  writer.addUint8(255);
  writer.addUint16(65535);
  writer.addUint32(0x89abcdef);
  writer.addUint64(0x89abcdef);
  writer.addUint64(Number.MAX_SAFE_INTEGER);

  // Signed
  writer.addInt8(127);
  writer.addInt16(32767);
  writer.addInt32(0x77abcdef);
  writer.addInt64(0x77abcdef);
  writer.addInt64(Number.MAX_SAFE_INTEGER);
  writer.addInt8(-128);
  writer.addInt16(-32768);
  writer.addInt32(-2147483648);
  writer.addInt64(-2147483648);
  writer.addInt64(Number.MIN_SAFE_INTEGER);

  // BigInt
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigInt64(2n ** 62n);
  writer.addBigInt64(-(2n ** 62n));

  // Values read back with getBigUintOrUint64/getBigIntOrInt64
  writer.addBigUint64(2n ** 64n - 1n);
  writer.addBigUint64(2n ** 52n);
  writer.addBigUint64(2n ** 53n - 1n);
  writer.addBigInt64(2n ** 63n - 1n);
  writer.addBigInt64(2n ** 52n);
  writer.addBigInt64(-(2n ** 62n));
  writer.addBigInt64(-(2n ** 52n));

  // Float
  writer.addFloat32(1.2345);
  writer.addFloat64(-9.87654321);

  const reader = new DataReader(
    writer.getBufferView(),
    undefined,
    undefined,
    true,
  );
  assertEquals(reader.littleEndian, true);

  // Unsigned
  assertEquals(reader.getUint8(), 255);
  assertEquals(reader.getUint16(), 65535);
  assertEquals(reader.getUint32(), 0x89abcdef);
  assertEquals(reader.getUint64(), 0x89abcdef);
  assertEquals(reader.getUint64(), Number.MAX_SAFE_INTEGER);

  // Signed
  assertEquals(reader.getInt8(), 127);
  assertEquals(reader.getInt16(), 32767);
  assertEquals(reader.getInt32(), 0x77abcdef);
  assertEquals(reader.getInt64(), 0x77abcdef);
  assertEquals(reader.getInt64(), Number.MAX_SAFE_INTEGER);
  assertEquals(reader.getInt8(), -128);
  assertEquals(reader.getInt16(), -32768);
  assertEquals(reader.getInt32(), -2147483648);
  assertEquals(reader.getInt64(), -2147483648);
  assertEquals(reader.getInt64(), Number.MIN_SAFE_INTEGER);

  // BigInt / BigUint
  assertEquals(reader.getBigUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigInt64(), 2n ** 62n);
  assertEquals(reader.getBigInt64(), -(2n ** 62n));

  // In little-endian mode these always return a BigInt
  assertEquals(reader.getBigUintOrUint64(), 2n ** 64n - 1n);
  assertEquals(reader.getBigUintOrUint64(), 2n ** 52n);
  assertEquals(reader.getBigUintOrUint64(), 2n ** 53n - 1n);
  assertEquals(reader.getBigIntOrInt64(), 2n ** 63n - 1n);
  assertEquals(reader.getBigIntOrInt64(), 2n ** 52n);
  assertEquals(reader.getBigIntOrInt64(), -(2n ** 62n));
  assertEquals(reader.getBigIntOrInt64(), -(2n ** 52n));

  // Float
  assertEquals(Math.abs(reader.getFloat32() - 1.2345) < 1e-6, true);
  assertEquals(Math.abs(reader.getFloat64() + 9.87654321) < 1e-10, true);
  assertEquals(reader.hasMoreData, false);
});
