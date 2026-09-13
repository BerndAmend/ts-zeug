/**
 * Runtime-agnostic smoke test executed under Node, Bun and Deno.
 *
 * Environment:
 *   TS_ZEUG_BUNDLE  file:// URL of the bundled library (see bun_node_test.ts)
 *   TS_ZEUG_BROKER  optional broker URL (mqtt:// or ws://); when set a
 *                   connect/subscribe/publish/receive round trip is executed
 */

const bundleUrl = process.env.TS_ZEUG_BUNDLE;
if (!bundleUrl) {
  console.error("TS_ZEUG_BUNDLE is not set");
  process.exit(1);
}

const broker = process.env.TS_ZEUG_BROKER;

const lib = await import(bundleUrl);

const runtimeName = process.versions?.bun
  ? "bun"
  : process.versions?.deno
  ? "deno"
  : "node";
console.log(`runtime=${runtimeName} version=${process.version}`);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readUntil(client, expectedType, timeoutMs) {
  const reader = client.readable.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(10, deadline - Date.now());
      let result;
      try {
        result = await withTimeout(reader.read(), remaining);
      } catch {
        continue;
      }
      if (!result || result.done) return null;
      if (result.value && result.value.type === expectedType) {
        return result.value;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

// --- core round trips (no broker required) -------------------------------
{
  const { serialize, deserialize } = lib.msgpack;
  const value = {
    number: 42,
    big: 2n ** 60n,
    text: "hello äöü",
    list: [1, 2, 3],
    flag: true,
    nothing: null,
  };
  const decoded = deserialize(serialize(value));
  assert(decoded.number === 42, "msgpack number");
  assert(decoded.big === 2n ** 60n, "msgpack bigint");
  assert(decoded.text === "hello äöü", "msgpack string");
  assert(decoded.list.length === 3, "msgpack array");
  assert(decoded.flag === true, "msgpack boolean");
  assert(decoded.nothing === undefined, "msgpack nil");

  const writer = new lib.mqtt.Writer();
  const packet = lib.mqtt.serializePublishPacket({
    type: 3,
    topic: "runtime/test",
    payload: "payload",
    qos: 0,
  }, writer);
  const reader = new lib.helper.DataReader(packet);
  const header = lib.mqtt.readFixedHeader(reader);
  const parsed = lib.mqtt.deserializePacket(header, reader);
  assert(parsed.topic === "runtime/test", "packet topic");
  assert(parsed.payload === "payload", "packet payload");
}

// --- broker round trip (optional) ----------------------------------------
if (broker) {
  const { Client, asClientID, asTopic, asTopicFilter, QoS, ControlPacketType } =
    lib.mqtt;
  const suffix = Math.random().toString(36).slice(2);
  const topic = `runtime/${suffix}`;
  const client = new Client(broker, {
    client_id: asClientID(`runtime-${suffix}`),
  }, { reconnectTime: 1000 });

  try {
    const connAck = await readUntil(client, ControlPacketType.ConnAck, 5000);
    assert(connAck !== null, "CONNACK");

    await client.subscribe({
      subscriptions: [{
        topic: asTopicFilter(topic),
        qos: QoS.At_most_once_delivery,
      }],
    });
    await client.publish({
      topic: asTopic(topic),
      payload: `hello from ${process.platform}`,
      qos: QoS.At_most_once_delivery,
    });

    const publish = await readUntil(client, ControlPacketType.Publish, 5000);
    assert(publish !== null, "loopback PUBLISH");
    assert(publish.payload === `hello from ${process.platform}`, "payload");
  } finally {
    await client.close().catch(() => {});
  }

  console.log(`OK broker ${broker}`);
} else {
  console.log("OK core");
}
