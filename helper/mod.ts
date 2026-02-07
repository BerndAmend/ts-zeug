/**
 * Helper utilities for binary data handling, readers, writers, and more.
 *
 * @module
 * @license MIT
 * @copyright 2023-2026 Bernd Amend
 */
export { abortable, deadline, delay } from "@std/async";

/**
 * Represents a buffer-like type that can be used for binary data operations.
 * Includes typed arrays, array buffers, and array-like objects.
 */
export type Buffer =
  | ArrayLike<number>
  | Uint8Array
  | ArrayBufferView
  | ArrayBuffer
  | SharedArrayBuffer;

/**
 * Symbol used for nominal/branded types.
 * @see {@link Branded}
 */
export const __brand: unique symbol = Symbol("__brand");

/**
 * A brand type that adds a unique type tag to a value.
 * @template B - The brand identifier type
 */
export type Brand<B> = { [__brand]: B };

/**
 * Creates a branded/nominal type by intersecting a base type with a brand.
 * Useful for creating distinct types that are structurally identical.
 * @template T - The base type to brand
 * @template B - The brand identifier type
 * @example
 * ```ts
 * type SomeBrandedType = Branded<string, "SomeBrandedType">;
 * type SomeOtherBrandedType = Branded<string, "SomeOtherBrandedType">;
 * // SomeBrandedType and SomeOtherBrandedType are now incompatible despite both being strings
 * ```
 */
export type Branded<T, B> = T & Brand<B>;

/**
 * Converts various buffer types to a Uint8Array.
 * For ArrayBufferView, this returns a view with the same underlying buffer.
 * For ArrayLike<number>, this creates a copy.
 * @param buffer - The input buffer to convert
 * @returns A Uint8Array representing the buffer contents
 */
export function intoUint8Array(
  buffer: Buffer,
): Uint8Array {
  if (buffer instanceof Uint8Array) {
    return buffer;
  } else if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else if (
    buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer
  ) {
    return new Uint8Array(buffer);
  } else {
    return Uint8Array.from(buffer);
  }
}

/**
 * A branded string type representing a NanoID.
 * @see {@link nanoid}
 */
export type NanoID = Branded<string, "NanoID">;

/**
 * Generates a cryptographically secure random string ID.
 * Based on the implementation from {@link https://github.com/ai/nanoid}.
 * @param t - The length of the ID to generate (default: 21)
 * @returns A random NanoID string
 * @example
 * ```ts
 * const id = nanoid(); // e.g. "V1StGXR8_Z5jdHi6B-myT"
 * const shortId = nanoid(10); // e.g. "IRFa-VaY2b"
 * ```
 */
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

/**
 * Converts an array of bytes to a hexadecimal string.
 * @param arr - The byte array to convert
 * @returns A lowercase hexadecimal string representation
 * @example
 * ```ts
 * toHexString([0xde, 0xad, 0xbe, 0xef]); // "deadbeef"
 * ```
 */
export function toHexString(arr: ArrayLike<number> | Iterable<number>): string {
  return Array.from(arr, (byte) => {
    return `0${(byte & 0xFF).toString(16)}`.slice(-2);
  }).join("");
}

