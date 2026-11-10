/**
 * Inbound Kafka test driver — calls handleMessage() directly from step definitions,
 * bypassing the real KafkaJS consumer loop.
 *
 * Why initKafkaFake() is needed: consumer.ts holds a module-level `consumer` variable
 * initialised to null. handleMessage() calls consumer!.commitOffsets() at the end —
 * null throws. startConsumer() sets `consumer` to the kafkajs stub (already in
 * require.cache), which has a no-op commitOffsets. No real Kafka connection is made.
 *
 * Ownership: this fake tracks two things —
 *   1. commitOffsets calls (per-scenario): verifies at-least-once semantics.
 *      A successful handleMessage() always calls commitOffsets exactly once.
 *      A failing handleMessage() (infrastructure error) never calls it.
 *   2. Nothing else — IO (MySQL, fetch) is owned by fake-mysql and fake-fetch.
 */

import path from 'path';
import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _handleMessage: (payload: any) => Promise<void>;

// ── commitOffsets ownership ─────────────────────────────────────────────────────
// The offset commit is an observable IO effect (the at-least-once guarantee), so it goes
// through the ownership model like any other write: a dispatched scenario must OWN its commit.
// The auto-default (defaults.ts) claims it for every dispatched scenario; failure-path scenarios
// opt out and let throwIfUnownedExist enforce absence. No read-only count inspection in steps
// (the ownership-over-inspection lint rule bans that).

interface CommitState { count: number; owned: boolean }
const commitOffsetsCalls = new Map<string, CommitState>();
// Scenarios that dispatched at least one Kafka message — the auto-default only asserts commit
// ownership for these (HTTP-only scenarios never touch the consumer).
const dispatchedScenarios = new Set<string>();

/**
 * Called by the kafkajs stub's commitOffsets method. Do not call from step definitions.
 * Wired in world.ts where the kafkajs stub is created.
 */
export function recordCommitOffsetsCall(scenarioId: string): void {
  const state = commitOffsetsCalls.get(scenarioId) ?? { count: 0, owned: false };
  state.count += 1;
  commitOffsetsCalls.set(scenarioId, state);
}

/** True if this scenario dispatched a Kafka message (so a commit assertion is relevant). */
export function wasKafkaDispatched(scenarioId: string): boolean {
  return dispatchedScenarios.has(scenarioId);
}

/**
 * Claim the offset commit(s) recorded in this scenario and return the count.
 * Marks them owned so throwIfUnownedExist won't flag them. Throws if none were recorded.
 */
export function takeOwnershipOfCommitOffsets(scenarioId: string): number {
  const state = commitOffsetsCalls.get(scenarioId);
  if (!state || state.count === 0) {
    throw new Error(
      `[fake-kafka] No commitOffsets calls to claim for scenario ${scenarioId}. ` +
        'Probable cause: handleMessage() threw before committing the offset (at-least-once: the message will be redelivered). ' +
        'Fix: if the handler is EXPECTED to throw, use "the Kafka offset should not have been committed" instead.',
    );
  }
  state.owned = true;
  return state.count;
}

// ── Fake lifecycle ────────────────────────────────────────────────────────────

export async function initKafkaFake(): Promise<void> {
  // dist/kafka/consumer is already in require.cache (loaded via dist/api/subscribers).
  // Calling startConsumer() sets the module-level `consumer` to the kafkajs stub object
  // (which calls recordCommitOffsetsCall) so handleMessage()'s commitOffsets() doesn't throw.
  // findDistinctTopics() returns [] during INIT_SENTINEL — startConsumer() returns early.
  const consumerModule = require(path.join(__dirname, '../../../../dist/kafka/consumer'));
  await consumerModule.startConsumer();
  _handleMessage = consumerModule.handleMessage;
}

/**
 * Dispatch a synthetic Kafka message to handleMessage() as if KafkaJS delivered it.
 *
 * @param topic    Kafka topic — determines which subscribers are fetched and which flag is checked
 * @param payload  Message body string, or null to simulate a message with no value
 *                 (handleMessage produces payload = '' when message.value is null)
 * @param key      Optional message key string; null if the producer sent no key
 * @param partition Kafka partition (only used by commitOffsets spy); defaults to 0
 */
export async function dispatchKafkaMessage(
  topic: string,
  payload: string | null,
  key: string | null = null,
  partition = 0,
): Promise<void> {
  // Mark that this scenario exercised the consumer so the commit-ownership auto-default applies.
  dispatchedScenarios.add(currentScenarioId());
  await _handleMessage({
    topic,
    partition,
    message: {
      key: key != null ? Buffer.from(key) : null,
      value: payload != null ? Buffer.from(payload) : null,
      timestamp: '0',
      size: payload != null ? Buffer.byteLength(payload) : 0,
      attributes: 0,
      offset: '0',
    },
    heartbeat: async () => {},
    pause: () => () => {},
  });
}

registerFake({
  name: 'kafka-inbound',
  throwIfUnownedExist: (scenarioId: string) => {
    const state = commitOffsetsCalls.get(scenarioId);
    if (state && state.count > 0 && !state.owned) {
      throw new Error(
        `[fake-kafka] ${state.count} offset commit(s) were recorded but never owned in scenario ${scenarioId}. ` +
          'Probable cause: a dispatched message committed its offset but no Then step claimed it. ' +
          'Fix: the commit-ownership auto-default claims it for dispatched scenarios; if the handler was ' +
          'EXPECTED to throw (no commit), use "the Kafka offset should not have been committed" to opt out.',
      );
    }
  },
  cleanup: (scenarioId: string) => {
    commitOffsetsCalls.delete(scenarioId);
    dispatchedScenarios.delete(scenarioId);
  },
});
