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
import { Branded, DataReader, DataWriter } from "../helper/mod.ts";
import { streamifyWebSocket } from "../helper/websocket.ts";

//#region Types

// 2.1.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901022
// 4-bit unsigned integer
export enum ControlPacketType {
  Reserved,
  Connect, // C->S Connection Request flags=0
  ConnAck, // S->C Connect acknowledgment flags=0
  Publish, //  *   Publish message flags=dup:1, qos:2, retain:1
  PubAck, //   *   Publish acknowledgment (QoS 1) flags=0
  PubRec, //   *   Publish received (QoS 2 delivery part 1) flags=0
  PubRel, //   *   Publish release (QoS 2 delivery part 2) flags=2
  PubComp, //  *   Publish complete (QoS 2 delivery part 3) flags=0
  Subscribe, // C->S Subscribe request flags=2
  SubAck, // S->C  Subscribe acknowledgment flags=0
  Unsubscribe, // C->S Unsubscribe request flags=2
  UnsubAck, // S->C Unsubscribe acknowledgment flags=0
  PingReq, // C->S  PING request flags=0
  PingResp, // S->C PING response flags=0
  Disconnect, // * Disconnect notification flags=0
  Auth, // * Authentication exchange flags=0
}

// 3.3.1.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901103
export enum QoS {
  At_most_once_delivery,
  At_least_once_delivery,
  Exactly_once_delivery,
  Reserved,
}

// 3.3.2.3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901111
const enum PayloadFormatIndicator {
  Binary, // default
  UTF8,
}

// 2.2.2.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html#_Toc464547805
enum Property {
  Payload_Format_Indicator = 0x01, //	Byte	 	PUBLISH, Will Properties
  Message_Expiry_Interval = 0x02, //	Four Byte Integer	 	PUBLISH, Will Properties
  Content_Type = 0x03, //	UTF-8 Encoded String	 	PUBLISH, Will Properties
  Response_Topic = 0x08, //	UTF-8 Encoded String	 	PUBLISH, Will Properties
  Correlation_Data = 0x09, //	Binary Data	 	PUBLISH, Will Properties
  Subscription_Identifier = 0x0B, //	Variable Byte Integer	 	PUBLISH, SUBSCRIBE
  Session_Expiry_Interval = 0x11, //	Four Byte Integer	 	CONNECT, CONNACK, DISCONNECT
  Assigned_Client_Identifier = 0x12, //	UTF-8 Encoded String	 	ConnAck
  Server_Keep_Alive = 0x13, //	Two Byte Integer	 	ConnAck
  Authentication_Method = 0x15, //	UTF-8 Encoded String	 	CONNECT, ConnAck, AUTH
  Authentication_Data = 0x16, //	Binary Data	 	CONNECT, ConnAck, AUTH
  Request_Problem_Information = 0x17, //	Byte	 	CONNECT
  Will_Delay_Interval = 0x18, //	Four Byte Integer	 	Will Properties
  Request_Response_Information = 0x19, //	Byte	 	CONNECT
  Response_Information = 0x1A, //	UTF-8 Encoded String	 	ConnAck
  Server_Reference = 0x1C, //	UTF-8 Encoded String	 	ConnAck, DISCONNECT
  Reason_String = 0x1F, //	UTF-8 Encoded String	 	ConnAck, PUBACK, PUBREC, PUBREL, PUBCOMP, SUBACK, UNSUBACK, DISCONNECT, AUTH
  Receive_Maximum = 0x21, //	Two Byte Integer	 	CONNECT, ConnAck
  Topic_Alias_Maximum = 0x22, //	Two Byte Integer	 	CONNECT, ConnAck
  Topic_Alias = 0x23, //	Two Byte Integer	 	PUBLISH
  Maximum_QoS = 0x24, //	Byte	 	ConnAck
  Retain_Available = 0x25, //	Byte	 	ConnAck
  User_Property = 0x26, //	UTF-8 String Pair	 	CONNECT, ConnAck, PUBLISH, Will Properties, PUBACK, PUBREC, PUBREL, PUBCOMP, SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK, DISCONNECT, AUTH
  Maximum_Packet_Size = 0x27, //	Four Byte Integer	 	CONNECT, ConnAck
  Wildcard_Subscription_Available = 0x28, //	Byte	 	ConnAck
  Subscription_Identifier_Available = 0x29, //	Byte	 	ConnAck
  Shared_Subscription_Available = 0x2A, //	Byte	 	ConnAck
}

