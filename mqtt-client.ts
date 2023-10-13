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
import * as mqtt from "./mqtt/mod.ts";
import { nanoid, sleep } from "./helper/mod.ts";

const { readable, writable, connection } = await mqtt.connectLowLevel(
  //"ws://127.0.0.1:1884",
  "tcp://127.0.0.1:1883",
);

const [reader, writer] = [readable.getReader(), writable.getWriter()];

function printPacket(
  msg: ReadableStreamDefaultReadResult<mqtt.AllPacket>,
) {
  if (msg.done) {
    console.log("Done");
    return;
  }
  mqtt.logPacket(msg.value);
}

const w = new mqtt.Writer();
const conMsg = mqtt.serializeConnectPacket(
  {
    client_id: mqtt.asClientID(
      nanoid().replaceAll("-", "").replaceAll("_", ""),
    ),
    keepalive: 60 as mqtt.Seconds,
    will: {
      topic: mqtt.asTopic("hi"),
    },
  },
  w,
);
await writer.write(conMsg);

printPacket(await reader.read());

const subMsg = mqtt.serializeSubscribePacket({
  packet_identifier: 2000 as mqtt.PacketIdentifier,
  subscriptions: [{ topic: mqtt.asTopicFilter("#") }],
}, w);
await writer.write(subMsg);

printPacket(await reader.read());

const pubMsg = mqtt.serializePublishPacket({
  topic: mqtt.asTopic("hi"),
  payload: "wie gehts?",
  retain: true,
}, w);
await writer.write(pubMsg);

await sleep(1000);

const sendPing = async () => {
  try {
    while (true) {
      await writer.write(mqtt.PingReqMessage);
      await sleep(10000);
    }
  } catch (e) {
    console.log("Write error", e);
  }
};

sendPing();

// (async () => {
//   await sleep(10000);
//   // await writer.write(mqtt.serializeDisconnectPacket({}, w));
//   // await sleep(2000);
//   connection.close();
// })();

reader.releaseLock();
for await (const packet of readable) {
  mqtt.logPacket(packet);
}

console.log("exiting");
