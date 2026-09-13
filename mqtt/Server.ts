/**
 * MQTT 5.0 broker implementation built on top of the existing packet layer.
 * Don't use this in production; it is a reference implementation for testing.
 *
 * Features:
 *   • TCP (mqtt://) and TLS (mqtts://) listeners
 *   • WebSocket (ws://, wss://) listeners
 *   • CONNECT → CONNACK handshake
 *   • PUBLISH (QoS 0 & QoS 1) with fan‑out
 *   • SUBSCRIBE / UNSUBSCRIBE with automatic SubAck / UnsubAck
 *   • PingReq / PingResp keep‑alive
 *   • Graceful disconnect via DISCONNECT or socket close
 *   • Topic Alias (bidirectional)
 *   • Retained Messages
 *   • Last Will
 *   • Authentication
 *   • Shared Subscriptions ($share/group/filter)
 *   • Wildcard Subscriptions (+, #)
 *
 * @module
 * @license MIT
 * @copyright 2023-2026 Bernd Amend
 */
import { DataReader, delay } from "../helper/mod.ts";
import { WebSocketSink, WebSocketSource } from "../helper/websocket.ts";
import {
  type AllPacket,
  asTopicFilter,
  type ClientID,
  type ConnAckPacket,
  type ConnectPacket,
  ConnectReasonCode,
  ControlPacketType,
  type DisconnectPacket,
  DisconnectReasonCode,
  type PacketIdentifier,
  type PubAckPacket,
  type PublishPacket,
  QoS,
  RetainHandling,
  type Seconds,
  type SubAckPacket,
  SubAckReasonCode,
  type SubscribePacket,
  type Topic,
  type TopicFilter,
  type UnsubAckPacket,
  UnsubAckReasonCode,
  type UnsubscribePacket,
} from "./packets.ts";

import {
  type MakeSerializePacketType,
  PingRespMessage,
  serializeConnAckPacket,
  serializeDisconnectPacket,
  serializePubAckPacket,
  serializePublishPacket,
  serializeSubAckPacket,
  serializeUnsubAckPacket,
  Writer,
} from "./serialize.ts";

import { DeserializeStream } from "./DeserializeStream.ts";
import { TopicAliasMapper } from "./TopicAliasMapper.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Deno WebSocket into readable / writable streams. */
function wsToStreams(ws: WebSocket): {
  readable: ReadableStream<string | Uint8Array>;
  writable: WritableStream<string | ArrayBufferLike | Blob | ArrayBufferView>;
} {
  ws.binaryType = "arraybuffer";
  return {
    readable: new ReadableStream(new WebSocketSource(ws)),
    writable: new WritableStream(new WebSocketSink(ws)),
  };
}

// ---------------------------------------------------------------------------
// AuthHandler
// ---------------------------------------------------------------------------

/**
 * Called for every CONNECT packet to decide whether a client may connect.
 */
export interface AuthHandler {
  /**
   * Authenticates an incoming client.
   * @param connect - The CONNECT packet sent by the client.
   * @returns The reason code to send in the CONNACK. Return
   *          {@link ConnectReasonCode.Success} to accept the connection.
   */
  authenticate(
    connect: ConnectPacket,
  ): Promise<{ reason: ConnectReasonCode }>;
}

class NoAuthHandler implements AuthHandler {
  // deno-lint-ignore require-await
  async authenticate(_connect: ConnectPacket) {
    return { reason: ConnectReasonCode.Success };
  }
}

// ---------------------------------------------------------------------------
// RetainedMessages
// ---------------------------------------------------------------------------

/** In-memory store for retained messages, keyed by topic. */
class RetainedMessages {
  readonly #store = new Map<Topic, PublishPacket>();

  /** Stores or (for an empty payload) deletes the retained message. */
  set(packet: PublishPacket): void {
    if (
      packet.payload === undefined ||
      (typeof packet.payload === "string" && packet.payload.length === 0) ||
      (packet.payload instanceof Uint8Array && packet.payload.length === 0) ||
      (packet.payload instanceof DataReader && packet.payload.byteLength === 0)
    ) {
      this.#store.delete(packet.topic);
    } else {
      this.#store.set(packet.topic, packet);
    }
  }

  /** Returns the retained message for an exact topic, if any. */
  get(topic: Topic): PublishPacket | undefined {
    return this.#store.get(topic);
  }

