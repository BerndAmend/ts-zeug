/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { DataReader, DataWriter } from "../helper/mod.ts";
import {
  type AllPacket,
  type AuthPacket,
  AuthReasonCode,
  type ConnAckPacket,
  type ConnectPacket,
  ConnectReasonCode,
  ControlPacketType,
  type DisconnectPacket,
  DisconnectReasonCode,
  maxFixedHeaderSize,
  PayloadFormatIndicator,
  Property,
  type PubAckPacket,
  PubAckReasonCode,
  type PubCompPacket,
  PubCompReasonCode,
  type PublishPacket,
  type PubRecPacket,
  PubRecReasonCode,
  type PubRelPacket,
  PubRelReasonCode,
  QoS,
  RetainHandling,
  type SubAckPacket,
  type SubscribePacket,
  type UnsubAckPacket,
  type UnsubscribePacket,
  type UserProperty,
} from "./packets.ts";

export class Writer extends DataWriter {
  constructor(
    options: { bufferSize: number; automaticallyExtendBuffer: boolean } = {
      bufferSize: 2048,
      automaticallyExtendBuffer: true,
    },
  ) {
    super(options);
    this.pos = maxFixedHeaderSize;
  }

  lengthVariableByteInteger(n: number): number {
    if (n === 0) {
      return 1;
    }
    return Math.ceil((32 - Math.clz32(n)) / 7);
  }

  addVariableByteInteger(num: number) {
    do {
      let encodedByte = num % 128;
      num = Math.floor(num / 128);

      // if there are more data to encode, set the top bit of this byte
      if (num > 0) {
        encodedByte = encodedByte | 128;
      }

      this.addUint8(encodedByte);
    } while (num > 0);
  }

  addBinaryData(bin: DataReader | Uint8Array) {
    if (bin.byteLength > 65535) {
      throw new Error(`data limit is 65535 got ${bin.byteLength}`);
    }
    this.addUint16(bin.byteLength);
    if (bin instanceof DataReader) {
      this.addArray(bin.asUint8Array());
    } else {
      this.addArray(bin);
    }
  }

  addUTF8String(str: string) {
    if (this.automaticallyExtendBuffer) {
      this.ensureBufferSize(str.length * 3); // the buffer may be to big
    }
    const lengthPos = this.pos;
    this.addUint16(0);
    const { read, written } = this.#textEncoder.encodeInto(
      str,
      this.bytes.subarray(this.pos),
    );
    if (read !== str.length) {
      throw new Error("Couldn't write the entire string");
    }
    this.pos = lengthPos;
    this.addUint16(written);
    this.pos += written;
  }

  addString(str: string): number {
    if (this.automaticallyExtendBuffer) {
      this.ensureBufferSize(str.length * 3); // the buffer may be to big
    }
    const { read, written } = this.#textEncoder.encodeInto(
      str,
      this.bytes.subarray(this.pos),
    );
    if (read !== str.length) {
      throw new Error("Couldn't write the entire string");
    }
    this.pos += written;
    return written;
  }

  addReasonString(s?: string) {
    if (s === undefined) {
      return;
    }
    this.addUint8(Property.Reason_String);
    this.addUTF8String(s);
  }

  addUserProperties(prop?: UserProperty[]) {
    if (prop === undefined) {
      return;
    }
    for (const { key, value } of prop) {
      this.addUint8(Property.User_Property);
      this.addUTF8String(key);
      this.addUTF8String(value);
    }
  }

  addProperties<T>(
    prop: T | undefined,
    f: (tw: Writer, p: T | undefined) => void,
  ) {
    this.#internalWriter ??= new Writer({
      bufferSize: 2048,
      automaticallyExtendBuffer: true,
    });
    this.#internalWriter.reset();
    f(this.#internalWriter, prop);
    const serializedProperties = this.#internalWriter.getBufferView();
    this.addVariableByteInteger(serializedProperties.length);
    this.addArray(serializedProperties);
  }

  beginMessage() {
    this.pos = maxFixedHeaderSize;
  }

  finalizeMessage(
    type: ControlPacketType,
    flags: number,
  ): Uint8Array {
    if (flags > 0xf) {
      throw new Error("flags only allows setting up to 4 bits");
    }
    const endPos = this.pos;
    const size = endPos - maxFixedHeaderSize;

    if (size >= this.#maximumPacketSize) {
      throw new Error(
        `Message size is too large: ${size} bytes, the maximum_packet_size is set to ${this.#maximumPacketSize} bytes`,
      );
    }

    const start = maxFixedHeaderSize - 1 - this.lengthVariableByteInteger(size);
    this.pos = start;
    this.addUint8(type << 4 | flags);
    this.addVariableByteInteger(size);
    this.pos = maxFixedHeaderSize;
    return this.getCopy(start, endPos);
  }

  get maximumPacketSize(): number {
    return this.#maximumPacketSize;
  }

  set maximumPacketSize(value: number | undefined) {
    value ??= 268_435_455; // default value
    if (value < 0 || value > 268_435_455) {
      throw new Error(
        `Invalid maximum packet size: ${value}, must be between 0 and 268_435_455`,
      );
    }
    this.#maximumPacketSize = value;
  }

  #textEncoder = new TextEncoder();
  #internalWriter: Writer | undefined;
  #maximumPacketSize = 268_435_455; //
}

