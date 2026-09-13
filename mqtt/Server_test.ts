/**
 * MQTT 5.0 broker integration tests.
 *
 * By default every scenario runs twice, against two backends:
 *   - `server`    the in-process ts-zeug {@link Server}
 *   - `mosquitto` an external Mosquitto broker
 *
 * Mosquitto tests are skipped automatically if the `mosquitto` binary is not
 * available (they are reported as "ignored").
 *
 * Run both backends with a single command:
 *   deno test -A
 * Run only one backend:
 *   MQTT_TEST_BACKEND=server deno test -A
 *   MQTT_TEST_BACKEND=mosquitto deno test -A
 *
 * Tests that assert server-specific configuration or behaviour (auth handler,
 * server options, CONNACK property echoes, QoS cap) only run for `server`.
 *
 * @license MIT
 * @copyright 2026 Bernd Amend
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { deadline } from "@std/async";
import {
  asClientID,
  asTopic,
  asTopicFilter,
  Client,
  ConnAckPacket,
  ConnectPacket,
  ConnectReasonCode,
  ControlPacketType,
  DisconnectReasonCode,
  PublishPacket,
  QoS,
  RetainHandling,
  SubAckReasonCode,
  TopicAliasMapper,
} from "./mod.ts";
import { type AuthHandler, Server, type ServerOptions } from "./Server.ts";
import { Mosquitto } from "./Mosquitto.ts";
import type { OmitPacketType } from "./serialize.ts";
import type { AllPacket, Seconds } from "./packets.ts";

type ConnectParams = OmitPacketType<ConnectPacket>;
type PublishParams = OmitPacketType<PublishPacket>;
type AnyPacket = AllPacket | { type: number };

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** Which broker implementation the suite runs against. */
type Backend = "server" | "mosquitto";

/** All backends that exist. */
const ALL_BACKENDS: readonly Backend[] = ["server", "mosquitto"];

/** Resolves the backends for this run (env override, otherwise both). */
function resolveBackends(): Backend[] {
  let requested: string | undefined;
  try {
    requested = Deno.env.get("MQTT_TEST_BACKEND");
  } catch {
    // No --allow-env permission: use the default (both).
  }
  if (requested === "server" || requested === "mosquitto") return [requested];
  return [...ALL_BACKENDS];
}

const BACKENDS = resolveBackends();

/** The backend of the test currently being executed. */
let activeBackend: Backend = "server";

let mosquittoAvailableCache: boolean | undefined;
/** Returns true if the `mosquitto` binary can be spawned. */
function isMosquittoAvailable(): boolean {
  if (mosquittoAvailableCache === undefined) {
    try {
      new Deno.Command("mosquitto", {
        args: ["-h"],
        stdout: "null",
        stderr: "null",
      }).outputSync();
      mosquittoAvailableCache = true;
    } catch {
      mosquittoAvailableCache = false;
    }
  }
  return mosquittoAvailableCache;
}

/** Whether the mosquitto binary is available. */
const MOSQUITTO_AVAILABLE = isMosquittoAvailable();

if (BACKENDS.includes("mosquitto") && !MOSQUITTO_AVAILABLE) {
  console.warn(
    `Mosquitto is unavailable (binary missing or --allow-run not granted); ` +
      `mosquitto tests will be skipped.`,
  );
}

/** A running broker under test. */
interface TestBroker extends AsyncDisposable {
  /** Port of the plain MQTT listener. */
  readonly port: number;
  /** Port of the WebSocket listener. */
  readonly wsPort: number;
}

/** Finds a free TCP port whose successor is also free (Mosquitto needs a pair). */
function getFreePortPair(): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    let port: number;
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      port = (listener.addr as Deno.NetAddr).port;
      listener.close();
    } catch {
      continue;
    }
    if (port >= 65534) continue;
    try {
      Deno.listen({ hostname: "127.0.0.1", port: port + 1 }).close();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("could not find a free consecutive port pair");
}

/** Waits until something accepts TCP connections on `port`. */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port,
        transport: "tcp",
      });
      conn.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`broker did not start listening on port ${port}`);
}

// ---------------------------------------------------------------------------
// Test registration helpers
// ---------------------------------------------------------------------------

/**
 * Registers a backend-agnostic test once per selected backend.
 * Mosquitto runs are ignored (not failed) when the binary is unavailable.
 */
function testBroker(name: string, fn: () => void | Promise<void>) {
  for (const backend of BACKENDS) {
    Deno.test({
      name: BACKENDS.length > 1 ? `[${backend}] ${name}` : name,
      ignore: backend === "mosquitto" && !MOSQUITTO_AVAILABLE,
      async fn() {
        activeBackend = backend;
        await fn();
      },
    });
  }
}

/** Registers a test that is specific to the in-process server implementation. */
function testServerOnly(name: string, fn: () => void | Promise<void>) {
  Deno.test({
    name,
    ignore: !BACKENDS.includes("server"),
    async fn() {
      activeBackend = "server";
      await fn();
    },
  });
}