  /** Returns all retained messages whose topic matches the given filter. */
  match(filter: TopicFilter): PublishPacket[] {
    const results: PublishPacket[] = [];
    for (const packet of this.#store.values()) {
      if (topicMatchesFilter(packet.topic, filter)) {
        results.push(packet);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// SubscriptionTable — topic trie with wildcard + shared subscription support
// ---------------------------------------------------------------------------

/** One level of the subscription trie. */
class TrieNode {
  children = new Map<string, TrieNode>();
  /** Clients whose subscription filter ends exactly at this node. */
  subscribers: BrokerClient[] = [];
  /** Subscription identifiers per subscriber (parallel array). */
  subscriptionIds: (number | undefined)[] = [];
  /** QoS per subscriber. */
  qosLevels: QoS[] = [];
  /** no_local per subscriber. */
  noLocalFlags: boolean[] = [];
  /** retain_as_published per subscriber. */
  retainAsPublishedFlags: boolean[] = [];
  /**
   * For shared subscriptions: the SharedGroup a subscriber slot belongs to,
   * or undefined for a regular subscription.
   */
  sharedGroups: (SharedGroup | undefined)[] = [];
}

/** Members of a single `$share/{group}/{filter}` subscription group. */
class SharedGroup {
  clients: BrokerClient[] = [];
  #next = 0;
  /** Per‑member parameters, parallel to {@link clients}. */
  subParams: SubParams[] = [];
  /**
   * Round‑robin selection: returns the next member and its parameters.
   */
  nextWithParams(): { client: BrokerClient; subParams: SubParams } | undefined {
    if (this.clients.length === 0) return undefined;
    const idx = this.#next;
    this.#next = (this.#next + 1) % this.clients.length;
    return {
      client: this.clients[idx]!,
      subParams: this.subParams[idx] ?? SUB_DEFAULTS,
    };
  }
  remove(client: BrokerClient): void {
    const idx = this.clients.indexOf(client);
    if (idx !== -1) {
      this.clients.splice(idx, 1);
      this.subParams.splice(idx, 1);
    }
    if (this.#next >= this.clients.length) this.#next = 0;
  }
}

interface SubParams {
  qos: QoS;
  subscriptionId?: number;
  noLocal: boolean;
  retainAsPublished: boolean;
}
const SUB_DEFAULTS: SubParams = {
  qos: QoS.At_most_once_delivery,
  noLocal: false,
  retainAsPublished: false,
};

/** Topic trie mapping subscription filters to their subscribers. */
class SubscriptionTable {
  readonly root = new TrieNode();
  readonly #shared = new Map<string, Map<string, SharedGroup>>();
  // groupName → filter → SharedGroup

  /** Returns the SharedGroup for a group/filter pair, creating it if needed. */
  #sharedGroup(group: string, filter: string): SharedGroup {
    let groups = this.#shared.get(group);
    if (!groups) {
      groups = new Map();
      this.#shared.set(group, groups);
    }
    let sg = groups.get(filter);
    if (!sg) {
      sg = new SharedGroup();
      groups.set(filter, sg);
    }
    return sg;
  }

  /**
   * Adds or updates a subscription for a client.
   * Handles both regular filters and `$share/{group}/{filter}` shared
   * subscriptions.
   * @returns The SubAck reason code plus whether the subscription is new.
   */
  subscribe(
    filter: TopicFilter,
    client: BrokerClient,
    qos: QoS,
    subscriptionId?: number,
    noLocal = false,
    retainHandling =
      RetainHandling.Send_retained_messages_at_the_time_of_the_subscribe,
    retainAsPublished = false,
  ): { code: SubAckReasonCode; isNew: boolean } {
    // Shared subscriptions: $share/{group}/{filter}
    if (filter.startsWith("$share/")) {
      const rest = filter.slice(7);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        return { code: SubAckReasonCode.Topic_Filter_invalid, isNew: false };
      }
      const group = rest.slice(0, slash);
      const realFilter = rest.slice(slash + 1);
      const sg = this.#sharedGroup(group, realFilter);

      const wasInGroup = sg.clients.includes(client);
      sg.remove(client);
      sg.clients.push(client);
      sg.subParams.push({
        qos,
        subscriptionId,
        noLocal,
        retainAsPublished,
      });
      client.sharedSubscriptions.push({ group, filter: realFilter, qos });

      this.#addToTrie(
        asTopicFilter(realFilter),
        client,
        qos,
        subscriptionId,
        noLocal,
        retainAsPublished,
        sg,
      );
      return { code: qos as unknown as SubAckReasonCode, isNew: !wasInGroup };
    }

    const isNew = !client.exactSubscriptions.some((s) => s.filter === filter);
    this.#addToTrie(
      filter,
      client,
      qos,
      subscriptionId,
      noLocal,
      retainAsPublished,
    );
    client.exactSubscriptions.push({
      filter,
      qos,
      noLocal,
      retainHandling,
      retainAsPublished,
    });
    return { code: qos as unknown as SubAckReasonCode, isNew };
  }

  #addToTrie(
    filter: TopicFilter,
    client: BrokerClient,
    qos: QoS,
    subscriptionId?: number,
    noLocal = false,
    retainAsPublished = false,
    sharedGroup?: SharedGroup,
  ): void {
    let node = this.root;
    let start = 0;
    for (let i = 0; i <= filter.length; i++) {
      if (i === filter.length || filter.charCodeAt(i) === 0x2F) {
        const level = filter.slice(start, i);
        let child = node.children.get(level);
        if (!child) {
          child = new TrieNode();
          node.children.set(level, child);
        }
        node = child;
        start = i + 1;
      }
    }
    // Don't add the same client twice; a client may hold both a regular
    // and a shared subscription on the same filter, so match on the slot.
    const idx = node.subscribers.findIndex((subscriber, i) => {
      if (subscriber !== client) return false;
      if (sharedGroup === undefined) {
        return node.sharedGroups[i] === undefined;
      }
      return node.sharedGroups[i] === sharedGroup;
    });
    if (idx === -1) {
      node.subscribers.push(client);
      node.subscriptionIds.push(subscriptionId);
      node.qosLevels.push(qos);
      node.noLocalFlags.push(noLocal);
      node.retainAsPublishedFlags.push(retainAsPublished);
      node.sharedGroups.push(sharedGroup);
    } else {
      node.subscriptionIds[idx] = subscriptionId;
      node.qosLevels[idx] = qos;
      node.noLocalFlags[idx] = noLocal;
      node.retainAsPublishedFlags[idx] = retainAsPublished;
      node.sharedGroups[idx] = sharedGroup;
    }
  }

  /** Removes a subscription (regular or shared) for a client. */
  unsubscribe(filter: TopicFilter, client: BrokerClient): void {
    // Handle shared subscriptions
    if (filter.startsWith("$share/")) {
      const rest = filter.slice(7);
      const slash = rest.indexOf("/");
      if (slash === -1) return;
      const group = rest.slice(0, slash);
      const realFilter = rest.slice(slash + 1);
      const groups = this.#shared.get(group);
      let sg: SharedGroup | undefined;
      if (groups) {
        sg = groups.get(realFilter);
        if (sg) {
          sg.remove(client);
          if (sg.clients.length === 0) groups.delete(realFilter);
        }
        if (groups.size === 0) this.#shared.delete(group);
      }
      this.#removeFromTrie(asTopicFilter(realFilter), client, sg ?? null);
      client.sharedSubscriptions = client.sharedSubscriptions.filter(
        (s) => !(s.group === group && s.filter === realFilter),
      );
    } else {
      this.#removeFromTrie(filter, client);
      client.exactSubscriptions = client.exactSubscriptions.filter(
        (s) => s.filter !== filter,
      );
    }
  }

