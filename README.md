# ts-zeug

Various stuff ("Zeug") for TypeScript, designed for Deno, the web, and partially
for Node.js. This repository provides:

- An MQTT 5 client implementation
- A feature-complete MsgPack implementation for efficient binary serialization.

## Features

- **MQTT 5 Client:** Connect to MQTT brokers, publish and subscribe to topics,
  and handle messages with ease. (Note: QoS 1/2 are supported but not
  automatically handled by the client)
- **MsgPack:** Serialize and deserialize JavaScript objects using the efficient
  MessagePack format. It also supports a low level API.

## MQTT Client Example

This example demonstrates how to connect to a local MQTT broker, subscribe to a
topic, publish a message, and handle incoming messages.

```ts
import { mqtt } from "jsr:@bernd/ts-zeug";

await using client = new mqtt.Client(
  "mqtt://localhost",
  {
    keepalive: 10 as mqtt.Seconds,
    will: {
      topic: mqtt.asTopic("test/topic"),
      payload: "bye",
    },
  },
  {
    publishDeserializeOptions: mqtt.PublishDeserializeOptions.UTF8String,
  },
);

// For Chrome, ... you have to use helper.streamAsyncIterator(client.readable)
for await (const p of client.readable) {
  switch (p.type) {
    case mqtt.ControlPacketType.ConnAck: {
      if (p.connect_reason_code !== mqtt.ConnectReasonCode.Success) {
        console.error("%cCouldn't connect", "color: red", p);
        break;
      }
      mqtt.logPacket(
        await client.subscribe({
          subscriptions: [{
            topic: mqtt.asTopicFilter("#"),
            retain_as_published: true,
          }],
        }),
      );
      await client.publish({
        topic: mqtt.asTopic("test/topic"),
        payload: "Hi!",
      });
      break;
    }
    case mqtt.ControlPacketType.Publish: {
      if (p.payload === undefined) {
        console.log(
          `%c${p.topic}`,
          `${p.retain ? "color: blue;" : ""} font-weight: bold`,
        );
      } else {
        try {
          console.log(
            `%c${p.topic}`,
            `${p.retain ? "color: blue;" : ""} font-weight: bold`,
            JSON.parse(p.payload as string),
          );
        } catch {
          console.log(
            `%c${p.topic}`,
            `${p.retain ? "color: blue;" : ""} font-weight: bold`,
            p.payload as string,
          );
        }
      }
      break;
    }
    default:
      mqtt.logPacket(p);
      break;
  }
}

console.log("%cexiting", "color: red");
```

## MsgPack Example

This example shows how to encode and decode objects using MsgPack.

```ts
import { msgpack } from "jsr:@bernd/ts-zeug";

const serialized = msgpack.serialize({ hello: "world", num: 42 });
console.log("Serialized:", serialized);

const deserialized = msgpack.deserialize(serialized);
console.log("Deserialized:", deserialized);
```

## Tests

Run all tests with:

`deno test`