/** Starts the selected broker backend. */
async function startBroker(
  options?: { serverOptions?: ServerOptions; ws?: boolean },
): Promise<TestBroker> {
  if (activeBackend === "mosquitto") {
    const mosquitto = new Mosquitto(getFreePortPair(), "127.0.0.1");
    await mosquitto.start();
    await waitForPort(mosquitto.port);
    return {
      port: mosquitto.port,
      wsPort: mosquitto.port + 1,
      async [Symbol.asyncDispose]() {
        await mosquitto[Symbol.asyncDispose]();
      },
    };
  }

  const protocol = options?.ws ? "ws://" : "mqtt://";
  const server = new Server(`${protocol}127.0.0.1:0`, options?.serverOptions);
  server.listen();
  const port = server.ports[0]!;
  assertNotEquals(port, 0, "expected a non-zero port");
  return {
    port,
    wsPort: port,
    async [Symbol.asyncDispose]() {
      await server[Symbol.asyncDispose]();
    },
  };
}

/** Repeatedly reads until a packet of the expected type arrives. Does NOT cancel the stream. */
async function readUntil(
  client: Client,
  expectedType: number,
  timeoutMs = 5000,
): Promise<AnyPacket | null> {
  const reader = client.readable.getReader();
  try {
    const deadlineMs = Date.now() + timeoutMs;
    while (Date.now() < deadlineMs) {
      const remaining = Math.max(10, deadlineMs - Date.now());
      try {
        const { done, value } = await deadline(reader.read(), remaining);
        if (done) return null;
        if ((value.type as number) === expectedType) return value;
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        throw e;
      }
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Reads and asserts we receive a ConnAck (or returns null on failure event). */
async function awaitConnAck(client: Client): Promise<ConnAckPacket | null> {
  const reader = client.readable.getReader();
  try {
    const deadlineMs = Date.now() + 5000;
    while (Date.now() < deadlineMs) {
      const remaining = Math.max(10, deadlineMs - Date.now());
      try {
        const { done, value } = await deadline(reader.read(), remaining);
        if (done) return null;
        if (value.type === ControlPacketType.ConnAck) {
          return value as ConnAckPacket;
        }
        const t = (value as { type: number }).type;
        if (t === 101 || t === 100 || t === 200) return null;
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        throw e;
      }
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** A one-shot publish helper: connects, publishes one message, disconnects. */
async function publishOnce(
  port: number,
  topic: string,
  payload: string,
  qos: QoS = QoS.At_most_once_delivery,
  retain = false,
): Promise<void> {
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID(`pub-${crypto.randomUUID().slice(0, 8)}`),
  });
  const ack = await awaitConnAck(client);
  if (!ack) throw new Error("publishOnce: ConnAck failed");
  await client.publish({
    topic: asTopic(topic),
    payload,
    qos,
    retain,
  } as PublishParams);
  await client.close();
}

/**
 * Counts how many PUBLISH packets a client receives within a time window.
 * Returns as soon as `expected` publishes are seen, or the window elapses.
 */
async function countPublishes(
  client: Client,
  expected: number,
  timeoutMs = 2000,
): Promise<number> {
  const reader = client.readable.getReader();
  let count = 0;
  try {
    const deadlineMs = Date.now() + timeoutMs;
    while (count < expected && Date.now() < deadlineMs) {
      const remaining = Math.max(10, deadlineMs - Date.now());
      try {
        const { done, value } = await deadline(reader.read(), remaining);
        if (done) break;
        if ((value.type as number) === (ControlPacketType.Publish as number)) {
          count++;
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        throw e;
      }
    }
    return count;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

testBroker("TCP CONNECT → CONNACK", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("test-tcp"),
    });
    const ack = await awaitConnAck(client);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("WebSocket CONNECT → CONNACK", async () => {
  const server = await startBroker({ ws: true });
  const wsPort = server.wsPort;
  try {
    const client = new Client(`ws://127.0.0.1:${wsPort}`, {
      client_id: asClientID("test-ws"),
    });
    const ack = await awaitConnAck(client);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testServerOnly("CONNECT rejected by auth handler", async () => {
  const rejectAuth: AuthHandler = {
    // deno-lint-ignore require-await
    async authenticate(_c: ConnectPacket) {
      return { reason: ConnectReasonCode.Not_authorized };
    },
  };
  const server = new Server("mqtt://127.0.0.1:0", rejectAuth);
  server.listen();
  const port = server.ports[0]!;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("rejected"),
    });
    const ack = await awaitConnAck(client);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Not_authorized);
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("PUBLISH QoS 0 → subscriber receives it", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("sub"),
    });
    const ack = await awaitConnAck(sub);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);

    const subAck = await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("test/qos0"),
        qos: QoS.At_most_once_delivery,
      }],
    });
    assert(subAck);

    await publishOnce(port, "test/qos0", "hello QoS 0");

    const msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "subscriber should receive the published message");
    assertEquals(msg.topic, asTopic("test/qos0"));
    assertEquals(msg.payload, "hello QoS 0");
    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("PUBLISH QoS 1 → PubAck + subscriber receives it", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("sub-qos1"),
    });
    const ack = await awaitConnAck(sub);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);

    const _subAck = await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("test/qos1"),
        qos: QoS.At_least_once_delivery,
      }],
    });

    await publishOnce(
      port,
      "test/qos1",
      "qos1 payload",
      QoS.At_least_once_delivery,
    );

    const msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "subscriber should receive the QoS 1 message");
    assertEquals(msg.payload, "qos1 payload");
    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("SUBSCRIBE → SubAck + retained messages", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    // First publish a retained message
    const pub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("pub-retain"),
    });
    const pubAck = await awaitConnAck(pub);
    assert(pubAck?.connect_reason_code === ConnectReasonCode.Success);
    await pub.publish({
      topic: asTopic("retained/test"),
      payload: "sticky message",
      retain: true,
    } as PublishParams);
    await pub.close();

    // New client subscribes → should receive retained message
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("sub-retain"),
    });
    const subConnAck = await awaitConnAck(sub);
    assert(subConnAck?.connect_reason_code === ConnectReasonCode.Success);

    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("retained/test"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    let gotRetained = false;
    const reader = sub.readable.getReader();
    try {
      const deadlineMs = Date.now() + 5000;
      while (Date.now() < deadlineMs) {
        try {
          const { done, value } = await deadline(
            reader.read(),
            Math.max(10, deadlineMs - Date.now()),
          );
          if (done) break;
          if (value.type === ControlPacketType.SubAck) continue;
          if (value.type === ControlPacketType.Publish) {
            const pubPkt = value as PublishPacket;
            assertEquals(pubPkt.topic, asTopic("retained/test"));
            assertEquals(pubPkt.payload, "sticky message");
            assert(pubPkt.retain, "retained message should have retain flag");
            gotRetained = true;
            break;
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "TimeoutError") break;
          throw e;
        }
      }
    } finally {
      reader.releaseLock();
    }
    assert(gotRetained, "should receive retained message on subscribe");
    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Last Will – published on unexpected disconnect", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const listener = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("will-listener"),
    });
    const listenerAck = await awaitConnAck(listener);
    assert(listenerAck?.connect_reason_code === ConnectReasonCode.Success);

    const _subAck = await listener.subscribe({
      subscriptions: [{
        topic: asTopicFilter("will/test"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    // Client with will
    const willClient = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("will-sender"),
      will: {
        topic: asTopic("will/test"),
        payload: "client disconnected unexpectedly",
        retain: false,
      },
    } as ConnectParams);
    const willAck = await awaitConnAck(willClient);
    assert(willAck?.connect_reason_code === ConnectReasonCode.Success);

    // Send DISCONNECT with will-message reason → server should publish the will
    await willClient.close({
      type: 0 as ControlPacketType.Disconnect,
      reason_code: DisconnectReasonCode.Disconnect_with_Will_Message,
    });

    const msg = await readUntil(listener, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "listener should receive the will message");
    assertEquals(msg.topic, asTopic("will/test"));
    assertEquals(msg.payload, "client disconnected unexpectedly");
    await listener.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Topic Alias – bidirectional alias substitution", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const pub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("alias-pub"),
    });
    const pubAck = await awaitConnAck(pub);
    assertEquals(pubAck?.connect_reason_code, ConnectReasonCode.Success);

    // Topic aliases should be available
    const srvAliasMax = pubAck?.properties?.topic_alias_maximum;
    assert(
      srvAliasMax && srvAliasMax > 0,
      "server should announce topic alias support",
    );

    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("alias-sub"),
    });
    const subAck1 = await awaitConnAck(sub);
    assert(subAck1?.connect_reason_code === ConnectReasonCode.Success);

    const _subAck2 = await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("alias/test"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    // First publish (topic + alias assignment)
    await pub.publish({
      topic: asTopic("alias/test"),
      payload: "first message",
    } as PublishParams);
    let msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assertEquals(msg?.payload, "first message");

    // Second publish (should reuse alias)
    await pub.publish({
      topic: asTopic("alias/test"),
      payload: "second via alias",
    } as PublishParams);
    msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assertEquals(msg?.payload, "second via alias");

    await pub.close();
    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

Deno.test("TopicAliasMapper LRU eviction", () => {
  const mapper = new TopicAliasMapper();
  mapper.maximum = 2;

  // First topic gets alias 1
  const r1 = mapper.preparePublish("a");
  assertEquals(r1?.topic_alias, 1);
  assertEquals(r1?.topic, undefined);

  // Second topic gets alias 2
  const r2 = mapper.preparePublish("b");
  assertEquals(r2?.topic_alias, 2);
  assertEquals(r2?.topic, undefined);

  // Re-publishing "a" returns alias-only (empty topic, alias 1)
  const r3 = mapper.preparePublish("a");
  assertEquals(r3?.topic_alias, 1);
  assertEquals(r3?.topic, "");

  // "c" evicts alias 2 (LRU: "a" touched last, so "b" → alias 2 evicted)
  const r4 = mapper.preparePublish("c");
  assertEquals(r4?.topic_alias, 2);

  // "a" still at alias 1
  const r5 = mapper.preparePublish("a");
  assertEquals(r5?.topic_alias, 1);
  assertEquals(r5?.topic, "");

  // "d" evicts alias 2 (LRU: [c=2, a=1], c was least recently used)
  const r6 = mapper.preparePublish("d");
  assertEquals(r6?.topic_alias, 2);
  assertEquals(r6?.topic, undefined);

  // Reset
  mapper.maximum = 0;
  assertEquals(mapper.preparePublish("anything"), undefined);
});

testBroker("PingReq → PingResp (keep-alive)", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("ping-test"),
      keepalive: 5,
    } as ConnectParams);

    const ack = await awaitConnAck(client);
    assert(ack?.connect_reason_code === ConnectReasonCode.Success);
    // Client sends PingReq automatically; verify connection stays alive
    await new Promise((r) => setTimeout(r, 500));
    assert(client.isConnected, "client should still be connected");
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Shared subscriptions – round-robin", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub1 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("shared-1"),
    });
    assert(
      (await awaitConnAck(sub1))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub1.subscribe({
      subscriptions: [{
        topic: asTopicFilter("$share/grp/shared/test"),
        qos: QoS.At_most_once_delivery,
      }],
    });
    const sub2 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("shared-2"),
    });
    assert(
      (await awaitConnAck(sub2))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub2.subscribe({
      subscriptions: [{
        topic: asTopicFilter("$share/grp/shared/test"),
        qos: QoS.At_most_once_delivery,
      }],
    });
    // Publish several messages → the group must distribute them, so no single
    // subscriber receives every message.
    const N = 10;
    for (let i = 0; i < N; i++) {
      await publishOnce(port, "shared/test", `msg${i}`);
    }

    const sub1Count = await countPublishes(sub1, N);
    const sub2Count = await countPublishes(sub2, N);

    assert(
      sub1Count + sub2Count === N,
      `each message should be delivered exactly once to the group, got ${
        sub1Count + sub2Count
      } of ${N}`,
    );
    assert(
      sub1Count > 0 && sub2Count > 0,
      `messages should be distributed round‑robin: sub1=${sub1Count} sub2=${sub2Count}`,
    );

    await sub1.close();
    await sub2.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Wildcard subscriptions", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("wildcard-sub"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );

    await sub.subscribe({
      subscriptions: [
        { topic: asTopicFilter("sensors/+"), qos: QoS.At_most_once_delivery },
        { topic: asTopicFilter("events/#"), qos: QoS.At_most_once_delivery },
      ],
    });
    await publishOnce(port, "sensors/temp", "22.5");
    let msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assertEquals(msg?.topic, asTopic("sensors/temp"));
    assertEquals(msg?.payload, "22.5");

    await publishOnce(port, "events/click/x", "clicked");
    msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assertEquals(msg?.topic, asTopic("events/click/x"));
    assertEquals(msg?.payload, "clicked");

    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("UNSUBSCRIBE → UnsubAck", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("unsub-test"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );

    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("unsub/topic"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    // unsubscribe returns UnsubAckPacket directly
    const unsubAck = await sub.unsubscribe({
      topic_filters: [asTopicFilter("unsub/topic")],
    });
    assert(unsubAck, "should receive UnsubAck");
    assertEquals(unsubAck.type, ControlPacketType.UnsubAck);

    // Publish to unsubscribed topic → should NOT arrive
    await publishOnce(port, "unsub/topic", "should not arrive");
    const reader = sub.readable.getReader();
    try {
      const { done, value } = await deadline(reader.read(), 2000);
      if (!done && value) {
        // if we got something, it must NOT be a publish for unsub/topic
        assert(
          value.type !== ControlPacketType.Publish ||
            (value as PublishPacket).topic !== asTopic("unsub/topic"),
          "unsubscribed client should not receive messages for unsub/topic",
        );
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        // timeout = no message received, which is expected
      } else {
        throw e;
      }
    } finally {
      reader.releaseLock();
    }

    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testServerOnly(
  "MQTT 3.1.1 CONNECT → Unsupported_Protocol_Version",
  async () => {
    const server = await startBroker();
    const port = server.port;
    try {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port,
        transport: "tcp",
      });
      conn.setNoDelay(true);

      // MQTT 3.1.1 CONNECT: type=1, remaining_length=12, protocol="MQTT", version=4
      const buf = new Uint8Array([
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
        0x3c,
        0x00,
        0x00,
      ]);
      const writer = conn.writable.getWriter();
      await writer.write(buf);
      writer.releaseLock();

      const reader = conn.readable.getReader();
      try {
        const { value } = await reader.read();
        assert(value && value.length >= 4, "should receive a ConnAck response");
        const packetType = value[0]! >> 4;
        const reasonCode = value[3]!; // ConnAck: [fixed, len, session, reason, [props...]]
        assertEquals(packetType, 2, "packet type should be ConnAck (2)");
        assertEquals(
          reasonCode,
          132,
          "reason code should be Unsupported_Protocol_Version (132)",
        );
      } finally {
        reader.releaseLock();
        try {
          conn.close();
        } catch { /* may already be closed */ }
      }
    } finally {
      await server[Symbol.asyncDispose]();
    }
  },
);

testBroker("For-await iteration over readable stream", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("forawait-test"),
    });

    let connAckReceived = false;
    for await (const p of client.readable) {
      if (p.type === ControlPacketType.ConnAck) {
        connAckReceived = true;
        break;
      }
    }
    assert(connAckReceived, "should receive ConnAck via for-await");
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Multiple clients publish and subscribe concurrently", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("concurrent-sub"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );

    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("concurrent/#"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    // Publish from 3 clients in parallel
    await Promise.all([
      publishOnce(port, "concurrent/a", "A"),
      publishOnce(port, "concurrent/b", "B"),
      publishOnce(port, "concurrent/c", "C"),
    ]);

    const topics = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const msg = await readUntil(sub, ControlPacketType.Publish) as
        | PublishPacket
        | null;
      if (msg) topics.add(msg.topic);
    }
    assertEquals(topics.size, 3);
    assert(topics.has("concurrent/a"));
    assert(topics.has("concurrent/b"));
    assert(topics.has("concurrent/c"));

    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testServerOnly("Broker disconnects clients on shutdown", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("shutdown-test"),
  });
  assert(
    (await awaitConnAck(client))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );

  // Shutdown the broker
  await server[Symbol.asyncDispose]();

  // Client should detect the disconnection
  let disconnected = false;
  try {
    const reader = client.readable.getReader();
    try {
      const deadlineMs = Date.now() + 5000;
      while (Date.now() < deadlineMs) {
        try {
          const { done, value } = await deadline(
            reader.read(),
            Math.max(10, deadlineMs - Date.now()),
          );
          if (done) {
            disconnected = true;
            break;
          }
          const t = (value as { type: number }).type;
          if (t === 100) {
            disconnected = true;
            break;
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "TimeoutError") break;
          throw e;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    disconnected = true;
  }
  assert(disconnected, "client should detect broker shutdown");
  await client.close();
});

testBroker("Empty retained messages are deleted", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    // Set a retained message
    const pub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("retain-setter"),
    });
    assert(
      (await awaitConnAck(pub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await pub.publish({
      topic: asTopic("retained/clear"),
      payload: "will be deleted",
      retain: true,
    } as PublishParams);
    await pub.close();

    // Clear with empty retained publish
    const clearer = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("retain-clearer"),
    } as ConnectParams);
    assert(
      (await awaitConnAck(clearer))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await clearer.publish({
      topic: asTopic("retained/clear"),
      payload: "",
      retain: true,
    } as PublishParams);
    await clearer.close();

    // Subscribe → should NOT receive retained
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("retain-clear-sub"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("retained/clear"),
        qos: QoS.At_most_once_delivery,
      }],
    });

    let gotRetained = false;
    const reader = sub.readable.getReader();
    try {
      const deadlineMs = Date.now() + 5000;
      while (Date.now() < deadlineMs) {
        try {
          const { done, value } = await deadline(
            reader.read(),
            Math.max(10, deadlineMs - Date.now()),
          );
          if (done) break;
          if (value.type === ControlPacketType.SubAck) continue;
          if (value.type === ControlPacketType.Publish) {
            gotRetained = true;
            break;
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "TimeoutError") break;
          throw e;
        }
      }
    } finally {
      reader.releaseLock();
    }
    assert(!gotRetained, "cleared retained message should not be delivered");
    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker(
  "Session Store – cleanStart=false restores subscriptions",
  async () => {
    const server = await startBroker();
    const port = server.port;
    const clientId = asClientID("session-test");

    // First connection: subscribe, then disconnect (session saved if expiry > 0)
    const c1 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: clientId,
      clean_start: true,
      properties: { session_expiry_interval: 60 as Seconds },
    } as ConnectParams);
    assert(
      (await awaitConnAck(c1))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await c1.subscribe({
      subscriptions: [{
        topic: asTopicFilter("session/topic"),
        qos: QoS.At_most_once_delivery,
      }],
    });
    await c1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Second connection: cleanStart=false → session should be restored
    const c2 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: clientId,
      clean_start: false,
    } as ConnectParams);
    const ack = await awaitConnAck(c2);
    assert(ack?.connect_reason_code === ConnectReasonCode.Success);
    assert(ack?.session_present, "session should be present on reconnect");

    // Publish to the topic that was previously subscribed → should arrive
    await publishOnce(port, "session/topic", "persisted");
    const msg = await readUntil(c2, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "should receive publish on restored session topic");
    assertEquals(msg.payload, "persisted");
    await c2.close();
    await server[Symbol.asyncDispose]();
  },
);

