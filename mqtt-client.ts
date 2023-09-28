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
import { protocol } from "./mqtt/mod.ts";
import { DataReader } from "./helper/mod.ts";
import { writeAll } from "https://deno.land/std@0.140.0/streams/conversion.ts";

// const wss = new WebSocketStream("ws://localhost:1884");
// const { readable, writable } = await wss.connection;
// const reader = readable.getReader();
// const writer = writable.getWriter();

// const w = new Writer();
// await writer.write(
//   serializeConnectPacket({ type: ControlPacketType.Connect }, w),
// );
// console.log(await reader.read());

const conn = await Deno.connect({
  hostname: "127.0.0.1",
  port: 1883,
  transport: "tcp",
});

conn.setNoDelay(true);

const w = new protocol.Writer();
const conMsg = protocol.serializeConnectPacket(
  {
    /*client_id: asClientID("fisch")*/
    keepalive: 60 as protocol.Seconds,
    will: {
      topic: protocol.asTopic("hi"),
    },
  },
  w,
);
await conn.write(conMsg);

const buf = new Uint8Array(65000);
async function readAndPrint() {
  const len = await conn.read(buf);
  if (len === null) {
    return null;
  }
  if (len === 0) {
    return;
  }
  const reader = new DataReader(buf.subarray(0, len ?? 0));
  // TODO: handle incomplete message
  const fixedHeader = protocol.readFixedHeader(reader);
  const packet = protocol.deserializePacket(
    fixedHeader,
    reader,
  );
  if (packet.type === protocol.ControlPacketType.Disconnect) {
    console.log(
      protocol.ControlPacketType[packet.type],
      protocol
        .DisconnectReasonCode[
          packet.reason_code ??
            protocol.DisconnectReasonCode.Normal_disconnection
        ],
      packet,
    );
  } else {
    console.log(protocol.ControlPacketType[packet.type], packet);
  }
  return packet;
}

await readAndPrint();

const subMsg = protocol.serializeSubscribePacket({
  packet_identifier: 2000 as protocol.PacketIdentifier,
  subscriptions: [{ topic: protocol.asTopicFilter("#") }],
}, w);
await writeAll(conn, subMsg);

await readAndPrint();

const pubMsg = protocol.serializePublishPacket({
  topic: protocol.asTopic("hi"),
  payload: "wie gehts?",
  retain: true,
}, w);
await writeAll(conn, pubMsg);

const sleep = async (time: number) =>
  await new Promise((r) => setTimeout(r, time));

await sleep(1000);

const sendPing = async () => {
  while (true) {
    await writeAll(conn, protocol.PingReqMessage);
    await sleep(10000);
  }
};

sendPing();

while (true) {
  const packet = await readAndPrint();
  if (packet === null) {
    break;
  }
  if (packet === undefined) {
    continue;
  }
}

console.log("exiting");
conn.close();