// 3.2.2.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901079
export enum ConnectReasonCode {
  Success = 0x00,
  Unspecified_error = 0x80,
  Malformed_Packet = 0x81,
  Protocol_Error = 0x82,
  Implementation_specific_error = 0x83,
  Unsupported_Protocol_Version = 0x84,
  Client_Identifier_not_valid = 0x85,
  Bad_User_Name_or_Password = 0x86,
  Not_authorized = 0x87,
  Server_unavailable = 0x88,
  Server_busy = 0x89,
  Banned = 0x8A,
  Bad_authentication_method = 0x8C,
  Topic_Name_invalid = 0x90,
  Packet_too_large = 0x95,
  Quota_exceeded = 0x97,
  Payload_format_invalid = 0x99,
  Retain_not_supported = 0x9A,
  QoS_not_supported = 0x9B,
  Use_another_server = 0x9C,
  Server_moved = 0x9D,
  Connection_rate_exceeded = 0x9F,
}

// 3.4.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901124
export enum PubAckReasonCode {
  Success = 0x00,
  No_matching_subscribers = 0x10,
  Unspecified_error = 0x80,
  Implementation_specific_error = 0x83,
  Not_authorized = 0x87,
  Topic_Name_invalid = 0x90,
  Packet_Identifier_in_use = 0x91,
  Quota_exceeded = 0x97,
  Payload_format_invalid = 0x99,
}

// 3.9.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901178
export enum SubAckReasonCode {
  Granted_QoS_0 = 0x00,
  Granted_QoS_1 = 0x01,
  Granted_QoS_2 = 0x02,
  Unspecified_error = 0x80,
  Implementation_specific_error = 0x83,
  Not_authorized = 0x87,
  Topic_Filter_invalid = 0x8F,
  Packet_Identifier_in_use = 0x91,
  Quota_exceeded = 0x97,
  Shared_Subscriptions_not_supported = 0x9E,
  Subscription_Identifiers_not_supported = 0xA1,
  Wildcard_Subscriptions_not_supported = 0xA2,
}

// 3.11.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901194
export enum UnsubAckReasonCode {
  Success = 0x00,
  No_subscription_existed = 0x11,
  Unspecified_error = 0x80,
  Implementation_specific_error = 0x83,
  Not_authorized = 0x87,
  Topic_Filter_invalid = 0x8F,
  Packet_Identifier_in_use = 0x91,
}

// 3.14.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901208
export enum DisconnectReasonCode {
  Normal_disconnection = 0x00,
  Disconnect_with_Will_Message = 0x04,
  Unspecified_error = 0x80,
  Malformed_Packet = 0x81,
  Protocol_Error = 0x82,
  Implementation_specific_error = 0x83,
  Not_authorized = 0x87,
  Server_busy = 0x89,
  Server_shutting_down = 0x8B,
  Keep_Alive_timeout = 0x8D,
  Session_taken_over = 0x8E,
  Topic_Filter_invalid = 0x8F,
  Topic_Name_invalid = 0x90,
  Receive_Maximum_exceeded = 0x93,
  Topic_Alias_invalid = 0x94,
  Packet_too_large = 0x95,
  Message_rate_too_high = 0x96,
  Quota_exceeded = 0x97,
  Administrative_action = 0x98,
  Payload_format_invalid = 0x99,
  Retain_not_supported = 0x9A,
  QoS_not_supported = 0x9B,
  Use_another_server = 0x9C,
  Server_moved = 0x9D,
  Shared_Subscriptions_not_supported = 0x9E,
  Connection_rate_exceeded = 0x9F,
  Maximum_connect_time = 0xA0,
  Subscription_Identifiers_not_supported = 0xA1,
  Wildcard_Subscriptions_not_supported = 0xA2,
}

