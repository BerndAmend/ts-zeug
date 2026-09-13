/**
 * MQTT 5.0 packet deserialization utilities.
 *
 * @module
 * @license MIT
 * @copyright 2023-2026 Bernd Amend
 */
import type { DataReader } from "../helper/mod.ts";
import {
  type AllPacket,
  type AllProperties,
  asTopic,
  asTopicFilter,
  type AuthPacket,
  type ClientID,
  type ConnAckPacket,
  type ConnectPacket,
  ControlPacketType,
  type DisconnectPacket,
  type FixedHeader,
  type PacketIdentifier,
  PayloadFormatIndicator,
  Property,
  type PubAckPacket,
  type PubCompPacket,
  type PublishPacket,
  type PubRecPacket,
  type PubRelPacket,
  QoS,
  RetainHandling,
  type Seconds,
  type SubAckPacket,
  type SubscribePacket,
  type Topic,
  type TopicFilter,
  type UnsubAckPacket,
  type UnsubscribePacket,
} from "./packets.ts";

function readVariableByteInteger(reader: DataReader): number;
function readVariableByteInteger(
  reader: DataReader,
  gracefullyHandleIncompleteNumbers?: boolean,
): number | undefined;

function readVariableByteInteger(
  reader: DataReader,
  gracefullyHandleIncompleteNumbers?: boolean,
): number | undefined {
  let multiplier = 1;
  let value = 0;
  const maxMultiplier = 128 * 128 * 128;

  while (true) {
    let encodedByte: number;
    try {
      encodedByte = reader.getUint8();
    } catch (e) {
      if (gracefullyHandleIncompleteNumbers) {
        return undefined;
      }
      throw e;
    }

    value += (encodedByte & 127) * multiplier;

    if (multiplier > maxMultiplier) {
      throw new Error("Malformed Variable Byte Integer");
    }

    multiplier *= 128;

    if ((encodedByte & 128) === 0) {
      break;
    }
  }
  return value;
}

/**
 * Options for how to deserialize PUBLISH packet payloads.
 */
export enum PublishDeserializeOptions {
  /**
   * Depending on the payload_format_indicator return the payload as a UTF8 string or as a DataReader.
   */
  PayloadFormatIndicator,
  /**
   * Always return the payload as a DataReader.
   */
  DataReader,
  /**
   * Always tries to return the payload as a UTF8 string.
   * If the payload is not a valid UTF8 string, it will return a DataReader.
   */
  UTF8String,
  /**
   * Always returns the payload as a Uint8Array.
   */
  Uint8Array,
}

/**
 * Called during deserialization to resolve a topic alias to the actual topic
 * string. Returns undefined if the alias is unknown, in which case the topic
 * remains empty.
 */
export type TopicAliasResolver = (topicAlias: number) => Topic | undefined;

/**

 * 2.1.1 Reads the MQTT fixed header from a reader.
 * @param reader - The data reader
 * @returns The parsed fixed header, or undefined if incomplete
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901021}
 */
export function readFixedHeader(
  reader: DataReader,
): FixedHeader | undefined {
  const d = reader.getUint8();
  const len = readVariableByteInteger(reader, true);
  if (len === undefined) {
    return undefined;
  }
  return {
    type: d >> 4,
    flags: d & 0x0f,
    length: len,
  };
}

function readUTF8String(reader: DataReader): string {
  const len = reader.getUint16();
  return reader.getUTF8String(len);
}

/**
 * Reads a Packet Identifier (2 byte integer). Per MQTT 5.0 [MQTT-2.2.1-2] a
 * Packet Identifier of 0 is a Protocol Error.
 */
function readPacketIdentifier(reader: DataReader): PacketIdentifier {
  const identifier = reader.getUint16();
  if (identifier === 0) {
    throw new Error("Invalid Packet Identifier: must not be 0");
  }
  return identifier as PacketIdentifier;
}

function readBinaryData(
  reader: DataReader,
  options?: PublishDeserializeOptions,
): Uint8Array | DataReader {
  const len = reader.getUint16();
  if (options === PublishDeserializeOptions.Uint8Array) {
    return reader.getUint8Array(len);
  }
  return reader.getDataReader(len);
}

/**
 * Reads the properties from a reader.
 * https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc464547805
 * @param reader - The data reader
 * @returns The parsed properties, or undefined if no properties are present
 */
