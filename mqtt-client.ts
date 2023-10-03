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

//const { readable, writable, connection } = await connect("ws://127.0.0.1:1884");
const { readable, writable, connection } = await mqtt.connect(
  "tcp://127.0.0.1:1883",
);

const reader = readable.getReader();
const writer = writable.getWriter();

function printPacket(packet: mqtt.AllPacket) {
  if (packet.type === mqtt.ControlPacketType.Disconnect) {
    console.log(
      mqtt.ControlPacketType[packet.type],
      mqtt
        .DisconnectReasonCode[
          packet.reason_code ??
            mqtt.DisconnectReasonCode.Normal_disconnection
        ],
      packet,
    );
  } else {
    console.log(mqtt.ControlPacketType[packet.type], packet);
  }
}

function printPacket2(
  msg: ReadableStreamDefaultReadResult<mqtt.AllPacket>,
) {
  if (msg.done) {
    console.log("Done");
    return;
  }
  printPacket(msg.value);
}

const w = new mqtt.Writer();
const conMsg = mqtt.serializeConnectPacket(
  {
    /*client_id: asClientID("fisch")*/
    keepalive: 60 as mqtt.Seconds,
    will: {
      topic: mqtt.asTopic("hi"),
    },
  },
  w,
);
// await
writer.write(conMsg);

printPacket2(await reader.read());

const subMsg = mqtt.serializeSubscribePacket({
  packet_identifier: 2000 as mqtt.PacketIdentifier,
  subscriptions: [{ topic: mqtt.asTopicFilter("#") }],
}, w);
writer.write(subMsg);

printPacket2(await reader.read());

const pubMsg = mqtt.serializePublishPacket({
  topic: mqtt.asTopic("hi"),
  payload: "wie gehts?",
  retain: true,
}, w);
writer.write(pubMsg);

const sleep = async (time: number) =>
  await new Promise((r) => setTimeout(r, time));

await sleep(1000);

const sendPing = async () => {
  while (true) {
    writer.write(mqtt.PingReqMessage);
    await sleep(10000);
  }
};

sendPing();

reader.releaseLock();
for await (const packet of readable) {
  printPacket(packet);
}

console.log("exiting");
connection.close();