// 3.15.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901220
export enum AuthReasonCode {
  Success = 0x00,
  Continue_authentication = 0x18,
  Re_authenticate = 0x19,
}

export type ClientID = Branded<string, "ClientID">; // 3.1.3.1
export type Topic = Branded<string, "Topic">;
// similar to topic to also allows the characters # and ?
export type TopicFilter = Branded<string, "TopicFilter">;
export type Seconds = Branded<number, "Seconds">;
export type PacketIdentifier = Branded<number, "PacketIdentifier">;

export type UserProperty = { key: string; value: string };

export function asTopic(input: string): Topic {
  if (input === "") {
    throw new Error(`Invalid Topic: cannot be empty`);
  }
  if (input.startsWith("/")) {
    throw new Error(
      `Invalid Topic: cannot start with a '/' input '${input}'`,
    );
  }
  if (input.includes("#")) {
    throw new Error(
      `Invalid Topic: cannot contain '#' input '${input}'`,
    );
  }
  if (input.includes("+")) {
    throw new Error(
      `Invalid Topic: cannot contain '+' input '${input}'`,
    );
  }

  return input as Topic;
}

export function asTopicFilter(input: string): TopicFilter {
  if (input === "") {
    throw new Error(`Invalid TopicFilter: cannot be empty`);
  }
  if (input.startsWith("/")) {
    throw new Error(
      `Invalid TopicFilter: cannot start with a '/' input '${input}'`,
    );
  }

  // TODO: check if a ? or # occur on an invalid position

  return input as TopicFilter;
}

export function asClientID(input: string): ClientID {
  const charSet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-";
  for (const o of input) {
    if (!charSet.includes(o)) {
      throw new Error(
        `Invalid ClientID: input '${input}' contains the invalid character '${o}' allowed characters '${charSet}'`,
      );
    }
  }
  return input as ClientID;
}

const maxFixedHeaderSize = 5; // 1 Byte + max size of a variable byte integer

export type FixedHeader = {
  type: ControlPacketType;
  flags: number;
  length: number;
};

export type AllProperties = Partial<{
  payload_format_indicator: boolean; // 3.3.2.3.2 true==utf8
  message_expiry_interval: Seconds; // 3.3.2.3.3
  content_type: string; // 3.1.3.2.5
  response_topic: Topic; // 3.3.2.3.5
  correlation_data: Uint8Array; // 3.3.2.3.6
  subscription_identifier: number[]; // 3.3.2.3.8
  session_expiry_interval: Seconds; // 3.1.2.11.2
  assigned_client_id: ClientID; // 3.2.2.3.7
  server_keep_alive: Seconds; // 3.2.2.3.14 - defaults to the value send by the client before
  authentication_method: string; // 3.1.2.11.9
  authentication_data: Uint8Array; // 3.1.2.11.10
  request_problem_information: boolean; // 3.1.2.11.7
  will_delay_interval: Seconds; // 3.1.3.2.2
  request_response_information: boolean; // 3.1.2.11.6
  response_information: Topic; // 3.2.2.3.15
  server_reference: string; // 3.2.2.3.16
  reason_string: string; // 3.2.2.3.9
  receive_maximum: number; // 3.1.2.11.3
  topic_alias_maximum: number; // 3.1.2.11.5
  topic_alias: number; // 3.3.2.3.4
  maximum_QoS: QoS; // 3.2.2.3.4
  retain_available: boolean; // 3.2.2.3.5
  user_properties: UserProperty[]; // 3.1.2.11.8
  maximum_packet_size: number; // 3.1.2.11.4
  wildcard_subscription_available: boolean; // 3.2.2.3.11 - undefined === true
  subscription_identifiers_available: boolean; // 3.2.2.3.12 - undefined === true
  shared_subscription_available: boolean; // 3.2.2.3.13 - undefined === true
}>;