/**
 * A binary data reader that provides methods to read various data types from a buffer.
 * Supports reading integers (8/16/32/64 bit), floats, strings, and sub-readers.
 * All multi-byte reads use big-endian byte order.
 */
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

  /** Returns the number of bytes remaining to be read. */
  get remainingSize(): number {
    return this.byteLength - this.#pos;
  }

  /** Returns true if there is more data to read. */
  get hasMoreData(): boolean {
    return this.#pos < this.byteLength;
  }

  /**
   * Creates a new DataReader for a slice of the current buffer.
   * @param byteLength - Number of bytes to include in the sub-reader
   * @returns A new DataReader for the specified slice
   * @throws If byteLength exceeds remaining buffer size
   */
  getDataReader(byteLength: number): DataReader {
    const pos = this.#getReadPosition(byteLength);
    return new DataReader(this, pos - this.#byteOffset, byteLength);
  }

  /** Reads an unsigned 8-bit integer and advances the position. */
  getUint8(): number {
    return this.#view.getUint8(this.#getReadPosition(1));
  }

  /** Reads a signed 8-bit integer and advances the position. */
  getInt8(): number {
    return this.#view.getInt8(this.#getReadPosition(1));
  }

  /** Reads an unsigned 16-bit integer (big-endian) and advances the position. */
  getUint16(): number {
    return this.#view.getUint16(this.#getReadPosition(2));
  }

  /** Reads a signed 16-bit integer (big-endian) and advances the position. */
  getInt16(): number {
    return this.#view.getInt16(this.#getReadPosition(2));
  }

  /** Reads an unsigned 32-bit integer (big-endian) and advances the position. */
  getUint32(): number {
    return this.#view.getUint32(this.#getReadPosition(4));
  }

  /** Reads a signed 32-bit integer (big-endian) and advances the position. */
  getInt32(): number {
    return this.#view.getInt32(this.#getReadPosition(4));
  }

  /** Reads a 32-bit IEEE 754 floating point (big-endian) and advances the position. */
  getFloat32(): number {
    return this.#view.getFloat32(this.#getReadPosition(4));
  }

  /** Reads a 64-bit IEEE 754 floating point (big-endian) and advances the position. */
  getFloat64(): number {
    return this.#view.getFloat64(this.#getReadPosition(8));
  }

  /**
   * Reads an unsigned 64-bit integer as a JavaScript number.
   * @warning Values > Number.MAX_SAFE_INTEGER will lose precision. Use getBigUint64() for full precision.
   */
  getUint64(): number {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getUint32(pos);
    const low = this.#view.getUint32(pos + 4);
    return high * 0x1_0000_0000 + low;
  }

  /**
   * Reads a signed 64-bit integer as a JavaScript number.
   * @warning Values outside safe integer range will lose precision. Use getBigInt64() for full precision.
   */
  getInt64(): number {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getInt32(pos);
    const low = this.#view.getUint32(pos + 4);
    return high * 0x1_0000_0000 + low;
  }

  /** Reads an unsigned 64-bit integer as a BigInt (full precision). */
  getBigUint64(): bigint {
    return this.#view.getBigUint64(this.#getReadPosition(8));
  }

  /** Reads a signed 64-bit integer as a BigInt (full precision). */
  getBigInt64(): bigint {
    return this.#view.getBigInt64(this.#getReadPosition(8));
  }

  /**
   * Reads an unsigned 64-bit integer, returning a number if safe, otherwise a BigInt.
   * @returns A number if the value is <= Number.MAX_SAFE_INTEGER, otherwise a BigInt
   */
  getBigUintOrUint64(): number | bigint {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getUint32(pos);
    // Checks if the value is a safe integer (<= 2 ** 53 - 1)
    // MAX_SAFE_INTEGER (2^53 - 1) has high 0x1FFFFF, which is < 0x200_000.
    // 2^53 (high 0x200_000) is unsafe.
    if (high < 0x200_000) {
      const low = this.#view.getUint32(pos + 4);
      return high * 0x1_0000_0000 + low;
    }
    this.#pos -= 8;
    return this.getBigUint64();
  }

  /**
   * Reads a signed 64-bit integer, returning a number if safe, otherwise a BigInt.
   * @returns A number if the value is within safe integer range, otherwise a BigInt
   */
  getBigIntOrInt64(): number | bigint {
    const pos = this.#getReadPosition(8);
    const high = this.#view.getInt32(pos);
    // Checks if the value is a safe integer
    // MAX_SAFE_INTEGER (high 0x1FFFFF) is < 0x200_000.
    // > -0x200_000 handles down to -(2^53 - 2^32).
    if (high > -0x200_000 && high < 0x200_000) {
      const low = this.#view.getUint32(pos + 4);
      return high * 0x1_0000_0000 + low;
    }
    // MIN_SAFE_INTEGER is -(2^53 - 1). High is -0x200_000, Low is 1.
    // -2^53 (high -0x200_000, low 0) is unsafe.
    if (high === -0x200_000) {
      const low = this.#view.getUint32(pos + 4);
      if (low !== 0) {
        return high * 0x1_0000_0000 + low;
      }
    }
    this.#pos -= 8;
    return this.getBigInt64();
  }

  /**
   * Reads a slice of bytes as a Uint8Array (shares underlying buffer).
   * @param byteLength - Number of bytes to read
   * @returns A Uint8Array view of the buffer slice
   */
  getUint8Array(byteLength: number): Uint8Array {
    const pos = this.#getReadPosition(byteLength);
    return this.#buffer.subarray(
      pos,
      this.#byteOffset + this.#pos,
    );
  }

  /**
   * Reads a UTF-8 encoded string.
   * @param byteLength - Number of bytes to read (not character count)
   * @returns The decoded string
   * @throws If the bytes are not valid UTF-8
   */
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
   * Returns a Uint8Array view of the entire buffer slice.
   * This method is useful for getting the full data read by this DataReader.
   * Note that this does not modify the position of the DataReader.
   * @returns A Uint8Array representing the entire buffer from byteOffset to byteOffset + byteLength
   */
  asUint8Array(): Uint8Array {
    return this.#buffer.subarray(
      this.#byteOffset,
      this.#byteOffset + this.byteLength,
    );
  }

  /** Current read position within the buffer. */
  get pos(): number {
    return this.#pos;
  }

  /**
   * Sets the read position.
   * @throws If value is negative or exceeds byteLength
   */
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
  /** The total length of the readable buffer in bytes. */
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