  /**
   * Removes a subscriber slot from the trie.
   * @param sharedGroup - `undefined` matches a regular slot, `null` matches any
   *   shared slot and a {@link SharedGroup} matches that specific shared slot.
   */
  #removeFromTrie(
    filter: TopicFilter,
    client: BrokerClient,
    sharedGroup?: SharedGroup | null,
  ): void {
    let node: TrieNode | undefined = this.root;
    let start = 0;
    const path: TrieNode[] = [node];
    for (let i = 0; i <= filter.length; i++) {
      if (i === filter.length || filter.charCodeAt(i) === 0x2F) {
        const level = filter.slice(start, i);
        node = node?.children.get(level);
        if (!node) return;
        path.push(node);
        start = i + 1;
      }
    }
    const leaf = path[path.length - 1]!;
    const idx = leaf.subscribers.findIndex((subscriber, i) => {
      if (subscriber !== client) return false;
      const slotSharedGroup = leaf.sharedGroups[i];
      if (sharedGroup === undefined) return slotSharedGroup === undefined;
      if (sharedGroup === null) return slotSharedGroup !== undefined;
      return slotSharedGroup === sharedGroup;
    });
    if (idx !== -1) {
      leaf.subscribers.splice(idx, 1);
      leaf.subscriptionIds.splice(idx, 1);
      leaf.qosLevels.splice(idx, 1);
      leaf.noLocalFlags.splice(idx, 1);
      leaf.retainAsPublishedFlags.splice(idx, 1);
      leaf.sharedGroups.splice(idx, 1);
    }
  }

  /** Removes every subscription of a client. */
  unsubscribeAll(client: BrokerClient): void {
    for (const s of client.exactSubscriptions) {
      this.#removeFromTrie(s.filter, client);
    }
    for (const s of client.sharedSubscriptions) {
      const groups = this.#shared.get(s.group);
      const sg = groups?.get(s.filter);
      this.#removeFromTrie(asTopicFilter(s.filter), client, sg ?? null);
      if (groups && sg) {
        sg.remove(client);
        if (sg.clients.length === 0) groups.delete(s.filter);
      }
      if (groups && groups.size === 0) this.#shared.delete(s.group);
    }
    client.exactSubscriptions = [];
    client.sharedSubscriptions = [];
  }

  /**
   * Callback-based matching — zero allocation for result collection.
   * Calls `cb` for every subscriber whose filter matches the topic.
   * Regular subscriptions are delivered for each matching subscriber; shared
   * subscriptions ($share/{group}/{filter}) deliver exactly one random member
   * of the group per message, chosen round‑robin.
   */
  match(
    topic: Topic,
    publisher: BrokerClient,
    cb: (
      client: BrokerClient,
      subscriptionIds: number[],
      qos: QoS,
      noLocal: boolean,
      retainAsPublished: boolean,
    ) => void,
  ): void {
    // Distinct shared groups reachable for this topic, collected while walking
    // the trie. Each is delivered exactly once (one message per group).
    const sharedSeen = new Set<SharedGroup>();
    const sharedPending: SharedGroup[] = [];

    this.#matchNode(
      this.root,
      topic,
      0,
      publisher,
      cb,
      sharedSeen,
      sharedPending,
    );

    for (const sg of sharedPending) {
      const selection = sg.nextWithParams();
      if (!selection) continue;
      const { client, subParams } = selection;
      cb(
        client,
        subParams.subscriptionId !== undefined
          ? [subParams.subscriptionId]
          : [],
        subParams.qos,
        subParams.noLocal,
        subParams.retainAsPublished,
      );
    }
  }

  #matchNode(
    node: TrieNode,
    topic: Topic,
    levelStart: number,
    _publisher: BrokerClient,
    cb: (
      client: BrokerClient,
      subscriptionIds: number[],
      qos: QoS,
      noLocal: boolean,
      retainAsPublished: boolean,
    ) => void,
    sharedSeen: Set<SharedGroup>,
    sharedPending: SharedGroup[],
  ): void {
    // # wildcard — matches all remaining levels
    const hashNode = node.children.get("#");
    if (hashNode) {
      this.#deliverNodeSlots(
        hashNode,
        topic,
        0,
        cb,
        sharedSeen,
        sharedPending,
        true,
        true,
      );
    }

    if (levelStart >= topic.length) {
      this.#deliverNodeSlots(
        node,
        topic,
        0,
        cb,
        sharedSeen,
        sharedPending,
        false,
        false,
      );
      return;
    }

    // Find the end of the current level
    let levelEnd = levelStart;
    while (levelEnd < topic.length && topic.charCodeAt(levelEnd) !== 0x2F) {
      levelEnd++;
    }

    const level = topic.slice(levelStart, levelEnd);
    const nextStart = levelEnd < topic.length ? levelEnd + 1 : topic.length;

    // Exact match
    const exact = node.children.get(level);
    if (exact) {
      this.#matchNode(
        exact,
        topic,
        nextStart,
        _publisher,
        cb,
        sharedSeen,
        sharedPending,
      );
    }

    // + wildcard — matches exactly one level
    const plus = node.children.get("+");
    if (plus) {
      this.#matchNode(
        plus,
        topic,
        nextStart,
        _publisher,
        cb,
        sharedSeen,
        sharedPending,
      );
    }
  }

  /**
   * Deliver the subscribers stored at a single trie node.
   * Regular subscribers are delivered immediately; shared subscribers are
   * recorded (deduplicated by group) so the caller delivers each group once
   * via round‑robin.
   */
  #deliverNodeSlots(
    node: TrieNode,
    _topic: Topic,
    _levelStart: number,
    cb: (
      client: BrokerClient,
      subscriptionIds: number[],
      qos: QoS,
      noLocal: boolean,
      retainAsPublished: boolean,
    ) => void,
    sharedSeen: Set<SharedGroup>,
    sharedPending: SharedGroup[],
    _hash: boolean,
    _endOfTopic: boolean,
  ): void {
    for (let i = 0; i < node.subscribers.length; i++) {
      const client = node.subscribers[i]!;
      const sg = node.sharedGroups[i];
      if (sg !== undefined) {
        // noLocal filtering is done in the callback; record the group once
        if (!sharedSeen.has(sg)) {
          sharedSeen.add(sg);
          sharedPending.push(sg);
        }
        continue;
      }

      const sid = node.subscriptionIds[i];
      cb(
        client,
        sid !== undefined ? [sid] : [],
        node.qosLevels[i]!,
        node.noLocalFlags[i] ?? false,
        node.retainAsPublishedFlags[i] ?? false,
      );
    }
  }

  /**
   * For shared subscriptions: picks one client round‑robin and calls cb.
   * Returns undefined if the shared group is empty.
   */
  deliverShared(
    group: string,
    filter: string,
    cb: (
      client: BrokerClient,
      subscriptionIds: number[],
      qos: QoS,
      noLocal: boolean,
      retainAsPublished: boolean,
    ) => void,
  ): void {
    const groups = this.#shared.get(group);
    if (!groups) return;
    const sg = groups.get(filter);
    if (!sg) return;
    const selection = sg.nextWithParams();
    if (!selection) return;
    const { client, subParams } = selection;
    cb(
      client,
      subParams.subscriptionId !== undefined ? [subParams.subscriptionId] : [],
      subParams.qos,
      subParams.noLocal,
      subParams.retainAsPublished,
    );
  }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/** A persisted client session. */
interface Session {
  clientId: ClientID;
  subscriptions: Array<{ filter: TopicFilter; qos: QoS }>;
  expiry: number; // timestamp in ms
}

/** Stores sessions for clients requesting a non-zero session expiry. */
class SessionStore {
  readonly #sessions = new Map<ClientID, Session>();
  #expiryTimer?: ReturnType<typeof setInterval>;

  save(
    clientId: ClientID,
    subscriptions: Array<{ filter: TopicFilter; qos: QoS }>,
    sessionExpiryInterval: Seconds,
  ): void {
    if (sessionExpiryInterval === 0) return;
    const session: Session = {
      clientId,
      subscriptions,
      expiry: Date.now() + sessionExpiryInterval * 1000,
    };
    this.#sessions.set(clientId, session);
  }

  load(clientId: ClientID): Session | undefined {
    const session = this.#sessions.get(clientId);
    if (!session) return undefined;
    if (Date.now() > session.expiry) {
      this.#sessions.delete(clientId);
      return undefined;
    }
    return session;
  }

