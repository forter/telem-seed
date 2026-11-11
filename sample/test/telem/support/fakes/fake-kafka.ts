/**
 * Inbound Kafka test driver — calls handleMessage() directly from step definitions,
 * bypassing the real KafkaJS consumer loop.
 *
 * Why reseatKafkaConsumer() (alias initKafkaFake) is needed: consumer.ts holds a module-level `consumer`
 * variable initialised to null. handleMessage() calls consumer!.commitOffsets() at the end —
 * null throws. startConsumer() sets `consumer` to the kafkajs stub's consumer (already in
 * require.cache), whose commitOffsets feeds recordCommitOffsets() below. No real Kafka
 * connection is made. It also runs before every scenario, so module state never leaks between them.
 *
 * Two surfaces, both per scenario:
 *   1. Driver (input): dispatchKafkaMessage() builds the EachMessagePayload KafkaJS would deliver
 *      and records where the message sits (topic, partition, offset). The payload shape is what
 *      handleMessage() branches on (null vs present key/value, offset as a string) — the parity suite
 *      (parity-tests/fake-kafka.parity.ts) compares it with what a real consumer receives from Apache Kafka.
 *   2. Capture (output): every commitOffsets call, one entry per {topic, partition, offset}, failed
 *      attempts included. Owned via takeOwnershipOfCommittedOffsets(scenarioId, topic, partition).
 *      A successful handleMessage() commits offset + 1 of its own message; a failing one (infrastructure
 *      error) never reaches the commit. IO (MySQL, fetch) is owned by fake-db and fake-fetch.
 *
 * Failure injection: fail(scenarioId, 'kafka.commitOffsets', sequence) — the attempt is recorded first,
 * then the failure is thrown, so handleMessage() rejects and KafkaJS would redeliver (at-least-once).
 *
 * A third surface, the consumer LIFECYCLE (subscribe / run / stop), is what POST /api/subscribers sets in
 * motion (subscribeToTopic: stop the running consumer, subscribe the new topic, run again). The stub's
 * consumer is a model of the real KafkaJS 2.2.4 one — createFakeConsumer() below — that:
 *   - throws the REAL errors for the out-of-order calls production could make (subscribing while running,
 *     an illegal topic name, a missing or non-string topic), pinned by the parity suite;
 *   - keeps subscriptions across stop(), like the real consumer (a restart re-joins with every topic);
 *   - records each subscribe / run / stop as an owned effect (takeOwnershipOfSubscriptions,
 *     takeOwnershipOfConsumerRunState) and can be told to fail (kafka.subscribe / kafka.run / kafka.stop);
 *   - takes a macrotask per call, like a broker round trip, so two registrations racing each other
 *     really interleave unless production's subscribeLock serialises them (settleKafkaConsumer() waits
 *     for in-flight calls).
 * The consumer module keeps its state (subscribedTopics, isRunning) at module level; reseatKafkaConsumer()
 * gives every scenario a fresh copy, so what a scenario observes never depends on scenario order.
 */

import path from 'path';
import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _handleMessage: (payload: any) => Promise<void>;

/** Where a message sits in the log. `offset` is a string because KafkaJS delivers it as one (int64). */
export interface KafkaPosition {
  topic: string;
  partition: number;
  offset: string;
}

/** One captured commitOffsets entry. `failed`: the attempt was recorded, then fail() made it throw. */
export interface CommittedOffset extends KafkaPosition {
  failed: boolean;
}

function safeClone<T>(value: T, context: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(
      `[fake-kafka] structuredClone failed in ${context} on value of type ${typeof value}. ` +
        'Probable cause: the value contains non-cloneable members (functions, Symbols). ' +
        'Fix: pass plain data.',
    );
  }
}

// ── Failure injection ───────────────────────────────────────────────────────────
// Same contract as fake-db / fake-fetch: a declared operation name (a typo throws at setup) and a
// per-call sequence of outcomes — an Error/zero-arg factory to throw, or null to succeed — advanced one
// entry per call, the last entry repeating past the end.

