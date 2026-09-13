/**
 * Cross-runtime integration test.
 *
 * Bundles the library and runs a smoke test (see bun_node_test_helper.mjs)
 * under every available JavaScript runtime (Deno, Node, Bun). The WebSocket
 * transport additionally runs against the browser bundle in a runtime without
 * Deno APIs, which exercises the browser code path.
 *
 * Runtimes that are not installed (or not permitted) are reported as ignored
 * steps, so the test can run with `deno test`. It needs run/read/write/env/net
 * permissions like the rest of the integration tests (use `deno test -A`).
 */

import { assert } from "@std/assert";
import { Server } from "./mqtt/Server.ts";

const entrypoint = new URL("mod.ts", import.meta.url);
const smokePath = new URL("./bun_node_test_helper.mjs", import.meta.url)
  .pathname;

type Runtime = { name: string; command: string; args: string[] };

/** Returns the runtime version, or undefined when it cannot be spawned. */
function runtimeVersion(command: string, args: string[]): string | undefined {
  try {
    const { success, stdout } = new Deno.Command(command, {
      args: [...args, "--version"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!success) return undefined;
    return new TextDecoder().decode(stdout).split("\n")[0]!.trim();
  } catch {
    return undefined;
  }
}

/** Whether subprocesses can be spawned (requires --allow-run). */
const canSpawn = runtimeVersion("deno", []) !== undefined;

const runtimes: { runtime: Runtime; version: string | undefined }[] = [
  {
    runtime: { name: "deno", command: "deno", args: ["run", "-A"] },
    version: runtimeVersion("deno", []),
  },
  {
    runtime: { name: "node", command: "node", args: [] },
    version: runtimeVersion("node", []),
  },
  {
    runtime: { name: "bun", command: "bun", args: [] },
    version: runtimeVersion("bun", []),
  },
];

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

Deno.test({
  name: "cross-runtime: deno, node and bun",
  ignore: !canSpawn,
  async fn(t) {
    const tempDir = await Deno.makeTempDir({ prefix: "ts-zeug-runtime-" });
    const server = new Server(["mqtt://127.0.0.1:0", "ws://127.0.0.1:0"]);
    server.listen();
    const mqttPort = server.ports[0]!;
    const wsPort = server.ports[1]!;

    try {
      const denoBundle = await bundle("deno", `${tempDir}/deno.mjs`);
      const browserBundle = await bundle("browser", `${tempDir}/browser.mjs`);

      await t.step("browser bundle has no static node: imports", async () => {
        const source = await Deno.readTextFile(`${tempDir}/browser.mjs`);
        assert(
          !/^\s*import[^\n]*from\s*"node:/m.test(source),
          "the browser bundle must not statically import Node built-ins",
        );
      });

      const transports = [
        {
          name: "tcp",
          bundle: denoBundle,
          broker: `mqtt://127.0.0.1:${mqttPort}`,
        },
        {
          // The browser bundle is imported by a runtime without Deno APIs,
          // which exercises the WebSocket code path used in browsers.
          name: "ws",
          bundle: browserBundle,
          broker: `ws://127.0.0.1:${wsPort}`,
        },
      ];

      const summary = runtimes
        .map(({ runtime, version }) =>
          version ? `${runtime.name}=${version}` : `${runtime.name}=skipped`
        )
        .join(", ");
      console.log(`cross-runtime runtimes: ${summary}`);

      for (const { runtime, version } of runtimes) {
        for (const transport of transports) {
          await t.step({
            name: `${runtime.name}/${transport.name}`,
            ignore: version === undefined,
            fn: async () => {
              const result = await runSmoke(
                runtime,
                transport.bundle,
                transport.broker,
              );
              assert(
                result.ok,
                `${runtime.name}/${transport.name}:\n${result.output}`,
              );
              // The helper reports which runtime actually executed the bundle.
              assert(
                result.output.includes(`runtime=${runtime.name} version=`),
                `expected the ${runtime.name} runtime to run the bundle:\n${result.output}`,
              );
            },
          });
        }
      }
    } finally {
      await server[Symbol.asyncDispose]();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