function readProperties(
  reader: DataReader,
  options?: PublishDeserializeOptions,
): AllProperties | undefined {
  if (!reader.hasMoreData) {
    return undefined;
  }

  const length = readVariableByteInteger(reader);

  if (length === 0) {
    return undefined;
  }

  const r = reader.getDataReader(length);
  const ret: AllProperties = {};
  const seen = new Set<Property>();

  while (r.pos < length) {
    const id: Property = r.getUint8();
    // [MQTT-2.2.2-1] A property MUST NOT appear more than once, except for
    // the User Property and (in PUBLISH) the Subscription Identifier.
    if (
      id !== Property.User_Property &&
      id !== Property.Subscription_Identifier
    ) {
      if (seen.has(id)) {
        throw new Error(
          `Duplicate property identifier: 0x${id.toString(16)}`,
        );
      }
      seen.add(id);
    }
    switch (id) {
      case Property.Payload_Format_Indicator:
        ret.payload_format_indicator = r.getUint8();
        if (ret.payload_format_indicator > PayloadFormatIndicator.UTF8) {
          throw new Error(
            `Invalid Payload Format Indicator: ${ret.payload_format_indicator}`,
          );
        }
        break;
      case Property.Message_Expiry_Interval:
        ret.message_expiry_interval = r.getUint32() as Seconds;
        break;
      case Property.Content_Type:
        ret.content_type = readUTF8String(r);
        break;
      case Property.Response_Topic:
        ret.response_topic = asTopic(readUTF8String(r));
        break;
      case Property.Correlation_Data:
        ret.correlation_data = readBinaryData(r, options);
        break;
      case Property.Subscription_Identifier:
        ret.subscription_identifier ??= [];
        ret.subscription_identifier.push(readVariableByteInteger(r));
        break;
      case Property.Session_Expiry_Interval:
        ret.session_expiry_interval = r.getUint32() as Seconds;
        break;
      case Property.Assigned_Client_Identifier:
        ret.assigned_client_id = readUTF8String(r) as ClientID; // mosquitto sends as client ids that contain more characters than required by the mqtt spec
        break;
      case Property.Server_Keep_Alive:
        ret.server_keep_alive = r.getUint16() as Seconds;
        break;
      case Property.Authentication_Method:
        ret.authentication_method = readUTF8String(r);
        break;
      case Property.Authentication_Data:
        ret.authentication_data = readBinaryData(r) as Uint8Array;
        break;
      case Property.Request_Problem_Information:
        ret.request_problem_information = r.getUint8() !== 0;
        break;
      case Property.Will_Delay_Interval:
        ret.will_delay_interval = r.getUint32() as Seconds;
        break;
      case Property.Request_Response_Information:
        ret.request_response_information = r.getUint8() === 1;
        break;
      case Property.Response_Information:
        ret.response_information = readUTF8String(r);
        break;
      case Property.Server_Reference:
        ret.server_reference = readUTF8String(r);
        break;
      case Property.Reason_String:
        ret.reason_string = readUTF8String(r);
        break;
      case Property.Receive_Maximum:
        ret.receive_maximum = r.getUint16();
        break;
      case Property.Topic_Alias_Maximum:
        ret.topic_alias_maximum = r.getUint16();
        break;
      case Property.Topic_Alias:
        ret.topic_alias = r.getUint16();
        break;
      case Property.Maximum_QoS:
        ret.maximum_QoS = r.getUint8();
        break;
      case Property.Retain_Available:
        ret.retain_available = r.getUint8() === 1;
        break;
      case Property.User_Property:
        ret.user_properties ??= [];
        ret.user_properties.push({
          key: readUTF8String(r),
          value: readUTF8String(r),
        });
        break;
      case Property.Maximum_Packet_Size:
        ret.maximum_packet_size = r.getUint32();
        break;
      case Property.Wildcard_Subscription_Available:
        ret.wildcard_subscription_available = r.getUint8() !== 0;
        break;
      case Property.Subscription_Identifier_Available:
        ret.subscription_identifiers_available = r.getUint8() !== 0;
        break;
      case Property.Shared_Subscription_Available:
        ret.shared_subscription_available = r.getUint8() !== 0;
        break;
      default:
        // MQTT 5.0 properties carry no encoding discriminator: the value format
        // is implicit in the identifier, so an unknown identifier cannot be safely
        // skipped (its value length is unknown). Reject it as a protocol error.
        throw new Error(
          `Unknown property identifier: 0x${(id as number).toString(16)}`,
        );
    }
  }
  return ret;
}