// connect is failable so a scenario can drive a failed startup (startConsumer run from a step); disconnect is not:
// production calls it only on shutdown.
export const KAFKA_OPERATIONS = ['kafka.commitOffsets', 'kafka.connect', 'kafka.subscribe', 'kafka.run', 'kafka.stop'] as const;
export type KafkaOperation = (typeof KAFKA_OPERATIONS)[number];

type Outcome = Error | (() => Error) | null;
interface FailState {
  sequence: Outcome[];
  index: number;
}
const failConfig = new Map<string, Map<KafkaOperation, FailState>>();

function assertDeclared(operation: string, caller: string): asserts operation is KafkaOperation {
  if (!(KAFKA_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(
      `[fake-kafka] Unknown operation "${operation}" passed to ${caller}(). ` +
        `Declared operations: ${KAFKA_OPERATIONS.join(', ')}. ` +
        'Fix: use one of the declared operation names (this catches typos at setup).',
    );
  }
}

/**
 * Make a Kafka operation fail for this scenario.
 *
 * @example — the offset commit always fails (broker unreachable):
 * fail(this.scenarioId, 'kafka.commitOffsets', [new Error('broker unreachable')]);
 */
export function fail(scenarioId: string, operation: KafkaOperation, sequence: Outcome[]): void {
  assertDeclared(operation, 'fail');
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-kafka] fail() sequence for "${operation}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(operation, { sequence, index: 0 });
}

/** True while the next call of `operation` is configured to fail (does not advance the sequence). */
export function isConfiguredToFail(scenarioId: string, operation: KafkaOperation): boolean {
  assertDeclared(operation, 'isConfiguredToFail');
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return false;
  return fs.sequence[Math.min(fs.index, fs.sequence.length - 1)] !== null;
}

/** Advance this operation's sequence one step and throw if the current outcome is an error. */
function maybeFail(scenarioId: string, operation: KafkaOperation): void {
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return;
  const o = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  if (o === null) return;
  throw typeof o === 'function' ? o() : o;
}

// ── Offset-commit capture ───────────────────────────────────────────────────────
// The offset commit is an observable IO effect (the at-least-once guarantee), so it goes through the
// ownership model like any other write. Index-set ownership: an entry's position in the log is its id.

const commitLog = new Map<string, CommittedOffset[]>();
const ownedCommits = new Map<string, Set<number>>();

// Messages this scenario dispatched, in order. The commit-ownership auto-default derives what it expects
// to have been committed from this (and only applies to scenarios that dispatched). It is the driver's
// own input record, not captured IO, so it has no ownership.
const dispatched = new Map<string, KafkaPosition[]>();

/**
 * KafkaJS Consumer.commitOffsets, called by the stub consumer (createFakeConsumer). Do not call from step definitions.
 * Documented behaviour reproduced: each `{topic, partition, offset}` is captured as sent (offset a string, int64-exact;
 * the broker keeps the latest per partition, the fake logs every one). Records one entry per offset, THEN lets
 * fail(sid, 'kafka.commitOffsets', [...]) throw, so a failed attempt is accounted for.
 * Provenance: parity-tests/fake-kafka.parity.ts (commit cases).
 */
export function recordCommitOffsets(
  scenarioId: string,
  offsets: ReadonlyArray<{ topic: string; partition: number; offset: string }>,
): void {
  const log = commitLog.get(scenarioId) ?? [];
  commitLog.set(scenarioId, log);
  const start = log.length;
  for (const { topic, partition, offset } of offsets) log.push({ topic, partition, offset, failed: false });
  try {
    maybeFail(scenarioId, 'kafka.commitOffsets');
  } catch (err) {
    for (let i = start; i < log.length; i++) log[i].failed = true;
    throw err;
  }
}

/**
 * Claim every unowned commit entry for (topic, partition), in the order they were made, and return
 * copies. Throws if there is none. Ownership is per partition: a scenario that dispatched on several
 * partitions claims each separately, and any commit nobody claims fails the scenario.
 */
