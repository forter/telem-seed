/**
 * Parity test: fake-kafka (the inbound driver + the offset-commit capture) vs a REAL KafkaJS consumer on
 * a real Apache Kafka broker.
 *
 * STATUS: Covered — container-backed (compose.parity.yaml `kafka`; run.sh brings it up). Skips, with a
 * recorded marker, when the broker is unreachable (no Docker); there is no CI, so run it locally; run.sh fails a skip with CI set.
 *
 * Run:  npm run bdd-test:fakes-parity   (or this file alone: npx tsx <this file>, with the broker up;
 *       PARITY_KAFKA_PORT sets the host port, default 9392)
 *
 * fake-kafka is not a broker fake: it HAND-BUILDS the EachMessagePayload that handleMessage() receives, and
 * it CAPTURES what handleMessage() sends back (commitOffsets). Both have a real counterpart:
 *
 *  1. Payload shape. Real messages are produced to a real topic (null key, null value / tombstone,
 *     empty-string key and value, non-ASCII, headers, non-zero partitions) and consumed by a real KafkaJS
 *     consumer exactly as production runs it (run({ autoCommit: false, eachMessage })). What eachMessage
 *     receives is compared with synthesizeEachMessagePayload() for the same message: field set, Buffer vs
 *     null, string offset, numeric partition. handleMessage branches on exactly these (`message.key ?
 *     key.toString() : null`, `BigInt(message.offset)`), so a wrong shape would change what BDD scenarios prove.
 *  2. Offset commit capture. The same commitOffsets arguments go to the real consumer and to the fake's
 *     capture; the broker's stored offset (admin.fetchOffsets) is compared with what the fake captured.
 *
 *  3. Consumer lifecycle. The kafkajs stub's consumer (createFakeConsumer) is what production's subscribeToTopic
 *     drives (stop → subscribe → run, on every new topic). The same call script is played on a real KafkaJS
 *     consumer and on the fake and the outcome of EVERY call is compared — ok, or the error's name, message,
 *     retriable flag and protocol type/code: subscribing while running, a missing / undefined / non-string topic,
 *     legal and illegal topic names (letters, digits, '.', '_', '-', ≤ 249 characters, not '.' / '..' — the
 *     fake's isLegalKafkaTopicName), repeated subscribe / run / stop, stop before connect. Where a group is
 *     joined, the topics the broker says the member consumes (admin.describeGroups) are compared with the topics
 *     the fake's last `run` recorded: subscriptions survive stop(), a restart re-joins with all of them, and a
 *     subscribe the broker rejected leaves no trace.
 *  4. Connect failure. A consumer pointed at a closed port rejects connect() itself — what fail('kafka.connect')
 *     models for startConsumer().
 *
 * It verifies behaviour, never just shape: each case compares values, nullness and types of one concrete message.
 *
 * NOT a Cucumber test. Cucumber loads this file on every BDD run, so everything is behind
 * `require.main === module`, and the real kafkajs is required lazily inside main() — world.ts seeds the
 * kafkajs stub into require.cache for the BDD process, and that must never be what this suite talks to.
 *
 * ---- Intentional divergences (documented, never asserted) -----------------------------------------
 *  - message.timestamp, message.batchContext values: the broker stamps wall-clock times and batch layout;
 *    the fake uses fixed fillers so scenarios are deterministic. Only presence and type are compared
 *    (timestamp: a numeric string; batchContext: same keys, same value types).
 *  - message.headers content: handleMessage does not read headers; the fake always delivers `{}`. A case
 *    produces real headers (and checks the real side has them) but does not compare them.
 *  - heartbeat / pause: real ones talk to the consumer group; the fake's are no-ops. Only `typeof` is compared.
 *  - fromBeginning: the parity consumer reads from the beginning of a fresh topic so it sees what it just
 *    produced; production runs fromBeginning: false. It does not change the shape of a delivered message.
 *  - Commit log vs broker state: the fake records EVERY commit attempt (that is what the ownership net
 *    counts); the broker keeps only the latest offset per partition. The comparison is "latest captured
 *    entry per partition" vs the broker's stored value, plus a fake-only check that the captured entries are
 *    exactly the arguments sent, in order.
 *  - Broker-side rejection: the real broker refuses a commit to a topic/partition it does not host ("This
 *    server does not host this topic-partition") and a commit from a consumer that has not joined its group.
 *    The fake knows no topics or groups and accepts any position. handleMessage only ever commits the
 *    position it was handed, which exists, so no scenario reaches this.
 *  - Failure injection (fail() / isConfiguredToFail) is a fake-only feature; a real broker outage is not
 *    reproducible here.
 *  - Topics the broker does not host: a real subscribe to a LEGAL name that does not exist fails with
 *    UNKNOWN_TOPIC_OR_PARTITION ("This server does not host this topic-partition", retriable, after KafkaJS's
 *    retries — slow). The fake treats every legal name as existing; production registers topics its producers
 *    already write to. Every legal name the parity cases subscribe is created on the broker first.
 *  - Calls after disconnect: the real error depends on the call history ("Closed connection" after a run
 *    attempt, "Connection error: write after end" straight after connect) and production never makes the call
 *    (stopConsumer nulls the consumer). The fake does not model it.
 *  - connect / run / stop never fail by themselves in the fake (a real run can crash the consumer later, via
 *    its `crash` event — not modelled); only fail() makes them throw.
 *  - Timing: the fake takes one macrotask per call so races between registrations are observable; a real call
 *    takes a broker round trip (~1 s for a stop/subscribe/run restart, per CLAUDE.md).
 *  - Redelivery after a handler error or a failed commit is KafkaJS/broker behaviour, not the fake's:
 *    the fake only guarantees "no commit recorded" / "attempt recorded and failed".
 */

