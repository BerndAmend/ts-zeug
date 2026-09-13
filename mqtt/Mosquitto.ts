/**
 * Helper to spawn and manage an external Mosquitto broker.
 * Used by the integration tests to run against a real MQTT implementation.
 *
 * @module
 * @license MIT
 * @copyright 2023-2026 Bernd Amend
 */

/**
 * Manages a local `mosquitto` process started with a generated configuration.
 * The broker listens for plain MQTT on {@link port} and for MQTT over
 * WebSockets on `port + 1`, allowing clients, wildcards and retained messages
 * to be tested against a reference implementation.
 *
 * @example
 * ```ts
 * await using mosquitto = new Mosquitto();
 * await mosquitto.start();
 * ```
 */
export class Mosquitto {
  /**
   * Creates a new Mosquitto manager.
   * @param port - Port for the plain MQTT listener (default: 1883)
   * @param brokerBindAddress - Optional bind address for the listeners
   */
  constructor(
    public port: number = 1883,
    public brokerBindAddress: string = "",
  ) {
  }

  /** Stops the broker if it is running. */
  async [Symbol.asyncDispose]() {
    await this.stop();
  }

  async #writeMosquittoConfig() {
    const config = `persistent_client_expiration 1d
set_tcp_nodelay true
max_packet_size 16777216
allow_anonymous true
max_queued_messages 10000

listener ${this.port} ${this.brokerBindAddress}
protocol mqtt

listener ${this.port + 1} ${this.brokerBindAddress}
protocol websockets
`;
    await Deno.writeTextFile(this.#configFilename, config);
  }

  #startProcess() {
    const command = new Deno.Command("mosquitto", {
      args: [
        "-c",
        this.#configFilename,
      ],
      stdin: "piped",
      stdout: "piped",
    });
    this.#child = command.spawn();
  }

  /** Writes the generated configuration and spawns the mosquitto process. */
  async start() {
    if (this.#child) {
      throw new Error("mosquitto was already started");
    }

    await this.#writeMosquittoConfig();
    this.#startProcess();
  }

  /** Terminates the broker process and waits for it to exit. */
  async stop() {
    if (this.#child) {
      await this.#child.stdout.cancel();
      await this.#child.stdin.close();
      try {
        this.#child.kill();
      } catch {
        // The process may already have exited.
      }
      await this.#child.status;
      this.#child = undefined;
    }
  }

  #configFilename = Deno.makeTempFileSync({ suffix: ".conf" });
  #child: Deno.ChildProcess | undefined;
}
