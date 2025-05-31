/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 * Implementation of msgpack as described in https://github.com/msgpack/msgpack/blob/master/spec.md
 */
import { DataReader, DataWriter, intoUint8Array } from "../helper/mod.ts";

const enum Formats {
  positive_fixint_start = 0x00,
  positive_fixint_end = 0x7f,

  fixmap_start = 0x80,
  fixmap_end = 0x8f,

  fixarray_start = 0x90,
  fixarray_end = 0x9f,

  fixstr_start = 0xa0,
  fixstr_end = 0xbf,

  nil = 0xc0,
  never_used = 0xc1,
  boolean_false = 0xc2,
  boolean_true = 0xc3,
  bin_8 = 0xc4,
  bin_16 = 0xc5,
  bin_32 = 0xc6,
  ext_8 = 0xc7,
  ext_16 = 0xc8,
  ext_32 = 0xc9,
  float_32 = 0xca,
  float_64 = 0xcb,
  uint_8 = 0xcc,
  uint_16 = 0xcd,
  uint_32 = 0xce,
  uint_64 = 0xcf,
  int_8 = 0xd0,
  int_16 = 0xd1,
  int_32 = 0xd2,
  int_64 = 0xd3,
  fixext_1 = 0xd4,
  fixext_2 = 0xd5,
  fixext_4 = 0xd6,
  fixext_8 = 0xd7,
  fixext_16 = 0xd8,
  str_8 = 0xd9,
  str_16 = 0xda,
  str_32 = 0xdb,
  array_16 = 0xdc,
  array_32 = 0xdd,
  map_16 = 0xde,
  map_32 = 0xdf,

  negative_fixint_start = 0xe0,
  negative_fixint_end = 0xff,
}

const enum Length {
  bit_8 = 2 ** 8 - 1,
  bit_16 = 2 ** 16 - 1,
  bit_32 = 2 ** 32 - 1,
  max_header_length = 1 + 4,
}

const enum Extensions {
  TimeStamp = -1,
}

const enum NumericLimits {
  negative_fixint_min = -0x20,
  int_8_min = -0x80,
  int_16_min = -0x8000,
  int_32_min = -0x80000000,

  positive_fixint_max = Formats.positive_fixint_end,
  uint_8_max = 0x100 - 1,
  uint_16_max = 0x10000 - 1,
  uint_32_max = 0x100000000 - 1,
}

export class Serializer {
  constructor(
    options: { bufferSize: number; automaticallyExtendBuffer: boolean } = {
      bufferSize: 2048,
      automaticallyExtendBuffer: true,
    },
  ) {
    this.#writer = new DataWriter(options);
  }

  getBufferView(): Uint8Array {
    return this.#writer.getBufferView();
  }

  reset() {
    this.#writer.reset();
  }

  addNil() {
    this.#addFormat(Formats.nil);
  }

  addBoolean(value: boolean) {
    this.#addFormat(value ? Formats.boolean_true : Formats.boolean_false);
  }