import assert from 'assert';
import type { Kafka, EachMessagePayload, Consumer, Admin } from 'kafkajs';
import { withScenario, isConnectionError, skipSuite } from './parity-setup';
import { cleanupScenario } from '../../fake-registry';
import {
  synthesizeEachMessagePayload,
  recordCommitOffsets,
  takeOwnershipOfCommittedOffsets,
  createFakeConsumer,
  takeOwnershipOfConsumerRunState,
  CONSUMER_GROUP_ID,
  fail as failKafka,
} from '../fake-kafka';

// ── Payload-shape cases ───────────────────────────────────────────────────────

interface PayloadCase {
  name: string;
  partition: number;
  key: string | null;
  value: string | null;
  headers?: Record<string, string>;
}

// Order matters: messages are produced to an empty topic, so each one's offset within its partition is
// the number of earlier cases on that partition — the expected offsets are derived from that, never read
// back from the real side (reading them back would make the offset type check circular).
const PAYLOAD_CASES: PayloadCase[] = [
  { name: 'key and JSON value', partition: 0, key: 'msg-1', value: '{"orderId":"abc"}' },
  { name: 'no key (null key)', partition: 0, key: null, value: 'no-key-body' },
  { name: 'tombstone: key with no value (null value)', partition: 0, key: 'msg-3', value: null },
  { name: 'empty-string key and empty-string value are not null', partition: 1, key: '', value: '' },
  { name: 'neither key nor value', partition: 1, key: null, value: null },
  { name: 'non-ASCII key and value', partition: 2, key: 'ключ', value: '{"name":"こんにちは","emoji":"🎉"}' },
  { name: 'message with headers (headers not compared)', partition: 2, key: 'with-headers', value: 'body', headers: { h1: 'v1', 'x-trace': 'abc' } },
  { name: 'later offset on the same partition', partition: 2, key: 'msg-8', value: 'later' },
];

/**
 * What a payload looks like once the values that legitimately differ are scrubbed: Buffers by content,
 * wall-clock/batch values by type. Everything else (field set, nullness, string offset, numeric partition) is compared as is.
 */
