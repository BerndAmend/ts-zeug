/**
 * MQTT 5.0 Broker Benchmark
 *
 * Publishes and subscribes on the same connection. Each outgoing message
 * carries its send-timestamp in the payload. On receive, the timestamp is
 * extracted to compute per-message round-trip latency.
 *
 * Usage:
 *   deno run --allow-net examples/mqtt/benchmark.ts
 *   deno run --allow-net examples/mqtt/benchmark.ts --max-inflight 100
 *
 * @license MIT
 * @copyright 2026 Bernd Amend
 */
import { parseArgs } from "@std/cli/parse-args";
import {
  asClientID,
  asTopic,
  asTopicFilter,
  Client,
  ControlPacketType,
  QoS,
} from "../../mqtt/mod.ts";
import type { Milliseconds } from "../../mqtt/packets.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtLat(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 0.001) return `${(ms * 1e6).toFixed(0)}ns`;
  if (ms < 1) return `${(ms * 1e3).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function stats(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { q5: 0, avg: 0, q95: 0, q99: 0 };
  const sum = s.reduce((a, x) => a + x, 0);
  return { q5: pct(s, 5), avg: sum / n, q95: pct(s, 95), q99: pct(s, 99) };
}

// ---------------------------------------------------------------------------
// Payload encoding: first 15 bytes = timestamp as "XXXXXXXXX.XXXXXX"
// Timestamp format: seconds.microseconds (15 chars, zero-padded)
// ---------------------------------------------------------------------------

const TS_LEN = 15;

/** Encode performance.now() as a 15-char string, embed at the start of payload. */
function encodePayload(size: number, ts: number): string {
  const sec = Math.floor(ts / 1000).toString().padStart(9, "0");
  const us = Math.floor((ts % 1000) * 1000).toString().padStart(6, "0");
  const stamp = sec + "." + us;
  const pad = size - TS_LEN;
  return pad > 0 ? stamp + "x".repeat(pad) : stamp.slice(0, size);
}

/** Extract send timestamp from a received payload string. Returns 0 on failure. */
function decodeTimestamp(payload: string): number {
  const stamp = payload.slice(0, TS_LEN);
  const dot = stamp.indexOf(".");
  if (dot !== 9) return 0;
  const sec = parseInt(stamp.slice(0, 9), 10);
  const us = parseInt(stamp.slice(10, 16), 10);
  if (isNaN(sec) || isNaN(us)) return 0;
  return sec * 1000 + us / 1000;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

async function run(
  broker: string,
  payloadSize: number,
  durationSec: number,
  qos: QoS,
  maxInflight: number,
) {
  const topic = `b/${crypto.randomUUID().slice(0, 6)}`;
  const client = new Client(broker, {
    client_id: asClientID(`b-${crypto.randomUUID().slice(0, 6)}`),
  }, { reconnectTime: 100 as Milliseconds });

  // Wait for ConnAck
  const reader = client.readable.getReader();
  const dl = Date.now() + 10_000;
  while (Date.now() < dl) {
    const { done, value } = await reader.read();
    if (done) throw new Error("conn closed before ConnAck");
    if (!value) continue;
    if (value.type === ControlPacketType.ConnAck) break;
    if ((value as { type: number }).type >= 100) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Subscribe
  await client.subscribe({
    subscriptions: [{ topic: asTopicFilter(topic), qos }],
  });

  // Shared state
  const latencies: number[] = [];
  const sendTimes: number[] = [];
  const recvTimes: number[] = [];
  let inflight = 0;
  let stop = false;

  // Receive loop
  const recvDone = (async () => {
    while (!stop || inflight > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.type === ControlPacketType.Publish) {
        const recv = performance.now();
        const payload = typeof value.payload === "string"
          ? value.payload
          : value.payload instanceof Uint8Array
          ? new TextDecoder().decode(value.payload)
          : "";
        const send = decodeTimestamp(payload);
        if (send > 0) {
          latencies.push(recv - send);
          recvTimes.push(recv);
        }
        inflight--;
      }
    }
  })();

  // Publish loop
  const end = performance.now() + durationSec * 1000;
  while (performance.now() < end) {
    if (maxInflight > 0) {
      while (inflight >= maxInflight) await 0;
    }
    const ts = performance.now();
    inflight++;
    try {
      await client.publish(
        {
          topic: asTopic(topic),
          payload: encodePayload(Math.max(payloadSize, TS_LEN), ts),
          qos,
        } as Parameters<Client["publish"]>[0],
      );
      sendTimes.push(ts);
    } catch {
      inflight--;
    }
  }

  stop = true;
  await recvDone.catch(() => {});
  reader.releaseLock();
  await client.close().catch(() => {});

  // Compute stats
  const lStats = stats(latencies);
  const wall = recvTimes.length >= 2
    ? recvTimes[recvTimes.length - 1]! - recvTimes[0]!
    : 0;

  const rates: number[] = [];
  const tputs: number[] = [];
  for (let i = 1; i < recvTimes.length; i++) {
    const dt = recvTimes[i]! - recvTimes[i - 1]!;
    if (dt > 0) {
      rates.push(1 / (dt / 1000));
      tputs.push(payloadSize / (dt / 1000));
    }
  }
  const rStats = stats(rates);
  const tpStats = stats(tputs);
  const overallRate = wall > 0 ? recvTimes.length / (wall / 1000) : 0;
  const overallTput = wall > 0
    ? (recvTimes.length * payloadSize) / (wall / 1000)
    : 0;

  return {
    size: payloadSize,
    sent: sendTimes.length,
    recv: latencies.length,
    msgsPerSec: {
      q5: rStats.q5,
      avg: overallRate,
      q95: rStats.q95,
      q99: rStats.q99,
    },
    throughputBps: {
      q5: tpStats.q5,
      avg: overallTput,
      q95: tpStats.q95,
      q99: tpStats.q99,
    },
    latencyMs: lStats,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["broker", "sizes", "duration", "qos", "max-inflight"],
    boolean: ["help"],
    alias: { broker: "b", help: "h", duration: "d" },
    default: {
      broker: "mqtt://localhost:1883",
      duration: "20",
      "max-inflight": "0",
    },
  });

  if (args.help) {
    console.log(`MQTT Broker Benchmark
  -b, --broker <url>    Broker URL (default: mqtt://localhost:1883)
  -d, --duration <s>    Measurement duration per size (default: 20)
  --max-inflight <n>    Max inflight messages (default: 0 = unlimited)
  --sizes <list>        Comma-separated payload sizes (default: 10..256M)
  --qos <0|1>           QoS level (default: 0)`);
    Deno.exit(0);
  }

  const broker: string = args.broker;
  const dur = Math.max(1, parseInt(args.duration));
  const inflight = Math.max(0, parseInt(args["max-inflight"]));
  const qos = (parseInt(args.qos ?? "0") || 0) as QoS;

  const defaults = [
    10,
    100,
    1_000,
    10_000,
    100_000,
    1_000_000,
    4_000_000,
    16_000_000,
    32_000_000,
    64_000_000,
    128_000_000,
    256_000_000,
  ];
  const sizes: number[] = args.sizes
    ? args.sizes.split(",").map((s: string) => parseInt(s.trim()))
    : defaults;

  console.log(
    `Benchmark: ${broker}  |  ${dur}s/size  |  QoS ${qos}  |  inflight=${
      inflight || "∞"
    }`,
  );
  console.log(
    "┌────────────┬───────────┬───────────────────────┬─────────────────────────────┬──────────────────────────────┐",
  );
  console.log(
    "│ Size       │ Msgs (s/r)│ msgs/s (q5│avg│q95│q99)│ throughput (q5│avg│q95│q99) │ latency (q5│avg│q95│q99)    │",
  );
  console.log(
    "├────────────┼───────────┼───────────────────────┼─────────────────────────────┼──────────────────────────────┤",
  );

  for (const size of sizes) {
    // Ensure minimum size for timestamp header
    const effectiveSize = Math.max(size, TS_LEN);
    const r = await run(broker, effectiveSize, dur, qos, inflight);
    const m = r.msgsPerSec;
    const t = r.throughputBps;
    const l = r.latencyMs;

    const msgs = `${fmtNum(m.q5)}│${fmtNum(m.avg)}│${fmtNum(m.q95)}│${
      fmtNum(m.q99)
    }`;
    const tput = `${fmtBytes(t.q5)}/s│${fmtBytes(t.avg)}/s│${
      fmtBytes(t.q95)
    }/s│${fmtBytes(t.q99)}/s`;
    const lat = `${fmtLat(l.q5)}│${fmtLat(l.avg)}│${fmtLat(l.q95)}│${
      fmtLat(l.q99)
    }`;

    console.log(
      `│ ${fmtBytes(size).padEnd(10)} │ ${String(r.sent).padStart(4)}/${
        String(r.recv).padEnd(4)
      } │ ${msgs.padEnd(21)} │ ${tput.padEnd(27)} │ ${lat.padEnd(28)} │`,
    );
  }

  console.log(
    "└────────────┴───────────┴───────────────────────┴─────────────────────────────┴──────────────────────────────┘",
  );
  Deno.exit(0);
}
