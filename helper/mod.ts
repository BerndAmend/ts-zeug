/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
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

/**
 * based on the implementation from https://github.com/ai/nanoid
 */
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
  /**
   * Creates a new DataReader instance.
   * @param buffer - The source buffer, can be a DataReader or Uint8Array.
   * @param byteOffset - The offset in bytes from the start of the buffer.
   *                     If a DataReader is passed, the pos is ignored, use getDataReader() instead.
   * @param byteLength - The length in bytes to read from the buffer.
   */
  constructor(
    buffer: DataReader | Uint8Array | ArrayBuffer,
    byteOffset?: number,
    byteLength?: number,
  ) {
    byteOffset ??= 0;
    byteLength ??= buffer.byteLength;

    if (byteOffset < 0 || byteLength < 0) {
      throw new Error("byteOffset and byteLength must be non-negative");
    }
    if (
      byteOffset + byteLength > buffer.byteLength
    ) {
      throw new Error(
        `byteOffset (${byteOffset}) + byteLength (${byteLength}) exceeds buffer length (${buffer.byteLength})`,
      );
    }
    if (buffer instanceof DataReader) {
      this.#buffer = buffer.#buffer;
      this.#byteOffset = byteOffset + buffer.#byteOffset;
      this.byteLength = byteLength;
      this.#view = buffer.#view;
    } else {
      this.#buffer = intoUint8Array(buffer);
      this.#byteOffset = byteOffset;
      this.byteLength = byteLength;
      this.#view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
    }
  }

  get remainingSize(): number {
    return this.byteLength - this.#pos;
  }

  get hasMoreData(): boolean {
    return this.#pos < this.byteLength;
  }

  getDataReader(byteLength: number): DataReader {
    const pos = this.#getReadPosition(byteLength);
    return new DataReader(this, pos - this.#byteOffset, byteLength);
  }

  getUint8(): number {
    return this.#view.getUint8(this.#getReadPosition(1));
  }

  getInt8(): number {
    return this.#view.getInt8(this.#getReadPosition(1));
  }

  getUint16(): number {
    return this.#view.getUint16(this.#getReadPosition(2));
  }

  getInt16(): number {
    return this.#view.getInt16(this.#getReadPosition(2));
  }

  getUint32(): number {
    return this.#view.getUint32(this.#getReadPosition(4));
  }

  getInt32(): number {
    return this.#view.getInt32(this.#getReadPosition(4));
  }

  getFloat32(): number {
    return this.#view.getFloat32(this.#getReadPosition(4));
  }

  getFloat64(): number {
    return this.#view.getFloat64(this.#getReadPosition(8));
  }

  getUint64(): number {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getUint32(pos);
    const low = this.#view.getUint32(pos + 4);
    return high * 0x1_0000_0000 + low;
  }

  getInt64(): number {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getInt32(pos);
    const low = this.#view.getUint32(pos + 4);
    return high * 0x1_0000_0000 + low;
  }

  getBigUint64(): bigint {
    return this.#view.getBigUint64(this.#getReadPosition(8));
  }

  getBigInt64(): bigint {
    return this.#view.getBigInt64(this.#getReadPosition(8));
  }

  getBigUintOrUint64(): number | bigint {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getUint32(pos);
    // Checks if the value is a safe integer (<= 2 ** 53)
    // If the high part is less or equal than 2**21, we can safely return a number without losing precision.
    if (high <= 0x200_000) {
      const low = this.#view.getUint32(pos + 4);
      return high * 0x1_0000_0000 + low;
    }
    this.#pos -= 8;
    return this.getBigUint64();
  }

  getBigIntOrInt64(): number | bigint {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getInt32(pos);
    // Checks if the value is a safe integer (< 2 ** 53)
    // If the high part is less than 2**21, we can safely return a number without losing precision.
    if (high >= -0x200_000 && high <= 0x200_000) {
      const low = this.#view.getUint32(pos + 4);
      return high * 0x1_0000_0000 + low;
    }
    this.#pos -= 8;
    return this.getBigInt64();
  }

  getUint8Array(byteLength: number): Uint8Array {
    const pos = this.#getReadPosition(byteLength);
    return this.#buffer.subarray(
      pos,
      this.#byteOffset + this.#pos,
    );
  }

  getUTF8String(byteLength: number): string {
    const arr = this.getUint8Array(byteLength);
    try {
      return DataReader.textDecoder.decode(arr);
    } catch (e) {
      this.#pos -= byteLength;
      throw e;
    }
  }

  /**
   * @returns A Uint8Array representing the entire buffer from byteOffset to byteOffset + byteLength.
   * This method is useful for getting the full data read by this DataReader.
   * Note that this does not modify the position of the DataReader.
   */
  asUint8Array(): Uint8Array {
    return this.#buffer.subarray(
      this.#byteOffset,
      this.#byteOffset + this.byteLength,
    );
  }

  get pos(): number {
    return this.#pos;
  }

  set pos(value: number) {
    if (value < 0 || value > this.byteLength) {
      throw new Error(
        `pos (${value}) must be between 0 and ${this.byteLength}`,
      );
    }
    this.#pos = value;
  }

  #getReadPosition(byteLength: number): number {
    if (this.#pos + byteLength > this.byteLength) {
      throw new Error(
        `length (${byteLength}) exceeds the remaining size of the buffer (${
          this.byteLength - this.#pos
        })`,
      );
    }
    const pos = this.#pos;
    this.#pos += byteLength;
    return this.#byteOffset + pos;
  }

  #pos = 0;
  readonly byteLength: number;
  #byteOffset: number;
  /**
   * If a DataReader is created from another DataReader, this will be the original buffer.
   * If a DataReader is created from a Uint8Array, this will be the same input Uint8Array.
   * This member is private to ensure that only the data within the range from byteOffset
   * to byteOffset + byteLength is accessed.
   */
  #buffer: Uint8Array;
  /**
   * If a DataReader is created from another DataReader, this will be the original DataView.
   * If a DataReader is created from a Uint8Array, this will be a new DataView of the same buffer.
   * This member is private to ensure that only the data within the range from byteOffset
   * to byteOffset + byteLength is accessed.
   */
  #view: DataView;
  /**
   * A TextDecoder instance for UTF-8 string decoding.
   * This is a static property to avoid creating a new instance for every DataReader.
   */
  static textDecoder: TextDecoder = new TextDecoder();
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

    const high = Math.floor(value / 0x1_0000_0000);
    const low = value | 0;
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
    const low = value | 0;
    this.view.setInt32(this.pos, high);
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

/**
 * https://jakearchibald.com/2017/async-iterators-and-generators/#making-streams-iterate
 */
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
