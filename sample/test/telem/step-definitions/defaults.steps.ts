import assert from 'assert';
import { BeforeAll, Before, After, Then } from '@cucumber/cucumber';
import { throwIfAnyUnownedExist, cleanupScenario } from '../support/fake-registry';
import { declareFlag } from '../support/fakes/fake-openfeature';
import {
  listDispatchedMessages,
  takeOwnershipOfCommittedOffsets,
  takeOwnershipOfSubscriptions,
  takeOwnershipOfConsumerRunState,
  settleKafkaConsumer,
  isLegalKafkaTopicName,
  CONSUMER_GROUP_ID,
  type ConsumerRunStateEntry,
} from '../support/fakes/fake-kafka';
import { listCreatedSubscriberTopics } from '../support/fakes/fake-db';
import type { WebhooksWorld } from '../support/world';

// Loaded at runtime (deferred) to avoid a circular import:
// features/defaults.ts imports assertNoUnownedChanges from here, so this file must be
// fully loaded before features/defaults.ts is resolved. A static top-level import would
// create a partial-module cycle. Runtime require in BeforeAll is the correct break point.
// eslint-disable-next-line @typescript-eslint/no-require-imports
let activeDefaults: { arrange?: { baselineFlags?: Record<string, boolean> }; assert?: Record<string, (this: WebhooksWorld) => void | Promise<void>> } | undefined;
let flagManifest: Record<string, { flags?: Record<string, string[]>; excluded?: Record<string, string> }> = {};

// Single deployment environment — no region/DR detection needed.
const MANIFEST_ENV = 'default';
const FEATURES_DIR = 'test/telem/features/';
const UNOWNED_IO_ASSERTION = 'No unowned IO changes should remain';

BeforeAll(function () {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  activeDefaults = require('../features/defaults').default;
  // Fail loud if the defaults module lost its final auto-assertion: without it the unowned-IO
  // safety net is silently off for every scenario.
  if (!activeDefaults?.assert?.[UNOWNED_IO_ASSERTION]) {
    throw new Error(
      `features/defaults.ts is missing the '${UNOWNED_IO_ASSERTION}' auto-assertion — ` +
        'the ownership safety net would be disabled. Restore it as the last entry of defaults.assert.',
    );
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    flagManifest = require('../flag-manifest.json');
  } catch {
    flagManifest = {};
  }
});

// Seed baseline flags and manifest flags for every scenario.
// Runs after world.ts's Before (which sets this.scenarioId) — support files load first.
// FLAG_PERMUTATION env var (set by telem-bdd run-flag-permutations) overrides baseline values.
Before(function (this: WebhooksWorld, { pickle }: { pickle: { uri: string } }) {
  const { baselineFlags } = activeDefaults?.arrange || {};
  const permutation: Record<string, boolean> = process.env.FLAG_PERMUTATION
    ? (JSON.parse(process.env.FLAG_PERMUTATION) as Record<string, boolean>)
    : {};

  // Declare all baseline binary flags (empty for this dynamic flag system).
  if (baselineFlags) {
    for (const [flag, value] of Object.entries(baselineFlags)) {
      declareFlag(this.scenarioId, flag, { type: 'binary', value: permutation[flag] ?? value });
    }
  }

  // Declare manifest flags for this feature file that aren't already in the baseline.
  const featureKey = pickle.uri.startsWith(FEATURES_DIR)
    ? pickle.uri.slice(FEATURES_DIR.length)
    : pickle.uri;
  const manifestFlags: string[] = flagManifest[featureKey]?.flags?.[MANIFEST_ENV] ?? [];
  for (const flag of manifestFlags) {
    if (baselineFlags?.[flag] !== undefined) continue;
    declareFlag(this.scenarioId, flag, { type: 'binary', value: permutation[flag] ?? false });
  }
});

/** Run as the final auto-default after every scenario (declared in features/defaults.ts). */
export function assertNoUnownedChanges(this: WebhooksWorld): void {
  throwIfAnyUnownedExist(this.scenarioId);
}

/**
 * Auto-default: every message a scenario dispatched must commit offset + 1 of ITSELF on ITS partition
 * (Kafka's rule: the committed offset is the next one to read; at-least-once — a committed offset means the
 * message was processed and won't be redelivered). Commits are claimed per (topic, partition) and compared
 * in dispatch order, so a wrong +N, partition, topic or commit count fails here.
 * Scenarios that assert specific offsets themselves, or expect the handler to throw, opt out
 * (see the Kafka commit steps in webhook-delivery.steps.ts); the ownership net then covers the rest.
 */