function normalize(p: EachMessagePayload, { dropHeaders = false }: { dropHeaders?: boolean } = {}): unknown {
  const message: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.message as unknown as Record<string, unknown>)) {
    if (k === 'headers' && dropHeaders) message[k] = '<not compared>';
    else if (k === 'timestamp') message[k] = typeof v === 'string' && /^\d+$/.test(v) ? '<epoch-ms string>' : v;
    else if (k === 'batchContext') message[k] = Object.fromEntries(Object.entries(v as object).map(([bk, bv]) => [bk, typeof bv]));
    else message[k] = Buffer.isBuffer(v) ? { buffer: v.toString('hex') } : v;
  }
  return { topic: p.topic, partition: p.partition, message, heartbeat: typeof p.heartbeat, pause: typeof p.pause };
}

// ── Commit cases ──────────────────────────────────────────────────────────────

interface CommitCase {
  name: string;
  /** One entry per commitOffsets call, sent in order. */
  commits: Array<Array<{ partition: number; offset: string }>>;
}

const COMMIT_CASES: CommitCase[] = [
  { name: 'one commit: the offset is stored as sent', commits: [[{ partition: 0, offset: '1' }]] },
  { name: 'offset zero', commits: [[{ partition: 0, offset: '0' }]] },
  {
    name: 'two partitions are tracked independently',
    commits: [[{ partition: 2, offset: '43' }], [{ partition: 0, offset: '8' }]],
  },
  { name: 'successive commits: the latest wins', commits: [[{ partition: 1, offset: '1' }], [{ partition: 1, offset: '3' }]] },
  { name: 'a lower offset committed later replaces a higher one', commits: [[{ partition: 1, offset: '9' }], [{ partition: 1, offset: '4' }]] },
  { name: 'one call, two partitions', commits: [[{ partition: 0, offset: '5' }, { partition: 2, offset: '6' }]] },
  { name: 'offset beyond 2^53 keeps every digit (offsets are int64, carried as strings)', commits: [[{ partition: 2, offset: '9007199254740993' }]] },
];

// ── Real-side plumbing ────────────────────────────────────────────────────────

const RECEIVE_TIMEOUT_MS = 30_000;
let uniqueCounter = 0;
const unique = (prefix: string): string => `parity-${prefix}-${process.pid}-${Date.now()}-${++uniqueCounter}`;

async function createTopic(admin: Admin): Promise<string> {
  const topic = unique('topic');
  await admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true });
  return topic;
}

/**
 * Run a real consumer the way production does (autoCommit off, eachMessage) until it has seen `expected`
 * messages. `onMessage` runs inside eachMessage — the only place commitOffsets is valid, as in handleMessage.
 */
async function consume(
  kafka: Kafka,
  topic: string,
  groupId: string,
  expected: number,
  onMessage?: (consumer: Consumer, p: EachMessagePayload) => Promise<void>,
): Promise<EachMessagePayload[]> {
  const consumer = kafka.consumer({ groupId });
  const received: EachMessagePayload[] = [];
  let done!: () => void;
  let failed!: (e: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    done = resolve;
    failed = reject;
  });
  const timer = setTimeout(
    () => failed(new Error(`real consumer received ${received.length}/${expected} messages on "${topic}" within ${RECEIVE_TIMEOUT_MS} ms`)),
    RECEIVE_TIMEOUT_MS,
  );
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async (p) => {
        try {
          received.push(p);
          if (onMessage) await onMessage(consumer, p);
          if (received.length >= expected) done();
        } catch (err) {
          failed(err as Error);
        }
      },
    });
    await finished;
  } finally {
    clearTimeout(timer);
    await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
  }
  return received;
}

// ── Consumer lifecycle cases ──────────────────────────────────────────────────

type Call =
  | { op: 'connect' | 'run' | 'stop' | 'disconnect' }
  | { op: 'subscribe'; topic: unknown };

interface LifecycleCase {
  name: string;
  calls: Call[];
  /** Also compare the topics the consumer joined its group with after the last call (the broker's view vs the fake's last `run`). */
  joined?: boolean;
}

/** `$t1` / `$t2` stand for two topics created on the broker for the case; everything else is a literal name. */
const T1 = '$t1';
const T2 = '$t2';

