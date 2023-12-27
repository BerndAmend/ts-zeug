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
import { sleep } from "./helper/mod.ts";
import * as mqtt from "./mqtt/mod.ts";

const client = new mqtt.Client(
  "ws://127.0.0.1:1884",
  {
    //keepalive: 60 as mqtt.Seconds,
    will: {
      topic: mqtt.asTopic("hi"),
    },
  },
  { alwaysTryToDecodePayloadAsUTF8String: true },
);

client.open();

await sleep(1000 as mqtt.Seconds);

client.subscribe({
  subscriptions: [{ topic: mqtt.asTopicFilter("#") }],
  properties: { subscription_identifier: 5 },
});

await sleep(1000 as mqtt.Seconds);

await client.publish({
  topic: mqtt.asTopic("hi"),
  payload: "wie gehts?",
  retain: true,
});

for await (const packet of client.readable) {
  mqtt.logPacket(packet);
}

console.log("exiting");
