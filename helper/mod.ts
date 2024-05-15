// Copyright 2023-2024 Bernd Amend. MIT license.
export { abortable, deadline, delay } from "@std/async";

export type Buffer =
  | ArrayLike<number>
  | Uint8Array
  | ArrayBufferView
  | ArrayBuffer;

export const __brand: unique symbol = Symbol("__brand");
export type Brand<B> = { [__brand]: B };
export type Branded<T, B> = T & Brand<B>;

export function intoUint8Array(
  buffer: Buffer,
): Uint8Array {
  if (buffer instanceof Uint8Array) {
    return buffer;
  } else if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  } else {
    return Uint8Array.from(buffer);
  }
}

/// based on the implementation from https://github.com/ai/nanoid
export type NanoID = Branded<string, "NanoID">;
export function nanoid(t = 21): NanoID {
  return crypto.getRandomValues(new Uint8Array(t))
    .reduce(
      (
        result,
        value,
      ) => (result += (value &= 63) < 36
        ? value.toString(36)
        : value < 62
        ? (value - 26).toString(36).toUpperCase()
        : value > 62
        ? "-"
        : "_"),
      "",
    ) as NanoID;
}

export function toHexString(arr: ArrayLike<number> | Iterable<number>): string {
  return Array.from(arr, (byte) => {
    return `0${(byte & 0xFF).toString(16)}`.slice(-2);
  }).join("");
}

export class DataReader {
  constructor(
    buffer: ArrayBuffer | SharedArrayBuffer | Uint8Array,
    byteOffset?: number,
    byteLength?: number,
  ) {
    if (buffer instanceof Uint8Array) {
      if (byteOffset !== undefined || byteLength !== undefined) {
        throw new Error("not supported");
      }
      this.#view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      this.#bytes = new Uint8Array(buffer.buffer);
    } else {
      this.#view = new DataView(buffer, byteOffset, byteLength);
      this.#bytes = new Uint8Array(buffer, byteOffset, byteLength);
    }
  }

  get remainingSize(): number {
    return this.#view.byteLength - this.pos;
  }

  get hasMoreData(): boolean {
    return this.pos < this.#view.byteLength;
  }

  getDataReader(length: number): DataReader {
    const pos = this.pos;
    if (length > (pos + this.#bytes.length)) {
      throw new Error(
        `length (${length}) exceeds the length of the buffer (${
          pos + this.#bytes.length
        })`,
      );
    }
    this.pos += length;
    return new DataReader(
      this.#view.buffer,
      this.#view.byteOffset + pos,
      length,
    );
  }

  getUint8(): number {
    const v = this.#view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  getInt8(): number {
    const v = this.#view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  getUint16(): number {
    const v = this.#view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  getInt16(): number {
    const v = this.#view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  getUint32(): number {
    const v = this.#view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  getInt32(): number {
    const v = this.#view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  getFloat32(): number {
    const v = this.#view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  getFloat64(): number {
    const v = this.#view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  getUint64(): number {
    const high = this.#view.getUint32(this.pos);
    const low = this.#view.getUint32(this.pos + 4);
    this.pos += 8;
    return high * 0x1_0000_0000 + low;
  }

  getInt64(): number {
    const high = this.#view.getInt32(this.pos);
    const low = this.#view.getUint32(this.pos + 4);
    this.pos += 8;
    return high * 0x1_0000_0000 + low;
  }

  getBigUint64(): bigint {
    const v = this.#view.getBigUint64(this.pos);
    this.pos += 8;
    return v;
  }

  getBigInt64(): bigint {
    const v = this.#view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }

  getBigUintOrUint64(): number | bigint {
    const high = this.#view.getUint32(this.pos);
    if (high < 2 ** 21) {
      return this.getUint64();
    }
    return this.getBigUint64();
  }

  getBigIntOrInt64(): number | bigint {
    // TODO: optimize
    const num = this.getBigInt64();
    if (
      num >= BigInt(Number.MIN_SAFE_INTEGER) &&
      num <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(num);
    }
    return num;
  }

  getUint8Array(size: number): Uint8Array {
    const v = this.#bytes.subarray(this.pos, this.pos + size);
    this.pos += size;
    return v;
  }

  getUTF8String(size: number): string {
    if (this.#textDecoder === undefined) {
      this.#textDecoder = new TextDecoder();
    }
    const arr = this.getUint8Array(size);
    try {
      return this.#textDecoder.decode(arr);
    } catch (e) {
      this.pos -= size;
      throw e;
    }
  }

  pos = 0;
  #view: DataView;
  #bytes: Uint8Array;
  #textDecoder?: TextDecoder;
}

export class DataWriter {
  constructor(
    options: { bufferSize: number; automaticallyExtendBuffer: boolean },
  ) {
    const buffer = new ArrayBuffer(options.bufferSize);
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.automaticallyExtendBuffer = options.automaticallyExtendBuffer;
  }

  reset() {
    this.pos = 0;
  }

  getBufferView(begin?: number, end?: number): Uint8Array {
    return this.bytes.subarray(begin ?? 0, end ?? this.pos);
  }

  ensureBufferSize(appendLength: number): void {
    if (!this.automaticallyExtendBuffer) {
      return;
    }
    const requiredSize = this.pos + appendLength;

    if (this.view.byteLength < requiredSize) {
      this.#resizeBuffer(requiredSize * 2);
    }
  }

  #resizeBuffer(newSize: number): void {
    const oldBytes = this.bytes;

    const buffer = new ArrayBuffer(newSize);
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);

    this.bytes.set(oldBytes);
  }