// 3.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_CONNECT_%E2%80%93_Connection
export type ConnectPacket = {
  type: ControlPacketType.Connect;
  protocol_name?: "MQTT"; // 3.1.2.1
  protocol_version?: 5; // 3.1.2.2
  clean_start?: boolean; // 3.1.2.4
  client_id?: ClientID; // 3.1.3.1
  username?: string; // 3.1.2.8, 3.1.3.5
  password?: string; // 3.1.2.9, 3.1.3.6
  keepalive?: Seconds; // 3.1.2.10
  will?: { // 3.1.2.5
    qos?: QoS; // 3.1.2.6 defaults to QoS.At_most_once_delivery
    retain?: boolean; // 3.1.2.7 defaults to false
    topic: Topic; // 3.1.3.3
    payload?: Uint8Array | string; // 3.1.3.4
    properties?: { // 3.1.3.2
      will_delay_interval?: Seconds; // 3.1.3.2.2
      // payload_format_indicator?: boolean; // 3.1.3.2.3 automatically determined by the type of the payload
      message_expiry_interval?: Seconds; // 3.1.3.2.4
      content_type?: string; // 3.1.3.2.5
      response_topic?: string; // 3.1.3.2.6
      correlation_data?: Uint8Array; // 3.1.3.2.7
      user_properties?: UserProperty[]; // 3.1.3.2.8
    };
  };
  properties?: {
    session_expiry_interval?: Seconds; // 3.1.2.11.2
    receive_maximum?: number; // 3.1.2.11.3
    maximum_packet_size?: number; // 3.1.2.11.4
    topic_alias_maximum?: number; // 3.1.2.11.5
    request_response_information?: boolean; // 3.1.2.11.6
    request_problem_information?: boolean; // 3.1.2.11.7
    user_properties?: UserProperty[]; // 3.1.2.11.8
    authentication_method?: string; // 3.1.2.11.9
    authentication_data?: Uint8Array; // 3.1.2.11.10
  };
};

// 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_CONNACK_%E2%80%93_Connect
export type ConnAckPacket = {
  type: ControlPacketType.ConnAck;
  session_present?: boolean; // 3.2.2.1.1 - defaults to false
  connect_reason_code?: ConnectReasonCode; // 3.2.2.2 - defaults to Success
  properties?: {
    session_expiry_interval?: Seconds; // 3.2.2.3.2
    receive_maximum?: number; // 3.2.2.3.3
    maximum_QoS?: QoS; // 3.2.2.3.4
    retain_available?: boolean; // 3.2.2.3.5
    maximum_packet_size?: number; // 3.2.2.3.6
    assigned_client_id?: ClientID; // 3.2.2.3.7
    topic_alias_maximum?: number; // 3.2.2.3.8
    reason_string?: string; // 3.2.2.3.9
    user_properties?: UserProperty[]; // 3.2.2.3.10
    wildcard_subscription_available?: boolean; // 3.2.2.3.11 - undefined === true
    subscription_identifiers_available?: boolean; // 3.2.2.3.12 - undefined === true
    shared_subscription_available?: boolean; // 3.2.2.3.13 - undefined === true
    server_keep_alive?: Seconds; // 3.2.2.3.14 - defaults to the value send by the client before
    response_information?: Topic; // 3.2.2.3.15
    server_reference?: string; // 3.2.2.3.16
    authentication_method?: string; // 3.2.2.3.17
    authentication_data?: Uint8Array; // 3.2.2.3.18
  };
};

// 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800410
export type PublishPacket = {
  type: ControlPacketType.Publish;
  packet_identifier?: PacketIdentifier; // 3.3.2.2
  dup?: boolean; // 3.3.1.1 defaults to false
  qos?: QoS; // 3.3.1.2 defaults to QoS.At_most_once_delivery
  retain?: boolean; // 3.3.1.3 defaults to false
  topic: Topic; // 3.3.2.1
  payload?: Uint8Array | string; // 3.3.3
  properties?: {
    // payload_format_indicator?: boolean; // 3.3.2.3.2 automatically determined by the type of the payload
    message_expiry_interval?: Seconds; // 3.3.2.3.3
    topic_alias?: number; // 3.3.2.3.4
    response_topic?: Topic; // 3.3.2.3.5
    correlation_data?: Uint8Array; // 3.3.2.3.6
    user_properties?: UserProperty[]; // 3.3.2.3.7
    subscription_identifier?: number[]; // 3.3.2.3.8
    content_type?: string; // 3.3.2.3.9
  };
};