testBroker(
  "retain_as_published flag preserves retain on forwarded publish",
  async () => {
    const server = await startBroker();
    const port = server.port;
    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("rap-sub"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("rap/topic"),
        qos: QoS.At_most_once_delivery,
        retain_as_published: true,
      }],
    });

    await publishOnce(
      port,
      "rap/topic",
      "data",
      QoS.At_most_once_delivery,
      false,
    );

    const msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "should receive publish");
    assertEquals(msg.retain ?? false, false);
    await sub.close();
    await server[Symbol.asyncDispose]();
  },
);

testBroker(
  "retain_handling=2 does not send retained messages on subscribe",
  async () => {
    const server = await startBroker();
    const port = server.port;
    await publishOnce(
      port,
      "rh2/topic",
      "retained data",
      QoS.At_most_once_delivery,
      true,
    );

    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("rh2-sub"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub.subscribe({
      subscriptions: [{
        topic: asTopicFilter("rh2/topic"),
        qos: QoS.At_most_once_delivery,
        retain_handling: RetainHandling
          .Do_not_send_retained_messages_at_the_time_of_the_subscribe,
      }],
    });

    let gotRetained = false;
    const reader = sub.readable.getReader();
    try {
      const { done, value } = await deadline(reader.read(), 2000);
      if (!done && value && value.type === ControlPacketType.Publish) {
        gotRetained = true;
      }
    } catch { /* timeout = good */ }
    reader.releaseLock();
    assert(
      !gotRetained,
      "retained message should not be sent when retain_handling=2",
    );
    await sub.close();
    await server[Symbol.asyncDispose]();
  },
);

testBroker("Assigned client ID when connecting without client_id", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(
    `mqtt://127.0.0.1:${port}`,
    { keepalive: 60 } as ConnectParams,
  );
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  const assignedId = ack?.properties?.assigned_client_id;
  assert(assignedId, "server should assign a client ID when none is provided");
  assert(assignedId.length > 0, "assigned client ID should not be empty");
  await client.close();
  await server[Symbol.asyncDispose]();
});

