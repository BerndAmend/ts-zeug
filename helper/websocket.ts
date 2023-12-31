// For environments that don't have a WebSocketStream we use the implementation from https://streams.spec.whatwg.org/#example-both
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
    this._ws.onclose = () => controller.close();

    this._ws.addEventListener("error", () => {
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
    this._ws.onclose = () =>
      controller.error(
        new Error("The server closed the connection unexpectedly!"),
      );
    this._ws.addEventListener("error", () => {
      controller.error(new Error("The WebSocket errored!"));
      this._ws.onclose = null;
    });

    return new Promise((resolve) => this._ws.onopen = () => resolve());
  }

  write(chunk: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this._ws.send(chunk);
  }

  close() {
    return this._closeWS(1000);
  }

  abort(reason?: any): Promise<void> {
    return this._closeWS(4000, reason && reason.message);
  }

  _closeWS(code?: number, reasonString?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._ws.onclose = (e) => {
        if (e.wasClean) {
          resolve();
        } else {
          reject(new Error("The connection was not closed cleanly"));
        }
      };
      this._ws.close(code, reasonString);
    });
  }
}