  addUint8(value: number) {
    this.ensureBufferSize(1);

    this.view.setUint8(this.pos, value);
    this.pos += 1;
  }

  addInt8(value: number) {
    this.ensureBufferSize(1);

    this.view.setInt8(this.pos, value);
    this.pos++;
  }

  addUint16(value: number) {
    this.ensureBufferSize(2);

    this.view.setUint16(this.pos, value);
    this.pos += 2;
  }

  addInt16(value: number) {
    this.ensureBufferSize(2);

    this.view.setInt16(this.pos, value);
    this.pos += 2;
  }

  addUint32(value: number) {
    this.ensureBufferSize(4);

    this.view.setUint32(this.pos, value);
    this.pos += 4;
  }

  addInt32(value: number) {
    this.ensureBufferSize(4);

    this.view.setInt32(this.pos, value);
    this.pos += 4;
  }

  addFloat32(value: number) {
    this.ensureBufferSize(4);

    this.view.setFloat32(this.pos, value);
    this.pos += 4;
  }

  addFloat64(value: number) {
    this.ensureBufferSize(8);

    this.view.setFloat64(this.pos, value);
    this.pos += 8;
  }

  addUint64(value: number) {
    if (!Number.isSafeInteger(value)) {
      console.warn(value, "exceeds MAX_SAFE_INTEGER. Precision may be lost");
    }
    this.ensureBufferSize(8);

    const high = value / 0x1_0000_0000;
    const low = value;
    this.view.setUint32(this.pos, high);
    this.view.setUint32(this.pos + 4, low);
    this.pos += 8;
  }

  addInt64(value: number) {
    if (!Number.isSafeInteger(value)) {
      console.warn(value, "exceeds MAX_SAFE_INTEGER. Precision may be lost");
    }
    this.ensureBufferSize(8);

    const high = Math.floor(value / 0x1_0000_0000);
    const low = value;
    this.view.setUint32(this.pos, high);
    this.view.setUint32(this.pos + 4, low);
    this.pos += 8;
  }

  addBigUint64(value: bigint) {
    this.ensureBufferSize(8);

    this.view.setBigUint64(this.pos, value);
    this.pos += 8;
  }

  addBigInt64(value: bigint) {
    this.ensureBufferSize(8);

    this.view.setBigInt64(this.pos, value);
    this.pos += 8;
  }

  addArray(values: ArrayLike<number>) {
    const size = values.length;
    this.ensureBufferSize(size);

    this.bytes.set(values, this.pos);
    this.pos += size;
  }

  pos = 0;
  protected view: DataView;
  protected bytes: Uint8Array;
  protected automaticallyExtendBuffer: boolean;
}

// https://jakearchibald.com/2017/async-iterators-and-generators/#making-streams-iterate
export async function* streamAsyncIterator<T>(
  stream: ReadableStream<T>,
): AsyncGenerator<Awaited<T>, void> {
  // Get a lock on the stream
  const reader = stream.getReader();

  try {
    while (true) {
      // Read from the stream
      const { done, value } = await reader.read();
      // Exit if we're done
      if (done) return;
      // Else yield the chunk
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
