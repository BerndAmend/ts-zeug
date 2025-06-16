/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { DataReader, deadline, delay } from "../helper/mod.ts";
import { streamifyWebSocket } from "../helper/websocket.ts";
import {
  type AllPacket,
  type ConnAckPacket,
  type ConnectPacket,
  ControlPacketType,
  type DisconnectPacket,
  DisconnectReasonCode,
  type Milliseconds,
  type PacketIdentifier,
  type PublishPacket,
  type Seconds,
  type SubAckPacket,
  type SubscribePacket,
  type UnsubAckPacket,
  type UnsubscribePacket,
} from "./packets.ts";

import {
  type MakeSerializePacketType,
  type OmitPacketType,
  PingReqMessage,
  serializeConnectPacket,
  serializeDisconnectPacket,
  serializePublishPacket,
  serializeSubscribePacket,
  serializeUnsubscribePacket,
  Writer,
} from "./serialize.ts";

import {
  deserializePacket,
  PublishDeserializeOptions,
  readFixedHeader,
} from "./deserialize.ts";

export type ClientProperties = {
  reconnectTime?: Milliseconds; // 0: no auto reconnect
  connectTimeout?: Milliseconds; // timeout if no CONNACK is received
  publishDeserializeOptions?: PublishDeserializeOptions;
};

export const DefaultClientProperties: Required<ClientProperties> = {
  reconnectTime: 1_000 as Milliseconds,
  connectTimeout: 10_000 as Milliseconds,
  publishDeserializeOptions: PublishDeserializeOptions.PayloadFormatIndicator,
};

export enum CustomPacketType {
  ConnectionClosed = 100,
  FailedConnectionAttempt = 101,
  Error = 200,
}

export enum ConnectionClosedReason {
  ClosedLocally,
  ClosedRemotely,
  PingFailed,
}

export type CustomPackets = {
  type:
    | CustomPacketType.Error
    | CustomPacketType.FailedConnectionAttempt;
  msg?: string | Error;
} | {
  type: CustomPacketType.ConnectionClosed;
  reason: ConnectionClosedReason;
};

export function logPacket(packet: AllPacket | CustomPackets) {
  if (packet.type === ControlPacketType.Disconnect) {
    console.log(
      ControlPacketType[packet.type],
      DisconnectReasonCode[
        packet.reason_code ?? DisconnectReasonCode.Normal_disconnection
      ],
      packet,
    );
  } else {
    console.log(
      (packet.type < 100)
        ? ControlPacketType[packet.type]
        : CustomPacketType[packet.type],
      packet,
    );
  }
}

export function printPacket(
  msg: { done: false; value: AllPacket } | {
    done: true;
  },
) {
  if (msg.done) {
    console.log("Done");
    return;
  }
  logPacket(msg.value);
}

/**
 * https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901285
 */
export class DeserializeStream {
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

export type LowLevelConnection = {
  readable: ReadableStream<AllPacket>;
  writable: WritableStream<string | ArrayBufferView | ArrayBufferLike | Blob>;
};

/**
 * You may also want to have a look at the Client
 */
export async function connectLowLevel(
  address: URL | string,
  options?: {
    publishDeserializeOptions?: PublishDeserializeOptions;
  },
): Promise<LowLevelConnection> {
  const ts = new TransformStream<Uint8Array<ArrayBuffer>, AllPacket>(
    new DeserializeStream(options),
  );

  if (typeof address === "string") {
    address = new URL(address);
  }
  if (address.protocol === "ws:" || address.protocol === "wss:") {
    if (typeof WebSocketStream === "undefined") {
      const conn = streamifyWebSocket(
        address.toString(),
        "mqtt",
      );
      return {
        readable: conn.readable.pipeThrough(ts),
        writable: conn.writable,
      };
    }
    const wss = new WebSocketStream(address.toString(), {
      protocols: ["mqtt"],
    });
    const conn = await wss.opened;
    return {
      readable: conn.readable.pipeThrough(ts),
      writable: conn.writable,
    };
  }
  if (
    typeof Deno !== "undefined" &&
    (address.protocol === "tcp:" || address.protocol === "mqtt:")
  ) {
    const conn = await Deno.connect({
      hostname: address.hostname,
      port: address.port === "" ? 1883 : Number.parseInt(address.port),
      transport: "tcp",
    });

    conn.setNoDelay(true);

    return {
      readable: conn.readable.pipeThrough(ts),
      writable: conn.writable,
    };
  }
  throw new Error(`Unsupported protocol ${address.protocol}`);
}

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

/**
 * Default Client implementation providing the following features
 *  - auto-reconnect, keeping the assigned client id
 *  - send pings
 */
export class Client implements AsyncDisposable {
  #writer = new Writer();
  #writable: WritableStreamDefaultWriter | undefined;
  #connectPacket: OmitPacketType<ConnectPacket>;
  #connectAck?: ConnAckPacket;
  #messageHandlerPromise: Promise<void> | undefined;
  #active = false;
  #pingIntervalId?: number;
  #source = new ClientSource();
  #readable = new ReadableStream<AllPacket | CustomPackets>(this.#source);