export type PubAckPacket = {
  type: ControlPacketType.PubAck;
  // Not implemented
};

export type PubRecPacket = {
  type: ControlPacketType.PubRec;
  // Not implemented
};

export type PubRelPacket = {
  type: ControlPacketType.PubRel;
  // Not implemented
};

export type PubCompPacket = {
  type: ControlPacketType.PubComp;
  // Not implemented
};

export enum RetainHandling {
  Send_retained_messages_at_the_time_of_the_subscribe,
  Send_retained_messages_at_subscribe_only_if_the_subscription_does_not_currently_exist,
  Do_not_send_retained_messages_at_the_time_of_the_subscribe,
}

// 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800436
export type SubscribePacket = {
  type: ControlPacketType.Subscribe;
  packet_identifier: PacketIdentifier; // 3.8.2
  subscriptions: { // 3.8.3.1
    topic: TopicFilter;
    qos?: QoS; // defaults to QoS.At_most_once_delivery
    no_local?: boolean;
    retain_handling?: RetainHandling; // defaults to Send_retained_messages_at_the_time_of_the_subscribe
    retain_as_published?: boolean;
  }[];
  properties?: {
    subscription_identifier?: number; // 3.8.2.1.2 - 0 and undefined -> don't transfer the property
    user_properties?: UserProperty[]; // 3.8.2.1.3
  };
};

// 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800441
export type SubAckPacket = {
  type: ControlPacketType.SubAck;
  packet_identifier: PacketIdentifier; // 3.9.2
  reason_codes: SubAckReasonCode[]; // 3.9.3
  properties?: {
    reason_string?: string; // 3.9.2.1.2
    user_properties?: UserProperty[]; // 3.9.2.1.3
  };
};

// 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800445
export type UnsubscribePacket = {
  type: ControlPacketType.Unsubscribe;
  packet_identifier: PacketIdentifier; // 3.10.2
  topic_filters: TopicFilter[]; // 3.10.3
  properties?: {
    user_properties?: UserProperty[]; // 3.10.2.1.2
  };
};

// 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc473023655
export type UnsubAckPacket = {
  type: ControlPacketType.UnsubAck;
  packet_identifier: PacketIdentifier; // 3.11.2
  reason_codes: UnsubAckReasonCode[]; // 3.11.3
  properties?: {
    reason_string?: string; // 3.11.2.1.2
    user_properties?: UserProperty[]; // 3.11.2.1.3
  };
};

// 3.12 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800454
export type PingReqPacket = {
  type: ControlPacketType.PingReq;
};

// 3.13 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800459
export type PingRespPacket = {
  type: ControlPacketType.PingResp;
};

// 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800463
export type DisconnectPacket = {
  type: ControlPacketType.Disconnect;
  reason_code?: DisconnectReasonCode; // 3.14.2.1
  properties?: {
    session_expiry_interval?: Seconds; // 3.14.2.2.2
    reason_string?: string; // 3.14.2.2.3
    user_properties?: UserProperty[]; // 3.14.2.2.4
    server_reference?: string; // 3.14.2.2.5
  };
};

// 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc464548075
export type AuthPacket = {
  type: ControlPacketType.Auth;
  reason_code?: AuthReasonCode; // 3.15.2.1
  properties?: {
    authentication_method?: string; // 3.15.2.2.2
    authentication_data?: Uint8Array; // 3.15.2.2.3
    reason_string?: string; // 3.15.2.2.4
    user_properties?: UserProperty[]; // 3.15.2.2.5
  };
};

export type AllPacket =
  | ConnectPacket
  | ConnAckPacket
  | PublishPacket
  | PubAckPacket
  | PubRecPacket
  | PubRelPacket
  | PubCompPacket
  | SubscribePacket
  | SubAckPacket
  | UnsubscribePacket
  | UnsubAckPacket
  | PingReqPacket
  | PingRespPacket
  | DisconnectPacket
  | AuthPacket;
//#endregion