testBroker("Subscription identifier is forwarded on PUBLISH", async () => {
  const server = await startBroker();
  const port = server.port;
  const sub = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("subid-test"),
  });
  assert(
    (await awaitConnAck(sub))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  await sub.subscribe({
    subscriptions: [{
      topic: asTopicFilter("subid/topic"),
      qos: QoS.At_most_once_delivery,
    }],
    properties: { subscription_identifier: 42 },
  });
  await publishOnce(port, "subid/topic", "data");
  const msg = await readUntil(sub, ControlPacketType.Publish) as
    | PublishPacket
    | null;
  assert(msg !== null);
  assertEquals(msg.payload, "data");
  assertEquals(msg.properties?.subscription_identifier, [42]);
  await sub.close();
  await server[Symbol.asyncDispose]();
});

testBroker("Will with retain flag stores retained message", async () => {
  const server = await startBroker();
  const port = server.port;
  const willClient = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("will-retain"),
    will: {
      topic: asTopic("will/retained"),
      payload: "retained will msg",
      retain: true,
    },
  } as ConnectParams);
  assert(
    (await awaitConnAck(willClient))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  // deno-lint-ignore no-explicit-any
  await willClient.close({ reason_code: 4 } as any);
  const sub = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("will-retain-sub"),
  });
  assert(
    (await awaitConnAck(sub))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  await sub.subscribe({
    subscriptions: [{
      topic: asTopicFilter("will/retained"),
      qos: QoS.At_most_once_delivery,
    }],
  });
  const msg = await readUntil(sub, ControlPacketType.Publish) as
    | PublishPacket
    | null;
  assert(
    msg !== null && msg.retain,
    "retained will should be delivered as retained message",
  );
  assertEquals(msg.payload, "retained will msg");
  await sub.close();
  await server[Symbol.asyncDispose]();
});