export type OmitPacketType<T extends { type: ControlPacketType }> =
  & Omit<T, "type">
  & {
    type?: T["type"];
  };

export type MakeSerializePacketType<T extends { type: ControlPacketType }> =
  Readonly<
    OmitPacketType<T>
  >;

/**
 * 3.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901033
 */
export function serializeConnectPacket(
  packet: MakeSerializePacketType<ConnectPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUTF8String(packet.protocol_name ?? "MQTT");
  w.addUint8(packet.protocol_version ?? 5);

  const connectFlags = (packet.username !== undefined ? 0b1000_0000 : 0) |
    (packet.password !== undefined ? 0b0100_0000 : 0) |
    (packet.will?.retain ? 0b0010_0000 : 0) |
    (packet.will?.qos ? (packet.will.qos << 3) : 0) |
    (packet.will !== undefined ? 0b0000_0100 : 0) |
    ((packet.clean_start === undefined || packet.clean_start === true)
      ? 0b0000_0010
      : 0);
  w.addUint8(connectFlags);
  w.addUint16(packet.keepalive ?? 0);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.session_expiry_interval !== undefined) {
      tw.addUint8(Property.Session_Expiry_Interval);
      tw.addUint32(p.session_expiry_interval);
    }

    if (p?.receive_maximum) {
      tw.addUint8(Property.Receive_Maximum);
      tw.addUint16(p.receive_maximum);
    }

    if (p?.maximum_packet_size) {
      tw.addUint8(Property.Maximum_Packet_Size);
      tw.addUint32(p.maximum_packet_size);
    }

    if (p?.topic_alias_maximum !== undefined) {
      tw.addUint8(Property.Topic_Alias_Maximum);
      tw.addUint16(p.topic_alias_maximum);
    }

    if (p?.request_response_information) {
      tw.addUint8(Property.Request_Response_Information);
      tw.addUint8(1);
    }

    if (
      p?.request_problem_information !== undefined &&
      p?.request_problem_information === false
    ) {
      tw.addUint8(Property.Request_Problem_Information);
      tw.addUint8(0);
    }

    tw.addUserProperties(p?.user_properties);

    if (p?.authentication_method !== undefined) {
      tw.addUint8(Property.Authentication_Method);
      tw.addUTF8String(p.authentication_method);
    }

    if (p?.authentication_data !== undefined) {
      if (p?.authentication_method === undefined) {
        throw new Error(
          "authentication data can only be set if the authentication method is set",
        );
      }
      tw.addUint8(Property.Authentication_Data);
      tw.addBinaryData(p.authentication_data);
    }
  });

  // 3.1.3 Payload https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901058

  w.addUTF8String(packet.client_id ?? "");

  if (packet.will) {
    w.addProperties(packet.will?.properties, (tw: Writer, p) => {
      if (typeof packet.will?.payload === "string") {
        tw.addUint8(Property.Payload_Format_Indicator);
        tw.addUint8(PayloadFormatIndicator.UTF8);
      }
      if (p?.message_expiry_interval !== undefined) {
        tw.addUint8(Property.Message_Expiry_Interval);
        tw.addUint32(p.message_expiry_interval);
      }

      if (p?.content_type !== undefined) {
        tw.addUint8(Property.Content_Type);
        tw.addUTF8String(p.content_type);
      }

      if (p?.response_topic !== undefined) {
        tw.addUint8(Property.Response_Topic);
        tw.addUTF8String(p.response_topic);
      }

      if (p?.correlation_data !== undefined) {
        tw.addUint8(Property.Correlation_Data);
        tw.addBinaryData(p.correlation_data);
      }

      if (p?.will_delay_interval !== undefined) {
        tw.addUint8(Property.Will_Delay_Interval);
        tw.addUint32(p.will_delay_interval);
      }

      tw.addUserProperties(p?.user_properties);
    });

    w.addUTF8String(packet.will.topic);
    if (packet.will.payload === undefined) {
      w.addUint16(0);
    } else if (typeof packet.will.payload === "string") {
      w.addUTF8String(packet.will.payload);
    } else {
      w.addBinaryData(packet.will.payload);
    }
  }

  if (packet.username !== undefined) {
    w.addUTF8String(packet.username);
  }

  if (packet.password !== undefined) {
    w.addUTF8String(packet.password);
  }

  return w.finalizeMessage(ControlPacketType.Connect, 0);
}

