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
import { mqtt } from "./mod.ts";

await using client = new mqtt.Client(
  "tcp://127.0.0.1:1883",
  {
    keepalive: 1 as mqtt.Seconds,
    will: {
      topic: mqtt.asTopic("hi"),
      retain: true,
    },
  },
  { alwaysTryToDecodePayloadAsUTF8String: true },
);

// For Chrome, ... you have to use helper.streamAsyncIterator(client.readable)
for await (const p of client.readable) {
  //mqtt.logPacket(p);
  switch (p.type) {
    case mqtt.ControlPacketType.ConnAck: {
      const suback = await client.subscribe({
        subscriptions: [{ topic: mqtt.asTopicFilter("#") }],
        properties: { subscription_identifier: 5 },
      });
      await client.publish({
        topic: mqtt.asTopic("hi"),
        payload: "wie gehts?",
        retain: true,
      });
      break;
    }
    case mqtt.ControlPacketType.Publish: {
      try {
        console.log(
          p.topic,
          typeof p.payload === "string" ? JSON.parse(p.payload) : "undefined",
        );
      } catch (e) {
        console.error("Couldn't parse", p.topic, p.payload, e);
      }
      break;
    }
    case mqtt.ControlPacketType.Disconnect: {
      console.log("Disconnect", p);
      break;
    }
    case mqtt.CustomPacketType.ConnectionClosed: {
      console.log("ConnectionClosed", p);
      break;
    }
    case mqtt.CustomPacketType.Error: {
      console.error("Error", p);
      break;
    }
  }
}

console.log("exiting");