/**
 * A binary data writer that provides methods to write various data types to a buffer.
 * Supports writing integers (8/16/32/64 bit), floats, and byte arrays.
 * All multi-byte writes use big-endian byte order.
 */
export class DataWriter {
  /**
   * Creates a new DataWriter.
   * @param options.bufferSize - Initial buffer size in bytes
   * @param options.automaticallyExtendBuffer - If true, buffer grows automatically when needed
   */
  constructor(
    options: { bufferSize: number; automaticallyExtendBuffer: boolean },
  ) {
    const buffer = new ArrayBuffer(options.bufferSize);
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.automaticallyExtendBuffer = options.automaticallyExtendBuffer;
  }

  /** Resets the write position to the beginning of the buffer. */
  reset() {
    this.pos = 0;
  }

  /**
   * Returns a view of the written data (shares underlying buffer).
   * @param begin - Start offset (default: 0)
   * @param end - End offset (default: current position)
   */
  getBufferView(begin?: number, end?: number): Uint8Array {
    return this.bytes.subarray(begin ?? 0, end ?? this.pos);
  }

  /**
   * Returns a copy of the written data.
   * @param begin - Start offset (default: 0)
   * @param end - End offset (default: current position)
   */
  getCopy(begin?: number, end?: number): Uint8Array {
    return this.bytes.slice(begin ?? 0, end ?? this.pos);
  }

  /**
   * Ensures the buffer has enough space for the specified number of additional bytes.
   * If automaticallyExtendBuffer is false, this is a no-op (writes may fail).
   * @param appendLength - Number of bytes to be written
   */
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

  /** Writes an unsigned 8-bit integer. */
  addUint8(value: number) {
    this.ensureBufferSize(1);
    this.view.setUint8(this.pos, value);
    this.pos += 1;
  }

  /** Writes a signed 8-bit integer. */
  addInt8(value: number) {
    this.ensureBufferSize(1);
    this.view.setInt8(this.pos, value);
    this.pos++;
  }

  /** Writes an unsigned 16-bit integer (big-endian). */
  addUint16(value: number) {
    this.ensureBufferSize(2);
    this.view.setUint16(this.pos, value);
    this.pos += 2;
  }

  /** Writes a signed 16-bit integer (big-endian). */
  addInt16(value: number) {
    this.ensureBufferSize(2);
    this.view.setInt16(this.pos, value);
    this.pos += 2;
  }

  /** Writes an unsigned 32-bit integer (big-endian). */
  addUint32(value: number) {
    this.ensureBufferSize(4);
    this.view.setUint32(this.pos, value);
    this.pos += 4;
  }

  /** Writes a signed 32-bit integer (big-endian). */
  addInt32(value: number) {
    this.ensureBufferSize(4);
    this.view.setInt32(this.pos, value);
    this.pos += 4;
  }

  /** Writes a 32-bit IEEE 754 floating point (big-endian). */
  addFloat32(value: number) {
    this.ensureBufferSize(4);
    this.view.setFloat32(this.pos, value);
    this.pos += 4;
  }

  /** Writes a 64-bit IEEE 754 floating point (big-endian). */
  addFloat64(value: number) {
    this.ensureBufferSize(8);
    this.view.setFloat64(this.pos, value);
    this.pos += 8;
  }

  /**
   * Writes an unsigned 64-bit integer from a JavaScript number.
   * @warning Logs a warning if value exceeds Number.MAX_SAFE_INTEGER. Use addBigUint64 for full precision.
   */
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

  /**
   * Writes a signed 64-bit integer from a JavaScript number.
   * @warning Logs a warning if value is outside safe integer range. Use addBigInt64 for full precision.
   */
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

  /** Writes an unsigned 64-bit integer from a BigInt. */
  addBigUint64(value: bigint) {
    this.ensureBufferSize(8);
    this.view.setBigUint64(this.pos, value);
    this.pos += 8;
  }

  /** Writes a signed 64-bit integer from a BigInt. */
  addBigInt64(value: bigint) {
    this.ensureBufferSize(8);
    this.view.setBigInt64(this.pos, value);
    this.pos += 8;
  }

  /**
   * Writes an array of bytes to the buffer.
   * @param values - Array-like object containing byte values (0-255)
   */
  addArray(values: ArrayLike<number>) {
    const size = values.length;
    this.ensureBufferSize(size);
    this.bytes.set(values, this.pos);
    this.pos += size;
  }

  /** Current write position in the buffer. */
  pos = 0;
  /** Internal DataView for typed access to the buffer. */
  protected view: DataView;
  /** Internal byte array backing the buffer. */
  protected bytes: Uint8Array;
  /** Whether the buffer should grow automatically when capacity is exceeded. */
  protected automaticallyExtendBuffer: boolean;
}
