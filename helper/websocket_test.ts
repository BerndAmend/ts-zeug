/**
 * Copyright 2023-2025 Bernd Amend. MIT license.
 */
import { assertRejects } from "@std/assert";
import { streamifyWebSocket } from "./websocket.ts";

Deno.test("DataWriter: buffer does not grow if not allowed", async () => {
  const { writable } = streamifyWebSocket("ws://localhost:54321");

  const writer = writable.getWriter();

  await assertRejects(async () => await writer.write("test"));
});
