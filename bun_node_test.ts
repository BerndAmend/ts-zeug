/**
 * Cross-runtime test harness.
 *
 * Bundles the library and runs a smoke test (see bun_node_test_helper.mjs) under every
 * available JavaScript runtime (Deno, Node, Bun) and, for the WebSocket
 * transport, against the browser bundle.
 *
 * Usage:
 *   deno task test:runtimes
 *   deno run -A bun_node_test.ts
 *
 * Runtimes that are not installed are skipped.
 */

import { Server } from "./mqtt/Server.ts";

const repoRoot = new URL("./", import.meta.url);
const entrypoint = new URL("mod.ts", repoRoot);
const smokePath =
  new URL("./bun_node_test_helper.mjs", import.meta.url).pathname;

type Runtime = { name: string; command: string; args: string[] };

async function findRuntime(
  name: string,
  command: string,
  args: string[],
): Promise<Runtime | undefined> {
  try {
    const status = await new Deno.Command(command, {
      args: [...args, "--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return status.success ? { name, command, args } : undefined;
  } catch {
    return undefined;
  }
}

async function bundle(platform: "deno" | "browser", out: string) {
  const status = await new Deno.Command("deno", {
    args: [
      "bundle",
      `--platform=${platform}`,
      "--quiet",
      "-o",
      out,
      entrypoint.pathname,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!status.success) {
    throw new Error(
      `deno bundle --platform=${platform} failed:\n${
        new TextDecoder().decode(status.stderr)
      }`,
    );
  }
  return new URL(`file://${out}`).href;
}

async function runSmoke(
  runtime: Runtime,
  bundleUrl: string,
  brokerUrl: string,
): Promise<{ ok: boolean; output: string }> {
  const command = new Deno.Command(runtime.command, {
    args: [...runtime.args, smokePath],
    env: {
      TS_ZEUG_BUNDLE: bundleUrl,
      TS_ZEUG_BROKER: brokerUrl,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  const output = decoder.decode(stdout) + decoder.decode(stderr);
  return { ok: code === 0 && output.includes("OK"), output };
}

const runtimes = (
  await Promise.all([
    findRuntime("deno", "deno", ["run", "-A"]),
    findRuntime("node", "node", []),
    findRuntime("bun", "bun", []),
  ])
).filter((r): r is Runtime => r !== undefined);

if (runtimes.length === 0) {
  console.error("No JavaScript runtime found");
  Deno.exit(1);
}

const tempDir = await Deno.makeTempDir({ prefix: "ts-zeug-runtime-" });
let failures = 0;

const server = new Server([
  "mqtt://127.0.0.1:0",
  "ws://127.0.0.1:0",
]);
server.listen();
const mqttPort = server.ports[0]!;
const wsPort = server.ports[1]!;

try {
  const denoBundle = await bundle("deno", `${tempDir}/deno.mjs`);
  const browserBundle = await bundle("browser", `${tempDir}/browser.mjs`);

  // The browser bundle must not statically import Node built-ins.
  const browserSource = await Deno.readTextFile(`${tempDir}/browser.mjs`);
  if (/^\s*import[^\n]*from\s*"node:/m.test(browserSource)) {
    console.error("browser bundle contains a static node: import");
    failures++;
  }

  const transports = [
    { name: "tcp", bundle: denoBundle, broker: `mqtt://127.0.0.1:${mqttPort}` },
    // The browser bundle is imported by a runtime without Deno APIs, which
    // exercises the WebSocket code path used in browsers.
    {
      name: "ws",
      bundle: browserBundle,
      broker: `ws://127.0.0.1:${wsPort}`,
    },
  ];

  for (const runtime of runtimes) {
    for (const transport of transports) {
      const label = `${runtime.name}/${transport.name}`;
      const result = await runSmoke(
        runtime,
        transport.bundle,
        transport.broker,
      );
      if (result.ok) {
        console.log(`ok   ${label}`);
      } else {
        failures++;
        console.error(`FAIL ${label}\n${result.output}`);
      }
    }
  }
} finally {
  await server[Symbol.asyncDispose]();
  await Deno.remove(tempDir, { recursive: true });
}

if (failures > 0) {
  console.error(`\n${failures} runtime test(s) failed`);
  Deno.exit(1);
}
console.log(
  `\nAll runtime tests passed (${runtimes.map((r) => r.name).join(", ")})`,
);
