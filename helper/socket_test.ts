/**
 * Tests for the Node.js socket transport wrappers.
 */
import { assertStringIncludes } from "@std/assert";
import net from "node:net";
import { connectTcp, connectTls } from "./socket.ts";

Deno.test("connectTcp: connection refused rejects", async () => {
  const err = await connectTcp("127.0.0.1", 1)
    .catch((e: unknown) => e);
  assertStringIncludes(String(err), "ECONNREFUSED");
});

Deno.test("connectTcp: round-trips data through an echo server", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  const { readable, writable } = await connectTcp("127.0.0.1", port);
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode("ping"));

  const reader = readable.getReader();
  const { value, done } = await reader.read();
  assertStringIncludes(new TextDecoder().decode(value!), "ping");
  assertStringIncludes(String(done), "false");

  writer.releaseLock();
  reader.releaseLock();
  await readable.cancel();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => e ? reject(e) : resolve())
  );
});

Deno.test("connectTls: connection refused rejects", async () => {
  const err = await connectTls("127.0.0.1", 1)
    .catch((e: unknown) => e);
  assertStringIncludes(String(err), "ECONNREFUSED");
});