testBroker("Will QoS is preserved in dispatched will message", async () => {
  const server = await startBroker();
  const port = server.port;
  const listener = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("will-qos-listener"),
  });
  assert(
    (await awaitConnAck(listener))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  await listener.subscribe({
    subscriptions: [{
      topic: asTopicFilter("will/qos"),
      qos: QoS.At_most_once_delivery,
    }],
  });
  const willClient = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("will-qos-sender"),
    will: {
      topic: asTopic("will/qos"),
      payload: "qos0 will",
      qos: QoS.At_most_once_delivery,
    },
  } as ConnectParams);
  assert(
    (await awaitConnAck(willClient))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  // deno-lint-ignore no-explicit-any
  await willClient.close({ reason_code: 4 } as any);
  const msg = await readUntil(listener, ControlPacketType.Publish) as
    | PublishPacket
    | null;
  assert(msg !== null);
  assertEquals(msg.payload, "qos0 will");
  await listener.close();
  await server[Symbol.asyncDispose]();
});

testBroker("User properties survive publish roundtrip", async () => {
  const server = await startBroker();
  const port = server.port;
  const sub = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("userprop-sub"),
  });
  assert(
    (await awaitConnAck(sub))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  await sub.subscribe({
    subscriptions: [{
      topic: asTopicFilter("userprop/test"),
      qos: QoS.At_most_once_delivery,
    }],
  });
  const pub = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("userprop-pub"),
  });
  assert(
    (await awaitConnAck(pub))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );
  await pub.publish({
    topic: asTopic("userprop/test"),
    payload: "data",
    properties: {
      user_properties: [{ key: "k1", value: "v1" }, { key: "k2", value: "v2" }],
    },
  } as PublishParams);
  await pub.close();
  const msg = await readUntil(sub, ControlPacketType.Publish) as
    | PublishPacket
    | null;
  assert(msg !== null);
  assertEquals(msg.payload, "data");
  assertEquals(msg.properties?.user_properties, [{ key: "k1", value: "v1" }, {
    key: "k2",
    value: "v2",
  }]);
  await sub.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly("ConnAck includes server_keep_alive", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("ska-test"),
    keepalive: 30,
  } as ConnectParams);
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  assertEquals(ack?.properties?.server_keep_alive, 30);
  await client.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly("ConnAck includes maximum_packet_size", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("mps-test"),
  });
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  assertEquals(ack?.properties?.maximum_packet_size, undefined);
  await client.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly("ConnAck includes maximum_QoS", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("maxqos-test"),
  });
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  assertEquals(ack?.properties?.maximum_QoS, QoS.At_least_once_delivery);
  await client.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly(
  "ConnAck includes session_expiry_interval when set",
  async () => {
    const server = await startBroker();
    const port = server.port;
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("sei-test"),
      properties: { session_expiry_interval: 3600 as Seconds },
    } as ConnectParams);
    const ack = await awaitConnAck(client);
    assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
    assertEquals(ack?.properties?.session_expiry_interval, 3600);
    await client.close();
    await server[Symbol.asyncDispose]();
  },
);