/**
 * 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901074
 */
export function serializeConnAckPacket(
  packet: MakeSerializePacketType<ConnAckPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  if (
    packet.properties?.server_reference &&
    packet.connect_reason_code !== ConnectReasonCode.Server_moved &&
    packet.connect_reason_code !== ConnectReasonCode.Use_another_server
  ) {
    throw new Error(
      "server_reference can only be set if the reason_code is Server_moved or Use_another_server",
    );
  }
  // 3.2.2.1 Connect Acknowledge Flags https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901077
  w.addUint8((packet.session_present ?? false) ? 1 : 0);
  w.addUint8(packet.connect_reason_code ?? ConnectReasonCode.Success);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.session_expiry_interval !== undefined) {
      tw.addUint8(Property.Session_Expiry_Interval);
      tw.addUint32(p.session_expiry_interval);
    }

    if (p?.receive_maximum) {
      tw.addUint8(Property.Receive_Maximum);
      tw.addUint16(p.receive_maximum);
    }

    if (p?.maximum_QoS) {
      tw.addUint8(Property.Maximum_QoS);
      tw.addUint8(p.maximum_QoS);
    }

    if (p?.retain_available) {
      tw.addUint8(Property.Retain_Available);
      tw.addUint8(p.retain_available ? 1 : 0);
    }

    if (p?.maximum_packet_size) {
      tw.addUint8(Property.Maximum_Packet_Size);
      tw.addUint32(p.maximum_packet_size);
    }

    if (p?.assigned_client_id) {
      tw.addUint8(Property.Assigned_Client_Identifier);
      tw.addUTF8String(p.assigned_client_id);
    }

    if (p?.topic_alias_maximum) {
      tw.addUint8(Property.Topic_Alias_Maximum);
      tw.addUint16(p.topic_alias_maximum);
    }

    tw.addReasonString(p?.reason_string);

    tw.addUserProperties(p?.user_properties);

    if (p?.wildcard_subscription_available === false) {
      tw.addUint8(Property.Wildcard_Subscription_Available);
      tw.addUint8(0);
    }

    if (p?.subscription_identifiers_available === false) {
      tw.addUint8(Property.Subscription_Identifier_Available);
      tw.addUint8(0);
    }

    if (p?.shared_subscription_available === false) {
      tw.addUint8(Property.Shared_Subscription_Available);
      tw.addUint8(0);
    }

    if (p?.server_keep_alive) {
      tw.addUint8(Property.Server_Keep_Alive);
      tw.addUint16(p.server_keep_alive);
    }

    if (p?.response_information) {
      tw.addUint8(Property.Response_Information);
      tw.addUTF8String(p.response_information);
    }

    if (p?.server_reference) {
      tw.addUint8(Property.Server_Reference);
      tw.addUTF8String(p.server_reference);
    }

    if (p?.authentication_method !== undefined) {
      tw.addUint8(Property.Authentication_Method);
      tw.addUTF8String(p.authentication_method);
    }

    if (p?.authentication_data !== undefined) {
      if (p?.authentication_method === undefined) {
        throw new Error(
          "authentication data can only be set if the authentication method is set",
        );
      }
      tw.addUint8(Property.Authentication_Data);
      tw.addBinaryData(p.authentication_data);
    }
  });

  return w.finalizeMessage(ControlPacketType.ConnAck, 0);
}

