/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { mqtt } from "@bernd/ts-zeug";

await using client = new mqtt.Client(
  "mqtt://localhost",
  {
    keepalive: 10 as mqtt.Seconds,
    username: "some_user",
    client_id: mqtt.asClientID("some_client"),
    properties: {
      authentication_method: "something",
    },
  },
  {
    publishDeserializeOptions: mqtt.PublishDeserializeOptions.UTF8String,
  },
);

Deno.addSignalListener("SIGINT", () => {
  console.log("interrupted!");
  client.close();
});

try {
  for await (const p of client.readable) {
    switch (p.type) {
      case mqtt.ControlPacketType.Auth:
        mqtt.logPacket(p);
        if (p.reason_code !== mqtt.AuthReasonCode.Continue_authentication) {
          console.error("got an unexpected reason_code in an auth packet", p);
          break;
        }
        if (!p.properties?.authentication_data) {
          console.error("got an auth packet without authentication data", p);
          break;
        }
        await client.auth(p);

        break;
      case mqtt.ControlPacketType.ConnAck: {
        mqtt.logPacket(p);
        if (p.connect_reason_code !== mqtt.ConnectReasonCode.Success) {
          console.error("%cCouldn't connect", "color: red", p);
          break;
        }
        try {
          mqtt.logPacket(
            await client.subscribe({
              subscriptions: [{
                topic: mqtt.asTopicFilter("#"),
                retain_as_published: true,
              }],
              properties: { subscription_identifier: 5 },
            }),
          );
          await client.publish({
            topic: mqtt.asTopic("hi"),
            payload: "wie gehts?".repeat(20),
            retain: false,
          });
        } catch (e) {
          console.log("publish error ", e);
        }
        break;
      }
      case mqtt.ControlPacketType.Publish:
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
      default:
        mqtt.logPacket(p);
        break;
    }
  }
} catch (e) {
  console.error("%cError", "color: red", e);
  await client.close();
}
console.log("%cexiting", "color: red");
