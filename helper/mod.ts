/**
The MIT License (MIT)

Copyright (c) 2023 Bernd Amend <typescript@berndamend.de>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
export type Buffer =
  | ArrayLike<number>
  | Uint8Array
  | ArrayBufferView
  | ArrayBuffer;

declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
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

export function toHexString(arr: ArrayLike<number> | Iterable<number>) {
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
    // TODO: implement handling of byteOffset and byteLength
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
      throw new Error("length exceeds the length of the buffer");
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
    return this.#textDecoder.decode(this.getUint8Array(size));
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

  getBufferView = (begin?: number, end?: number) =>
    this.bytes.subarray(begin ?? 0, end ?? this.pos);

  ensureBufferSize(appendLength: number) {
    if (!this.automaticallyExtendBuffer) {
      return;
    }
    const requiredSize = this.pos + appendLength;

    if (this.view.byteLength < requiredSize) {
      this.#resizeBuffer(requiredSize * 2);
    }
  }

  #resizeBuffer(newSize: number) {
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