/**
 * 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901100
 */
export function serializePublishPacket(
  packet: MakeSerializePacketType<PublishPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  const qos = packet.qos ?? QoS.At_most_once_delivery;

  w.addUTF8String(packet.topic);

  if (packet.packet_identifier !== undefined) {
    if (qos === QoS.At_most_once_delivery) {
      throw new Error("packet_identifier can only be set for QoS !== 0");
    }
    w.addUint16(packet.packet_identifier);
  } else {
    if (qos !== QoS.At_most_once_delivery) {
      throw new Error("packet_identifier are required for QoS !== 0");
    }
  }

  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (typeof packet.payload === "string") {
      tw.addUint8(Property.Payload_Format_Indicator);
      tw.addUint8(PayloadFormatIndicator.UTF8);
    }
    if (p?.message_expiry_interval !== undefined) {
      tw.addUint8(Property.Message_Expiry_Interval);
      tw.addUint32(p.message_expiry_interval);
    }

    if (p?.content_type !== undefined) {
      tw.addUint8(Property.Content_Type);
      tw.addUTF8String(p.content_type);
    }

    if (p?.response_topic !== undefined) {
      tw.addUint8(Property.Response_Topic);
      tw.addUTF8String(p.response_topic);
    }

    if (p?.correlation_data !== undefined) {
      tw.addUint8(Property.Correlation_Data);
      tw.addBinaryData(p.correlation_data);
    }

    if (p?.subscription_identifier !== undefined) {
      for (const subscription of p.subscription_identifier) {
        tw.addUint8(Property.Subscription_Identifier);
        tw.addVariableByteInteger(subscription);
      }
    }

    if (p?.topic_alias) {
      tw.addUint8(Property.Topic_Alias);
      tw.addUint16(p.topic_alias);
    }

    tw.addUserProperties(p?.user_properties);
  });

  if (packet.payload === undefined) {
    // no payload
  } else if (typeof packet.payload === "string") {
    w.addString(packet.payload);
  } else if (packet.payload instanceof DataReader) {
    w.addArray(packet.payload.asUint8Array());
  } else {
    w.addArray(packet.payload);
  }

  const flags = (packet.dup ? 0b1000 : 0) |
    (qos << 1) |
    (packet.retain ? 0b0001 : 0);

  return w.finalizeMessage(ControlPacketType.Publish, flags);
}

/**
 * 3.4 PUBACK
 */
export function serializePubAckPacket(
  packet: MakeSerializePacketType<PubAckPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUint16(packet.packet_identifier!);
  if (
    packet.reason_code !== PubAckReasonCode.Success ||
    packet.properties !== undefined
  ) {
    w.addUint8(packet.reason_code ?? PubAckReasonCode.Success);
    w.addProperties(packet.properties, (tw, p) => {
      tw.addReasonString(p?.reason_string);
      tw.addUserProperties(p?.user_properties);
    });
  }
  return w.finalizeMessage(ControlPacketType.PubAck, 0);
}

/**
 * 3.5 PUBREC
 */