  // TODO: how to handle unsafe numbers?
  addInt(num: number) {
    if (num >= 0) {
      if (num <= NumericLimits.positive_fixint_max) {
        this.#writer.addUint8(num); // Formats.positive_fixint
      } else if (num <= NumericLimits.uint_8_max) {
        this.#addFormat(Formats.uint_8);
        this.#writer.addUint8(num);
      } else if (num <= NumericLimits.uint_16_max) {
        this.#addFormat(Formats.uint_16);
        this.#writer.addUint16(num);
      } else if (num <= NumericLimits.uint_32_max) {
        this.#addFormat(Formats.uint_32);
        this.#writer.addUint32(num);
      } else {
        this.#addFormat(Formats.uint_64);
        this.#writer.addUint64(num);
      }
    } else {
      if (num >= NumericLimits.negative_fixint_min) {
        this.#writer.addUint8(
          Formats.negative_fixint_start |
            (num - NumericLimits.negative_fixint_min),
        );
      } else if (num >= NumericLimits.int_8_min) {
        this.#addFormat(Formats.int_8);
        this.#writer.addInt8(num);
      } else if (num >= NumericLimits.int_16_min) {
        this.#addFormat(Formats.int_16);
        this.#writer.addInt16(num);
      } else if (num >= NumericLimits.int_32_min) {
        this.#addFormat(Formats.int_32);
        this.#writer.addInt32(num);
      } else {
        this.#addFormat(Formats.int_64);
        this.#writer.addInt64(num);
      }
    }
  }

  addBigInt(num: bigint) {
    if (
      num >= BigInt(Number.MIN_SAFE_INTEGER) &&
      num <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      this.addInt(Number(num));
    } else if (num >= 0n) {
      this.#addFormat(Formats.uint_64);
      this.#writer.addBigUint64(num);
    } else {
      this.#addFormat(Formats.int_64);
      this.#writer.addBigInt64(num);
    }
  }

  addFloat32(num: number): void {
    if (Number.isSafeInteger(num)) {
      return this.addInt(num);
    }
    this.#addFormat(Formats.float_32);
    this.#writer.addFloat32(num);
  }

  addFloat64(num: number): void {
    if (Number.isSafeInteger(num)) {
      return this.addInt(num);
    }
    this.#addFormat(Formats.float_64);
    this.#writer.addFloat64(num);
  }

  addString(str: string) {
    const utf8 = this.#textEncoder.encode(str);
    this.#writer.ensureBufferSize(
      utf8.byteLength + Length.max_header_length,
    );
    if (utf8.byteLength < 31) {
      this.#addFormat(Formats.fixstr_start | utf8.byteLength);
    } else if (utf8.byteLength < Length.bit_8) {
      this.#addFormat(Formats.str_8);
      this.#writer.addUint8(utf8.byteLength);
    } else if (utf8.byteLength < Length.bit_16) {
      this.#addFormat(Formats.str_16);
      this.#writer.addUint16(utf8.byteLength);
    } else if (utf8.byteLength < Length.bit_32) {
      this.#addFormat(Formats.str_32);
      this.#writer.addUint32(utf8.byteLength);
    } else {
      throw new Error(
        `string length exceeds the limit of msgpack length: ${utf8.byteLength}`,
      );
    }
    this.#writer.addArray(utf8);
  }

  addBinary(array: ArrayBufferView) {
    const data = intoUint8Array(array);
    this.#writer.ensureBufferSize(
      data.byteLength + Length.max_header_length,
    );
    if (data.byteLength < Length.bit_8) {
      this.#addFormat(Formats.bin_8);
      this.#writer.addUint8(data.byteLength);
    } else if (data.byteLength < Length.bit_16) {
      this.#addFormat(Formats.bin_16);
      this.#writer.addUint16(data.byteLength);
    } else if (data.byteLength < Length.bit_32) {
      this.#addFormat(Formats.bin_32);
      this.#writer.addUint32(data.byteLength);
    } else {
      throw new Error(
        `string length exceeds the limit of msgpack length: ${array.byteLength}`,
      );
    }
    this.#writer.addArray(data);
  }

  /**
   * the number of objects in the map will be 2*lenInObjects (key+value)
   */
  addMapHeader(lenInObjects: number) {
    if (lenInObjects < 16) {
      this.#addFormat(Formats.fixmap_start | lenInObjects);
    } else if (lenInObjects < Length.bit_16) {
      this.#addFormat(Formats.map_16);
      this.#writer.addUint16(lenInObjects);
    } else { // the max length of typescript arrays is 2**32-1
      this.#addFormat(Formats.map_32);
      this.#writer.addUint32(lenInObjects);
    }
  }

  addArrayHeader(lenInObjects: number) {
    if (lenInObjects < 16) {
      this.#addFormat(Formats.fixarray_start | lenInObjects);
    } else if (lenInObjects < Length.bit_16) {
      this.#addFormat(Formats.array_16);
      this.#writer.addUint16(lenInObjects);
    } else { // the max length of typescript arrays is 2**32-1
      this.#addFormat(Formats.array_32);
      this.#writer.addUint32(lenInObjects);
    }
  }

  addExt(typeAsInt8: number, array: ArrayBufferView) {
    if (typeAsInt8 < -128 || typeAsInt8 > 128) {
      throw new Error("typeAsInt8 is out of range (-128<x<128)");
    }

    const data = intoUint8Array(array);
    if (data.byteLength == 1) {
      this.#addFormat(Formats.fixext_1);
    } else if (data.byteLength == 2) {
      this.#addFormat(Formats.fixext_2);
    } else if (data.byteLength == 4) {
      this.#addFormat(Formats.fixext_4);
    } else if (data.byteLength == 8) {
      this.#addFormat(Formats.fixext_8);
    } else if (data.byteLength == 16) {
      this.#addFormat(Formats.fixext_16);
    } else if (data.byteLength < Length.bit_8) {
      this.#addFormat(Formats.ext_8);
      this.#writer.addUint8(data.byteLength);
    } else if (data.byteLength < Length.bit_16) {
      this.#addFormat(Formats.ext_16);
      this.#writer.addUint16(data.byteLength);
    } else if (data.byteLength < Length.bit_32) {
      this.#addFormat(Formats.ext_32);
      this.#writer.addUint32(data.byteLength);
    }
    this.#writer.addInt8(typeAsInt8);
    this.#writer.addArray(data);
  }

  addDate(date: Date) {
    // The following code ensures nsec is unsigned.
    const { sec, nsec } = (() => {
      const msec = date.getTime();
      const sec = Math.floor(msec / 1e3);
      const nsec = (msec - sec * 1e3) * 1e6;

      const nsecInSec = Math.floor(nsec / 1e9);
      return {
        sec: sec + nsecInSec,
        nsec: nsec - nsecInSec * 1e9,
      };
    })();

    const TIMESTAMP32_MAX_SEC = 0x100000000 - 1; // 32-bit unsigned int
    const TIMESTAMP64_MAX_SEC = 0x400000000 - 1; // 34-bit unsigned int

    const writer = new DataWriter({
      bufferSize: 12,
      automaticallyExtendBuffer: false,
    });

    if (sec >= 0 && nsec >= 0 && sec <= TIMESTAMP64_MAX_SEC) {
      if (nsec === 0 && sec <= TIMESTAMP32_MAX_SEC) {
        // timestamp 32
        writer.addUint32(sec);
      } else {
        // timestamp 64
        const secHigh = sec / 0x100000000;
        const secLow = sec & 0xffffffff;
        writer.addUint32((nsec << 2) | (secHigh & 0x3));
        writer.addUint32(secLow);
      }
    } else {
      // timestamp 96
      writer.addUint32(nsec);
      writer.addInt64(sec);
    }
    this.addExt(Extensions.TimeStamp, writer.getBufferView());
  }

  // TODO: is it necessary to skip undefined value and not to transfer them?
  add(
    // deno-lint-ignore no-explicit-any
    arg: any,
    options = {
      transferTypedArraysAsBinary: false,
      serializeNumbersAsFloats: false,
    },
  ): void {
    switch (typeof arg) {
      case "string":
        return this.addString(arg);
      case "number":
        if (options.serializeNumbersAsFloats) {
          return this.addFloat32(arg);
        } else {
          return this.addFloat64(arg);
        }
      case "bigint":
        return this.addBigInt(arg);
      case "boolean":
        return this.addBoolean(arg);
      case "symbol":
        throw new Error("Cannot serialize symbol");
      case "undefined":
        return this.addNil();
      case "object":
        if (arg === null) {
          return this.addNil();
        }
        if (
          arg instanceof Uint8Array || arg instanceof Int8Array ||
          arg instanceof Uint8ClampedArray ||
          arg instanceof DataView ||
          (options.transferTypedArraysAsBinary && ArrayBuffer.isView(arg))
        ) {
          return this.addBinary(arg);
        }
        if (
          Array.isArray(arg) ||
          arg instanceof Int16Array || arg instanceof Uint16Array ||
          arg instanceof Int32Array || arg instanceof Uint32Array ||
          arg instanceof BigInt64Array || arg instanceof BigUint64Array ||
          arg instanceof Float32Array || arg instanceof Float64Array
        ) {
          this.addArrayHeader(arg.length);
          for (const o of arg) {
            this.add(o);
          }
          return;
        }
        if (arg instanceof Map) {
          this.addMapHeader(arg.size);
          for (const [k, v] of arg) {
            this.add(k);
            this.add(v);
          }
          return;
        }
        if (arg instanceof Set) {
          this.addArrayHeader(arg.size);
          for (const o of arg) {
            this.add(o);
          }
          return;
        }
        if (arg instanceof Date) {
          this.addDate(arg);
          return;
        }
        {
          const keys = Object.keys(arg);
          this.addMapHeader(keys.length);
          for (const k of keys) {
            this.add(k);
            this.add(arg[k]);
          }
        }
        return;
      case "function":
        throw new Error("Cannot serialize function");
    }
  }

  #addFormat(format: Formats) {
    this.#writer.addUint8(format);
  }

  #writer: DataWriter;
  #textEncoder = new TextEncoder();
}

