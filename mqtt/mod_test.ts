/**
 * Copyright 2025 Bernd Amend. MIT license.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { DataReader } from "../helper/mod.ts";
import * as m from "./mod.ts";

// asTopic
Deno.test("asTopic: valid topics", () => {
  m.asTopic("foo");
  m.asTopic("foo/bar");
  m.asTopic("foo/bar/baz");
  m.asTopic("foo-bar_123");
  m.asTopic("ä/ö/ü/&");
});

Deno.test("asTopic: invalid topics", () => {
  const invalid = [
    "",
    "/foo",
    "#",
    "foo/#",
    "foo/bar#",
    "foo/#/bar",
    "foo/+/bar",
    "+/foo/bar",
    "foo/bar+",
    "foo/bar/#",
    "foo/bar/#/baz",
    "foo/bar/+/baz",
    "foo/bar+foo",
    "foo/bar#foo",
  ];
  for (const t of invalid) {
    assertThrows(() => m.asTopic(t));
  }
});

// asTopicFilter
Deno.test("asTopicFilter: valid filters", () => {
  m.asTopicFilter("foo");
  m.asTopicFilter("foo/bar");
  m.asTopicFilter("foo/+");
  m.asTopicFilter("+/bar");
  m.asTopicFilter("+/+/baz");
  m.asTopicFilter("foo/+/baz");
  m.asTopicFilter("#");
  m.asTopicFilter("foo/#");
  m.asTopicFilter("foo/bar/#");
  m.asTopicFilter("+");
  m.asTopicFilter("ä/ö/ü/+");
});

Deno.test("asTopicFilter: invalid filters", () => {
  const invalid = [
    "", // empty string
    "/foo", // starts with /
    "foo/#/bar", // # not at the end
    "foo/#/#", // multiple #
    "foo/bar#", // # not alone in level
    "foo/ba+r", // + not alone in level
    "foo/+/bar+", // + not alone in level
    "foo/#/+", // # not at the end
    "foo/bar/#/baz", // # not at the end
    "foo/bar/#/+", // # not at the end
    "foo/bar+/#", // + not alone in level
    "foo/bar/#foo", // # not alone in level
    "foo/bar/fo#o", // # not alone in level
    "foo/bar/fo+o", // + not alone in level
  ];
  for (const f of invalid) {
    assertThrows(
      () => m.asTopicFilter(f),
    );
  }
});

// asClientID
Deno.test("asClientID: valid IDs", () => {
  m.asClientID("client123");
  m.asClientID("client-foo_bar");
  m.asClientID("client.id");
  m.asClientID("äöüß@");
});

Deno.test("asClientID: invalid IDs", () => {
  const invalid = [
    "foo#bar",
    "foo+bar",
    "foo/bar",
    "#",
    "+",
    "/",
  ];
  for (const id of invalid) {
    assertThrows(() => m.asClientID(id));
  }
});

Deno.test("serialize/deserialize ConnectPacket", () => {
  const w = new m.Writer();
  const packet: m.ConnectPacket = {
    type: m.ControlPacketType.Connect,
    client_id: m.asClientID("client1"),
    protocol_name: "MQTT",
    protocol_version: 5,
    clean_start: true,
    keepalive: 10 as m.Seconds,
    username: "user",
    password: "pass",
    will: {
      topic: m.asTopic("will/topic"),
      payload: "will message",
      qos: m.QoS.At_most_once_delivery,
      retain: false,
      properties: {
        will_delay_interval: 60 as m.Seconds,
        payload_format_indicator: m.PayloadFormatIndicator.UTF8,
        response_topic: m.asTopic("response/topic"),
        correlation_data: new DataReader(new Uint8Array([1, 2, 3])),
        user_properties: [
          { key: "key1", value: "value1" },
          { key: "key2", value: "value2" },
        ],
      },
    },
    properties: {
      authentication_data: new DataReader(new Uint8Array([1, 2, 3])),
      authentication_method: "authMethod",
      session_expiry_interval: 3600 as m.Seconds,
      receive_maximum: 100,
      maximum_packet_size: 1024,
      topic_alias_maximum: 10,
      request_response_information: true,
      request_problem_information: false,
      user_properties: [
        { key: "key1", value: "value1" },
        { key: "key2", value: "value2" },
      ],
    },
  };
  const buf = m.serializeConnectPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Connect,
    flags: 0,
    length: buf.length - 3, // 3 bytes for fixed header
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize ConnAckPacket", () => {
  const w = new m.Writer();
  const packet: m.ConnAckPacket = {
    type: m.ControlPacketType.ConnAck,
    session_present: true,
    connect_reason_code: m.ConnectReasonCode.Server_moved,
    properties: {
      session_expiry_interval: 60 as m.Seconds,
      receive_maximum: 10,
      maximum_packet_size: 1024,
      topic_alias_maximum: 5,
      maximum_QoS: m.QoS.At_least_once_delivery,
      retain_available: true,
      assigned_client_id: m.asClientID("client1"),
      reason_string: "OK",
      user_properties: [{ key: "k", value: "v" }],
      wildcard_subscription_available: false,
      subscription_identifiers_available: false,
      shared_subscription_available: false,
      server_keep_alive: 60 as m.Seconds,
      response_information: m.asTopic("info"),
      server_reference: "ref",
      authentication_method: "auth",
      authentication_data: new DataReader(new Uint8Array([1, 2, 3])),
    },
  };
  const buf = m.serializeConnAckPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.ConnAck,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize PublishPacket At_most_once_delivery", () => {
  const w = new m.Writer();
  const packet: m.PublishPacket = {
    type: m.ControlPacketType.Publish,
    topic: m.asTopic("foo/bar"),
    payload: "payload",
    retain: true,
    dup: true,
    properties: {
      payload_format_indicator: m.PayloadFormatIndicator.UTF8,
      message_expiry_interval: 60 as m.Seconds,
      topic_alias: 1,
      response_topic: m.asTopic("response/topic"),
      correlation_data: new DataReader(new Uint8Array([1, 2, 3])),
      user_properties: [{ key: "k", value: "v" }],
      subscription_identifier: [1, 2, 3, 4, 5, 6, 7, 8, 9, 123],
      content_type: "text/plain",
    },
  };
  const buf = m.serializePublishPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Publish,
    flags: 0b1001, // qos 0, retain true
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize PublishPacket At_least_once_delivery", () => {
  const w = new m.Writer();
  const packet: m.PublishPacket = {
    type: m.ControlPacketType.Publish,
    topic: m.asTopic("foo/bar"),
    payload: "payload",
    qos: m.QoS.At_least_once_delivery,
    retain: true,
    dup: true,
    packet_identifier: 42 as m.PacketIdentifier,
    properties: {
      payload_format_indicator: m.PayloadFormatIndicator.UTF8,
      message_expiry_interval: 60 as m.Seconds,
      topic_alias: 1,
      response_topic: m.asTopic("response/topic"),
      correlation_data: new DataReader(new Uint8Array([1, 2, 3])),
      user_properties: [{ key: "k", value: "v" }],
      subscription_identifier: [123],
      content_type: "text/plain",
    },
  };
  const buf = m.serializePublishPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Publish,
    flags: 0b1011, // qos 1, retain true
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize PubAckPacket", () => {
  const w = new m.Writer();
  const packet: m.PubAckPacket = {
    type: m.ControlPacketType.PubAck,
    packet_identifier: 1 as m.PacketIdentifier,
    reason_code: m.PubAckReasonCode.Success,
    properties: {
      reason_string: "ok",
      user_properties: [{ key: "k", value: "v" }],
    },
  };
  const buf = m.serializePubAckPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.PubAck,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize SubAckPacket", () => {
  const w = new m.Writer();
  const packet: m.SubAckPacket = {
    type: m.ControlPacketType.SubAck,
    packet_identifier: 1 as m.PacketIdentifier,
    reason_codes: [m.SubAckReasonCode.Granted_QoS_0],
    properties: {
      reason_string: "subscribed",
      user_properties: [{ key: "k", value: "v" }],
    },
  };
  const buf = m.serializeSubAckPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.SubAck,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize UnsubAckPacket", () => {
  const w = new m.Writer();
  const packet: m.UnsubAckPacket = {
    type: m.ControlPacketType.UnsubAck,
    packet_identifier: 1 as m.PacketIdentifier,
    reason_codes: [m.UnsubAckReasonCode.Success],
    properties: {
      reason_string: "unsubscribed",
      user_properties: [{ key: "k", value: "v" }],
    },
  };
  const buf = m.serializeUnsubAckPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.UnsubAck,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize DisconnectPacket", () => {
  const w = new m.Writer();
  const packet: m.DisconnectPacket = {
    type: m.ControlPacketType.Disconnect,
    reason_code: m.DisconnectReasonCode.Normal_disconnection,
    properties: {
      session_expiry_interval: 60 as m.Seconds,
      reason_string: "bye",
      user_properties: [{ key: "k", value: "v" }],
      server_reference: "ref",
    },
  };
  const buf = m.serializeDisconnectPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Disconnect,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});