export function assertKafkaOffsetCommitted(this: WebhooksWorld): void {
  const messages = listDispatchedMessages(this.scenarioId);
  if (messages.length === 0) return; // HTTP-only scenarios never touch the consumer

  const expectedByPartition = new Map<string, { topic: string; partition: number; offsets: string[] }>();
  for (const { topic, partition, offset } of messages) {
    const key = JSON.stringify([topic, partition]);
    const group = expectedByPartition.get(key) ?? { topic, partition, offsets: [] };
    group.offsets.push((BigInt(offset) + 1n).toString());
    expectedByPartition.set(key, group);
  }
  for (const { topic, partition, offsets } of expectedByPartition.values()) {
    const committed = takeOwnershipOfCommittedOffsets(this.scenarioId, topic, partition);
    assert.deepStrictEqual(
      committed,
      offsets.map((offset) => ({ topic, partition, offset, failed: false })),
      `Expected each dispatched message on "${topic}" partition ${partition} to commit the offset after its own ` +
        `(${offsets.join(', ')}). Probable cause: handleMessage() committed a different offset, partition or topic, ` +
        'committed more than once, or the commit failed. ' +
        'What to check: the commitOffsets call at the end of src/kafka/consumer.ts handleMessage().',
    );
  }
}

/**
 * Auto-default: registering a subscriber on a topic subscribes the Kafka consumer to it — once per distinct
 * topic, however many subscribers share it — by stopping the running consumer, subscribing, and running again
 * (src/kafka/consumer.ts doSubscribeToTopic). A topic the broker rejects (an illegal name such as "order placed")
 * still gets its one attempt; the registration succeeds anyway because the subscribe is fire-and-forget.
 * Scenarios that pin the lifecycle themselves (failures, restarts, races) opt out.
 *
 * The expectation walks the topics in registration order the way the production loop does: a consumer that is
 * running is stopped first; a failed subscribe leaves it stopped (nothing runs it again until the next success).
 */
export async function assertKafkaSubscriptions(this: WebhooksWorld): Promise<void> {
  const topics = [...new Set(listCreatedSubscriberTopics(this.scenarioId))];
  if (topics.length === 0) return; // nothing was registered (or every registration was rejected)

  const expectedRunState: ConsumerRunStateEntry[] = [];
  const subscribed: string[] = []; // the topics a (re)started consumer joins its group with: all successful ones so far
  let running = false;
  for (const topic of topics) {
    if (running) {
      expectedRunState.push({ op: 'stop', groupId: CONSUMER_GROUP_ID, failed: false });
      running = false;
    }
    const subscribes = isLegalKafkaTopicName(topic);
    assert.deepStrictEqual(
      await takeOwnershipOfSubscriptions(this.scenarioId, topic),
      [{ op: 'subscribe', topic, fromBeginning: false, failed: !subscribes }],
      `Expected exactly one subscribe attempt for topic "${topic}" (${subscribes ? 'a legal topic name, so it succeeds' : 'an illegal topic name, so the broker rejects it'}). ` +
        'Probable cause: subscribeToTopic skipped the topic, subscribed it twice, or subscribed while the consumer was still running. ' +
        'What to check: doSubscribeToTopic in src/kafka/consumer.ts (subscribedTopics check, stop before subscribe, the subscribeLock).',
    );
    if (subscribes) {
      subscribed.push(topic);
      expectedRunState.push({ op: 'run', groupId: CONSUMER_GROUP_ID, topics: [...subscribed], failed: false });
      running = true;
    }
  }
  if (expectedRunState.length > 0) {
    assert.deepStrictEqual(
      await takeOwnershipOfConsumerRunState(this.scenarioId, CONSUMER_GROUP_ID),
      expectedRunState,
      `Expected the consumer to run, then stop and run again for each further topic (${topics.join(', ')}), each run joining the group with every topic subscribed so far. ` +
        'Probable cause: the consumer was not stopped before re-subscribing, was not run after a subscribe, or two registrations interleaved. ' +
        'What to check: doSubscribeToTopic / startRunning in src/kafka/consumer.ts.',
    );
  }
}

// The single After hook. Ordering within this body is guaranteed:
//   1. Auto-default ownership claims (assertNoUnownedChanges last)
//   2. Per-scenario cleanup, in a finally so a failing assertion can't skip it: every scenario has the same
//      scenarioId (see COLLECTED-WISDOM.md "Scenario ids and randomUUID"), so stale state would leak into the next one.
After(async function (this: WebhooksWorld) {
  try {
    // The Kafka consumer is driven by a fire-and-forget subscribe; let it finish before claiming its effects.
    await settleKafkaConsumer();
    if (activeDefaults?.assert) {
      for (const [text, handler] of Object.entries(activeDefaults.assert)) {
        if (!this._skippedDefaults?.has(text)) {
          await handler.call(this);
        }
      }
    }
  } finally {
    cleanupScenario(this.scenarioId);
  }
});

// Opt-out of the unowned-IO check. No scenario uses it.
Then('we might have unowned IO changes', function (this: WebhooksWorld) {
  if (!this._skippedDefaults) this._skippedDefaults = new Set();
  this._skippedDefaults.add('No unowned IO changes should remain');
});
