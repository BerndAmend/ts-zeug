/**
 * Manages MQTT 5.0 Topic Alias mappings with LRU eviction.
 * Shared by both client-side (outgoing PUBLISH) and server-side (fan-out)
 * alias handling.
 *
 * Topic Aliases reduce packet size by substituting the topic string with a
 * small integer once it has been sent at least once on the connection.
 *
 * @module
 * @license MIT
 * @copyright 2026 Bernd Amend
 */

/**
 * Manages outgoing topic aliases for a single MQTT connection.
 *
 * When topic aliases are available (maximum > 0), `preparePublish()` returns
 * an overrides object that should be forwarded to `serializePublishPacket()`.
 * The first publish of a topic includes both the topic and the assigned alias;
 * subsequent publishes include only the alias (with an empty topic string).
 *
 * If all alias slots are in use, the least recently used alias is evicted
 * and reassigned to the new topic.
 */
export class TopicAliasMapper {
  #aliasToTopic = new Map<number, string>();
  #topicToAlias = new Map<string, number>();
  #lru: number[] = [];
  #nextAlias = 1;
  #maximum = 0;

  /** Returns the current topic alias maximum (0 = aliases disabled). */
  get maximum(): number {
    return this.#maximum;
  }

  /**
   * Sets the topic alias maximum and resets all state.
   * Call on every (re-)connect when ConnAck is received.
   */
  set maximum(value: number) {
    this.#maximum = value;
    this.reset();
  }

  /** Resets all alias mappings. */
  reset(): void {
    this.#aliasToTopic.clear();
    this.#topicToAlias.clear();
    this.#lru = [];
    this.#nextAlias = 1;
  }

  /**
   * Prepares topic alias overrides for an outgoing PUBLISH.
   *
   * Uses LRU eviction to maximize alias usage: when all alias slots are full,
   * the least recently used alias is reassigned to the new topic.
   * If the topic already has an alias, an alias-only override (empty topic)
   * is returned.
   *
   * @returns Overrides for `serializePublishPacket`, or `undefined` when
   *          aliases are disabled (`maximum === 0`).
   */
  preparePublish(
    topic: string,
  ): { topic?: string; topic_alias?: number } | undefined {
    if (this.#maximum === 0) return undefined;

    const existingAlias = this.#topicToAlias.get(topic);
    if (existingAlias !== undefined) {
      this.#touchLru(existingAlias);
      return { topic: "", topic_alias: existingAlias };
    }

    let alias = this.#nextAlias;
    if (this.#aliasToTopic.has(alias)) {
      let tries = 0;
      while (
        tries < this.#maximum &&
        this.#aliasToTopic.has(alias)
      ) {
        alias = (alias % this.#maximum) + 1;
        tries++;
      }
      if (tries >= this.#maximum) {
        alias = this.#lru.shift()!;
        const evicted = this.#aliasToTopic.get(alias)!;
        this.#aliasToTopic.delete(alias);
        this.#topicToAlias.delete(evicted);
      }
    }

    this.#aliasToTopic.set(alias, topic);
    this.#topicToAlias.set(topic, alias);
    this.#lru.push(alias);
    this.#nextAlias = (alias % this.#maximum) + 1;

    return { topic_alias: alias };
  }

  /** Moves the given alias to the end of the LRU list. */
  #touchLru(alias: number): void {
    const idx = this.#lru.indexOf(alias);
    if (idx !== -1) this.#lru.splice(idx, 1);
    this.#lru.push(alias);
  }
}