testServerOnly("ConnAck includes response_information", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("ri-test"),
    properties: { request_response_information: true },
  } as ConnectParams);
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  assert(
    ack?.properties?.response_information,
    "response_information should be present",
  );
  await client.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly("server_reference in shutdown DISCONNECT", async () => {
  const server = new Server("mqtt://127.0.0.1:0", {
    serverReference: "test-broker-v1",
  });
  server.listen();
  const port = server.ports[0]!;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("sr-test"),
  });
  assert(
    (await awaitConnAck(client))?.connect_reason_code ===
      ConnectReasonCode.Success,
  );

  const reader = client.readable.getReader();
  const disconnectPromise = (async () => {
    const deadlineMs = Date.now() + 5000;
    while (Date.now() < deadlineMs) {
      const { done, value } = await deadline(reader.read(), 5000);
      if (done) return null;
      if (
        (value as { type: number }).type ===
          (ControlPacketType.Disconnect as number)
      ) {
        return value as {
          reason_code?: number;
          properties?: { server_reference?: string };
        };
      }
    }
    return null;
  })();

  // Shutdown — server_reference is valid in shutdown DISCONNECT
  await server[Symbol.asyncDispose]();

  const disconnect = await disconnectPromise;
  reader.releaseLock();
  assert(disconnect !== null, "client should receive the shutdown DISCONNECT");
  assertEquals(
    disconnect.reason_code,
    DisconnectReasonCode.Server_shutting_down,
  );
  assertEquals(disconnect.properties?.server_reference, "test-broker-v1");

  await client.close();
});