  remove(clientId: ClientID): void {
    this.#sessions.delete(clientId);
  }

  startExpiry(): void {
    if (this.#expiryTimer) return;
    this.#expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.#sessions) {
        if (now > session.expiry) {
          this.#sessions.delete(id);
        }
      }
    }, 60_000);
  }

  stopExpiry(): void {
    if (this.#expiryTimer) {
      clearInterval(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// BrokerClient — per‑connection state
// ---------------------------------------------------------------------------

/** A transport-level connection before the CONNECT handshake completed. */
interface Connection {
  readable: ReadableStream<AllPacket>;
  writable: WritableStream<string | ArrayBufferLike | Blob | ArrayBufferView>;
  remoteAddr?: Deno.NetAddr;
}

/** Per-connection broker state and helpers. */
class BrokerClient {
  id!: ClientID;
  readonly writer = new Writer();
  #writableWriter?: WritableStreamDefaultWriter;
  #writableIsOpen = true;

  // CONNECT state
  cleanStart = true;
  keepAlive: Seconds = 60 as Seconds;
  receiveMaximum = 65535;
  maximumPacketSize = 0;
  sessionExpiryInterval: Seconds = 0 as Seconds;
  remoteAddr?: Deno.NetAddr;

  // Topic alias — server → client (outgoing)
  readonly outgoingAliasMapper = new TopicAliasMapper();

  // Topic alias — client → server (incoming, resolved in processPacket)
  incomingAliasToTopic = new Map<number, Topic>();
  clientAliasMaximum = 0;

  // Outgoing packet identifier allocation (per-connection, 1..65535)
  #nextPacketIdentifier = 0;

  allocatePacketIdentifier(): PacketIdentifier {
    this.#nextPacketIdentifier = (this.#nextPacketIdentifier % 65535) + 1;
    return this.#nextPacketIdentifier as PacketIdentifier;
  }

  // Will
  will?: {
    topic: Topic;
    payload?: Uint8Array | string | DataReader;
    qos: QoS;
    retain: boolean;
    delay: Seconds;
    properties?: PublishPacket["properties"];
  };

  // Subscriptions (for cleanup — accessed by SubscriptionTable)
  exactSubscriptions: Array<
    {
      filter: TopicFilter;
      qos: QoS;
      noLocal?: boolean;
      retainHandling?: RetainHandling;
      retainAsPublished?: boolean;
    }
  > = [];
  sharedSubscriptions: Array<{ group: string; filter: string; qos: QoS }> = [];

  // Keep-alive
  lastPingReceived = Date.now();
  #keepAliveTimer?: ReturnType<typeof setInterval>;

  // Disconnect reason for will execution
  disconnectReason?: DisconnectReasonCode;

  constructor(writableWriter: WritableStreamDefaultWriter) {
    this.#writableWriter = writableWriter;
  }

  /** Send a serialized packet. */
  async send(packet: AllPacket): Promise<void> {
    if (!this.#writableIsOpen || !this.#writableWriter) return;
    try {
      const bytes = serializePacket(packet, this.writer);
      await this.#writableWriter.write(bytes);
    } catch {
      this.#writableIsOpen = false;
    }
  }

  /** Send raw bytes (for pre‑serialized fan‑out). */
  async sendRaw(bytes: Uint8Array): Promise<void> {
    if (!this.#writableIsOpen || !this.#writableWriter) return;
    try {
      await this.#writableWriter.write(bytes);
    } catch {
      this.#writableIsOpen = false;
    }
  }

  /** Start keep‑alive monitoring. Returns false if keepAlive is 0 (disabled). */
  startKeepAlive(onTimeout: () => void): boolean {
    const ka = this.keepAlive;
    if (!ka || ka === 0) return false;
    this.lastPingReceived = Date.now();
    const interval = ka * 1000 * 1.5;
    this.#keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastPingReceived > interval) {
        onTimeout();
      }
    }, ka * 500);
    return true;
  }

  stopKeepAlive(): void {
    if (this.#keepAliveTimer) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  /** Prepare topic alias overrides for an outgoing publish to this client. */
  prepareServerPublish(
    topic: Topic,
  ): { topic?: Topic; topic_alias?: number } | undefined {
    const overrides = this.outgoingAliasMapper.preparePublish(topic);
    if (overrides?.topic === "") {
      return { topic: "" as Topic, topic_alias: overrides.topic_alias };
    }
    return overrides as { topic?: Topic; topic_alias?: number } | undefined;
  }

  async close(): Promise<void> {
    this.stopKeepAlive();
    if (this.#writableWriter) {
      try {
        await this.#writableWriter.close();
      } catch {
        // stream may already be closed
      }
      try {
        this.#writableWriter.releaseLock();
      } catch {
        // lock may already be released
      }
      this.#writableWriter = undefined;
    }
    this.#writableIsOpen = false;
  }

  // read() removed — the caller manages its own reader
}

// ---------------------------------------------------------------------------
// Helper: serialize dispatch (avoids exporting every function)
// ---------------------------------------------------------------------------

function serializePacket(packet: AllPacket, w: Writer): Uint8Array {
  switch (packet.type) {
    case ControlPacketType.ConnAck:
      return serializeConnAckPacket(packet, w);
    case ControlPacketType.Publish:
      return serializePublishPacket(packet, w);
    case ControlPacketType.PubAck:
      return serializePubAckPacket(packet, w);
    case ControlPacketType.SubAck:
      return serializeSubAckPacket(packet, w);
    case ControlPacketType.UnsubAck:
      return serializeUnsubAckPacket(packet, w);
    case ControlPacketType.Disconnect:
      return serializeDisconnectPacket(packet, w);
    default:
      throw new Error(`serializePacket: unhandled type ${packet.type}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: topic‑matches‑filter (for retained messages)
// ---------------------------------------------------------------------------

function topicMatchesFilter(topic: Topic, filter: TopicFilter): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");

  let fi = 0;
  let ti = 0;
  while (fi < filterLevels.length) {
    const level = filterLevels[fi]!;
    if (level === "#") {
      // Multi-level wildcard: matches the parent level plus any number of
      // child levels (including zero), so it always matches the remainder.
      return true;
    }
    if (level === "+") {
      // Single-level wildcard: matches exactly one topic level.
      if (ti >= topicLevels.length) return false;
      ti++;
      fi++;
      continue;
    }
    if (ti >= topicLevels.length || topicLevels[ti] !== level) {
      return false;
    }
    ti++;
    fi++;
  }
  return ti === topicLevels.length;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Optional authentication handler (defaults to accept-all). */
  authHandler?: AuthHandler;
  /** TLS certificate and key for mqtts:// / tls:// listeners. */
  tls?: {
    cert: string;
    key: string;
  };
  /** Server-side topic alias maximum (default: 16). */
  topicAliasMaximum?: number;
  /** Server reference string (included in ConnAck and shutdown Disconnect). */
  serverReference?: string;
}

/**
 * An in-process MQTT 5.0 broker.
 *
 * Listens on one or more URLs (`mqtt://`, `mqtts://`, `ws://`, `wss://`),
 * accepts clients, routes PUBLISH packets to matching subscribers and manages
 * retained messages, last wills, sessions and topic aliases.
 *
 * @example
 * ```ts
 * await using server = new Server("mqtt://0.0.0.0:1883");
 * server.listen();
 * ```
 */
export class Server implements AsyncDisposable {
  /** Currently connected clients, keyed by their client id. */
  readonly clients = new Map<ClientID, BrokerClient>();
  /** Topic trie including wildcard and shared subscriptions. */
  readonly subscriptions = new SubscriptionTable();
  /** Retained messages keyed by topic. */
  readonly retained = new RetainedMessages();
  /** Persistent sessions for clients using a non-zero session expiry. */
  readonly sessions = new SessionStore();
  readonly #addresses: URL[];
  readonly #authHandler: AuthHandler;
  readonly #tlsOptions?: { cert: string; key: string };
  readonly #topicAliasMaximum: number;
  readonly #serverReference?: string;

  #active = false;
  #listeners: (Deno.Listener | Deno.HttpServer)[] = [];
  #connectionTimeouts: ReturnType<typeof setTimeout>[] = [];
  #verbose = false;
  #maximumQoS: QoS = QoS.At_least_once_delivery;

  /**
   * @param address  Single URL like "mqtt://0.0.0.0:1883", or a list of URLs
   *                 for multi-protocol listening.
   * @param options  Optional configuration (auth, TLS, topic alias maximum)
   */
  constructor(
    address: URL | string | (URL | string)[],
    options?: ServerOptions | AuthHandler,
  ) {
    const raw = Array.isArray(address) ? address : [address];
    this.#addresses = raw.map((a) => typeof a === "string" ? new URL(a) : a);

    if (
      options && typeof (options as AuthHandler).authenticate === "function"
    ) {
      this.#authHandler = options as AuthHandler;
      this.#tlsOptions = undefined;
      this.#topicAliasMaximum = 16;
      this.#serverReference = undefined;
    } else {
      const opts = (options ?? {}) as ServerOptions;
      this.#authHandler = opts.authHandler ?? new NoAuthHandler();
      this.#tlsOptions = opts.tls;
      this.#topicAliasMaximum = opts.topicAliasMaximum ?? 16;
      this.#serverReference = opts.serverReference;
    }
  }

  /** Enable verbose logging: received packets and dispatch decisions. */
  set verbose(v: boolean) {
    this.#verbose = v;
  }
  get verbose(): boolean {
    return this.#verbose;
  }

  /** Returns the ports this server is listening on. Only available after `listen()`. */
  get ports(): number[] {
    return this.#listeners.map((l) => {
      if ("addr" in l && l.addr && "port" in l.addr) {
        return (l.addr as Deno.NetAddr).port;
      }
      return 0;
    });
  }

  /** Start listening for incoming connections on all configured addresses. */
  listen(): void {
    if (this.#active) throw new Error("Server already listening");
    this.#active = true;
    this.sessions.startExpiry();

    for (const addr of this.#addresses) {
      const { protocol, hostname, port: rawPort } = addr;

      if (protocol === "mqtt:" || protocol === "tcp:") {
        const listener = Deno.listen({
          hostname,
          port: Number(rawPort || 1883),
        });
        this.#listeners.push(listener);
        void this.#acceptTcp(listener, hostname);
      } else if (protocol === "mqtts:" || protocol === "tls:") {
        if (!this.#tlsOptions?.cert || !this.#tlsOptions?.key) {
          throw new Error(
            "TLS listeners require cert and key in ServerOptions.tls",
          );
        }
        const listener = Deno.listenTls({
          hostname,
          port: Number(rawPort || 8883),
          cert: this.#tlsOptions.cert,
          key: this.#tlsOptions.key,
        });
        this.#listeners.push(listener);
        void this.#acceptTcp(listener, hostname);
      } else if (protocol === "ws:" || protocol === "wss:") {
        const port = Number(rawPort || (protocol === "wss:" ? 443 : 80));
        const server = Deno.serve({ hostname, port }, (req) => {
          if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("not a websocket", { status: 400 });
          }
          const { socket, response } = Deno.upgradeWebSocket(req, {
            protocol: "mqtt",
          });
          void this.#handleWebSocket(socket);
          return response;
        });
        this.#listeners.push(server);
      } else {
        throw new Error(`Unsupported protocol ${protocol}`);
      }
    }
  }

  async #acceptTcp(
    listener: Deno.Listener,
    _hostname: string,
  ): Promise<void> {
    for await (const conn of listener) {
      if (!this.#active) break;
      try {
        if ("setNoDelay" in conn) (conn as Deno.TcpConn).setNoDelay(true);
      } catch {
        // ignore
      }
      void this.#handleRawConnection({
        readable: conn.readable as unknown as ReadableStream<Uint8Array>,
        writable: conn.writable,
        remoteAddr: conn.remoteAddr as Deno.NetAddr,
      }, "tcp");
    }
  }

  async #handleWebSocket(ws: WebSocket): Promise<void> {
    const raw = wsToStreams(ws);
    const ts = new TransformStream<Uint8Array, AllPacket>(
      new DeserializeStream(),
    );
    const conn: Connection = {
      readable: raw.readable.pipeThrough(
        ts as unknown as TransformStream<string | Uint8Array, AllPacket>,
      ) as ReadableStream<AllPacket>,
      writable: raw.writable,
    };
    await this.#handleConnection(conn, "ws");
  }

  async #handleRawConnection(
    raw: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      remoteAddr?: Deno.NetAddr;
    },
    transport: "tcp" | "tls",
  ): Promise<void> {
    // Pipe through DeserializeStream
    const ts = new TransformStream<Uint8Array, AllPacket>(
      new DeserializeStream(),
    );

    const conn: Connection = {
      readable: raw.readable.pipeThrough(ts),
      writable: raw.writable as unknown as WritableStream<
        string | ArrayBufferLike | Blob | ArrayBufferView
      >,
      remoteAddr: raw.remoteAddr,
    };

    await this.#handleConnection(conn, transport);
  }

  async #handleConnection(
    conn: Connection,
    transport: "tcp" | "tls" | "ws",
  ): Promise<void> {
    // Lock writable first, then readable (must be before BrokerClient)
    const writableWriter = conn.writable.getWriter();
    await writableWriter.ready;
    const reader = (conn.readable as ReadableStream<AllPacket>).getReader();

    const client = new BrokerClient(writableWriter);
    client.remoteAddr = conn.remoteAddr;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      // Read CONNECT
      let handshakeDone = false;
      timeoutId = setTimeout(() => {
        if (!handshakeDone) {
          client.close().catch(() => {});
        }
      }, 10_000);
      this.#connectionTimeouts.push(timeoutId);

      // Wait for CONNECT
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) {
          clearTimeout(timeoutId);
          this.#removeConnectionTimeout(timeoutId);
          writableWriter.releaseLock();
          reader.releaseLock();
          return;
        }
        if (value.type === ControlPacketType.Connect) {
          clearTimeout(timeoutId);
          this.#removeConnectionTimeout(timeoutId);
          handshakeDone = true;
          await this.#handleConnect(value, client, transport, reader);
          return;
        }
      }
    } catch (e: unknown) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        this.#removeConnectionTimeout(timeoutId);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("protocol_version")) {
        console.error(`[broker] client sent unsupported protocol version`);
        try {
          // Respond with CONNACK before closing
          const connAck = serializeConnAckPacket({
            connect_reason_code: ConnectReasonCode.Unsupported_Protocol_Version,
          }, client.writer);
          await writableWriter.write(connAck);
        } catch { /* ignore */ }
      } else {
        console.error(
          `[broker] handshake error: ${msg}`,
        );
      }
      try {
        reader.releaseLock();
        await client.close();
      } catch { /* ignore */ }
    }
  }

  #removeConnectionTimeout(id: ReturnType<typeof setTimeout>): void {
    const idx = this.#connectionTimeouts.indexOf(id);
    if (idx !== -1) this.#connectionTimeouts.splice(idx, 1);
  }

  async #handleConnect(
    packet: ConnectPacket,
    client: BrokerClient,
    _transport: "tcp" | "tls" | "ws",
    reader: ReadableStreamDefaultReader<AllPacket>,
  ): Promise<void> {
    // Authenticate
    const authResult = await this.#authHandler.authenticate(packet);
    if (authResult.reason !== ConnectReasonCode.Success) {
      const connAck: ConnAckPacket = {
        type: ControlPacketType.ConnAck,
        connect_reason_code: authResult.reason,
      };
      await client.send(connAck);
      await client.close();
      return;
    }

    // Determine client ID
    let clientId: ClientID;
    if (packet.client_id && packet.client_id.length > 0) {
      clientId = packet.client_id;
    } else {
      // Generate a unique ID
      clientId = crypto.randomUUID() as ClientID;
    }

    // Check for existing session
    const cleanStart = packet.clean_start ?? true;
    let sessionPresent = false;

    if (!cleanStart) {
      const session = this.sessions.load(clientId);
      if (session) {
        sessionPresent = true;
        // Re-subscribe saved subscriptions
        for (const sub of session.subscriptions) {
          this.subscriptions.subscribe(sub.filter, client, sub.qos);
        }
      }
    }

    if (cleanStart && packet.client_id) {
      // Remove any previous session and disconnect old client
      const existing = this.clients.get(clientId);
      if (existing) {
        existing.disconnectReason = DisconnectReasonCode.Session_taken_over;
        try {
          await existing.close();
        } catch {
          // ignore
        }
      }
      this.sessions.remove(clientId);
    }

    client.id = clientId;

    // Store CONNECT properties
    client.cleanStart = cleanStart;
    client.keepAlive = packet.keepalive ?? (60 as Seconds);
    client.receiveMaximum = packet.properties?.receive_maximum ?? 65535;
    client.maximumPacketSize = packet.properties?.maximum_packet_size ?? 0;
    client.sessionExpiryInterval = packet.properties?.session_expiry_interval ??
      (0 as Seconds);
    client.clientAliasMaximum = packet.properties?.topic_alias_maximum ?? 0;

    // Apply client's maximum_packet_size to the writer
    if (client.maximumPacketSize > 0) {
      client.writer.maximumPacketSize = client.maximumPacketSize;
    }

    // Store will
    if (packet.will) {
      client.will = {
        topic: packet.will.topic,
        payload: packet.will.payload,
        qos: packet.will.qos ?? QoS.At_most_once_delivery,
        retain: packet.will.retain ?? false,
        delay: packet.will.properties?.will_delay_interval ??
          (0 as Seconds),
        properties: packet.will.properties as PublishPacket["properties"],
      };
    }

    // Build and send ConnAck
    const serverAliasMax = this.#topicAliasMaximum;
    client.outgoingAliasMapper.maximum = serverAliasMax;

    const connAck: ConnAckPacket = {
      type: ControlPacketType.ConnAck,
      session_present: sessionPresent,
      connect_reason_code: ConnectReasonCode.Success,
      properties: {
        topic_alias_maximum: serverAliasMax,
        receive_maximum: 65535,
        maximum_packet_size: 0,
        maximum_QoS: this.#maximumQoS,
        retain_available: true,
        wildcard_subscription_available: true,
        subscription_identifiers_available: true,
        shared_subscription_available: true,
        server_keep_alive: client.keepAlive,
        session_expiry_interval: client.sessionExpiryInterval > 0
          ? client.sessionExpiryInterval
          : undefined,
        response_information:
          packet.properties?.request_response_information === true
            ? (this.#serverReference ?? "ts-zeug MQTT 5.0 broker")
            : undefined,
      },
    };

    // If client didn't provide a client_id, assign one
    if (!packet.client_id || packet.client_id.length === 0) {
      connAck.properties!.assigned_client_id = clientId;
    }

    await client.send(connAck);
    this.clients.set(clientId, client);

    const remoteIp = client.remoteAddr?.hostname ?? "unknown";
    const user = packet.username ?? "anonymous";
    console.error(
      `[broker] client ${clientId} connected from ${remoteIp} user=${user}`,
    );

    // Start keep-alive
    client.startKeepAlive(() => {
      void (async () => {
        await this.#disconnectClient(
          client,
          DisconnectReasonCode.Keep_Alive_timeout,
        );
      })();
    });

    // Main packet processing loop
    try {
      while (this.#active) {
        // If the client was disconnected by a previous packet, exit cleanly
        if (!this.clients.has(client.id)) break;

        const { done, value } = await reader.read();
        if (done || !value) break;

        await this.#processPacket(value, client);
      }
    } catch (e: unknown) {
      // connection lost
      if (e instanceof Error && e.message !== "connection closed") {
        console.error(`[broker] ${client.id} error: ${e.message}`);
      }
    } finally {
      reader.releaseLock();
      await this.#disconnectClient(client, client.disconnectReason);
    }
  }

  async #processPacket(
    packet: AllPacket,
    client: BrokerClient,
  ): Promise<void> {
    switch (packet.type) {
      case ControlPacketType.Publish: {
        let pub = packet as PublishPacket;
        if (this.#verbose) {
          const plen = typeof pub.payload === "string"
            ? pub.payload.length
            : pub.payload instanceof DataReader
            ? pub.payload.byteLength
            : pub.payload instanceof Uint8Array
            ? pub.payload.length
            : 0;
          console.error(
            `[verbose] recv ${client.id} → ${pub.topic}` +
              ` q${pub.qos ?? 0}${pub.retain ? " retain" : ""}` +
              (plen ? ` (${plen}B)` : ""),
          );
        }

        // Resolve and register topic alias if present
        if (pub.properties?.topic_alias) {
          const alias = pub.properties.topic_alias;
          // Validate alias against client's declared maximum
          if (
            client.clientAliasMaximum > 0 && alias > client.clientAliasMaximum
          ) {
            const disc: DisconnectPacket = {
              type: ControlPacketType.Disconnect,
              reason_code: DisconnectReasonCode.Protocol_Error,
              properties: { reason_string: "Topic Alias exceeds maximum" },
            };
            await client.send(disc);
            await this.#disconnectClient(
              client,
              DisconnectReasonCode.Protocol_Error,
            );
            return;
          }
          if (pub.topic === "" as Topic) {
            // Alias-only publish — resolve from stored mapping
            const resolved = client.incomingAliasToTopic.get(alias);
            if (resolved) {
              pub = { ...pub, topic: resolved };
            }
          } else {
            // First occurrence — store the mapping
            client.incomingAliasToTopic.set(alias, pub.topic);
          }
        }

        // Retained message handling
        if (packet.retain) {
          this.retained.set(pub);
        }

        const qos = pub.qos ?? QoS.At_most_once_delivery;

        // This broker only supports QoS 0 and QoS 1. A PUBLISH with a higher
        // QoS is rejected with QoS not supported (0x9B).
        if (qos > this.#maximumQoS) {
          const disc: DisconnectPacket = {
            type: ControlPacketType.Disconnect,
            reason_code: DisconnectReasonCode.QoS_not_supported,
          };
          await client.send(disc);
          await this.#disconnectClient(
            client,
            DisconnectReasonCode.QoS_not_supported,
          );
          return;
        }

        // QoS 0 — fire and forget
        if (qos === QoS.At_most_once_delivery) {
          this.#dispatchPublish(pub, client);
          break;
        }

        // QoS 1 — send PubAck, then dispatch
        if (pub.packet_identifier !== undefined) {
          const pubAck: PubAckPacket = {
            type: ControlPacketType.PubAck,
            packet_identifier: pub.packet_identifier,
            reason_code: 0,
          };
          await client.send(pubAck);
        }
        this.#dispatchPublish(pub, client);
        break;
      }

      case ControlPacketType.Subscribe: {
        const sub = packet as SubscribePacket;
        if (this.#verbose) {
          console.error(
            `[verbose] recv ${client.id} subscribe ${
              sub.subscriptions.map((s) => s.topic).join(", ")
            }`,
          );
        }
        const reasonCodes: SubAckReasonCode[] = [];
        const isNewSubscriptions: boolean[] = [];

        for (const s of sub.subscriptions) {
          const granted = Math.min(
            s.qos ?? QoS.At_most_once_delivery,
            this.#maximumQoS,
          ) as QoS;
          const result = this.subscriptions.subscribe(
            s.topic,
            client,
            granted,
            sub.properties?.subscription_identifier,
            s.no_local ?? false,
            s.retain_handling ??
              RetainHandling
                .Send_retained_messages_at_the_time_of_the_subscribe,
            s.retain_as_published ?? false,
          );
          reasonCodes.push(result.code);
          isNewSubscriptions.push(result.isNew);
        }

        const subAck: SubAckPacket = {
          type: ControlPacketType.SubAck,
          packet_identifier: sub.packet_identifier,
          reason_codes: reasonCodes,
        };
        await client.send(subAck);

        // Send retained messages matching the subscriptions
        for (let i = 0; i < sub.subscriptions.length; i++) {
          const s = sub.subscriptions[i]!;
          const rh = s.retain_handling ??
            RetainHandling.Send_retained_messages_at_the_time_of_the_subscribe;
          if (
            rh ===
              RetainHandling
                .Do_not_send_retained_messages_at_the_time_of_the_subscribe
          ) {
            continue;
          }
          if (
            rh ===
              RetainHandling
                .Send_retained_messages_at_subscribe_only_if_the_subscription_does_not_currently_exist &&
            !isNewSubscriptions[i]!
          ) {
            continue;
          }
          const retaineds = this.retained.match(s.topic);
          for (const r of retaineds) {
            const qos = Math.min(
              r.qos ?? QoS.At_most_once_delivery,
              s.qos ?? QoS.At_most_once_delivery,
            ) as QoS;
            const overrides = client.prepareServerPublish(r.topic);
            const forward: PublishPacket = {
              ...r,
              qos,
              retain: s.retain_as_published ? true : (r.retain ?? false),
              dup: false,
              packet_identifier: qos === QoS.At_most_once_delivery
                ? undefined
                : client.allocatePacketIdentifier(),
            };
            const bytes = serializePublishPacket(
              forward,
              client.writer,
              overrides,
            );
            await client.sendRaw(bytes);
          }
        }
        break;
      }

      case ControlPacketType.Unsubscribe: {
        const unsub = packet as UnsubscribePacket;
        if (this.#verbose) {
          console.error(
            `[verbose] recv ${client.id} unsubscribe ${
              unsub.topic_filters.join(", ")
            }`,
          );
        }
        for (const f of unsub.topic_filters) {
          this.subscriptions.unsubscribe(f, client);
        }
        const unsubAck: UnsubAckPacket = {
          type: ControlPacketType.UnsubAck,
          packet_identifier: unsub.packet_identifier,
          reason_codes: unsub.topic_filters.map(() =>
            UnsubAckReasonCode.Success
          ),
        };
        await client.send(unsubAck);
        break;
      }

      case ControlPacketType.PingReq: {
        client.lastPingReceived = Date.now();
        await client.sendRaw(PingRespMessage);
        break;
      }

      case ControlPacketType.Connect: {
        // [MQTT-3.1.0-2] A second CONNECT is a Protocol Error.
        const disc: DisconnectPacket = {
          type: ControlPacketType.Disconnect,
          reason_code: DisconnectReasonCode.Protocol_Error,
          properties: { reason_string: "Second CONNECT packet" },
        };
        await client.send(disc);
        await this.#disconnectClient(
          client,
          DisconnectReasonCode.Protocol_Error,
        );
        break;
      }

      case ControlPacketType.Disconnect: {
        const disc = packet as DisconnectPacket;
        client.disconnectReason = disc.reason_code ??
          DisconnectReasonCode.Normal_disconnection;
        if (
          client.disconnectReason ===
            DisconnectReasonCode.Disconnect_with_Will_Message
        ) {
          await this.#executeWill(client);
        }
        await this.#disconnectClient(client, client.disconnectReason);
        break;
      }

      default:
        // Ignore other packets
        break;
    }
  }

  /**
   * Fan-out dispatch. Each subscriber gets a correctly-formed PUBLISH:
   * per-connection packet identifier for QoS > 0, proper retain flag based on
   * retain_as_published, and the subscription identifiers of the matching
   * subscription(s).
   */
  #dispatchPublish(pub: PublishPacket, publisher: BrokerClient): void {
    this.subscriptions.match(
      pub.topic,
      publisher,
      (client, subscriptionIds, qos, noLocal, retainAsPublished) => {
        if (noLocal && publisher === client) return;

        const effectiveQos = Math.min(
          pub.qos ?? QoS.At_most_once_delivery,
          qos,
        ) as QoS;

        const pkt: MakeSerializePacketType<PublishPacket> = {
          topic: pub.topic,
          payload: pub.payload,
          qos: effectiveQos,
          retain: retainAsPublished ? (pub.retain ?? false) : false,
          dup: false,
          packet_identifier: effectiveQos === QoS.At_most_once_delivery
            ? undefined
            : client.allocatePacketIdentifier(),
          properties: {
            ...pub.properties,
            subscription_identifier: subscriptionIds.length > 0
              ? subscriptionIds
              : undefined,
          },
        };

        const overrides = client.prepareServerPublish(pub.topic);
        const bytes = serializePublishPacket(pkt, client.writer, overrides);
        if (this.#verbose) {
          console.error(
            `[verbose] send ${publisher.id}→${client.id} ${pub.topic}`,
          );
        }
        client.sendRaw(bytes).catch(() => {});
      },
    );
  }

  async #disconnectClient(
    client: BrokerClient,
    reasonCode?: DisconnectReasonCode,
  ): Promise<void> {
    // Avoid double-disconnect (called from DISCONNECT handler + finally block)
    if (!this.clients.has(client.id)) return;

    const reason = reasonCode !== undefined
      ? `reason=${DisconnectReasonCode[reasonCode] ?? reasonCode}`
      : "";
    const remoteIp = client.remoteAddr?.hostname ?? "unknown";
    console.error(
      `[broker] client ${client.id} disconnected from ${remoteIp} ${reason}`,
    );
    this.clients.delete(client.id);

    // Execute will on unexpected disconnect
    if (
      reasonCode !== DisconnectReasonCode.Normal_disconnection &&
      reasonCode !== DisconnectReasonCode.Disconnect_with_Will_Message
    ) {
      await this.#executeWill(client);
    }

    // Save session
    if (client.sessionExpiryInterval > 0) {
      const subs: Array<{ filter: TopicFilter; qos: QoS }> = [
        ...client.exactSubscriptions.map((s) => ({
          filter: s.filter,
          qos: s.qos,
        })),
        ...client.sharedSubscriptions.map((s) => ({
          filter: asTopicFilter(`$share/${s.group}/${s.filter}`),
          qos: s.qos,
        })),
      ];
      if (subs.length > 0) {
        this.sessions.save(client.id, subs, client.sessionExpiryInterval);
      }
    }

    this.subscriptions.unsubscribeAll(client);
    client.stopKeepAlive();
    await client.close();
  }

  async #executeWill(client: BrokerClient): Promise<void> {
    if (!client.will) return;

    const will = client.will;

    if (will.delay > 0) {
      await delay(will.delay * 1000);
    }

    // Don't execute if the client already reconnected with a new session
    if (this.clients.get(client.id) !== client) return;

    const willPacket: PublishPacket = {
      type: ControlPacketType.Publish,
      topic: will.topic,
      payload: will.payload,
      qos: will.qos,
      retain: will.retain,
      properties: will.properties,
    };

    if (will.retain) {
      this.retained.set(willPacket);
    }

    this.#dispatchPublish(willPacket, client);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#active = false;
    this.sessions.stopExpiry();

    for (const listener of this.#listeners) {
      try {
        if ("shutdown" in listener) {
          await (listener as Deno.HttpServer).shutdown();
        } else if ("close" in listener) {
          (listener as Deno.Listener).close();
        }
      } catch {
        // ignore
      }
    }
    this.#listeners = [];

    for (const [, client] of this.clients) {
      try {
        const disc: DisconnectPacket = {
          type: ControlPacketType.Disconnect,
          reason_code: DisconnectReasonCode.Server_shutting_down,
          properties: this.#serverReference
            ? { server_reference: this.#serverReference }
            : undefined,
        };
        await client.send(disc);
        await client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    for (const id of this.#connectionTimeouts) {
      clearTimeout(id);
    }
    this.#connectionTimeouts = [];
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  import("@std/cli/parse-args").then(({ parseArgs }) => {
    const args = parseArgs(Deno.args, {
      string: ["host", "protocol", "cert", "key"],
      boolean: ["help", "verbose"],
      collect: ["listen"] as const,
      default: {
        host: "0.0.0.0",
        protocol: "mqtt",
      },
      alias: {
        port: "p",
        host: "h",
        help: "H",
        listen: "l",
        verbose: "v",
      },
    });

    if (args.help) {
      console.log(`MQTT 5.0 Broker

Usage: deno run --allow-net mqtt/Server.ts [options]

Options:
  -l, --listen <url>      Listen address (can be repeated).
                           Example: --listen mqtt://0.0.0.0:1883 --listen ws://0.0.0.0:8080
  -p, --port <port>       Port for single-protocol mode (default: depends on protocol)
  -h, --host <host>       Host to bind to (default: 0.0.0.0)
  --protocol <protocol>   mqtt | mqtts | ws | wss (default: mqtt).
                           Ignored when --listen is used.
  -H, --help              Show this help
  -v, --verbose           Log received packets, subscription changes, and dispatch decisions`);
      Deno.exit(0);
    }

    let addresses: string[];

    if (args.listen && args.listen.length > 0) {
      addresses = args.listen as string[];
    } else {
      const protocol = args.protocol;
      const host = args.host;
      const port = typeof args.port === "string"
        ? parseInt(args.port)
        : args.port ?? (
          protocol === "mqtts"
            ? 8883
            : protocol === "ws"
            ? 8080
            : protocol === "wss"
            ? 443
            : 1883
        );
      addresses = [`${protocol}://${host}:${port}`];
    }

    console.log(
      `Starting MQTT broker on:\n${addresses.map((a) => `  ${a}`).join("\n")}`,
    );
    const broker = new Server(addresses);
    broker.verbose = !!args.verbose;
    broker.listen();
    console.log("Broker running. Press Ctrl+C to stop.");

    const shutdown = () => {
      console.log("\nShutting down...");
      broker[Symbol.asyncDispose]().then(() => Deno.exit(0), (e: unknown) => {
        console.error("Shutdown error:", e);
        Deno.exit(1);
      });
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);
  }).catch((e: unknown) => {
    console.error("Failed to start broker:", e);
    Deno.exit(1);
  });
}