export function takeOwnershipOfCommittedOffsets(scenarioId: string, topic: string, partition: number): CommittedOffset[] {
  const log = commitLog.get(scenarioId) ?? [];
  const owned = ownedCommits.get(scenarioId) ?? new Set<number>();
  ownedCommits.set(scenarioId, owned);

  const claimed: CommittedOffset[] = [];
  log.forEach((entry, i) => {
    if (entry.topic === topic && entry.partition === partition && !owned.has(i)) {
      owned.add(i);
      claimed.push(safeClone(entry, 'takeOwnershipOfCommittedOffsets'));
    }
  });
  if (claimed.length === 0) {
    const unowned = log.filter((_, i) => !owned.has(i));
    throw new Error(
      `[fake-kafka] No unowned offset commit for topic "${topic}" partition ${partition} (scenario: ${scenarioId}). ` +
        `Unowned commits elsewhere: ${unowned.length === 0 ? 'none' : JSON.stringify(unowned).slice(0, 200)}. ` +
        'Probable cause: handleMessage() threw before committing (at-least-once: the message will be redelivered), ' +
        'a different topic/partition was committed, or this commit was already claimed. ' +
        'Fix: if the handler is EXPECTED to throw, use "the Kafka offset should not have been committed" instead.',
    );
  }
  return claimed;
}

/** Messages this scenario dispatched, oldest first (copies). Empty for scenarios that never touched the consumer. */
export function listDispatchedMessages(scenarioId: string): KafkaPosition[] {
  return safeClone(dispatched.get(scenarioId) ?? [], 'listDispatchedMessages');
}

// ── Consumer lifecycle (subscribe / run / stop) ─────────────────────────────────

/**
 * Subscribe / run / stop calls the consumer received, in call order. `failed`: the call threw.
 * A `run` carries the topics the consumer joins its group with (every topic subscribed so far — they survive
 * stop()), which is what the broker's group membership shows for the real consumer.
 */
export type ConsumerLifecycleEntry =
  | { op: 'subscribe'; topic: string; fromBeginning: boolean; failed: boolean }
  | { op: 'run'; groupId: string; topics: string[]; failed: boolean }
  | { op: 'stop'; groupId: string; failed: boolean };

/** What a claimed run / stop entry looks like. */
export type ConsumerRunStateEntry = Extract<ConsumerLifecycleEntry, { op: 'run' | 'stop' }>;

const lifecycleLog = new Map<string, ConsumerLifecycleEntry[]>();
const ownedLifecycle = new Map<string, Set<number>>();

// Same shape as the errors KafkaJS 2.2.4 throws (name, message, retriable, and for protocol errors type/code).
// Not the real classes: `kafkajs` is the stub in this process. The parity suite compares them field by field.
class FakeKafkaJSError extends Error {
  retriable: boolean;
  constructor(name: string, message: string, retriable: boolean) {
    super(message);
    this.name = name;
    this.retriable = retriable;
  }
}
class FakeKafkaJSProtocolError extends FakeKafkaJSError {
  constructor(message: string, readonly type: string, readonly code: number, retriable: boolean) {
    super('KafkaJSProtocolError', message, retriable);
  }
}

/**
 * The broker's topic-name rule (what an INVALID_TOPIC_EXCEPTION answers): letters, digits, '.', '_', '-',
 * at most 249 characters, and not '.' or '..'. A topic that satisfies it is treated as existing on the
 * broker (a legal-but-unknown topic really fails with UNKNOWN_TOPIC_OR_PARTITION after KafkaJS's retries;
 * production registers topics producers already write to). Exported so a scenario's expectation can follow
 * the same rule instead of re-deriving it; the parity suite checks it against a real broker.
 */
export function isLegalKafkaTopicName(topic: string): boolean {
  return topic.length > 0 && topic.length <= 249 && topic !== '.' && topic !== '..' && /^[a-zA-Z0-9._-]+$/.test(topic);
}

