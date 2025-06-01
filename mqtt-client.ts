/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { mqtt } from "./mod.ts";

await using client = new mqtt.Client(
  "tcp://127.0.0.1:1883",
  {
    keepalive: 10 as mqtt.Seconds,
    // will: {
    //   topic: mqtt.asTopic("hi"),
    //   retain: true,
    // },
  },
  {
    publishDeserializeOptions: mqtt.PublishDeserializeOptions.UTF8String,
  },
);

// For Chrome, ... you have to use helper.streamAsyncIterator(client.readable)
for await (const p of client.readable) {
  //mqtt.logPacket(p);
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
          properties: { subscription_identifier: 5 },
        }),
      );
      // await client.publish({
      //   topic: mqtt.asTopic("hi"),
      //   payload: "wie gehts?",
      //   retain: true,
      // });
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
    case mqtt.ControlPacketType.Disconnect: {
      console.log("%cDisconnect", "color: red", p);
      break;
    }
    case mqtt.CustomPacketType.ConnectionClosed: {
      console.log("%cConnectionClosed", "color: red", p);
      break;
    }
    case mqtt.CustomPacketType.Error: {
      console.error("%cError", "color: red", p);
      break;
    }
  }
}

console.log("%cexiting", "color: red");
