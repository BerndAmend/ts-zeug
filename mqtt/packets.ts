/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import type { Branded, DataReader } from "../helper/mod.ts";

/**
 * 2.1.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901022
 * 4-bit unsigned integer
 *
 * Connect:     C->S Connection Request flags=0
 * ConnAck:     S->C Connect acknowledgment flags=0
 * Publish:      *   Publish message flags=dup:1, qos:2, retain:1
 * PubAck:       *   Publish acknowledgment (QoS 1) flags=0
 * PubRec:       *   Publish received (QoS 2 delivery part 1) flags=0
 * PubRel:       *   Publish release (QoS 2 delivery part 2) flags=2
 * PubComp:      *   Publish complete (QoS 2 delivery part 3) flags=0
 * Subscribe:   C->S Subscribe request flags=2
 * SubAck:      S->C Subscribe acknowledgment flags=0
 * Unsubscribe: C->S Unsubscribe request flags=2
 * UnsubAck:    S->C Unsubscribe acknowledgment flags=0
 * PingReq:     C->S PING request flags=0
 * PingResp:    S->C PING response flags=0
 * Disconnect:   *   Disconnect notification flags=0
 * Auth:         *   Authentication exchange flags=0
 */
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

/**
 * 3.3.1.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901103
 */
export enum QoS {
  At_most_once_delivery,
  At_least_once_delivery,
  Exactly_once_delivery,
  Reserved,
}

/**
 * 3.3.2.3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901111
 */
export const enum PayloadFormatIndicator {
  Binary, // default
  UTF8,
}

/**
 * 2.2.2.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html#_Toc464547805
 */
export enum Property {
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

/**
 * 3.2.2.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901079
 */
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

/**
 * 3.4.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901124
 */
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

/**
 * 3.5.2.1
 */
export enum PubRecReasonCode {
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

/**
 * 3.6.2.1
 */
export enum PubRelReasonCode {
  Success = 0x00,
  Packet_Identifier_not_found = 0x92,
}

/**
 * 3.7.2.1
 */
export enum PubCompReasonCode {
  Success = 0x00,
  Packet_Identifier_not_found = 0x92,
}

/**
 * 3.9.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901178
 */
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

/**
 * 3.11.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901194
 */
export enum UnsubAckReasonCode {
  Success = 0x00,
  No_subscription_existed = 0x11,
  Unspecified_error = 0x80,
  Implementation_specific_error = 0x83,
  Not_authorized = 0x87,
  Topic_Filter_invalid = 0x8F,
  Packet_Identifier_in_use = 0x91,
}

/**
 * 3.14.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901208
 */
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

/**
 * 3.15.2.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901220
 */
export enum AuthReasonCode {
  Success = 0x00,
  Continue_authentication = 0x18,
  Re_authenticate = 0x19,
}

/**
 * 3.1.3.1
 */
export type ClientID = Branded<string, "ClientID">;
export type Topic = Branded<string, "Topic">;
/**
 * similar to topic to also allows the characters # and ?
 */
export type TopicFilter = Branded<string, "TopicFilter">;
export type Milliseconds = Branded<number, "Milliseconds">;
export type Seconds = Branded<number, "Seconds">;
/**
 * 0 <= PacketIdentifier <= 65535
 */
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

  const levels = input.split("/");
  for (let i = 0; i < levels.length; ++i) {
    const level = levels[i]!;
    if (level === "#") {
      if (i !== levels.length - 1) {
        throw new Error(
          `Invalid TopicFilter: '#' must only appear at the last level. Input: '${input}'`,
        );
      }
    } else if (level === "+") {
      // valid
    } else {
      if (level.includes("#") || level.includes("+")) {
        throw new Error(
          `Invalid TopicFilter: Wildcards must occupy an entire level. Input: '${input}'`,
        );
      }
    }
  }

  return input as TopicFilter;
}

/**
 * Throws if the input contains the characters #, + and /
 * This implementation forbids these characters to ensure the ClientIDs can be used as part of a topic.
 */
export function asClientID(input: string): ClientID {
  if (input.includes("#")) {
    throw new Error(
      `Invalid ClientID: cannot contain '#' input '${input}'`,
    );
  }
  if (input.includes("+")) {
    throw new Error(
      `Invalid ClientID: cannot contain '+' input '${input}'`,
    );
  }
  if (input.includes("/")) {
    throw new Error(
      `Invalid ClientID: cannot contain '/' input '${input}'`,
    );
  }
  return input as ClientID;
}

/**
 * 1 Byte + max size of a variable byte integer
 */
export const maxFixedHeaderSize = 5;

export type FixedHeader = {
  type: ControlPacketType;
  flags: number;
  length: number;
};

export type AllProperties = Partial<{
  payload_format_indicator: PayloadFormatIndicator; // 3.3.2.3.2
  message_expiry_interval: Seconds; // 3.3.2.3.3
  content_type: string; // 3.1.3.2.5
  response_topic: Topic; // 3.3.2.3.5
  correlation_data: DataReader | Uint8Array; // 3.3.2.3.6
  subscription_identifier: number[]; // 3.3.2.3.8
  session_expiry_interval: Seconds; // 3.1.2.11.2
  assigned_client_id: ClientID; // 3.2.2.3.7
  server_keep_alive: Seconds; // 3.2.2.3.14 - defaults to the value send by the client before
  authentication_method: string; // 3.1.2.11.9
  authentication_data: DataReader | Uint8Array; // 3.1.2.11.10
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

/**
 * 3.1 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_CONNECT_%E2%80%93_Connection
 */
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
    payload?: DataReader | Uint8Array | string; // 3.1.3.4
    properties?: { // 3.1.3.2
      will_delay_interval?: Seconds; // 3.1.3.2.2
      /**
       * 3.1.3.2.3 automatically determined by the type of the payload
       * ignored when serializing
       */
      payload_format_indicator?: PayloadFormatIndicator;
      message_expiry_interval?: Seconds; // 3.1.3.2.4
      content_type?: string; // 3.1.3.2.5
      response_topic?: Topic; // 3.1.3.2.6
      correlation_data?: DataReader | Uint8Array; // 3.1.3.2.7
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
    authentication_data?: DataReader | Uint8Array; // 3.1.2.11.10
  };
};

/**
 * 3.2 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_CONNACK_%E2%80%93_Connect
 */
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
    authentication_data?: DataReader | Uint8Array; // 3.2.2.3.18
  };
};

