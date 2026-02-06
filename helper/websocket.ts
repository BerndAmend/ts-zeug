/**
 * Copyright 2023-2025 Bernd Amend. BSD-3 license.
 * For environments that don't have a WebSocketStream we use the implementation from https://streams.spec.whatwg.org/#example-both
 */
export function streamifyWebSocket(
  url: string | URL,
  protocols?: string | string[],
) {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = "arraybuffer";

  return {
    readable: new ReadableStream(new WebSocketSource(ws)),
    writable: new WritableStream(new WebSocketSink(ws)),
  };
}

export class WebSocketSource {
  private _ws: WebSocket;
  constructor(ws: WebSocket) {
    this._ws = ws;
  }

  start(controller: ReadableStreamDefaultController) {
    this._ws.onmessage = (event) => controller.enqueue(event.data);
    const onClose = () => controller.close();
    this._ws.addEventListener("close", onClose, {
      once: true,
    });

    this._ws.addEventListener("error", () => {
      this._ws.removeEventListener("close", onClose);
      controller.error(new Error("The WebSocket errored!"));
    });
  }

  cancel() {
    this._ws.close();
  }
}

export class WebSocketSink {
  private _ws: WebSocket;
  constructor(ws: WebSocket) {
    this._ws = ws;
  }

  start(controller: WritableStreamDefaultController): Promise<void> {
    this._ws.addEventListener("close", () => {
      controller.error(
        new Error("The server closed the connection unexpectedly!"),
      );
    }, { once: true });
    this._ws.addEventListener("error", () => {
      controller.error(new Error("The WebSocket errored!"));
    });

    if (this._ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this._ws.removeEventListener("open", onOpen);
        this._ws.removeEventListener("error", onError);
        this._ws.removeEventListener("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The WebSocket errored!"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("The connection was closed!"));
      };

      this._ws.addEventListener("open", onOpen);
      this._ws.addEventListener("error", onError);
      this._ws.addEventListener("close", onClose);
    });
  }

  write(chunk: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this._ws.send(chunk);
  }

  close() {
    return this._closeWS(1000);
  }

  abort(reason?: Error): Promise<void> {
    return this._closeWS(4000, reason && reason.message);
  }

  _closeWS(code?: number, reasonString?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._ws.addEventListener("close", (e) => {
        if (e.wasClean) {
          resolve();
        } else {
          reject(new Error("The connection was not closed cleanly"));
        }
      }, { once: true });
      this._ws.close(code, reasonString);
    });
  }
}