//#region Serialize
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

  lengthVariableByteInteger(n: number) {
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

  addBinaryData(bin: Uint8Array) {
    if (bin.length > 65535) {
      throw new Error(`data limit is 65535 got ${bin.length}`);
    }
    this.addUint16(bin.length);
    this.addBinaryData(bin);
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

  finalizeMessage(
    type: ControlPacketType,
    flags: number,
  ): Uint8Array {
    if (flags > 0xf) {
      throw new Error("flags only allows setting up to 4 bits");
    }
    const endPos = this.pos;
    const size = endPos - maxFixedHeaderSize;
    const start = maxFixedHeaderSize - 1 - this.lengthVariableByteInteger(size);
    this.pos = start;
    this.addUint8(type << 4 | flags);
    this.addVariableByteInteger(size);
    this.pos = maxFixedHeaderSize;
    return this.getBufferView(start, endPos);
  }

  #textEncoder = new TextEncoder();
  #internalWriter: Writer | undefined;
}

type MakeSerializePacketType<T extends { type: ControlPacketType }> = Readonly<
  Omit<T, "type"> & { type?: T["type"] }
>;

// 3.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901033
export function serializeConnectPacket(
  packet: MakeSerializePacketType<ConnectPacket>,
  w: Writer,
): Uint8Array {
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
        // TODO: Are empty topics allowed?
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
  }

  if (packet.will !== undefined) {
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

// 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901074
export function serializeConnAckPacket(
  packet: MakeSerializePacketType<ConnAckPacket>,
  w: Writer,
): Uint8Array {
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

// 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901100
export function serializePublishPacket(
  packet: MakeSerializePacketType<PublishPacket>,
  w: Writer,
): Uint8Array {
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
      // TODO: Are empty topics allowed?
      tw.addUint8(Property.Response_Topic);
      tw.addUTF8String(p.response_topic);
    }

    if (p?.correlation_data !== undefined) {
      tw.addUint8(Property.Correlation_Data);
      tw.addBinaryData(p.correlation_data);
    }

    if (p?.subscription_identifier !== undefined) {
      for (const subscription of p.subscription_identifier) {
        w.addUint8(Property.Subscription_Identifier);
        w.addVariableByteInteger(subscription);
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
  } else {
    w.addArray(packet.payload);
  }

  const flags = (packet.dup ? 0b1000 : 0) |
    (qos << 1) |
    (packet.retain ? 0b0001 : 0);

  return w.finalizeMessage(ControlPacketType.Publish, flags);
}

// 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901161
export function serializeSubscribePacket(
  packet: MakeSerializePacketType<SubscribePacket>,
  w: Writer,
): Uint8Array {
  if (packet.subscriptions.length == 0) {
    throw new Error("Empty subscriptions are not allowed");
  }

  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    if (p?.subscription_identifier) {
      w.addUint8(Property.Subscription_Identifier);
      w.addVariableByteInteger(p.subscription_identifier);
    }

    tw.addUserProperties(p?.user_properties);
  });

  for (const s of packet.subscriptions) {
    // TODO: does it make sense to have an empty topic filter?
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

// 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901171
export function serializeSubAckPacket(
  packet: MakeSerializePacketType<SubAckPacket>,
  w: Writer,
): Uint8Array {
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

// 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901179
export function serializeUnsubscribePacket(
  packet: MakeSerializePacketType<UnsubscribePacket>,
  w: Writer,
): Uint8Array {
  w.addUint16(packet.packet_identifier);

  w.addProperties(packet.properties, (tw: Writer, p) => {
    tw.addUserProperties(p?.user_properties);
  });

  if (packet.topic_filters.length == 0) {
    throw new Error("Empty subscriptions are not allowed");
  }

  for (const f of packet.topic_filters) {
    // TODO: does it make sense to have an empty topic filter?
    w.addUTF8String(f);
  }

  return w.finalizeMessage(ControlPacketType.Unsubscribe, 0);
}

// 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901187
export function serializeUnsubAckPacket(
  packet: MakeSerializePacketType<UnsubAckPacket>,
  w: Writer,
): Uint8Array {
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

export const PingReqMessage = (() => {
  const writer = new Writer(
    {
      bufferSize: 5,
      automaticallyExtendBuffer: false,
    },
  );
  return writer.finalizeMessage(ControlPacketType.PingReq, 0);
})();

export const PingRespMessage = (() => {
  const writer = new Writer(
    {
      bufferSize: 5,
      automaticallyExtendBuffer: false,
    },
  );
  return writer.finalizeMessage(ControlPacketType.PingResp, 0);
})();

// 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901205
export function serializeDisconnectPacket(
  packet: MakeSerializePacketType<DisconnectPacket>,
  w: Writer,
): Uint8Array {
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

// 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901217
export function serializeAuthPacket(
  packet: MakeSerializePacketType<AuthPacket>,
  w: Writer,
): Uint8Array {
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

function serialize(packet: AllPacket, w: Writer) {
  switch (packet.type) {
    case ControlPacketType.Connect:
      return serializeConnectPacket(packet, w);
    case ControlPacketType.ConnAck:
      return serializeConnAckPacket(packet, w);
    case ControlPacketType.Publish:
      return serializePublishPacket(packet, w);
    case ControlPacketType.PubAck:
    case ControlPacketType.PubRec:
    case ControlPacketType.PubRel:
    case ControlPacketType.PubComp:
      throw new Error("not implemented");
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
//#endregion

//#region Deserialize

function readVariableByteInteger(reader: DataReader): number;
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

// 2.1.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901021
export function readFixedHeader(
  reader: DataReader,
): FixedHeader | undefined {
  const d = reader.getUint8();
  const len = readVariableByteInteger(reader);
  if (len === undefined) {
    return undefined;
  }
  return {
    type: d >> 4,
    flags: d & 0xff,
    length: len,
  };
}

function readUTF8String(reader: DataReader): string {
  const len = reader.getUint16();
  return reader.getUTF8String(len);
}

function readBinaryData(reader: DataReader): Uint8Array {
  const len = reader.getUint16();
  return reader.getUint8Array(len);
}

function readProperties(reader: DataReader): AllProperties | undefined {
  if (!reader.hasMoreData) {
    return undefined;
  }

  const length = readVariableByteInteger(reader);
  const r = reader.getDataReader(length);

  if (length === 0) {
    return undefined;
  }

  const ret: AllProperties = {};

  while (r.pos < length) {
    const id: Property = r.getUint8();
    switch (id) {
      case Property.Payload_Format_Indicator:
        ret.payload_format_indicator = r.getUint8() === 1;
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
        ret.correlation_data = readBinaryData(r);
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
        ret.assigned_client_id = asClientID(readUTF8String(r));
        break;
      case Property.Server_Keep_Alive:
        ret.server_keep_alive = r.getUint16() as Seconds;
        break;
      case Property.Authentication_Method:
        ret.authentication_method = readUTF8String(r);
        break;
      case Property.Authentication_Data:
        ret.authentication_data = readBinaryData(r);
        break;
      case Property.Request_Problem_Information:
        ret.request_problem_information = r.getUint8() !== 0;
        break;
      case Property.Will_Delay_Interval:
        ret.will_delay_interval = r.getUint32() as Seconds;
        break;
      case Property.Request_Response_Information:
        ret.request_problem_information = r.getUint8() === 1;
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

// 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901074
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

  // TODO: check if only the expected properties existed
  // session_expiry_interval, receive_maximum, maximum_QoS, retain_available,
  // maximum_packet_size, assigned_client_id, topic_alias_maximum, reason_string,
  // user_properties, wildcard_subscription_available, subscription_identifiers_available,
  // shared_subscription_available, server_keep_alive, response_information,
  // server_reference, authentication_method, authentication_data

  return ret;
}

// 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901100
function deserializePublishPacket(
  fixedHeader: FixedHeader,
  r: DataReader,
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
  }

  const props = readProperties(r);
  if (props !== undefined) {
    ret.properties = props;
  }

  const remainingSize = r.remainingSize;
  if (remainingSize > 0) {
    if (props?.payload_format_indicator === true) {
      ret.payload = r.getUTF8String(remainingSize);
    } else {
      ret.payload = r.getUint8Array(remainingSize);
    }
  }
  return ret;
}

// 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901179
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

// 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901161
function deserializeSubscribePacket(
  _fixedHeader: FixedHeader,
  r: DataReader,
): SubscribePacket {
  const ret: SubscribePacket = {
    type: ControlPacketType.Subscribe,
    packet_identifier: r.getUint16() as PacketIdentifier,
    subscriptions: [],
  };

  // TODO: check the flags, they should be 0b10

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

// 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901171
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

// 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901187
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

// 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901205
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

// 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901217
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
): AllPacket {
  const r = reader.getDataReader(fixedHeader.length);
  switch (fixedHeader.type) {
    case ControlPacketType.Reserved:
      break;
    case ControlPacketType.Connect:
      break;
    case ControlPacketType.ConnAck:
      return deserializeConnAckPacket(fixedHeader, r);
    case ControlPacketType.Publish:
      return deserializePublishPacket(fixedHeader, r);
    case ControlPacketType.PubAck:
      break;
    case ControlPacketType.PubRec:
      break;
    case ControlPacketType.PubRel:
      break;
    case ControlPacketType.PubComp:
      break;
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

//#endregion

//#region Stream
// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901285
export class DeserializeStream {
  constructor() {
  }

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<AllPacket>,
  ) {
    if (this.#particalChunk) {
      const newChunk = new Uint8Array(
        this.#particalChunk.length + chunk.length,
      );
      newChunk.set(this.#particalChunk);
      newChunk.set(chunk, this.#particalChunk.length);
      this.#particalChunk = undefined;
    }
    const reader = new DataReader(chunk);
    const fixedHeader = readFixedHeader(reader);
    if (fixedHeader === undefined) {
      // incomplete mqtt message, decode and handle the data the next time we receive more data
      this.#particalChunk = chunk;
      return;
    }
    controller.enqueue(deserializePacket(fixedHeader, reader));
    // store the left over data
    if (reader.hasMoreData) {
      this.#particalChunk = reader.getUint8Array(reader.remainingSize);
    }
  }

  #particalChunk: Uint8Array | undefined;
}

/// You may also want to have a look at the Client
export async function connect(address: URL | string): Promise<{
  readable: ReadableStream<AllPacket>;
  writable: WritableStream<string | ArrayBufferView | ArrayBufferLike | Blob>;
  connection: WebSocket | WebSocketStream | Deno.TcpConn;
}> {
  const ts = new TransformStream<Uint8Array, AllPacket>(
    new DeserializeStream(),
  );

  if (typeof address === "string") {
    address = new URL(address);
  }
  if (address.protocol === "ws:" || address.protocol === "wss:") {
    if (WebSocketStream === undefined) {
      const conn = streamifyWebSocket(
        address.toString(),
        "mqtt",
      );
      return {
        readable: conn.readable.pipeThrough(ts),
        writable: conn.writable,
        connection: conn.conn,
      };
    }
    const wss = new WebSocketStream(address.toString(), {
      protocols: ["mqtt"],
    });
    const conn = await wss.connection;
    return {
      readable: conn.readable.pipeThrough(ts),
      writable: conn.writable,
      connection: wss,
    };
  }
  if (typeof Deno !== undefined && address.protocol === "tcp:") {
    const conn = await Deno.connect({
      hostname: address.hostname,
      port: Number.parseInt(address.port),
      transport: "tcp",
    });

    conn.setNoDelay(true);

    return {
      readable: conn.readable.pipeThrough(ts),
      writable: conn.writable,
      connection: conn,
    };
  }
  throw new Error(`Unsupported protocol ${address.protocol}`);
}

// TODO
export class Client implements Disposable {
  constructor(address: URL | string) {
  }

  [Symbol.dispose]() {
    this.close();
  }

  // TODO:
  // send pings
  // auto-reconnect
  // automatically republish retained data
  // callback for disconnect/connect
  // use subscription id to efficiently dispatch them
  // automatically use topic aliases

  publish(packet: PublishPacket) {
  }

  subscribe(packet: SubscribePacket, handler: (packet: PublishPacket) => void) {
  }

  close() {
    // https://developer.chrome.com/articles/websocketstream/
  }
}

//#endregion
