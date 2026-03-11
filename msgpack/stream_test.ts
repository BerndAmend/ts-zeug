import { assertEquals } from "@std/assert";
import { DeserializerStream, serialize, Serializer } from "./mod.ts";

Deno.test("DeserializerStream - simple messages", async () => {
  const expected = ["hello", 42, { a: 1 }];
  const stream = new ReadableStream({
    start(controller) {
      for (const v of expected) {
        controller.enqueue(serialize(v));
      }
      controller.close();
    },
  });

  const results = await Array.fromAsync(
    stream.pipeThrough(new DeserializerStream()),
  );

  assertEquals(results, expected);
});

Deno.test("DeserializerStream - fragmented messages", async () => {
  const msg1 = serialize("hello world");
  const msg2 = serialize({ foo: "bar", count: 123 });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(msg1.subarray(0, 5));
      controller.enqueue(msg1.subarray(5));
      controller.enqueue(msg2.subarray(0, 2));
      controller.enqueue(msg2.subarray(2, 8));
      controller.enqueue(msg2.subarray(8));
      controller.close();
    },
  });

  const results = await Array.fromAsync(
    stream.pipeThrough(new DeserializerStream()),
  );

  assertEquals(results, ["hello world", { foo: "bar", count: 123 }]);
});

Deno.test("DeserializerStream - multiple messages in one chunk", async () => {
  const expected = [1, 2, 3];
  const serializer = new Serializer();
  for (const v of expected) {
    serializer.addInt(v);
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(serializer.getBufferView());
      controller.close();
    },
  });

  const results = await Array.fromAsync(
    stream.pipeThrough(new DeserializerStream()),
  );

  assertEquals(results, expected);
});

Deno.test("DeserializerStream - large messages", async () => {
  const largeData = new Uint8Array(1024 * 1024).fill(0x42);
  const msg = serialize(largeData);

  // Chunk it into 16KB chunks
  const chunkSize = 16 * 1024;
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < msg.length; i += chunkSize) {
        controller.enqueue(msg.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });

  const results = await Array.fromAsync(
    stream.pipeThrough(new DeserializerStream()),
  );

  assertEquals(results.length, 1);
  assertEquals(results[0], largeData);
});
