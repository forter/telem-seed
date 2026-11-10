import assert from 'assert';
import { BeforeAll, Before, After, Then } from '@cucumber/cucumber';
import { throwIfAnyUnownedExist, cleanupScenario } from '../support/fake-registry';
import { declareFlag } from '../support/fakes/fake-openfeature';
import { wasKafkaDispatched, takeOwnershipOfCommitOffsets } from '../support/fakes/fake-kafka';
import type { WebhooksWorld } from '../support/world';

// Loaded at runtime (deferred) to avoid a circular import:
// features/defaults.ts imports assertNoUnownedChanges from here, so this file must be
// fully loaded before features/defaults.ts is resolved. A static top-level import would
// create a partial-module cycle. Runtime require in BeforeAll is the correct break point.
// eslint-disable-next-line @typescript-eslint/no-require-imports
let activeDefaults: { arrange?: { baselineFlags?: Record<string, boolean> }; assert?: Record<string, (this: WebhooksWorld) => void> } | undefined;
let flagManifest: Record<string, { flags?: Record<string, string[]>; excluded?: Record<string, string> }> = {};

// Single deployment environment — no region/DR detection needed.
const MANIFEST_ENV = 'default';
const FEATURES_DIR = 'test/telem/features/';
const UNOWNED_IO_ASSERTION = 'No unowned IO changes should remain';

BeforeAll(function () {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  activeDefaults = require('../features/defaults').default;
  // Fail loud if the wrong defaults module was resolved. `require('../features/defaults')`
  // is caller-context-dependent: a tsx-hooked .ts caller (this file) resolves defaults.ts,
  // but a plain-JS caller would resolve the sibling defaults.js audit stub (empty assert),
  // silently disabling the unowned-IO safety net. This guard converts that into a hard error.
  if (!activeDefaults?.assert?.[UNOWNED_IO_ASSERTION]) {
    throw new Error(
      `defaults module is missing the '${UNOWNED_IO_ASSERTION}' auto-assertion — ` +
        'the ownership safety net would be disabled. Did the audit stub (features/defaults.js) ' +
        'get resolved instead of features/defaults.ts?',
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
 * Auto-default: every scenario that dispatched a Kafka message must commit its offset exactly
 * once (the at-least-once guarantee — a committed offset means the message was processed and won't
 * be redelivered). Claiming ownership here removes read-only count inspection from step definitions.
 * Failure-path scenarios where the handler is expected to throw opt out via
 * "the Kafka offset should not have been committed", which relies on the ownership net for absence.
 */
export function assertKafkaOffsetCommitted(this: WebhooksWorld): void {
  if (!wasKafkaDispatched(this.scenarioId)) return; // HTTP-only scenarios never touch the consumer
  const count = takeOwnershipOfCommitOffsets(this.scenarioId);
  assert.strictEqual(
    count,
    1,
    `Expected exactly one Kafka offset commit (at-least-once: offset committed → message processed) ` +
      `but got ${count}. Probable cause: handleMessage() committed more than once, or a retry path ` +
      `re-committed. What to check: the commitOffsets call at the end of src/kafka/consumer.ts handleMessage().`,
  );
}

// Single After hook — replaces the one in world.ts (which must be removed).
// Ordering within this body is guaranteed:
//   1. Auto-default ownership claims (including assertNoUnownedChanges last)
//   2. Per-scenario cleanup — always runs via finally, even when an assertion throws.
//      Without the finally, a failing assertion would skip cleanup and leave stale state
//      (e.g. fail() failure config) that bleeds into the next scenario when the
//      non-determinism fake re-issues the same deterministic scenarioId.
After(function (this: WebhooksWorld) {
  try {
    if (activeDefaults?.assert) {
      for (const [text, handler] of Object.entries(activeDefaults.assert)) {
        if (!this._skippedDefaults?.has(text)) {
          handler.call(this);
        }
      }
    }
  } finally {
    cleanupScenario(this.scenarioId);
  }
});

// Opt-out step — temporary escape hatch while scenarios are incrementally brought under
// the ownership model. Track usage and aim to eliminate.
Then('we might have unowned IO changes', function (this: WebhooksWorld) {
  if (!this._skippedDefaults) this._skippedDefaults = new Set();
  this._skippedDefaults.add('No unowned IO changes should remain');
});