export function serialize(
  arg: unknown,
): Uint8Array {
  const s = new Serializer();
  s.add(arg);
  return s.getBufferView();
}

/**
 * https://github.com/msgpack/msgpack/blob/master/spec.md#timestamp-extension-type
 */
function deserializeTimestampExtension(reader: DataReader): Date {
  const asDate = (sec: number, nsec: number) =>
    new Date(sec * 1e3 + nsec / 1e6);

  switch (reader.remainingSize) {
    case 4: {
      const sec = reader.getUint32();
      return asDate(sec, 0);
    }
    case 8: {
      const nsec30AndSecHigh2 = reader.getUint32();
      const secLow32 = reader.getUint32();
      const sec = (nsec30AndSecHigh2 & 0x3) * 0x100000000 + secLow32;
      const nsec = nsec30AndSecHigh2 >>> 2;
      return asDate(sec, nsec);
    }
    case 12: {
      const nsec = reader.getUint32();
      const sec = reader.getInt64();
      return asDate(sec, nsec);
    }
    default:
      throw new Error(
        `Unexpected timestamp data size (expected [4, 8, 12]) got ${reader.remainingSize}`,
      );
  }
}

export function deserialize(
  buffer: DataReader | Uint8Array,
  extensionHandler?: (type: number, data: DataReader) => unknown,
): unknown[] {
  const reader = buffer instanceof DataReader ? buffer : new DataReader(buffer);

  const handleExtension = (type: number, reader: DataReader) => {
    if (type === Extensions.TimeStamp) {
      return deserializeTimestampExtension(reader);
    }
    if (extensionHandler === undefined) {
      throw new Error(`cannot handle unknown extension ${type}`);
    }
    return extensionHandler(type, reader);
  };

  const handleArray = (length: number) => {
    const r = new Array(length);
    for (let i = 0; i < length; ++i) {
      r[i] = next();
    }
    return r;
  };

  const handleMap = (length: number) => {
    // deno-lint-ignore no-explicit-any
    const r: any = {};
    for (let i = 0; i < length; ++i) {
      const k = next();
      const v = next();
      r[k] = v;
    }
    return r;
  };

  const next = () => {
    const format = reader.getUint8() as Formats;
    // Formats.positive_fixint
    if (format <= Formats.positive_fixint_end) {
      return format as number;
    }
    // Formats.negative_fixint
    if (format >= Formats.negative_fixint_start) {
      return ((format as number) & 0b1_1111) +
        NumericLimits.negative_fixint_min;
    }

    // Formats.fixmap:
    if ((format & 0b1111_0000) === Formats.fixmap_start) {
      return handleMap((format as number) & 0b1111);
    }

    // Formats.fixarray:
    if ((format & 0b1111_0000) === Formats.fixarray_start) {
      return handleArray((format as number) & 0b1111);
    }

    if ((format & 0b1010_0000) === Formats.fixstr_start) {
      return reader.getUTF8String(format & 0b1_1111);
    }

    switch (format) {
      case Formats.nil:
        return undefined;
      case Formats.never_used:
        return;
      case Formats.boolean_false:
        return false;
      case Formats.boolean_true:
        return true;
      case Formats.bin_8:
        return reader.getUint8Array(reader.getUint8());
      case Formats.bin_16:
        return reader.getUint8Array(reader.getUint16());
      case Formats.bin_32:
        return reader.getUint8Array(reader.getUint32());
      case Formats.ext_8: {
        const length = reader.getUint8();
        const type = reader.getInt8();
        return handleExtension(type, reader.getDataReader(length));
      }
      case Formats.ext_16: {
        const length = reader.getUint16();
        const type = reader.getInt8();
        return handleExtension(type, reader.getDataReader(length));
      }
      case Formats.ext_32: {
        const length = reader.getUint32();
        const type = reader.getInt8();
        return handleExtension(type, reader.getDataReader(length));
      }
      case Formats.float_32:
        return reader.getFloat32();
      case Formats.float_64:
        return reader.getFloat64();
      case Formats.uint_8:
        return reader.getUint8();
      case Formats.uint_16:
        return reader.getUint16();
      case Formats.uint_32:
        return reader.getUint32();
      case Formats.uint_64:
        return reader.getBigUintOrUint64();
      case Formats.int_8:
        return reader.getInt8();
      case Formats.int_16:
        return reader.getInt16();
      case Formats.int_32:
        return reader.getInt32();
      case Formats.int_64:
        return reader.getBigIntOrInt64();
      case Formats.fixext_1:
        return handleExtension(reader.getInt8(), reader.getDataReader(1));
      case Formats.fixext_2:
        return handleExtension(reader.getInt8(), reader.getDataReader(2));
      case Formats.fixext_4:
        return handleExtension(reader.getInt8(), reader.getDataReader(4));
      case Formats.fixext_8:
        return handleExtension(reader.getInt8(), reader.getDataReader(8));
      case Formats.fixext_16:
        return handleExtension(reader.getInt8(), reader.getDataReader(16));
      case Formats.str_8:
        return reader.getUTF8String(reader.getUint8());
      case Formats.str_16:
        return reader.getUTF8String(reader.getUint16());
      case Formats.str_32:
        return reader.getUTF8String(reader.getUint32());
      case Formats.array_16:
        return handleArray(reader.getUint16());
      case Formats.array_32:
        return handleArray(reader.getUint32());
      case Formats.map_16:
        return handleMap(reader.getUint16());
      case Formats.map_32:
        return handleMap(reader.getUint32());
    }
  };

  const out = [];
  while (reader.hasMoreData) {
    out.push(next());
  }

  return out;
}