/** The consumer group production joins (src/kafka/consumer.ts: `kafka.consumer({ groupId })`). */
export const CONSUMER_GROUP_ID = 'webhooks-platform';

let inFlight = 0;
const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Wait until no stub call is in flight. Calls take a macrotask each and production fires subscribeToTopic
 * without awaiting it, so the POST response can arrive before the consumer is done. Between two stub calls of
 * one chain there are only microtasks, so "nothing in flight at a macrotask boundary" means the chain finished.
 */
export async function settleKafkaConsumer(): Promise<void> {
  while (inFlight > 0) await macrotask();
}

// The return type widens `failed` back to boolean: callers pass the literal `failed: false`, then flip it on a throw.
function recordLifecycle<T extends ConsumerLifecycleEntry>(scenarioId: string, entry: T): Omit<T, 'failed'> & { failed: boolean } {
  const log = lifecycleLog.get(scenarioId) ?? [];
  lifecycleLog.set(scenarioId, log);
  log.push(entry);
  return entry;
}

/** A tracked, latency-bearing consumer call: counts as in flight for settleKafkaConsumer() until it settles. */
async function tracked<T>(body: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await body();
  } finally {
    inFlight--;
  }
}

/**
 * The kafkajs stub's consumer (world.ts: `new Kafka(...).consumer({ groupId })`). One instance per
 * startConsumer(); its state is the real consumer's: connected, running, and the subscribed topics, which
 * survive stop() (probed against KafkaJS 2.2.4: stop → subscribe → run re-joins the group with both topics).
 */
