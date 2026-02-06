/**
 * Copyright 2023-2026 Bernd Amend. MIT license.
 */
import { DataReader } from "../helper/mod.ts";
import type { AllPacket } from "./packets.ts";
import {
  deserializePacket,
  type PublishDeserializeOptions,
  readFixedHeader,
} from "./deserialize.ts";

/**
 * A TransformStream that deserializes MQTT packets from a byte stream.
 * Handles partial packets and reassembly across chunk boundaries.
 * @see https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901285
 */
export class DeserializeStream implements Transformer<Uint8Array, AllPacket> {
  constructor(
    readonly options?: {
      publishDeserializeOptions?: PublishDeserializeOptions;
    },
  ) {
  }

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<AllPacket>,
  ) {
    if (this.#partialChunk) {
      const newChunk = new Uint8Array(
        this.#partialChunk.length + chunk.length,
      );
      newChunk.set(this.#partialChunk);
      newChunk.set(chunk, this.#partialChunk.length);
      this.#partialChunk = undefined;
      chunk = newChunk;
    }
    let firstMessage = true;
    const reader = new DataReader(chunk);
    while (reader.hasMoreData) {
      const pos = reader.pos;
      const fixedHeader = readFixedHeader(reader);
      if (
        fixedHeader === undefined || reader.remainingSize < fixedHeader.length
      ) {
        // incomplete mqtt packet, decode and handle the data the next time we receive more data
        if (firstMessage) {
          this.#partialChunk = chunk;
        } else {
          // store the left over data
          reader.pos = pos;
          this.#partialChunk = reader.getUint8Array(reader.remainingSize);
        }
        return;
      }
      try {
        controller.enqueue(
          deserializePacket(
            fixedHeader,
            reader,
            this.options?.publishDeserializeOptions,
          ),
        );
      } catch (e) {
        controller.error(`Error while deserializing ${e}`);
      }
      firstMessage = false;
    }
  }

  #partialChunk: Uint8Array | undefined;
}
