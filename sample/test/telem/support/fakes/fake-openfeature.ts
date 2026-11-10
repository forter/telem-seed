/**
 * In-memory OpenFeature fake — injected into require.cache as `@openfeature/server-sdk`
 * before dist/flags/index.js loads (same cache-injection pattern as mysql2/promise).
 *
 * Feature flags are inputs, not outputs, so there is no ownership safety net.
 * Flag state is sourced from the MySQL fake's topic_flags table — the same store
 * that PATCH /api/flags writes to and GET /api/flags reads from. blockTopic() seeds
 * a topic_flags row with blocked=1; getBooleanValue() reads it back via peekTopicFlagBlocked().
 *
 * Design: no strict undeclared-topic enforcement. This flag system is dynamic — the flag
 * key is the Kafka topic name, a runtime value. The defaultValue (false = not blocked) is
 * always the correct production default, so any unblocked topic is implicitly "declared"
 * via the SDK's own default. Only blocked topics require explicit declaration via blockTopic().
 * See COLLECTED-WISDOM.md § "Feature Flag Inventory" for the full rationale.
 */

import { currentScenarioId, INIT_SENTINEL } from '../scenario-context';
import { registerFake } from '../fake-registry';
import { seedTopicFlags, peekTopicFlagBlocked } from './fake-mysql';

/** Seed a topic as delivery-blocked for this scenario. Seeds a topic_flags row with blocked=1. */
export function blockTopic(scenarioId: string, topic: string): void {
  seedTopicFlags(scenarioId, [{ topic, blocked: 1 }]);
}

/**
 * Generic flag-declaration API for the Before hook template and permutation runner.
 * Maps to blockTopic() for value:true; value:false is a no-op (not-blocked is the default).
 */
export function declareFlag(
  scenarioId: string,
  flagName: string,
  config: { type: string; value: boolean | undefined },
): void {
  if (config.value === true) {
    blockTopic(scenarioId, flagName);
  }
}

/** Read declared flag state — used in step definitions to branch on flag value. */
export function isFlagEnabled(scenarioId: string, flagName: string): boolean {
  return peekTopicFlagBlocked(scenarioId, flagName);
}

function throwIfUnownedExist(_scenarioId: string): void {
  // Flag reads are inputs — nothing to assert ownership on.
}

function cleanup(_scenarioId: string): void {
  // Topic flag state lives in the MySQL fake; it handles its own cleanup.
}

registerFake({ name: 'openfeature', throwIfUnownedExist, cleanup });

/** Shape injected as `@openfeature/server-sdk` into require.cache. */
export const openfeatureFake = {
  OpenFeature: {
    setProviderAndWait: async (_provider: unknown): Promise<void> => {},
    getClient: () => ({
      getBooleanValue: async (flagKey: string, defaultValue: boolean): Promise<boolean> => {
        const scenarioId = currentScenarioId();
        // Pass through during BeforeAll / app init — no scenario context yet.
        if (scenarioId === INIT_SENTINEL) return defaultValue;
        return peekTopicFlagBlocked(scenarioId, flagKey);
      },
    }),
  },
};