export function createFakeConsumer({ groupId }: { groupId: string }) {
  let running = false;
  const topics = new Map<string, { fromBeginning: boolean }>();

  return {
    /**
     * KafkaJS Consumer.connect. Documented behaviour reproduced: an unreachable broker rejects connect() itself.
     * Not recorded (a connect happens before every scenario, in reseatKafkaConsumer) and no ordering rule is modelled:
     * production never calls subscribe after disconnect. Injection: fail(sid, 'kafka.connect', [...]).
     * Provenance: parity-tests/fake-kafka.parity.ts ("connect to a closed port rejects").
     */
    connect: async (): Promise<void> => maybeFail(currentScenarioId(), 'kafka.connect'),

    /**
     * KafkaJS Consumer.subscribe. Documented behaviour reproduced: client-side refusals first (running consumer,
     * missing or non-string topic: KafkaJSNonRetriableError), then the broker's INVALID_TOPIC_EXCEPTION for an illegal
     * name; a failed subscribe leaves no subscription. Recorded, failed or not. Injection: fail(sid, 'kafka.subscribe', [...]).
     * Provenance: parity-tests/fake-kafka.parity.ts (consumer lifecycle cases).
     */
    subscribe: async ({ topic, topics: many, fromBeginning = false }: { topic?: unknown; topics?: unknown; fromBeginning?: boolean }): Promise<void> => {
      if (many !== undefined) {
        throw new Error(`[fake-kafka] the consumer stub supports subscribe({ topic }) only — production never passes \`topics\`, but got topics=${JSON.stringify(many).slice(0, 200)} (scenario: ${currentScenarioId()}). Probable cause: production now subscribes several topics in one call. Fix: extend createFakeConsumer (and its parity cases).`);
      }
      const sid = currentScenarioId();
      const entry = recordLifecycle(sid, { op: 'subscribe', topic: String(topic), fromBeginning, failed: false });
      return tracked(async () => {
        try {
          // Client-side checks first, in KafkaJS's order — they throw before any broker round trip.
          if (running) throw new FakeKafkaJSError('KafkaJSNonRetriableError', 'Cannot subscribe to topic while consumer is running', false);
          if (!topic) throw new FakeKafkaJSError('KafkaJSNonRetriableError', 'Missing required argument "topics"', false);
          if (typeof topic !== 'string') {
            throw new FakeKafkaJSError('KafkaJSNonRetriableError', `Invalid topic ${String(topic)} (${typeof topic}), the topic name has to be a String or a RegExp`, false);
          }
          await macrotask(); // the metadata round trip
          if (!isLegalKafkaTopicName(topic)) {
            throw new FakeKafkaJSProtocolError('The request attempted to perform an operation on an invalid topic', 'INVALID_TOPIC_EXCEPTION', 17, false);
          }
          maybeFail(sid, 'kafka.subscribe');
          topics.set(topic, { fromBeginning });
        } catch (err) {
          entry.failed = true;
          throw err;
        }
      });
    },

    /**
     * KafkaJS Consumer.run. Documented behaviour reproduced: joins the group with every topic subscribed so far
     * (subscriptions survive stop()); run twice is accepted; "running" is set synchronously. Recorded, failed or not.
     * Injection: fail(sid, 'kafka.run', [...]). Provenance: parity-tests/fake-kafka.parity.ts (consumer lifecycle cases).
     */
    run: async (_config?: unknown): Promise<void> => {
      const sid = currentScenarioId();
      const entry = recordLifecycle(sid, { op: 'run', groupId, topics: [...topics.keys()], failed: false });
      // KafkaJS creates its consumer group synchronously, so a subscribe racing this run already sees "running".
      const wasRunning = running;
      running = true;
      return tracked(async () => {
        try {
          await macrotask();
          maybeFail(sid, 'kafka.run');
        } catch (err) {
          running = wasRunning;
          entry.failed = true;
          throw err;
        }
      });
    },

    /**
     * KafkaJS Consumer.stop. Documented behaviour reproduced: leaves the group, keeps the subscriptions; stop twice or
     * before connect is accepted. Recorded, failed or not. Injection: fail(sid, 'kafka.stop', [...]).
     * Provenance: parity-tests/fake-kafka.parity.ts (consumer lifecycle cases).
     */
    stop: async (): Promise<void> => {
      const sid = currentScenarioId();
      const entry = recordLifecycle(sid, { op: 'stop', groupId, failed: false });
      return tracked(async () => {
        try {
          await macrotask(); // leaving the group; the consumer still counts as running until it has left
          maybeFail(sid, 'kafka.stop');
          running = false;
        } catch (err) {
          entry.failed = true;
          throw err;
        }
      });
    },

    /**
     * KafkaJS Consumer.disconnect. Documented behaviour reproduced: accepted while running, which stops it. Not
     * recorded and not failable: production calls it only on shutdown. Provenance: parity-tests/fake-kafka.parity.ts
     * (the "stop before connect, connect twice, disconnect while running" case).
     */
    disconnect: async (): Promise<void> => {
      running = false;
    },

    /** KafkaJS Consumer.commitOffsets: see recordCommitOffsets. Injection: fail(sid, 'kafka.commitOffsets', [...]). */
    commitOffsets: async (offsets: Array<{ topic: string; partition: number; offset: string }>): Promise<void> =>
      recordCommitOffsets(currentScenarioId(), offsets),
  };
}

function claimLifecycle(
  scenarioId: string,
  matches: (e: ConsumerLifecycleEntry) => boolean,
  describe: string,
): ConsumerLifecycleEntry[] {
  const log = lifecycleLog.get(scenarioId) ?? [];
  const owned = ownedLifecycle.get(scenarioId) ?? new Set<number>();
  ownedLifecycle.set(scenarioId, owned);
  const claimed: ConsumerLifecycleEntry[] = [];
  log.forEach((entry, i) => {
    if (!owned.has(i) && matches(entry)) {
      owned.add(i);
      claimed.push(safeClone(entry, 'takeOwnershipOfConsumerLifecycle'));
    }
  });
  if (claimed.length === 0) {
    const unowned = log.filter((_, i) => !owned.has(i));
    throw new Error(
      `[fake-kafka] No unowned consumer ${describe} (scenario: ${scenarioId}). ` +
        `Unowned consumer calls elsewhere: ${unowned.length === 0 ? 'none' : JSON.stringify(unowned).slice(0, 200)}. ` +
        'Probable cause: the registration never reached subscribeToTopic (rejected, or the topic was already subscribed), ' +
        'it was already claimed, or the scenario did not wait for the fire-and-forget subscribe to settle. ' +
        'Fix: check the When step registers a subscriber on a new topic, and claim each effect once.',
    );
  }
  return claimed;
}

