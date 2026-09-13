/**
 * Socket utilities for Node.js and Bun environments.
 * Provides Web-standard stream wrappers around Node.js net and tls sockets.
 *
 * @module
 * @license MIT
 * @copyright 2026 Bernd Amend
 */

// Type-only imports are erased at runtime, so importing this module never
// pulls in the Node.js built-ins (important for browser bundles).
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

export type NodeLowLevelConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array | string>;
};

/**
 * Establishes a TCP connection using Node.js/Bun's net module.
 * @param hostname - The destination hostname
 * @param port - The destination port
 * @returns A promise resolving to a WebStream-wrapped socket
 */
export async function connectTcp(
  hostname: string,
  port: number,
): Promise<NodeLowLevelConnection> {
  const { default: net } = await import("node:net");
  const { promise, resolve, reject } = Promise.withResolvers<
    NodeLowLevelConnection
  >();
  const socket = net.connect({ host: hostname, port }, () => {
    resolve(wrapSocket(socket));
  });
  socket.on("error", reject);
  return promise;
}

/**
 * Establishes a TLS connection using Node.js/Bun's tls module.
 * @param hostname - The destination hostname
 * @param port - The destination port
 * @returns A promise resolving to a WebStream-wrapped socket
 */
export async function connectTls(
  hostname: string,
  port: number,
): Promise<NodeLowLevelConnection> {
  const { default: tls } = await import("node:tls");
  const { promise, resolve, reject } = Promise.withResolvers<
    NodeLowLevelConnection
  >();
  const socket = tls.connect({ host: hostname, port }, () => {
    resolve(wrapSocket(socket));
  });
  socket.on("error", reject);
  return promise;
}

/**
 * Wraps a Node.js socket into Web-standard Readable and Writable streams.
 * @param socket - The Node.js socket instance
 * @returns An object containing the wrapped streams
 */
function wrapSocket(
  socket: Socket | TLSSocket,
): NodeLowLevelConnection {
  const readable = new ReadableStream({
    start(controller) {
      socket.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
      socket.on("end", () => controller.close());
      socket.on("error", (err: Error) => controller.error(err));
    },
    cancel() {
      socket.destroy();
    },
  });

  const writable = new WritableStream({
    write(chunk: Uint8Array | string) {
      return new Promise((resolve, reject) => {
        socket.write(chunk, (err) => {
          if (err) reject(Error.isError(err) ? err : new Error(String(err)));
          else resolve();
        });
      });
    },
    close() {
      socket.end();
    },
  });

  return { readable, writable };
}
