/**
 * Copyright 2023-2026 Bernd Amend. MIT license.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DataReader } from "../helper/mod.ts";
import * as m from "./mod.ts";

// asTopic
Deno.test("asTopic: valid topics", () => {
  m.asTopic("foo");
  m.asTopic("foo/bar");
  m.asTopic("foo/bar/baz");
  m.asTopic("foo-bar_123");
  m.asTopic("ä/ö/ü/&");
  m.asTopic("/foo");
  m.asTopic("/foo/bar");
});

Deno.test("asTopic: invalid topics", () => {
  const invalid = [
    "",
    "foo\u0000bar",
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
  m.asTopicFilter("/foo");
  m.asTopicFilter("/");
});

Deno.test("asTopicFilter: invalid filters", () => {
  const invalid = [
    "", // empty string
    "foo\u0000bar", // null character
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

Deno.test("serialize/deserialize SubscribePacket", () => {
  const w = new m.Writer();
  const packet: m.SubscribePacket = {
    type: m.ControlPacketType.Subscribe,
    packet_identifier: 42 as m.PacketIdentifier,
    subscriptions: [
      {
        topic: m.asTopicFilter("sensors/+/temp"),
        qos: m.QoS.At_least_once_delivery,
        no_local: true,
        retain_handling: m.RetainHandling
          .Do_not_send_retained_messages_at_the_time_of_the_subscribe,
        retain_as_published: true,
      },
      {
        topic: m.asTopicFilter("#"),
      },
    ],
    properties: {
      subscription_identifier: 123,
      user_properties: [{ key: "k", value: "v" }],
    },
  };
  const buf = m.serializeSubscribePacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Subscribe,
    flags: 2, // Subscribe fixed header flags must be 0b0010
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize UnsubscribePacket", () => {
  const w = new m.Writer();
  const packet: m.UnsubscribePacket = {
    type: m.ControlPacketType.Unsubscribe,
    packet_identifier: 7 as m.PacketIdentifier,
    topic_filters: [m.asTopicFilter("foo/bar"), m.asTopicFilter("sensors/#")],
    properties: {
      user_properties: [{ key: "x", value: "y" }],
    },
  };
  const buf = m.serializeUnsubscribePacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Unsubscribe,
    flags: 2, // Unsubscribe fixed header flags must be 0b0010
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("serialize/deserialize AuthPacket", () => {
  const w = new m.Writer();
  const packet: m.AuthPacket = {
    type: m.ControlPacketType.Auth,
    reason_code: m.AuthReasonCode.Continue_authentication,
    properties: {
      authentication_method: "SCRAM-SHA-256",
      authentication_data: new DataReader(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      ),
      reason_string: "continue",
      user_properties: [{ key: "k", value: "v" }],
    },
  };
  const buf = m.serializeAuthPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r);
  assertEquals(h, {
    type: m.ControlPacketType.Auth,
    flags: 0,
    length: buf.length - 2,
  });
  const result = m.deserializePacket(h!, r);
  assertEquals(result, packet);
});

Deno.test("PingReq and PingResp are valid pre-serialized constants", () => {
  // PingReq
  assertEquals(m.PingReqMessage.length, 2);
  assertEquals(m.PingReqMessage[0]! >> 4, m.ControlPacketType.PingReq);
  assertEquals(m.PingReqMessage[1], 0);

  // PingResp
  assertEquals(m.PingRespMessage.length, 2);
  assertEquals(m.PingRespMessage[0]! >> 4, m.ControlPacketType.PingResp);
  assertEquals(m.PingRespMessage[1], 0);

  // Smoke-test roundtrip deserialization via readFixedHeader
  const r = new DataReader(m.PingReqMessage);
  const h = m.readFixedHeader(r);
  assertEquals(h?.type, m.ControlPacketType.PingReq);
  assertEquals(h?.flags, 0);
  assertEquals(h?.length, 0);
});

Deno.test("deserialize: reject malformed variable byte integer", () => {
  const r = new DataReader(
    new Uint8Array([0x10, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
  assertThrows(() => m.readFixedHeader(r), Error, "Malformed");
});

Deno.test("deserialize: readFixedHeader returns undefined for incomplete length", () => {
  const r = new DataReader(new Uint8Array([0x10, 0x80]));
  assertEquals(m.readFixedHeader(r), undefined);
});

Deno.test("deserialize: reject invalid protocol name", () => {
  // CONNECT with protocol name "XXXX" instead of "MQTT"
  const r = new DataReader(
    new Uint8Array([
      0x10,
      0x0c,
      0x00,
      0x04,
      0x58,
      0x58,
      0x58,
      0x58,
      0x05,
      0x02,
      0x00,
      0x00,
      0x00,
      0x00,
    ]),
  );
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r), Error, "protocol_name");
});

Deno.test("deserialize: reject invalid protocol version", () => {
  // CONNECT with protocol version 4 (MQTT 3.1.1)
  const r = new DataReader(
    new Uint8Array([
      0x10,
      0x0c,
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54,
      0x04,
      0x02,
      0x00,
      0x00,
      0x00,
      0x00,
    ]),
  );
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r), Error, "protocol_version");
});

Deno.test("deserialize: reject CONNECT with reserved flag bit set", () => {
  // CONNECT with flags 0x03 (reserved bit 0 set)
  const r = new DataReader(
    new Uint8Array([
      0x10,
      0x0c,
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54,
      0x05,
      0x03,
      0x00,
      0x00,
      0x00,
      0x00,
    ]),
  );
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r), Error, "reserved");
});

Deno.test("deserialize: reject invalid fixed-header flags", () => {
  const w = new m.Writer();
  const validPackets: Uint8Array[] = [
    m.serializeConnAckPacket({ type: m.ControlPacketType.ConnAck }, w),
    m.serializePubAckPacket({
      type: m.ControlPacketType.PubAck,
      packet_identifier: 1 as m.PacketIdentifier,
    }, w),
    m.serializePubRecPacket({
      type: m.ControlPacketType.PubRec,
      packet_identifier: 1 as m.PacketIdentifier,
    }, w),
    m.serializePubRelPacket({
      type: m.ControlPacketType.PubRel,
      packet_identifier: 1 as m.PacketIdentifier,
    }, w),
    m.serializePubCompPacket({
      type: m.ControlPacketType.PubComp,
      packet_identifier: 1 as m.PacketIdentifier,
    }, w),
    m.serializeUnsubscribePacket({
      type: m.ControlPacketType.Unsubscribe,
      packet_identifier: 1 as m.PacketIdentifier,
      topic_filters: [m.asTopicFilter("a/b")],
    }, w),
    m.serializeDisconnectPacket({ type: m.ControlPacketType.Disconnect }, w),
    m.serializeAuthPacket({ type: m.ControlPacketType.Auth }, w),
    m.PingReqMessage,
    m.PingRespMessage,
  ];
  for (const packet of validPackets) {
    const buf = packet.slice();
    buf[0] = (buf[0]! & 0xf0) | 0x0f;
    const r = new DataReader(buf);
    const h = m.readFixedHeader(r)!;
    assertThrows(() => m.deserializePacket(h, r));
  }
});

Deno.test("deserialize: reject PUBLISH with QoS 3", () => {
  // PUBLISH, flags 0b0110 (QoS 3), topic "a"
  const r = new DataReader(new Uint8Array([0x36, 0x03, 0x00, 0x01, 0x61]));
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r), Error, "QoS");
});

Deno.test("deserialize: reject invalid payload format indicator", () => {
  // PUBLISH, topic "a", properties: Payload Format Indicator (0x01) = 2
  const r = new DataReader(
    new Uint8Array([0x30, 0x06, 0x00, 0x01, 0x61, 0x02, 0x01, 0x02]),
  );
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r), Error, "Payload Format");
});

Deno.test("deserialize: reject reserved packet type", () => {
  const r = new DataReader(new Uint8Array([0x00, 0x00]));
  const h = m.readFixedHeader(r)!;
  assertThrows(() => m.deserializePacket(h, r));
});

Deno.test("serialize: reject password without username", () => {
  const w = new m.Writer();
  assertThrows(() =>
    m.serializeConnectPacket({
      type: m.ControlPacketType.Connect,
      password: "secret",
    }, w)
  );
});

Deno.test("serialize: reject authentication_data without authentication_method", () => {
  const w = new m.Writer();
  const data = new Uint8Array([1]);
  assertThrows(() =>
    m.serializeConnectPacket({
      type: m.ControlPacketType.Connect,
      properties: { authentication_data: data },
    }, w)
  );
  assertThrows(() =>
    m.serializeConnAckPacket({
      type: m.ControlPacketType.ConnAck,
      properties: { authentication_data: data },
    }, w)
  );
  assertThrows(() =>
    m.serializeAuthPacket({
      type: m.ControlPacketType.Auth,
      properties: { authentication_data: data },
    }, w)
  );
});

Deno.test("serialize: reject ConnAck server_reference with wrong reason", () => {
  const w = new m.Writer();
  assertThrows(() =>
    m.serializeConnAckPacket({
      type: m.ControlPacketType.ConnAck,
      connect_reason_code: m.ConnectReasonCode.Success,
      properties: { server_reference: "ref" },
    }, w)
  );
});

Deno.test("serialize: enforce PUBLISH packet_identifier rules", () => {
  const w = new m.Writer();
  const topic = m.asTopic("a/b");
  // packet_identifier is forbidden for QoS 0
  assertThrows(() =>
    m.serializePublishPacket({
      type: m.ControlPacketType.Publish,
      topic,
      packet_identifier: 5 as m.PacketIdentifier,
    }, w)
  );
  // packet_identifier is required for QoS 1
  assertThrows(() =>
    m.serializePublishPacket({
      type: m.ControlPacketType.Publish,
      topic,
      qos: m.QoS.At_least_once_delivery,
    }, w)
  );
});

Deno.test("serialize: reject Topic Alias 0", () => {
  const w = new m.Writer();
  assertThrows(() =>
    m.serializePublishPacket({
      type: m.ControlPacketType.Publish,
      topic: m.asTopic("a/b"),
      properties: { topic_alias: 0 },
    }, w)
  );
});

Deno.test("serialize: enforce maximum_packet_size including fixed header", () => {
  const w = new m.Writer();
  w.maximumPacketSize = 5;
  assertThrows(() =>
    m.serializePublishPacket({
      type: m.ControlPacketType.Publish,
      topic: m.asTopic("a/b"),
      payload: "hello world",
    }, w)
  );
});

Deno.test("Writer: maximumPacketSize setter", () => {
  const w = new m.Writer();
  w.maximumPacketSize = 0;
  assertEquals(w.maximumPacketSize, 268_435_455);
  w.maximumPacketSize = undefined;
  assertEquals(w.maximumPacketSize, 268_435_455);
  assertThrows(() => {
    w.maximumPacketSize = -1;
  });
  assertThrows(() => {
    w.maximumPacketSize = 268_435_456;
  });
});

Deno.test("serialize: reject empty subscriptions / reason codes", () => {
  const w = new m.Writer();
  assertThrows(() =>
    m.serializeSubscribePacket({
      type: m.ControlPacketType.Subscribe,
      packet_identifier: 1 as m.PacketIdentifier,
      subscriptions: [],
    }, w)
  );
  assertThrows(() =>
    m.serializeSubAckPacket({
      type: m.ControlPacketType.SubAck,
      packet_identifier: 1 as m.PacketIdentifier,
      reason_codes: [],
    }, w)
  );
  assertThrows(() =>
    m.serializeUnsubscribePacket({
      type: m.ControlPacketType.Unsubscribe,
      packet_identifier: 1 as m.PacketIdentifier,
      topic_filters: [],
    }, w)
  );
  assertThrows(() =>
    m.serializeUnsubAckPacket({
      type: m.ControlPacketType.UnsubAck,
      packet_identifier: 1 as m.PacketIdentifier,
      reason_codes: [],
    }, w)
  );
});

Deno.test("serialize/deserialize ConnAck with falsy properties", () => {
  const w = new m.Writer();
  const packet: m.ConnAckPacket = {
    type: m.ControlPacketType.ConnAck,
    properties: {
      maximum_QoS: m.QoS.At_most_once_delivery,
      retain_available: false,
      topic_alias_maximum: 0,
      server_keep_alive: 0 as m.Seconds,
    },
  };
  const buf = m.serializeConnAckPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r)!;
  const result = m.deserializePacket(h, r) as m.ConnAckPacket;
  assertEquals(result.properties?.maximum_QoS, m.QoS.At_most_once_delivery);
  assertEquals(result.properties?.retain_available, false);
  assertEquals(result.properties?.topic_alias_maximum, 0);
  assertEquals(result.properties?.server_keep_alive, 0);
});

Deno.test("serialize/deserialize ConnectPacket with binary will payload", () => {
  const w = new m.Writer();
  const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x80]);
  const packet: m.ConnectPacket = {
    type: m.ControlPacketType.Connect,
    client_id: m.asClientID("client1"),
    will: {
      topic: m.asTopic("will/topic"),
      payload,
    },
  };
  const buf = m.serializeConnectPacket(packet, w);
  const r = new DataReader(buf);
  const h = m.readFixedHeader(r)!;
  const result = m.deserializePacket(h, r) as m.ConnectPacket;
  assert(result.will);
  assert(result.will.payload instanceof DataReader);
  assertEquals((result.will.payload as DataReader).asUint8Array(), payload);
});

Deno.test("serialize dispatch for remaining packet types", () => {
  const w = new m.Writer();
  assertEquals(
    m.serialize({ type: m.ControlPacketType.Disconnect }, w),
    m.serializeDisconnectPacket({ type: m.ControlPacketType.Disconnect }, w),
  );
  assertEquals(
    m.serialize({ type: m.ControlPacketType.Auth }, w),
    m.serializeAuthPacket({ type: m.ControlPacketType.Auth }, w),
  );
  assertEquals(
    m.serialize({ type: m.ControlPacketType.PingReq }, w),
    m.PingReqMessage,
  );
  assertEquals(
    m.serialize({ type: m.ControlPacketType.PingResp }, w),
    m.PingRespMessage,
  );
});

Deno.test("DeserializeStream reassembles packets split across chunks", async () => {
  const ts = new TransformStream<Uint8Array, m.AllPacket>(
    new m.DeserializeStream(),
  );
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(m.PingReqMessage.slice(0, 1));
      controller.enqueue(m.PingReqMessage.slice(1));
      controller.close();
    },
  });

  const reader = source.pipeThrough(ts).getReader();

  const { value, done } = await reader.read();
  assert(!done);
  assertEquals(value, { type: m.ControlPacketType.PingReq });

  const end = await reader.read();
  assert(end.done);
});