const sub = (topic: unknown): Call => ({ op: 'subscribe', topic });
const connect: Call = { op: 'connect' };
const run: Call = { op: 'run' };
const stop: Call = { op: 'stop' };

// Legal names that must EXIST on the broker for a real subscribe to succeed (the fake treats every legal name as
// existing — see the header). The 249-character one is the longest legal name.
const LEGAL_NAMES = ['orders', 'a_b-c.d', 'UPPER.case_Mixed-1', 'x'.repeat(249)];
// Names the broker rejects as invalid (INVALID_TOPIC_EXCEPTION): other characters, too long, '.' and '..'.
const ILLEGAL_NAMES = ['order placed', '   ', 'a/b', 'ключ', '../../etc/passwd', "orders'; DROP TABLE subscribers; --", 'x'.repeat(250), '.', '..'];

const LIFECYCLE_CASES: LifecycleCase[] = [
  { name: 'subscribe then run: the group is joined with that topic', calls: [connect, sub(T1), run], joined: true },
  { name: 'subscribing while the consumer is running is refused', calls: [connect, sub(T1), run, sub(T2)], joined: true },
  // The production restart (doSubscribeToTopic): KafkaJS keeps subscriptions across stop(), so the new run joins with both.
  { name: 'stop, subscribe, run: the restarted consumer keeps its earlier topics', calls: [connect, sub(T1), run, stop, sub(T2), run], joined: true },
  { name: 'a subscribe the broker rejects leaves no trace: the next run joins only the good topics', calls: [connect, sub(T1), run, stop, sub('order placed'), sub(T2), run], joined: true },
  { name: 'subscribing the same topic twice is accepted', calls: [connect, sub(T1), sub(T1), run], joined: true },
  { name: 'run twice and stop twice are accepted', calls: [connect, sub(T1), run, run, stop, stop] },
  { name: 'stop before connect, connect twice, disconnect while running are accepted', calls: [stop, connect, connect, sub(T1), run, { op: 'disconnect' }, stop] },
  { name: 'subscribe without a topic is refused client-side', calls: [connect, sub('')] },
  { name: 'subscribe with an undefined topic is refused client-side', calls: [connect, sub(undefined)] },
  { name: 'subscribe with a number as the topic is refused client-side', calls: [connect, sub(5)] },
  ...LEGAL_NAMES.map((n): LifecycleCase => ({ name: `legal topic name (${n.length > 40 ? `${n.length} characters` : JSON.stringify(n)}) is subscribed`, calls: [connect, sub(n)] })),
  ...ILLEGAL_NAMES.map((n): LifecycleCase => ({ name: `illegal topic name (${n.length > 40 ? `${n.length} characters` : JSON.stringify(n)}) is rejected by the broker`, calls: [connect, sub(n)] })),
];

interface Outcome {
  ok: boolean;
  name?: string;
  message?: string;
  retriable?: boolean;
  type?: string;
  code?: number;
}

/** The fields a caller can branch on, from either side's thrown error. */
function describeOutcome(err: unknown): Outcome {
  if (err === undefined) return { ok: true };
  const e = err as { name: string; message: string; retriable?: boolean; type?: string; code?: number };
  const outcome: Outcome = { ok: false, name: e.name, message: e.message, retriable: e.retriable };
  if (e.type !== undefined) outcome.type = e.type;
  if (e.code !== undefined) outcome.code = e.code;
  return outcome;
}

