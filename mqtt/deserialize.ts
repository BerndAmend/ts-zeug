/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
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

    if ((encodedByte & 128) == 0) {
      break;
    }
  }
  return value;
}

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
 * 2.1.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901021
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

  while (r.pos < length) {
    const id: Property = r.getUint8();
    switch (id) {
      case Property.Payload_Format_Indicator:
        ret.payload_format_indicator = r.getUint8();
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
        if (ret.subscription_identifier === undefined) {
          ret.subscription_identifier = [];
        }
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
        ret.response_information = asTopic(readUTF8String(r));
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
        if (ret.user_properties === undefined) {
          ret.user_properties = [];
        }
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
    }
  }
  return ret;
}

function deserializeConnectPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): ConnectPacket {
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

  const usernameFlag = (connectFlags & 0b1000_0000) !== 0;
  const passwordFlag = (connectFlags & 0b0100_0000) !== 0;
  const willRetainFlag = (connectFlags & 0b0010_0000) !== 0;
  const willQoS = (connectFlags & 0b0001_1000) >> 3;
  const willFlag = (connectFlags & 0b0000_0100) !== 0;
  ret.clean_start = (connectFlags & 0b0000_0010) !== 0;

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

    // How can we improve the payload handling?
    let payload;
    try {
      payload = readUTF8String(r);
    } catch {
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
 * 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901074
 */
function deserializeConnAckPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): ConnAckPacket {
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
 * 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901100
 */
function deserializePublishPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
  options?: PublishDeserializeOptions,
): PublishPacket {
  const ret: PublishPacket = {
    type: ControlPacketType.Publish,
    topic: asTopic(readUTF8String(r)),
  };

  if (fixedHeader.flags & 0b1000) {
    ret.dup = true;
  }

  if (fixedHeader.flags & 0b0001) {
    ret.retain = true;
  }

  const qos = (fixedHeader.flags >> 1) & 0b11;
  if (qos !== QoS.At_most_once_delivery) {
    ret.qos = qos;
    ret.packet_identifier = r.getUint16() as PacketIdentifier;
  }

  const props = readProperties(r, options);
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
 * 3.4
 */
function deserializePubAckPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): PubAckPacket {
  const ret: PubAckPacket = {
    type: ControlPacketType.PubAck,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.5
 */
function deserializePubRecPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): PubRecPacket {
  const ret: PubRecPacket = {
    type: ControlPacketType.PubRec,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.6
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
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.7
 */
function deserializePubCompPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): PubCompPacket {
  const ret: PubCompPacket = {
    type: ControlPacketType.PubComp,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901161
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
    packet_identifier: r.getUint16() as PacketIdentifier,
    subscriptions: [],
  };

  const props = readProperties(r);
  if (props?.subscription_identifier !== undefined) {
    if (ret.properties === undefined) {
      ret.properties = {};
    }
    ret.properties.subscription_identifier = props.subscription_identifier[0];
  }

  if (props?.user_properties !== undefined) {
    if (ret.properties === undefined) {
      ret.properties = {};
    }
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
    const qos = flags & 0b11;
    if (qos !== 0) {
      subscription.qos = qos;
    }
    if (flags & 0b100) {
      subscription.no_local = true;
    }

    if (flags & 0b1000) {
      subscription.retain_as_published = true;
    }

    const retain_handling = flags >> 4;
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
 * 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901171
 */
function deserializeSubAckPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): SubAckPacket {
  const ret: SubAckPacket = {
    type: ControlPacketType.SubAck,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901179
 */
function deserializeUnsubscribePacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): UnsubscribePacket {
  const ret: UnsubscribePacket = {
    type: ControlPacketType.Unsubscribe,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901187
 */
function deserializeUnsubAckPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): UnsubAckPacket {
  const ret: UnsubAckPacket = {
    type: ControlPacketType.UnsubAck,
    packet_identifier: r.getUint16() as PacketIdentifier,
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
 * 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901205
 */
export function deserializeDisconnectPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): DisconnectPacket {
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
 * 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901217
 */
export function deserializeAuthPacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): AuthPacket {
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
export function deserializePacket(
  fixedHeader: FixedHeader,
  reader: DataReader,
  options?: PublishDeserializeOptions,
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
      return deserializePublishPacket(fixedHeader, r, options);
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
      return { type: fixedHeader.type };
    case ControlPacketType.Disconnect:
      return deserializeDisconnectPacket(fixedHeader, r);
    case ControlPacketType.Auth:
      return deserializeAuthPacket(fixedHeader, r);
  }
  throw new Error(`not implemented yet ${ControlPacketType[fixedHeader.type]}`);
}