/**
 * 3.1 Deserializes a CONNECT packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901033}
 */
function deserializeConnectPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): ConnectPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for Connect packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: ConnectPacket = {
    type: ControlPacketType.Connect,
  };

  // 3.2.2.1 Connect Acknowledge Flags https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901077
  const protocol_name = readUTF8String(r);
  if (protocol_name !== "MQTT") {
    throw new Error(`received the invalid protocol_name '${protocol_name}'`);
  }

  const protocol_version = r.getUint8();
  if (protocol_version !== 5) {
    throw new Error(
      `received the invalid protocol_version '${protocol_version}'`,
    );
  }

  ret.protocol_name = "MQTT";
  ret.protocol_version = 5;

  const connectFlags = r.getUint8();

  // 3.1.2.3 The reserved flag bit 0 MUST be set to 0.
  if ((connectFlags & 0b0000_0001) !== 0) {
    throw new Error("Invalid Connect flags: reserved bit 0 must be 0");
  }

  const usernameFlag = (connectFlags & 0b1000_0000) !== 0;
  const passwordFlag = (connectFlags & 0b0100_0000) !== 0;
  const willRetainFlag = (connectFlags & 0b0010_0000) !== 0;
  const willQoS = ((connectFlags & 0b0001_1000) >> 3) as QoS;
  const willFlag = (connectFlags & 0b0000_0100) !== 0;
  ret.clean_start = (connectFlags & 0b0000_0010) !== 0;

  // 3.1.2.6/3.1.2.7 If the Will Flag is 0 the Will QoS and Will Retain bits
  // MUST be 0. If the Will Flag is 1 the Will QoS MUST NOT be 3.
  if (
    !willFlag &&
    (willQoS !== QoS.At_most_once_delivery || willRetainFlag)
  ) {
    throw new Error(
      "Invalid Connect flags: Will QoS/Retain set without a Will Flag",
    );
  }
  if (willFlag && willQoS === QoS.Reserved) {
    throw new Error("Invalid Connect flags: Will QoS must not be 3");
  }
  // [MQTT-3.1.2-22] If the User Name Flag is 0 the Password Flag MUST be 0.
  if (passwordFlag && !usernameFlag) {
    throw new Error(
      "Invalid Connect flags: Password Flag set without User Name Flag",
    );
  }

  ret.keepalive = r.getUint16() as Seconds;

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  // 3.1.3 Payload https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901058
  ret.client_id = readUTF8String(r) as ClientID;

  if (willFlag) {
    const willProps = readProperties(r);

    const topic = readUTF8String(r);

    // 3.1.3.4 The Will Payload is Binary Data; only decode as UTF-8 when the
    // Will Properties explicitly mark it as UTF-8.
    let payload: string | Uint8Array | DataReader;
    if (willProps?.payload_format_indicator === PayloadFormatIndicator.UTF8) {
      payload = readUTF8String(r);
    } else {
      payload = readBinaryData(r);
    }

    ret.will = {
      qos: willQoS,
      retain: willRetainFlag,
      topic: topic as Topic,
      payload,
    };

    if (willProps !== undefined) {
      ret.will.properties = willProps;
    }
  }

  if (usernameFlag) {
    ret.username = readUTF8String(r);
  }

  if (passwordFlag) {
    ret.password = readUTF8String(r);
  }

  // Should we check if only the expected properties existed?
  // session_expiry_interval, receive_maximum, maximum_QoS, retain_available,
  // maximum_packet_size, assigned_client_id, topic_alias_maximum, reason_string,
  // user_properties, wildcard_subscription_available, subscription_identifiers_available,
  // shared_subscription_available, server_keep_alive, response_information,
  // server_reference, authentication_method, authentication_data

  return ret;
}

/**
 * 3.2 Deserializes a CONNACK packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901074}
 */
function deserializeConnAckPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): ConnAckPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for ConnAck packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: ConnAckPacket = {
    type: ControlPacketType.ConnAck,
  };

  // 3.2.2.1 Connect Acknowledge Flags https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901077
  ret.session_present = r.getUint8() === 1;
  ret.connect_reason_code = r.getUint8();

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  // Should we check if only the expected properties existed?
  // session_expiry_interval, receive_maximum, maximum_QoS, retain_available,
  // maximum_packet_size, assigned_client_id, topic_alias_maximum, reason_string,
  // user_properties, wildcard_subscription_available, subscription_identifiers_available,
  // shared_subscription_available, server_keep_alive, response_information,
  // server_reference, authentication_method, authentication_data

  return ret;
}

/**
 * 3.3 Deserializes a PUBLISH packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901100}
 */
function deserializePublishPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
  options?: PublishDeserializeOptions,
  resolveTopicAlias?: TopicAliasResolver,
): PublishPacket {
  const topicRaw = readUTF8String(r);
  const qos: QoS = (fixedHeader.flags >> 1) & 0b11;

  if (qos === QoS.Reserved) {
    throw new Error("Invalid QoS (3) in PUBLISH packet");
  }

  let packet_identifier: PacketIdentifier | undefined;
  if (qos !== QoS.At_most_once_delivery) {
    packet_identifier = readPacketIdentifier(r);
  }

  const props = readProperties(r, options);

  // 3.3.2.3.4 A Topic Alias of 0 is a Protocol Error.
  if (props?.topic_alias === 0) {
    throw new Error("Invalid Topic Alias: must not be 0");
  }

  const ret: PublishPacket = {
    type: ControlPacketType.Publish,
    topic: (topicRaw !== "" || props?.topic_alias === undefined)
      ? asTopic(topicRaw)
      : (resolveTopicAlias?.(props.topic_alias) ?? "" as Topic),
  };

  if (fixedHeader.flags & 0b1000) {
    ret.dup = true;
  }

  if (fixedHeader.flags & 0b0001) {
    ret.retain = true;
  }

  if (qos !== QoS.At_most_once_delivery) {
    ret.qos = qos;
    ret.packet_identifier = packet_identifier;
  }

  if (props !== undefined) {
    ret.properties = props;
  }

  const remainingSize = r.remainingSize;
  if (remainingSize > 0) {
    switch (options ?? PublishDeserializeOptions.PayloadFormatIndicator) {
      case PublishDeserializeOptions.PayloadFormatIndicator:
        if (props?.payload_format_indicator) {
          try {
            ret.payload = r.getUTF8String(remainingSize);
          } catch {
            ret.payload = r.getDataReader(remainingSize);
          }
        } else {
          ret.payload = r.getDataReader(remainingSize);
        }
        break;
      case PublishDeserializeOptions.UTF8String:
        try {
          ret.payload = r.getUTF8String(remainingSize);
        } catch {
          ret.payload = r.getDataReader(remainingSize);
        }
        break;
      case PublishDeserializeOptions.DataReader:
        ret.payload = r.getDataReader(remainingSize);
        break;
      case PublishDeserializeOptions.Uint8Array:
        ret.payload = r.getUint8Array(remainingSize);
        break;
    }
  }
  return ret;
}

/**
 * 3.4 Deserializes a PUBACK packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901121}
 */
function deserializePubAckPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): PubAckPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for PubAck packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: PubAckPacket = {
    type: ControlPacketType.PubAck,
    packet_identifier: readPacketIdentifier(r),
  };
  if (r.hasMoreData) {
    ret.reason_code = r.getUint8();
    const props = readProperties(r);
    if (props !== undefined) {
      ret.properties = props;
    }
  }
  return ret;
}

/**
 * 3.5 Deserializes a PUBREC packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800421}
 */
function deserializePubRecPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): PubRecPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for PubRec packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: PubRecPacket = {
    type: ControlPacketType.PubRec,
    packet_identifier: readPacketIdentifier(r),
  };
  if (r.hasMoreData) {
    ret.reason_code = r.getUint8();
    const props = readProperties(r);
    if (props !== undefined) {
      ret.properties = props;
    }
  }
  return ret;
}

/**
 * 3.6 Deserializes a PUBREL packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800426}
 */
function deserializePubRelPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): PubRelPacket {
  if (fixedHeader.flags !== 0b0010) {
    throw new Error(
      `Invalid flags for PubRel packet: ${fixedHeader.flags}, expected 0b0010`,
    );
  }
  const ret: PubRelPacket = {
    type: ControlPacketType.PubRel,
    packet_identifier: readPacketIdentifier(r),
  };
  if (r.hasMoreData) {
    ret.reason_code = r.getUint8();
    const props = readProperties(r);
    if (props !== undefined) {
      ret.properties = props;
    }
  }
  return ret;
}

/**
 * 3.7 Deserializes a PUBCOMP packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc511988628}
 */
function deserializePubCompPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): PubCompPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for PubComp packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: PubCompPacket = {
    type: ControlPacketType.PubComp,
    packet_identifier: readPacketIdentifier(r),
  };
  if (r.hasMoreData) {
    ret.reason_code = r.getUint8();
    const props = readProperties(r);
    if (props !== undefined) {
      ret.properties = props;
    }
  }
  return ret;
}

/**
 * 3.8 Deserializes a SUBSCRIBE packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901161}
 */
function deserializeSubscribePacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): SubscribePacket {
  if (fixedHeader.flags !== 0b0010) {
    throw new Error(
      `Invalid flags for Subscribe packet: ${fixedHeader.flags}, expected 0b0010`,
    );
  }

  const ret: SubscribePacket = {
    type: ControlPacketType.Subscribe,
    packet_identifier: readPacketIdentifier(r),
    subscriptions: [],
  };

  const props = readProperties(r);
  if (props?.subscription_identifier !== undefined) {
    ret.properties ??= {};
    ret.properties.subscription_identifier = props.subscription_identifier[0];
  }

  if (props?.user_properties !== undefined) {
    ret.properties ??= {};
    ret.properties.user_properties = props.user_properties;
  }

  while (r.hasMoreData) {
    const topicFilter = asTopicFilter(readUTF8String(r));
    const flags = r.getUint8();
    const subscription: { // 3.8.3.1
      topic: TopicFilter;
      qos?: QoS; // defaults to QoS.At_most_once_delivery
      no_local?: boolean;
      retain_handling?: RetainHandling; // defaults to Send_retained_messages_at_the_time_of_the_subscribe
      retain_as_published?: boolean;
    } = { topic: topicFilter };
    const qos = (flags & 0b11) as QoS;
    // 3.8.3.1 Reserved bits 6-7 MUST be 0, QoS MUST NOT be 3 and Retain
    // Handling MUST NOT be 3.
    if ((flags & 0b1100_0000) !== 0) {
      throw new Error(
        "Invalid Subscribe options: reserved bits must be 0",
      );
    }
    if (qos === QoS.Reserved) {
      throw new Error("Invalid Subscribe options: QoS must not be 3");
    }
    const retain_handling = ((flags >> 4) & 0b11) as RetainHandling;
    if (
      retain_handling >
        RetainHandling
          .Do_not_send_retained_messages_at_the_time_of_the_subscribe
    ) {
      throw new Error(
        "Invalid Subscribe options: Retain Handling must not be 3",
      );
    }
    if (qos !== QoS.At_most_once_delivery) {
      subscription.qos = qos;
    }
    if (flags & 0b100) {
      subscription.no_local = true;
    }

    if (flags & 0b1000) {
      subscription.retain_as_published = true;
    }

    if (
      retain_handling !==
        RetainHandling.Send_retained_messages_at_the_time_of_the_subscribe
    ) {
      subscription.retain_handling = retain_handling;
    }

    ret.subscriptions.push(subscription);
  }

  return ret;
}

/**
 * 3.9 Deserializes a SUBACK packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901171}
 */
function deserializeSubAckPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): SubAckPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for SubAck packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: SubAckPacket = {
    type: ControlPacketType.SubAck,
    packet_identifier: readPacketIdentifier(r),
    reason_codes: [],
  };

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  while (r.hasMoreData) {
    ret.reason_codes.push(r.getUint8());
  }

  return ret;
}

/**
 * 3.10 Deserializes an UNSUBSCRIBE packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901179}
 */
function deserializeUnsubscribePacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): UnsubscribePacket {
  if (fixedHeader.flags !== 0b0010) {
    throw new Error(
      `Invalid flags for Unsubscribe packet: ${fixedHeader.flags}, expected 0b0010`,
    );
  }
  const ret: UnsubscribePacket = {
    type: ControlPacketType.Unsubscribe,
    packet_identifier: readPacketIdentifier(r),
    topic_filters: [],
  };

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  while (r.hasMoreData) {
    ret.topic_filters.push(asTopicFilter(readUTF8String(r)));
  }

  return ret;
}

/**
 * 3.11 Deserializes an UNSUBACK packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901187}
 */
function deserializeUnsubAckPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): UnsubAckPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for UnsubAck packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: UnsubAckPacket = {
    type: ControlPacketType.UnsubAck,
    packet_identifier: readPacketIdentifier(r),
    reason_codes: [],
  };

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  while (r.hasMoreData) {
    ret.reason_codes.push(r.getUint8());
  }

  return ret;
}

/**
 * 3.14 Deserializes a DISCONNECT packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901205}
 */
export function deserializeDisconnectPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): DisconnectPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for Disconnect packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: DisconnectPacket = {
    type: ControlPacketType.Disconnect,
  };

  if (!r.hasMoreData) {
    return ret;
  }

  ret.reason_code = r.getUint8();

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  return ret;
}

/**
 * 3.15 Deserializes an AUTH packet.
 * @see {@link https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901217}
 */
export function deserializeAuthPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
): AuthPacket {
  if (fixedHeader.flags !== 0) {
    throw new Error(
      `Invalid flags for Auth packet: ${fixedHeader.flags}, expected 0`,
    );
  }
  const ret: AuthPacket = {
    type: ControlPacketType.Auth,
  };

  if (!r.hasMoreData) {
    return ret;
  }

  ret.reason_code = r.getUint8();

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  return ret;
}
/**
 * Deserializes any MQTT packet from binary data.
 * @param fixedHeader - The packet's fixed header
 * @param reader - The data reader positioned after the fixed header
 * @param options - Optional payload deserialization options for PUBLISH packets
 * @returns The deserialized packet
 * @throws If the packet type is not implemented or invalid
 */
export function deserializePacket(
  fixedHeader: FixedHeader,
  reader: DataReader,
  options?: PublishDeserializeOptions,
  resolveTopicAlias?: TopicAliasResolver,
): AllPacket {
  const r = reader.getDataReader(fixedHeader.length);
  switch (fixedHeader.type) {
    case ControlPacketType.Reserved:
      break;
    case ControlPacketType.Connect:
      return deserializeConnectPacket(fixedHeader, r);
    case ControlPacketType.ConnAck:
      return deserializeConnAckPacket(fixedHeader, r);
    case ControlPacketType.Publish:
      return deserializePublishPacket(
        fixedHeader,
        r,
        options,
        resolveTopicAlias,
      );
    case ControlPacketType.PubAck:
      return deserializePubAckPacket(fixedHeader, r);
    case ControlPacketType.PubRec:
      return deserializePubRecPacket(fixedHeader, r);
    case ControlPacketType.PubRel:
      return deserializePubRelPacket(fixedHeader, r);
    case ControlPacketType.PubComp:
      return deserializePubCompPacket(fixedHeader, r);
    case ControlPacketType.Subscribe:
      return deserializeSubscribePacket(fixedHeader, r);
    case ControlPacketType.SubAck:
      return deserializeSubAckPacket(fixedHeader, r);
    case ControlPacketType.Unsubscribe:
      return deserializeUnsubscribePacket(fixedHeader, r);
    case ControlPacketType.UnsubAck:
      return deserializeUnsubAckPacket(fixedHeader, r);
    case ControlPacketType.PingResp:
    case ControlPacketType.PingReq:
      if (fixedHeader.flags !== 0) {
        throw new Error(
          `Invalid flags for ${
            ControlPacketType[fixedHeader.type]
          } packet: ${fixedHeader.flags}, expected 0`,
        );
      }
      return { type: fixedHeader.type };
    case ControlPacketType.Disconnect:
      return deserializeDisconnectPacket(fixedHeader, r);
    case ControlPacketType.Auth:
      return deserializeAuthPacket(fixedHeader, r);
  }
  throw new Error(`not implemented yet ${ControlPacketType[fixedHeader.type]}`);
}