export function serializePubRecPacket(
  packet: MakeSerializePacketType<PubRecPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUint16(packet.packet_identifier!);
  if (
    packet.reason_code !== PubRecReasonCode.Success ||
    packet.properties !== undefined
  ) {
    w.addUint8(packet.reason_code ?? PubRecReasonCode.Success);
    w.addProperties(packet.properties, (tw, p) => {
      tw.addReasonString(p?.reason_string);
      tw.addUserProperties(p?.user_properties);
    });
  }
  return w.finalizeMessage(ControlPacketType.PubRec, 0);
}

/**
 * 3.6 PUBREL
 */
export function serializePubRelPacket(
  packet: MakeSerializePacketType<PubRelPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUint16(packet.packet_identifier!);
  if (
    packet.reason_code !== PubRelReasonCode.Success ||
    packet.properties !== undefined
  ) {
    w.addUint8(packet.reason_code ?? PubRelReasonCode.Success);
    w.addProperties(packet.properties, (tw, p) => {
      tw.addReasonString(p?.reason_string);
      tw.addUserProperties(p?.user_properties);
    });
  }
  return w.finalizeMessage(ControlPacketType.PubRel, 0b0010);
}

/**
 * 3.7 PUBCOMP
 */
export function serializePubCompPacket(
  packet: MakeSerializePacketType<PubCompPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUint16(packet.packet_identifier!);
  if (
    packet.reason_code !== PubCompReasonCode.Success ||
    packet.properties !== undefined
  ) {
    w.addUint8(packet.reason_code ?? PubCompReasonCode.Success);
    w.addProperties(packet.properties, (tw, p) => {
      tw.addReasonString(p?.reason_string);
      tw.addUserProperties(p?.user_properties);
    });
  }
  return w.finalizeMessage(ControlPacketType.PubComp, 0);
}

/**
 * 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901161
 */
export function serializeSubscribePacket(
  packet: MakeSerializePacketType<SubscribePacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  if (packet.subscriptions.length == 0) {
    throw new Error("Empty subscriptions are not allowed");
  }

  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.subscription_identifier) {
      tw.addUint8(Property.Subscription_Identifier);
      tw.addVariableByteInteger(p.subscription_identifier);
    }

    tw.addUserProperties(p?.user_properties);
  });

  for (const s of packet.subscriptions) {
    w.addUTF8String(s.topic);
    const flag = (s.qos ?? 0) |
      (s.no_local ? 0b100 : 0) |
      (s.retain_as_published ? 0b1000 : 0) |
      ((s.retain_handling ??
        RetainHandling.Send_retained_messages_at_the_time_of_the_subscribe) <<
        4);
    w.addUint8(flag);
  }

  return w.finalizeMessage(ControlPacketType.Subscribe, 0b10);
}

/**
 * 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901171
 */
export function serializeSubAckPacket(
  packet: MakeSerializePacketType<SubAckPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  if (packet.reason_codes.length === 0) {
    throw new Error("reason_codes cannot be empty");
  }
  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    tw.addReasonString(p?.reason_string);
    tw.addUserProperties(p?.user_properties);
  });

  for (const s of packet.reason_codes) {
    w.addUint8(s);
  }

  return w.finalizeMessage(ControlPacketType.SubAck, 0);
}

/**
 * 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901179
 */
export function serializeUnsubscribePacket(
  packet: MakeSerializePacketType<UnsubscribePacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    tw.addUserProperties(p?.user_properties);
  });

  if (packet.topic_filters.length == 0) {
    throw new Error("Empty subscriptions are not allowed");
  }

  for (const f of packet.topic_filters) {
    w.addUTF8String(f);
  }

  return w.finalizeMessage(ControlPacketType.Unsubscribe, 0b0010);
}

/**
 * 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901187
 */
export function serializeUnsubAckPacket(
  packet: MakeSerializePacketType<UnsubAckPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  if (packet.reason_codes.length === 0) {
    throw new Error("reason_codes cannot be empty");
  }
  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    tw.addReasonString(p?.reason_string);
    tw.addUserProperties(p?.user_properties);
  });

  for (const s of packet.reason_codes) {
    w.addUint8(s);
  }

  return w.finalizeMessage(ControlPacketType.UnsubAck, 0);
}