/**
 * Claim the unowned subscribe calls for `topic`, in call order. Throws if there is none.
 * Awaits in-flight consumer calls first: subscribeToTopic is fire-and-forget, so the POST can return before it ends.
 */
export async function takeOwnershipOfSubscriptions(
  scenarioId: string,
  topic: string,
): Promise<Array<{ op: 'subscribe'; topic: string; fromBeginning: boolean; failed: boolean }>> {
  await settleKafkaConsumer();
  return claimLifecycle(scenarioId, (e) => e.op === 'subscribe' && e.topic === topic, `subscribe for topic "${topic}"`) as Array<{
    op: 'subscribe';
    topic: string;
    fromBeginning: boolean;
    failed: boolean;
  }>;
}

/**
 * Claim the unowned run / stop calls of consumer group `groupId`, in call order — the consumer's start and
 * restarts. Throws if there is none. Awaits in-flight consumer calls first (see takeOwnershipOfSubscriptions).
 */
export async function takeOwnershipOfConsumerRunState(
  scenarioId: string,
  groupId: string,
): Promise<ConsumerRunStateEntry[]> {
  await settleKafkaConsumer();
  return claimLifecycle(
    scenarioId,
    (e) => e.op !== 'subscribe' && e.groupId === groupId,
    `run/stop call for group "${groupId}"`,
  ) as ConsumerRunStateEntry[];
}

// ── Fake lifecycle ────────────────────────────────────────────────────────────

/**
 * Give the consumer module a fresh state and a started (stub) consumer. Called once at boot and before every
 * scenario.
 *
 * Why: src/kafka/consumer.ts keeps `consumer`, `subscribedTopics` and `isRunning` at module level, so once one
 * scenario registered "orders" every later one would see `subscribedTopics.has("orders")` and skip the
 * subscribe — what a scenario observes would depend on scenario order. Production cannot be changed for tests,
 * so the module is loaded again (fresh state) and its exports are copied onto the ORIGINAL exports object
 * that dist/api/* already hold; require.cache keeps pointing at that object, so every importer
 * (api/subscribers, api/index, steps that require the module) sees the fresh functions.
 */
export async function reseatKafkaConsumer(): Promise<void> {
  const modulePath = require.resolve(path.join(__dirname, '../../../../dist/kafka/consumer'));
  if (!require.cache[modulePath]) require(modulePath);
  const original = require.cache[modulePath]!;
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  require.cache[modulePath] = original;
  Object.assign(original.exports, fresh);

  // startConsumer() sets the module-level `consumer` to the kafkajs stub's consumer so handleMessage()'s
  // commitOffsets() doesn't throw. findDistinctTopics() has nothing yet (no scenario data, or INIT_SENTINEL at
  // boot), so it returns after connect(); its log line would otherwise print once per scenario.
  const log = console.log;
  console.log = () => undefined;
  try {
    await original.exports.startConsumer();
  } finally {
    console.log = log;
  }
  _handleMessage = original.exports.handleMessage;
}

export const initKafkaFake = reseatKafkaConsumer;

/**
 * Build the EachMessagePayload a KafkaJS consumer hands to eachMessage. Exported so the parity suite
 * can compare it with what a real consumer receives; step definitions go through dispatchKafkaMessage.
 */
