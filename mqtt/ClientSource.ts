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

  start(controller: ReadableStreamDefaultController) {
    this.#controller = controller;
    this.#closed = false;
  }

  enqueue(p: AllPacket | CustomPackets) {
    if (!this.#closed) {
      this.#controller!.enqueue(p);
    }
  }

  close() {
    if (!this.#closed) {
      this.#controller!.close();
      this.#closed = true;
    }
  }

  error(err: Error) {
    if (!this.#closed) {
      this.#controller!.error(err);
    }
  }

  cancel() {
    this.#closed = true;
  }
}