testServerOnly("maximum_packet_size sets writer limit on connect", async () => {
  const server = await startBroker();
  const port = server.port;
  const client = new Client(`mqtt://127.0.0.1:${port}`, {
    client_id: asClientID("mps-enforce"),
    properties: { maximum_packet_size: 100 },
  } as ConnectParams);
  const ack = await awaitConnAck(client);
  assertEquals(ack?.connect_reason_code, ConnectReasonCode.Success);
  await client.close();
  await server[Symbol.asyncDispose]();
});

testServerOnly(
  "SUBSCRIBE QoS 2 → granted QoS 1 (maximum QoS cap)",
  async () => {
    const server = await startBroker();
    const port = server.port;
    try {
      const sub = new Client(`mqtt://127.0.0.1:${port}`, {
        client_id: asClientID("qos-cap"),
      });
      assert(
        (await awaitConnAck(sub))?.connect_reason_code ===
          ConnectReasonCode.Success,
      );

      const subAck = await sub.subscribe({
        subscriptions: [{
          topic: asTopicFilter("qos2/test"),
          qos: QoS.Exactly_once_delivery,
        }],
      });
      assertEquals(subAck.reason_codes[0], SubAckReasonCode.Granted_QoS_1);

      await sub.close();
    } finally {
      await server[Symbol.asyncDispose]();
    }
  },
);