export function synthesizeEachMessagePayload(
  topic: string,
  payload: string | null,
  key: string | null,
  { partition = 0, offset = '0' }: { partition?: number; offset?: string } = {},
) {
  return {
    topic,
    partition,
    // Same field set KafkaJS 2.x delivers (pinned by the parity suite). Only key, value and offset are read
    // by handleMessage; the rest is filler of the right type — see the parity header for the value divergences.
    message: {
      magicByte: 2,
      attributes: 0,
      timestamp: '0',
      offset,
      key: key != null ? Buffer.from(key) : null,
      value: payload != null ? Buffer.from(payload) : null,
      headers: {},
      isControlRecord: false,
      batchContext: {
        firstOffset: offset,
        firstTimestamp: '0',
        partitionLeaderEpoch: 0,
        inTransaction: false,
        isControlBatch: false,
        lastOffsetDelta: 0,
        producerId: '-1',
        producerEpoch: 0,
        firstSequence: 0,
        maxTimestamp: '0',
        timestampType: 0,
        magicByte: 2,
      },
    },
    heartbeat: async () => {},
    pause: () => () => {},
  };
}

/**
 * Dispatch a synthetic Kafka message to handleMessage() as if KafkaJS delivered it.
 *
 * @param topic    Kafka topic — determines which subscribers are fetched and which flag is checked
 * @param payload  Message body string, or null to simulate a message with no value
 *                 (handleMessage produces payload = '' when message.value is null)
 * @param key      Optional message key string; null if the producer sent no key
 * @param position Where the message sits: partition (default 0) and offset (default '0', a string like KafkaJS).
 *                 handleMessage commits `offset + 1` of THIS message on THIS partition.
 */
export async function dispatchKafkaMessage(
  topic: string,
  payload: string | null,
  key: string | null = null,
  { partition = 0, offset = '0' }: { partition?: number; offset?: string } = {},
): Promise<void> {
  const sid = currentScenarioId();
  // Mark that this scenario exercised the consumer so the commit-ownership auto-default applies.
  dispatched.set(sid, [...(dispatched.get(sid) ?? []), { topic, partition, offset }]);
  await _handleMessage(synthesizeEachMessagePayload(topic, payload, key, { partition, offset }));
}

registerFake({
  name: 'kafka-inbound',
  throwIfUnownedExist: (scenarioId: string) => {
    const log = commitLog.get(scenarioId) ?? [];
    const owned = ownedCommits.get(scenarioId) ?? new Set<number>();
    const unowned = log.filter((_, i) => !owned.has(i));
    const lifecycle = lifecycleLog.get(scenarioId) ?? [];
    const ownedCalls = ownedLifecycle.get(scenarioId) ?? new Set<number>();
    const unownedCalls = lifecycle.filter((_, i) => !ownedCalls.has(i));
    if (unownedCalls.length > 0) {
      throw new Error(
        `[fake-kafka] ${unownedCalls.length} consumer subscribe/run/stop call(s) were recorded but never owned in scenario ${scenarioId}: ` +
          `${JSON.stringify(unownedCalls).slice(0, 200)}. ` +
          'Probable cause: a registration subscribed the consumer to a topic and no Then step claimed it. ' +
          'Fix: the subscription auto-default claims it for registered topics; otherwise claim it with ' +
          'takeOwnershipOfSubscriptions / takeOwnershipOfConsumerRunState.',
      );
    }
    if (unowned.length > 0) {
      throw new Error(
        `[fake-kafka] ${unowned.length} offset commit(s) were recorded but never owned in scenario ${scenarioId}: ` +
          `${JSON.stringify(unowned).slice(0, 200)}. ` +
          'Probable cause: a dispatched message committed its offset but no Then step claimed it. ' +
          'Fix: the commit-ownership auto-default claims it for dispatched scenarios; if the handler was ' +
          'EXPECTED to throw (no commit), use "the Kafka offset should not have been committed" to opt out; ' +
          'otherwise claim it with takeOwnershipOfCommittedOffsets(scenarioId, topic, partition).',
      );
    }
  },
  cleanup: (scenarioId: string) => {
    commitLog.delete(scenarioId);
    ownedCommits.delete(scenarioId);
    lifecycleLog.delete(scenarioId);
    ownedLifecycle.delete(scenarioId);
    dispatched.delete(scenarioId);
    failConfig.delete(scenarioId);
  },
});