export const PingReqMessage: Uint8Array = (() => {
  const writer = new Writer(
    {
      bufferSize: 5,
      automaticallyExtendBuffer: false,
    },
  );
  return writer.finalizeMessage(ControlPacketType.PingReq, 0);
})();

export const PingRespMessage: Uint8Array = (() => {
  const writer = new Writer(
    {
      bufferSize: 5,
      automaticallyExtendBuffer: false,
    },
  );
  return writer.finalizeMessage(ControlPacketType.PingResp, 0);
})();

/**
 * 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901205
 */
export function serializeDisconnectPacket(
  packet: MakeSerializePacketType<DisconnectPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  const reason_code = packet.reason_code ??
    DisconnectReasonCode.Normal_disconnection;
  if (
    reason_code === DisconnectReasonCode.Normal_disconnection &&
    packet.properties === undefined
  ) {
    return w.finalizeMessage(ControlPacketType.Disconnect, 0);
  }

  w.addUint8(reason_code);
  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.session_expiry_interval !== undefined) {
      tw.addUint8(Property.Session_Expiry_Interval);
      tw.addUint32(p.session_expiry_interval);
    }

    tw.addReasonString(p?.reason_string);
    tw.addUserProperties(p?.user_properties);

    if (p?.server_reference) {
      tw.addUint8(Property.Server_Reference);
      tw.addUTF8String(p.server_reference);
    }
  });
  return w.finalizeMessage(ControlPacketType.Disconnect, 0);
}

/**
 * 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901217
 */
export function serializeAuthPacket(
  packet: MakeSerializePacketType<AuthPacket>,
  w: Writer,
): Uint8Array {
  w.beginMessage();
  const reason_code = packet.reason_code ?? AuthReasonCode.Success;
  if (
    reason_code === AuthReasonCode.Success && packet.properties === undefined
  ) {
    return w.finalizeMessage(ControlPacketType.Auth, 0);
  }

  w.addUint8(reason_code);
  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.authentication_method !== undefined) {
      tw.addUint8(Property.Authentication_Method);
      tw.addUTF8String(p.authentication_method);
    }

    if (p?.authentication_data !== undefined) {
      if (p?.authentication_method === undefined) {
        throw new Error(
          "authentication data can only be set if the authentication method is set",
        );
      }
      tw.addUint8(Property.Authentication_Data);
      tw.addBinaryData(p.authentication_data);
    }

    tw.addReasonString(p?.reason_string);
    tw.addUserProperties(p?.user_properties);
  });
  return w.finalizeMessage(ControlPacketType.Auth, 0);
}

export function serialize(packet: AllPacket, w: Writer): Uint8Array {
  switch (packet.type) {
    case ControlPacketType.Connect:
      return serializeConnectPacket(packet, w);
    case ControlPacketType.ConnAck:
      return serializeConnAckPacket(packet, w);
    case ControlPacketType.Publish:
      return serializePublishPacket(packet, w);
    case ControlPacketType.PubAck:
      return serializePubAckPacket(packet, w);
    case ControlPacketType.PubRec:
      return serializePubRecPacket(packet, w);
    case ControlPacketType.PubRel:
      return serializePubRelPacket(packet, w);
    case ControlPacketType.PubComp:
      return serializePubCompPacket(packet, w);
    case ControlPacketType.Subscribe:
      return serializeSubscribePacket(packet, w);
    case ControlPacketType.SubAck:
      return serializeSubAckPacket(packet, w);
    case ControlPacketType.Unsubscribe:
      return serializeUnsubscribePacket(packet, w);
    case ControlPacketType.UnsubAck:
      return serializeUnsubAckPacket(packet, w);
    case ControlPacketType.PingReq:
      return PingReqMessage;
    case ControlPacketType.PingResp:
      return PingRespMessage;
    case ControlPacketType.Disconnect:
      return serializeDisconnectPacket(packet, w);
    case ControlPacketType.Auth:
      return serializeAuthPacket(packet, w);
  }
}