  #lastPingRespReceived = 0;

  #closePromiseFulFill?: (
    value: { done: true; value: ConnectionClosedReason.ClosedLocally },
  ) => void;
  #closePromiseFulFillPromise?: Promise<
    { done: true; value: ConnectionClosedReason.ClosedLocally }
  >;

  #pendingReplies: ({
    resolve: (value: AllPacket) => void;
    reject: (err: Error) => void;
  } | undefined)[] = [];

  #clearPendingReplies(err?: Error) {
    for (const v of this.#pendingReplies) {
      if (v !== undefined) {
        try {
          v.reject(err ?? new Error("#clearPendingReplies"));
        } catch (e: unknown) {
          console.error("Error while rejecting a pending reply", e);
        }
      }
    }
    this.#pendingReplies = [{
      resolve: (v) => {
        console.error("The PacketIdentifier 0 shouldn't be used, but got ", v);
      },
      reject: (_) => {},
    }];
  }

  #getPacketIdentifierHandler(): [PacketIdentifier, Promise<AllPacket>] {
    let freePacketIdentifier = this.#pendingReplies.findIndex((e) =>
      e === undefined
    );
    if (freePacketIdentifier === -1) {
      freePacketIdentifier = this.#pendingReplies.length;
      if (freePacketIdentifier > 65535) {
        throw new Error("Too many pending replies, max is 65535");
      }
    }

    const promise = new Promise<AllPacket>(
      (resolve, reject) => {
        this.#pendingReplies[freePacketIdentifier] = { resolve, reject };
      },
    );

    return [freePacketIdentifier as PacketIdentifier, promise];
  }

  /**
   * Creates a new MQTT Client that connects to the given address.
   * The connection is established automatically.
   * If the connection fails, it will retry to connect after the reconnectTime.
   * If the connection was closed with close(), you have to call open() to re-open the connection.
   * @param address the address of the MQTT server to connect to, e.g. "mqtt://localhost" or "ws://localhost/mqtt"
   * @param connectPacket the connect packet that is sent to the MQTT server. An Empty object is used if not provided.
   * @param properties Values that are not set are set to DefaultClientProperties.
   */
  constructor(
    public readonly address: URL | string,
    connectPacket?: OmitPacketType<ConnectPacket>,
    public readonly properties?: ClientProperties,
  ) {
    this.#clearPendingReplies();
    this.#connectPacket = connectPacket ?? {};
    this.open();
  }

  /**
   * The connect packet that is sent to the MQTT server.
   */
  get connectPacket(): OmitPacketType<ConnectPacket> {
    return this.#connectPacket;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  /**
   * Warning: even if this function returns true, a publish call
   * may fail if the connection was closed in the meantime.
   * @returns if the client is connected to a MQTT Server
   */
  get isConnected(): boolean {
    return this.#writable !== undefined;
  }

  /**
   * A readable stream that emits all packets received from the MQTT server.
   * It also emits CustomPackets, which are used to signal errors or connection issues.
   * The readable stream is closed if the connection was closed locally.
   * You need to consume this stream!
   */
  get readable(): ReadableStream<AllPacket | CustomPackets> {
    return this.#readable;
  }

  /**
   * This function is called automatically in the constructor and is only required if the connection was closed with close().
   */
  open() {
    if (this.#messageHandlerPromise) {
      throw new Error("open was already called");
    }
    this.#closePromiseFulFillPromise = new Promise(
      (resolve) => {
        this.#closePromiseFulFill = resolve;
      },
    );
    this.#active = true;
    this.#messageHandlerPromise = this.#handleMessages();
  }

  /**
   * Closes the connection to the MQTT server.
   * If the connection was closed successfully, the readable stream is closed.
   * @param disconnectPacket optional disconnect packet to send to the server
   * @returns when the connection was closed
   */
  async close(disconnectPacket?: DisconnectPacket) {
    if (this.#writable === undefined) {
      return;
    }
    this.#active = false;
    try {
      await this.#writable.write(
        serializeDisconnectPacket(disconnectPacket ?? {}, this.#writer),
      );
    } catch {
      // The connection could already be closed
    }
    this.#closePromiseFulFill!({
      done: true,
      value: ConnectionClosedReason.ClosedLocally,
    });
    await this.#messageHandlerPromise;
    this.#source.close();

    this.#source = new ClientSource();
    this.#readable = new ReadableStream<AllPacket | CustomPackets>(
      this.#source,
    );
  }

  /**
   * @returns a promise that resolves when the connection was closed
   */
  async #handleMessages() {
    while (this.#active) {
      let con: LowLevelConnection;
      try {
        con = await connectLowLevel(this.address, this.properties);
      } catch (e: unknown) {
        if (e instanceof Error) {
          this.#source.enqueue({
            type: CustomPacketType.FailedConnectionAttempt,
            msg: e,
          });
        } else {
          this.#source.enqueue({
            type: CustomPacketType.FailedConnectionAttempt,
            msg: new Error(`Unknown exception caught: ${e}`),
          });
        }
        if (this.#active) {
          await delay(
            this.properties?.reconnectTime ??
              DefaultClientProperties.reconnectTime,
          );
        }
        continue;
      }
      this.#writable = con.writable.getWriter();
      const r = con.readable.getReader();
      try {
        this.#writable.write(
          serializeConnectPacket(this.#connectPacket, this.#writer),
        );
        const d = await deadline(r.read(), 1000);
        if (d && !d.done && d.value.type === ControlPacketType.ConnAck) {
          this.#connectAck = d.value;
          if (this.#connectPacket.client_id === undefined) {
            const assigned_client_id = this.#connectAck?.properties
              ?.assigned_client_id;
            if (assigned_client_id === undefined) {
              console.error(
                "No client_id was provided and the server didn't assign one to us",
              );
            } else {
              this.#connectPacket.client_id = assigned_client_id;
            }
          }
          this.#writer.maximumPacketSize = this.#connectAck?.properties
            ?.maximum_packet_size;
          this.#source.enqueue(this.#connectAck);
        } else {
          this.#writable.releaseLock();
          r.releaseLock();
          await con.writable.close();
          this.#source.enqueue({
            type: CustomPacketType.FailedConnectionAttempt,
            msg: "No ConnAck",
          });
          await delay(
            this.properties?.reconnectTime ??
              DefaultClientProperties.reconnectTime,
          );
          continue; // retry connecting
        }
      } catch (e: unknown) {
        try {
          if (con.writable.locked) {
            this.#writable.releaseLock();
          }
          if (con.readable.locked) {
            r.releaseLock();
          }
          await con.writable.close();
        } catch (_e) {
          //          console.error("Couldn't close connection", e);
        }
        if (e instanceof Error) {
          this.#source.enqueue({
            type: CustomPacketType.FailedConnectionAttempt,
            msg: e,
          });
        } else {
          this.#source.enqueue({
            type: CustomPacketType.FailedConnectionAttempt,
            msg: new Error(`Unknown exception caught: ${e}`),
          });
        }
        await delay(
          this.properties?.reconnectTime ??
            DefaultClientProperties.reconnectTime,
        );
        continue; // retry connecting
      }

      let pingFailed: (
        value: {
          done: true;
          value: ConnectionClosedReason.PingFailed;
        },
      ) => void;
      const pingFailedPromise = new Promise<
        { done: true; value: ConnectionClosedReason.PingFailed }
      >(
        (resolve) => {
          pingFailed = resolve;
        },
      );
      // ping
      // 3.1.2.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901045
      if (
        this.#connectPacket.keepalive ||
        this.#connectAck!.properties?.server_keep_alive
      ) {
        this.#lastPingRespReceived = Date.now();
        let keep_alive = this.#connectAck.properties?.server_keep_alive ??
          this.#connectPacket.keepalive;
        if (this.#connectAck.properties?.server_keep_alive) {
          console.log(
            `Use the keep_alive time provided by the server server=${
              this.#connectAck!.properties?.server_keep_alive
            } client=${this.#connectPacket.keepalive}`,
          );
        }
        if (keep_alive === undefined) {
          keep_alive = 5 as Seconds;
          console.error(
            `BUG: the keepalive should be valid, default to 5 seconds server=${
              this.#connectAck!.properties?.server_keep_alive
            } client=${this.#connectPacket.keepalive}`,
          );
        }
        this.#pingIntervalId = setInterval(async () => {
          const msSinceLastPingResp = Date.now() - this.#lastPingRespReceived;
          if (msSinceLastPingResp > (keep_alive! * 1000 * 1.5)) {
            // console.log(
            //   `PingResp was missing for ${msSinceLastPingResp} ms, terminate connection`,
            // );
          } else {
            try {
              await this.#writable!.write(PingReqMessage);
              return;
            } catch (e) {
              console.log("Couldn't send ping, close connection", e);
            }
          }
          pingFailed({
            done: true,
            value: ConnectionClosedReason.PingFailed,
          });
          try {
            if (this.#writable && con.writable.locked) {
              this.#writable.releaseLock();
            }
            await con.writable.close();
          } catch (e) {
            console.log("Terminate connection in ping handler failed", e);
          }
        }, keep_alive * 1000 - 100); // 100 is randomly selected to ensure we stay below the keep_alive time
      }

      let connectionClosedPacket: CustomPackets;

      try {
        dispatchLoop: while (true) {
          // Read from the stream
          const { done, value } = await Promise.race([
            r.read(),
            pingFailedPromise,
            this.#closePromiseFulFillPromise!,
          ]);
          // Exit if we're done
          if (done) {
            connectionClosedPacket = {
              type: CustomPacketType.ConnectionClosed,
              reason: (value === ConnectionClosedReason.ClosedLocally ||
                  value === ConnectionClosedReason.PingFailed)
                ? value
                : ConnectionClosedReason.ClosedRemotely,
            };
            break;
          }
          // Else yield the chunk

          const p = value;
          switch (p.type) {
            case ControlPacketType.SubAck:
            case ControlPacketType.UnsubAck: {
              const handler = this.#pendingReplies[p.packet_identifier];
              this.#pendingReplies[p.packet_identifier] = undefined;
              if (handler === undefined) {
                console.error(
                  "the handler for the PacketIdentifier ",
                  p.packet_identifier,
                  " was undefined",
                );
              } else {
                handler.resolve(p);
              }

              continue dispatchLoop;
            }

            case ControlPacketType.PingResp: {
              this.#lastPingRespReceived = Date.now();
              continue dispatchLoop;
            }

            case ControlPacketType.Publish: {
              break;
            }
          }

          this.#source.enqueue(p);
        }
      } catch (_e: unknown) {
        // The stream was closed, we can ignore this error, e.g. network error
        connectionClosedPacket = {
          type: CustomPacketType.ConnectionClosed,
          reason: ConnectionClosedReason.ClosedRemotely,
        };
      }

      if (this.#pingIntervalId) {
        clearInterval(this.#pingIntervalId);
        this.#pingIntervalId = undefined;
      }

      try {
        if (con.writable.locked) {
          this.#writable.releaseLock();
        }
        if (con.readable.locked) {
          r.releaseLock();
        }
        this.#writable = undefined;
        await con.writable.close();
      } catch (_e: unknown) {
        // We don't really care if an error occurred while closing the connection
      }

      this.#clearPendingReplies(new Error("connection closed"));

      this.#source.enqueue(connectionClosedPacket);
    }
  }

  /**
   * Publishes a message to the MQTT server.
   * @param packet the packet to publish, the packet_identifier is set automatically
   * @returns a promise that resolves when the message was sent
   * @throws if the connection is not connected or the write fails
   */
  async publish(
    packet: MakeSerializePacketType<PublishPacket>,
  ) {
    const msg = serializePublishPacket(packet, this.#writer);
    if (this.#writable === undefined) {
      throw new Error("not connected");
    }

    await this.#writable.write(msg);
  }

  /**
   * Subscribes to a topic on the MQTT server.
   * @param packet the packet to subscribe, the packet_identifier is set automatically
   * @returns a promise that resolves with the SubAckPacket when the subscription was successful
   * @throws if the connection is not connected, the write fails or no SubAckPacket is received
   */
  async subscribe(
    packet: MakeSerializePacketType<Omit<SubscribePacket, "packet_identifier">>,
  ): Promise<SubAckPacket> {
    const [packet_identifier, promise] = this.#getPacketIdentifierHandler();
    const p: Omit<SubscribePacket, "type"> = {
      ...structuredClone(packet),
      packet_identifier,
    };
    const subMsg = serializeSubscribePacket(p, this.#writer);
    await this.#writable?.write(subMsg);

    const reply = await promise;

    if (reply.type !== ControlPacketType.SubAck) {
      throw new Error(
        `Didn't receive the expected SubAck packet send=${p} received=${reply}`,
      );
    }

    return reply;
  }

  /**
   * Unsubscribes from a topic on the MQTT server.
   * @param packet the packet to unsubscribe, the packet_identifier is set automatically
   * @returns a promise that resolves with the UnsubAckPacket when the unsubscription was successful
   * @throws if the connection is not connected, the write fails or no UnsubAckPacket is received
   */
  async unsubscribe(
    packet: MakeSerializePacketType<
      Omit<UnsubscribePacket, "packet_identifier">
    >,
  ): Promise<UnsubAckPacket> {
    const [packet_identifier, promise] = this.#getPacketIdentifierHandler();
    const p: Omit<UnsubscribePacket, "type"> = {
      ...structuredClone(packet),
      packet_identifier,
    };

    const subMsg = serializeUnsubscribePacket(p, this.#writer);
    await this.#writable?.write(subMsg);

    const reply = await promise;

    if (reply.type !== ControlPacketType.UnsubAck) {
      throw new Error(
        `Didn't receive the expected UnsubAck packet send=${p} received=${reply}`,
      );
    }

    return reply;
  }
}