interface Consumerish {
  connect(): Promise<void>;
  subscribe(args: { topic: unknown; fromBeginning: boolean }): Promise<void>;
  run(args: { autoCommit: boolean; eachMessage: () => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

async function play(consumer: Consumerish, calls: Call[], topics: Record<string, string>): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const call of calls) {
    try {
      if (call.op === 'subscribe') {
        const topic = typeof call.topic === 'string' && call.topic in topics ? topics[call.topic] : call.topic;
        await consumer.subscribe({ topic, fromBeginning: false });
      } else if (call.op === 'run') {
        await consumer.run({ autoCommit: false, eachMessage: async () => undefined });
      } else {
        await consumer[call.op]();
      }
      outcomes.push(describeOutcome(undefined));
    } catch (err) {
      outcomes.push(describeOutcome(err));
    }
  }
  return outcomes;
}

/** What the broker says the group's member consumes, once the group has settled (two identical reads in a row). */
async function joinedTopics(admin: Admin, groupId: string, AssignerProtocol: typeof import('kafkajs').AssignerProtocol): Promise<string[]> {
  let previous = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    const { groups } = await admin.describeGroups([groupId]);
    const members = groups[0]?.members ?? [];
    if (groups[0]?.state === 'Stable' && members.length === 1 && members[0].memberAssignment.length > 0) {
      const topics = Object.keys(AssignerProtocol.MemberAssignment.decode(members[0].memberAssignment)!.assignment).sort();
      const now = JSON.stringify(topics);
      if (now === previous) return topics;
      previous = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the real group "${groupId}" never settled on a member assignment`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('fake-kafka parity test (fake driver + commit capture vs a real KafkaJS consumer on Apache Kafka)\n');

  // The REAL kafkajs: nothing seeds require.cache in this process, so this is the npm package, not the stub.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Kafka: RealKafka, logLevel, AssignerProtocol } = require('kafkajs') as typeof import('kafkajs');
  const brokers = [`localhost:${process.env.PARITY_KAFKA_PORT ?? '9392'}`];

  // Reachability probe with no retries, so a missing broker is a fast skip rather than a long retry loop.
  const probe = new RealKafka({ clientId: 'parity-probe', brokers, logLevel: logLevel.NOTHING, connectionTimeout: 3000, retry: { retries: 0 } }).admin();
  try {
    await probe.connect();
    await probe.disconnect();
  } catch (err) {
    if (isConnectionError(err)) {
      skipSuite('fake-kafka', `Kafka not reachable on ${brokers[0]} (${(err as Error).message}). Start it with run.sh (needs Docker).`);
    }
    throw err;
  }

  // A fresh broker may still be electing the group coordinator when the first consumer joins; retry through it.
  const kafka = new RealKafka({ clientId: 'parity', brokers, logLevel: logLevel.NOTHING, retry: { retries: 10 } });
  const admin = kafka.admin();
  const producer = kafka.producer();
  await admin.connect();
  await producer.connect();

  let testsRun = 0;
  const divergences: string[] = [];
  const diverged = (name: string, detail: string): void => {
    // Keep going: one run should list every divergence, not just the first.
    divergences.push(`  - "${name}"\n${detail}`);
  };

  try {
    // 1. Payload shape ─────────────────────────────────────────────────────────
    console.log('Payload shape (what eachMessage receives):');
    const topic = await createTopic(admin);
    await producer.send({
      topic,
      messages: PAYLOAD_CASES.map((c) => ({ partition: c.partition, key: c.key, value: c.value, headers: c.headers })),
    });
    const received = await consume(kafka, topic, unique('group'), PAYLOAD_CASES.length);
    const byPosition = new Map(received.map((p) => [`${p.partition}:${p.message.offset}`, p]));

    const nextOffset = new Map<number, number>();
    for (const [i, c] of PAYLOAD_CASES.entries()) {
      console.log(`${i + 1}. ${c.name}`);
      const offset = String(nextOffset.get(c.partition) ?? 0);
      nextOffset.set(c.partition, Number(offset) + 1);

      const real = byPosition.get(`${c.partition}:${offset}`);
      if (!real) {
        diverged(c.name, `      the real consumer never delivered partition ${c.partition} offset ${offset}`);
        continue;
      }
      const dropHeaders = c.headers !== undefined;
      if (dropHeaders && Object.keys(real.message.headers ?? {}).length === 0) {
        diverged(c.name, '      the case sends headers but the real consumer delivered none — the case would prove nothing');
        continue;
      }
      // Expected positions come from the producer side, never from the real message, so type drift in
      // partition/offset on the real side shows up as a divergence rather than being copied.
      const fake = synthesizeEachMessagePayload(topic, c.value, c.key, { partition: c.partition, offset }) as unknown as EachMessagePayload;
      try {
        assert.deepStrictEqual(normalize(fake, { dropHeaders }), normalize(real, { dropHeaders }));
        testsRun++;
      } catch {
        diverged(
          c.name,
          `      real: ${JSON.stringify(normalize(real, { dropHeaders })).slice(0, 700)}\n      fake: ${JSON.stringify(normalize(fake, { dropHeaders })).slice(0, 700)}`,
        );
      }
    }

    // 2. Offset commit capture ─────────────────────────────────────────────────
    console.log('\nOffset commit capture (what the broker stores vs what the fake captured):');
    for (const [i, c] of COMMIT_CASES.entries()) {
      console.log(`${i + 1}. ${c.name}`);

      // Real: a consumer running inside eachMessage — as handleMessage commits — then ask the broker.
      const commitTopic = await createTopic(admin);
      const groupId = unique('group');
      await producer.send({ topic: commitTopic, messages: [{ partition: 0, key: 'k', value: 'v' }] });
      await consume(kafka, commitTopic, groupId, 1, async (consumer) => {
        for (const call of c.commits) await consumer.commitOffsets(call.map((o) => ({ topic: commitTopic, ...o })));
      });
      const stored = await admin.fetchOffsets({ groupId, topics: [commitTopic] });
      const real = Object.fromEntries(stored[0].partitions.filter((p) => p.offset !== '-1').map((p) => [p.partition, p.offset]));

      // Fake: the identical calls, then read the capture back through the ownership API.
      const { fake, captureProblem } = await withScenario(cleanupScenario, async (scenarioId) => {
        const sent: Array<{ topic: string; partition: number; offset: string }> = [];
        for (const call of c.commits) {
          const args = call.map((o) => ({ topic: commitTopic, ...o }));
          recordCommitOffsets(scenarioId, args);
          sent.push(...args);
        }
        const latest: Record<number, string> = {};
        let problem: string | undefined;
        for (const partition of new Set(sent.map((a) => a.partition))) {
          const captured = takeOwnershipOfCommittedOffsets(scenarioId, commitTopic, partition);
          latest[partition] = captured[captured.length - 1].offset;
          // Fake-only invariant: what is captured is exactly what was sent (no rewrite, no lost digits).
          try {
            assert.deepStrictEqual(
              captured,
              sent.filter((a) => a.partition === partition).map((a) => ({ ...a, failed: false })),
            );
          } catch {
            problem = `captured ${JSON.stringify(captured)} for partition ${partition} but sent ${JSON.stringify(sent.filter((a) => a.partition === partition))}`;
          }
        }
        return { fake: latest, captureProblem: problem };
      });

      try {
        assert.deepStrictEqual(fake, real);
        assert.strictEqual(captureProblem, undefined);
        testsRun++;
      } catch {
        diverged(c.name, `      broker: ${JSON.stringify(real)}\n      fake:   ${JSON.stringify(fake)}${captureProblem ? `\n      capture: ${captureProblem}` : ''}`);
      }
    }

    // 3. Consumer lifecycle ────────────────────────────────────────────────────
    console.log('\nConsumer lifecycle (the same calls on a real KafkaJS consumer and on the fake consumer):');
    // The legal names must exist on the real broker for a real subscribe to succeed.
    await admin.createTopics({ topics: LEGAL_NAMES.map((topic) => ({ topic, numPartitions: 1 })), waitForLeaders: true });
    for (const [i, c] of LIFECYCLE_CASES.entries()) {
      console.log(`${i + 1}. ${c.name}`);

      const topics = { [T1]: unique('t1'), [T2]: unique('t2') };
      await admin.createTopics({ topics: Object.values(topics).map((topic) => ({ topic, numPartitions: 1 })), waitForLeaders: true });
      const groupId = unique('group');

      // Real: play the calls on a real consumer, then ask the broker what the group consumes.
      const realConsumer = kafka.consumer({ groupId });
      let real: { outcomes: Outcome[]; joined?: string[] };
      try {
        const outcomes = await play(realConsumer as unknown as Consumerish, c.calls, topics);
        real = { outcomes };
        if (c.joined) real.joined = (await joinedTopics(admin, groupId, AssignerProtocol)).map((t) => t);
      } finally {
        await realConsumer.stop().catch(() => undefined);
        await realConsumer.disconnect().catch(() => undefined);
      }

      // Fake: the identical calls on the fake consumer; its `run` records the topics it joined with.
      const fake = await withScenario(cleanupScenario, async (scenarioId) => {
        const outcomes = await play(createFakeConsumer({ groupId: CONSUMER_GROUP_ID }) as unknown as Consumerish, c.calls, topics);
        const result: { outcomes: Outcome[]; joined?: string[] } = { outcomes };
        if (c.joined) {
          const runs = (await takeOwnershipOfConsumerRunState(scenarioId, CONSUMER_GROUP_ID)).filter(
            (e): e is Extract<typeof e, { op: 'run' }> => e.op === 'run',
          );
          result.joined = [...runs[runs.length - 1].topics].sort();
        }
        return result;
      });

      try {
        assert.deepStrictEqual(fake, real);
        testsRun++;
      } catch {
        diverged(c.name, `      real: ${JSON.stringify(real).slice(0, 900)}\n      fake: ${JSON.stringify(fake).slice(0, 900)}`);
      }
    }

    // 4. A connect that fails ──────────────────────────────────────────────────
    // startConsumer() awaits connect() before anything else, so a broker it cannot reach must reject connect()
    // itself (not a later call). The fake's connect rejects only through fail('kafka.connect'), fed the real error.
    console.log('\nConnect failure (an unreachable broker rejects connect()):');
    console.log('1. connect to a closed port rejects');
    const net = await import('net');
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as import('net').AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = new RealKafka({ clientId: 'parity-down', brokers: [`127.0.0.1:${port}`], logLevel: logLevel.NOTHING, connectionTimeout: 1000, retry: { retries: 0 } });
    let realError: unknown;
    const downConsumer = unreachable.consumer({ groupId: unique('group') });
    try {
      await downConsumer.connect();
    } catch (err) {
      realError = err;
    } finally {
      await downConsumer.disconnect().catch(() => undefined);
    }
    const realConnect = describeOutcome(realError);
    const fakeConnect = await withScenario(cleanupScenario, async (scenarioId) => {
      if (realError !== undefined) failKafka(scenarioId, 'kafka.connect', [realError as Error]);
      return (await play(createFakeConsumer({ groupId: CONSUMER_GROUP_ID }) as unknown as Consumerish, [connect], {}))[0];
    });
    try {
      assert.strictEqual(realConnect.ok, false, 'the real connect to a closed port should have rejected');
      assert.deepStrictEqual(fakeConnect, realConnect);
      testsRun++;
    } catch (err) {
      diverged('connect to a closed port rejects', `      real: ${JSON.stringify(realConnect)}\n      fake: ${JSON.stringify(fakeConnect)}\n      ${(err as Error).message}`);
    }
  } finally {
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }

  if (divergences.length > 0) {
    throw new Error(
      `fake-kafka diverges from a real KafkaJS consumer on Apache Kafka in ${divergences.length} case(s):\n${divergences.join('\n')}\n` +
        'Probable cause: the fake builds a payload or records a commit differently from KafkaJS / the broker (see the header for intentional divergences). ' +
        'Fix: change the fake to match the real result (never loosen an assertion), then re-run the BDD suite.',
    );
  }

  if (testsRun === 0) {
    throw new Error('parity suite executed zero tests — a stale import or empty suite silently disabled parity');
  }
  console.log(`\n✓ All parity checks passed (ran ${testsRun} tests).`);
  // Machine-readable marker consumed by run.sh to fail a zero-test run.
  console.log(`PARITY_TESTS_RUN=${testsRun}`);
}

// Guard: only run when invoked directly — Cucumber loads this file on every BDD run and must not trigger it.
if (require.main === module) {
  void main().catch((err: Error) => {
    console.error('\n✗ PARITY TEST FAILED:', err.message);
    process.exit(1);
  });
}