/**
 * 3.3 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800410
 */
export type PublishPacket = {
  type: ControlPacketType.Publish;
  packet_identifier?: PacketIdentifier; // 3.3.2.2
  dup?: boolean; // 3.3.1.1 defaults to false
  qos?: QoS; // 3.3.1.2 defaults to QoS.At_most_once_delivery
  retain?: boolean; // 3.3.1.3 defaults to false
  topic: Topic; // 3.3.2.1
  /**
   * The DataReader should be preferred if the received data is later accessed with a DataReader/DataView,
   * since it allows sharing the internal DataView.
   * For writing DataReader.asUint8Array() is used.
   */
  payload?: DataReader | string | Uint8Array; // 3.3.3
  properties?: {
    /**
     * 3.3.2.3.2 automatically determined by the type of the payload
     * ignored when serializing
     */
    payload_format_indicator?: PayloadFormatIndicator;
    message_expiry_interval?: Seconds; // 3.3.2.3.3
    topic_alias?: number; // 3.3.2.3.4
    response_topic?: Topic; // 3.3.2.3.5
    correlation_data?: DataReader | Uint8Array; // 3.3.2.3.6
    user_properties?: UserProperty[]; // 3.3.2.3.7
    subscription_identifier?: number[]; // 3.3.2.3.8
    content_type?: string; // 3.3.2.3.9
  };
};

/**
 * 3.4
 */
export type PubAckPacket = {
  type: ControlPacketType.PubAck;
  packet_identifier: PacketIdentifier;
  reason_code?: PubAckReasonCode;
  properties?: {
    reason_string?: string;
    user_properties?: UserProperty[];
  };
};

/**
 * 3.5
 */
export type PubRecPacket = {
  type: ControlPacketType.PubRec;
  packet_identifier: PacketIdentifier;
  reason_code?: PubRecReasonCode;
  properties?: {
    reason_string?: string;
    user_properties?: UserProperty[];
  };
};

/**
 * 3.6
 */
export type PubRelPacket = {
  type: ControlPacketType.PubRel;
  packet_identifier: PacketIdentifier;
  reason_code?: PubRelReasonCode;
  properties?: {
    reason_string?: string;
    user_properties?: UserProperty[];
  };
};

/**
 * 3.7
 */
export type PubCompPacket = {
  type: ControlPacketType.PubComp;
  packet_identifier: PacketIdentifier;
  reason_code?: PubCompReasonCode;
  properties?: {
    reason_string?: string;
    user_properties?: UserProperty[];
  };
};

export enum RetainHandling {
  Send_retained_messages_at_the_time_of_the_subscribe,
  Send_retained_messages_at_subscribe_only_if_the_subscription_does_not_currently_exist,
  Do_not_send_retained_messages_at_the_time_of_the_subscribe,
}

/**
 * 3.8 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800436
 */
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

/**
 * 3.9 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800441
 */
export type SubAckPacket = {
  type: ControlPacketType.SubAck;
  packet_identifier: PacketIdentifier; // 3.9.2
  reason_codes: SubAckReasonCode[]; // 3.9.3
  properties?: {
    reason_string?: string; // 3.9.2.1.2
    user_properties?: UserProperty[]; // 3.9.2.1.3
  };
};

/**
 * 3.10 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800445
 */
export type UnsubscribePacket = {
  type: ControlPacketType.Unsubscribe;
  packet_identifier: PacketIdentifier; // 3.10.2
  topic_filters: TopicFilter[]; // 3.10.3
  properties?: {
    user_properties?: UserProperty[]; // 3.10.2.1.2
  };
};

/**
 * 3.11 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc473023655
 */
export type UnsubAckPacket = {
  type: ControlPacketType.UnsubAck;
  packet_identifier: PacketIdentifier; // 3.11.2
  reason_codes: UnsubAckReasonCode[]; // 3.11.3
  properties?: {
    reason_string?: string; // 3.11.2.1.2
    user_properties?: UserProperty[]; // 3.11.2.1.3
  };
};

/**
 * 3.12 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800454
 */
export type PingReqPacket = {
  type: ControlPacketType.PingReq;
};

/**
 * 3.13 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800459
 */
export type PingRespPacket = {
  type: ControlPacketType.PingResp;
};

/**
 * 3.14 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc384800463
 */
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

/**
 * 3.15 https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc464548075
 */
export type AuthPacket = {
  type: ControlPacketType.Auth;
  reason_code?: AuthReasonCode; // 3.15.2.1
  properties?: {
    authentication_method?: string; // 3.15.2.2.2
    authentication_data?: DataReader | Uint8Array; // 3.15.2.2.3
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