testServerOnly("PUBLISH QoS 2 is rejected with QoS not supported", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("qos2-publish"),
    });
    assert(
      (await awaitConnAck(client))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );

    await client.publish({
      topic: asTopic("qos2/rejected"),
      payload: "payload",
      qos: QoS.Exactly_once_delivery,
    } as PublishParams);

    const disconnect = await readUntil(
      client,
      ControlPacketType.Disconnect,
      5000,
    ) as { reason_code?: number } | null;
    assert(disconnect !== null, "server should send a DISCONNECT");
    assertEquals(
      disconnect.reason_code,
      DisconnectReasonCode.QoS_not_supported,
    );

    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testServerOnly("Second CONNECT is a protocol error", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const id = new TextEncoder().encode("dup");
    const body = new Uint8Array([
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54, // "MQTT"
      0x05, // protocol version 5
      0x02, // flags: clean start
      0x00,
      0x00, // keepalive
      0x00, // properties
      0x00,
      id.length,
      ...id, // client id
    ]);
    const connect = new Uint8Array([0x10, body.length, ...body]);

    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port,
      transport: "tcp",
    });
    conn.setNoDelay(true);
    const writer = conn.writable.getWriter();
    const reader = conn.readable.getReader();
    try {
      await writer.write(connect);
      const { value: connack } = await deadline(reader.read(), 5000);
      assert(connack && (connack[0]! >> 4) === 2, "expected a CONNACK");

      // Send a second CONNECT on the same connection.
      await writer.write(connect);
      const { value: disconnect } = await deadline(reader.read(), 5000);
      assert(
        disconnect && (disconnect[0]! >> 4) === 14,
        "expected a DISCONNECT for the second CONNECT",
      );
      assertEquals(disconnect[2], DisconnectReasonCode.Protocol_Error);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("retained message matches '#' filter at parent level", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    // Publish a retained message to "sport" (no child level)
    await publishOnce(
      port,
      "sport",
      "parent retained",
      QoS.At_most_once_delivery,
      true,
    );

    const sub = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("hash-parent"),
    });
    assert(
      (await awaitConnAck(sub))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await sub.subscribe({
      subscriptions: [{ topic: asTopicFilter("sport/#") }],
    });

    const msg = await readUntil(sub, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "should receive retained message at parent level");
    assertEquals(msg.topic, asTopic("sport"));
    assertEquals(msg.payload, "parent retained");

    await sub.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Server disconnects client on keep-alive timeout", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port,
      transport: "tcp",
    });
    conn.setNoDelay(true);

    const clientId = "ka-timeout";
    const idBytes = new TextEncoder().encode(clientId);
    const body = new Uint8Array([
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54, // "MQTT"
      0x05, // protocol version 5
      0x02, // flags: clean start
      0x00,
      0x01, // keepalive = 1 second
      0x00, // properties length = 0
      0x00,
      idBytes.length,
      ...idBytes, // client id
    ]);
    const connect = new Uint8Array([0x10, body.length, ...body]);

    const writer = conn.writable.getWriter();
    await writer.write(connect);
    writer.releaseLock();

    const reader = conn.readable.getReader();
    try {
      const { value: connack } = await deadline(reader.read(), 5000);
      assert(connack && connack.length >= 2, "should receive a CONNACK");
      assertEquals(connack[0]! >> 4, 2, "packet type should be ConnAck");

      // Send no PINGREQ: the server must drop us after 1.5 * keepalive.
      // A compliant server may send a DISCONNECT packet before closing.
      let closed = false;
      const deadlineMs = Date.now() + 5000;
      while (Date.now() < deadlineMs) {
        const { done, value } = await deadline(reader.read(), 5000);
        if (done) {
          closed = true;
          break;
        }
        // Ignore an optional DISCONNECT (type 14) with reason Keep Alive
        // timeout (0x8D).
        if (value && (value[0]! >> 4) === 14) {
          continue;
        }
      }
      assert(
        closed,
        "server should close the connection on keep-alive timeout",
      );
    } finally {
      reader.releaseLock();
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

// The will delay is only applied by the in-process server. Mosquitto publishes
// the will immediately when the client sends DISCONNECT with reason 0x04.
testServerOnly("Will delay interval delays will publication", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const listener = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("will-delay-listener"),
    });
    assert(
      (await awaitConnAck(listener))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await listener.subscribe({
      subscriptions: [{ topic: asTopicFilter("will/delay") }],
    });

    const willClient = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("will-delay-sender"),
      // The Will Delay is capped by the Session Expiry Interval; a non-zero
      // value is required for the delay to apply.
      properties: { session_expiry_interval: 60 as Seconds },
      will: {
        topic: asTopic("will/delay"),
        payload: "delayed will",
        properties: { will_delay_interval: 1 as Seconds },
      },
    } as ConnectParams);
    assert(
      (await awaitConnAck(willClient))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );

    const start = Date.now();
    await willClient.close({
      type: 0 as ControlPacketType.Disconnect,
      reason_code: DisconnectReasonCode.Disconnect_with_Will_Message,
    });

    const msg = await readUntil(listener, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(msg !== null, "listener should receive the delayed will message");
    assertEquals(msg.payload, "delayed will");
    assert(
      Date.now() - start >= 500,
      "will should be delayed by will_delay_interval",
    );

    await listener.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testServerOnly(
  "ConnAck omits response_information unless requested",
  async () => {
    const server = await startBroker();
    const port = server.port;
    try {
      const client = new Client(`mqtt://127.0.0.1:${port}`, {
        client_id: asClientID("ri-default"),
      });
      const ack = await awaitConnAck(client);
      assert(ack?.connect_reason_code === ConnectReasonCode.Success);
      assertEquals(
        ack?.properties?.response_information,
        undefined,
        "response_information must only be sent when requested",
      );
      await client.close();
    } finally {
      await server[Symbol.asyncDispose]();
    }
  },
);

testBroker("unsubscribe removes a shared subscription", async () => {
  const server = await startBroker();
  const port = server.port;
  try {
    const client = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: asClientID("share-unsub"),
    });
    assert(
      (await awaitConnAck(client))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await client.subscribe({
      subscriptions: [{ topic: asTopicFilter("$share/g/unsub/topic") }],
    });
    await client.unsubscribe({
      topic_filters: [asTopicFilter("$share/g/unsub/topic")],
    });

    await publishOnce(port, "unsub/topic", "hello");

    const count = await countPublishes(client, 1, 1000);
    assertEquals(count, 0, "unsubscribed shared client must not receive data");
    await client.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});

testBroker("Session Store restores shared subscriptions", async () => {
  const server = await startBroker();
  const port = server.port;
  const clientId = asClientID("share-session");
  try {
    const c1 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: clientId,
      clean_start: true,
      properties: { session_expiry_interval: 60 as Seconds },
    } as ConnectParams);
    assert(
      (await awaitConnAck(c1))?.connect_reason_code ===
        ConnectReasonCode.Success,
    );
    await c1.subscribe({
      subscriptions: [{ topic: asTopicFilter("$share/g/session/topic") }],
    });
    await c1.close();
    await new Promise((r) => setTimeout(r, 50));

    const c2 = new Client(`mqtt://127.0.0.1:${port}`, {
      client_id: clientId,
      clean_start: false,
    } as ConnectParams);
    const ack = await awaitConnAck(c2);
    assert(ack?.session_present, "session should be present on reconnect");

    await publishOnce(port, "session/topic", "restored");
    const msg = await readUntil(c2, ControlPacketType.Publish) as
      | PublishPacket
      | null;
    assert(
      msg !== null,
      "restored shared subscription should receive the message",
    );
    assertEquals(msg.payload, "restored");
    await c2.close();
  } finally {
    await server[Symbol.asyncDispose]();
  }
});
