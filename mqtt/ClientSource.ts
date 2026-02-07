/**
 * Copyright 2023-2026 Bernd Amend. MIT license.
 */
import type { AllPacket } from "./packets.ts";

/**
 * Custom packet types for internal client events.
 */
export enum CustomPacketType {
  ConnectionClosed = 100,
  FailedConnectionAttempt = 101,
  PingFailed = 102,
  CloseLocally = 103,
  Error = 200,
}

/**
 * Custom packets used to signal client events and errors.
 */
export type CustomPackets = {
  type:
    | CustomPacketType.Error
    | CustomPacketType.FailedConnectionAttempt;
  msg?: string | Error;
} | {
  type:
    | CustomPacketType.ConnectionClosed
    | CustomPacketType.PingFailed
    | CustomPacketType.CloseLocally;
};

/**
 * An UnderlyingSource implementation for the Client's readable stream.
 * Manages the controller and handles enqueue/close/error operations safely.
 */
export class ClientSource
  implements UnderlyingSource<AllPacket | CustomPackets> {
  #controller?: ReadableStreamDefaultController;
  #closed = false;
  constructor() {
  }

  /**
   * Called when the stream starts. Stores the controller reference.
   * @param controller - The stream controller
   */
  start(controller: ReadableStreamDefaultController) {
    this.#controller = controller;
    this.#closed = false;
  }

  /**
   * Enqueues a packet to the readable stream.
   * @param p - The packet to enqueue
   */
  enqueue(p: AllPacket | CustomPackets) {
    if (!this.#closed) {
      this.#controller!.enqueue(p);
    }
  }

  /** Closes the readable stream. */
  close() {
    if (!this.#closed) {
      this.#controller!.close();
      this.#closed = true;
    }
  }

  /**
   * Signals an error on the readable stream.
   * @param err - The error to signal
   */
  error(err: Error) {
    if (!this.#closed) {
      this.#controller!.error(err);
    }
  }

  /** Called when the stream is cancelled. */
  cancel() {
    this.#closed = true;
  }
}
