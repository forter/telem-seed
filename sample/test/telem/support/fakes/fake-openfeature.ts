/**
 * In-memory OpenFeature fake — injected into require.cache as `@openfeature/server-sdk`
 * before dist/flags/index.js loads (same cache-injection pattern as mysql2/promise).
 *
 * It stands in for the SDK AND, by default, for MySqlFlagsProvider (never constructed or run, unless a
 * scenario calls useRealFlagsProvider()): a lookup answers from the database fake's topic_flags rows
 * (fake-db.ts) — the same store that
 * PATCH /api/flags writes to and GET /api/flags reads from. blockTopic() seeds a topic_flags row with
 * blocked=1; getBooleanValue() reads it back via peekTopicFlag().
 *
 * Feature flags are inputs, not outputs, so there is no ownership safety net.
 *
 * Semantics verified against the REAL SDK + real MySqlFlagsProvider on MySQL (fake-db.parity.ts):
 *  - a managed topic answers with its stored blocked value, ignoring the caller's default; an
 *    unmanaged topic answers with the caller's default; the lookup is exact-case;
 *  - a provider that throws while evaluating does NOT reject getBooleanValue — the SDK swallows the
 *    error and answers with the caller's default. fail() reproduces that.
 *  Not modelled: the provider's 5 s cache refresh (the fake answers instantly) — unless a scenario opts
 *  into the real provider with useRealFlagsProvider() (see below).
 *
 * Design: no strict undeclared-topic enforcement. This flag system is dynamic — the flag
 * key is the Kafka topic name, a runtime value. The defaultValue (false = not blocked) is
 * always the correct production default, so any unblocked topic is implicitly "declared"
 * via the SDK's own default. Only blocked topics require explicit declaration via blockTopic().
 * See COLLECTED-WISDOM.md § "Feature Flag Inventory" for the full rationale.
 */

import { currentScenarioId, INIT_SENTINEL } from '../scenario-context';
import { registerFake } from '../fake-registry';
import { seedTopicFlags, peekTopicFlag, peekTopicFlagBlocked, enableTopicFlagsPool } from './fake-db';
import { useVirtualIntervals } from './non-determinism';

/** Seed a topic as delivery-blocked for this scenario. Seeds a topic_flags row with blocked=1. */
export function blockTopic(scenarioId: string, topic: string): void {
  seedTopicFlags(scenarioId, [{ topic, blocked: true }]);
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

// ---- Failure injection: fail(scenarioId, operation, sequence) ----
// One declared operation. fail() takes a per-call `sequence` of outcomes (an Error/zero-arg factory
// for "the provider throws during evaluation", or null for "evaluates normally"), advanced one
// entry per getBooleanValue call, the last entry repeating past the end ([err] = always fails,
// [err, null] = fail once then recover). The SDK swallows the error, so a failing call answers with
// the caller's default rather than throwing — the injected error is never visible to production code.

export const OPENFEATURE_OPERATIONS = ['openfeature.getBooleanValue'] as const;
export type OpenFeatureOperation = (typeof OPENFEATURE_OPERATIONS)[number];

type Outcome = Error | (() => Error) | null;
interface FailState {
  sequence: Outcome[];
  index: number;
}
const failConfig = new Map<string, Map<OpenFeatureOperation, FailState>>();

function checkOperation(operation: string): asserts operation is OpenFeatureOperation {
  if (!(OPENFEATURE_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(
      `[fake-openfeature] Unknown operation "${operation}". ` +
        `Declared operations: ${OPENFEATURE_OPERATIONS.join(', ')}. ` +
        'Fix: use one of the declared operation names (this catches typos at setup).',
    );
  }
}

/**
 * Make flag evaluation fail for this scenario: the (fake) provider throws, so the SDK answers with
 * the caller's default value.
 *
 * @example — the first evaluation fails, later ones recover:
 * fail(this.scenarioId, 'openfeature.getBooleanValue', [new Error('provider down'), null]);
 */
export function fail(scenarioId: string, operation: OpenFeatureOperation, sequence: Outcome[]): void {
  checkOperation(operation);
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-openfeature] fail() sequence for "${operation}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(operation, { sequence, index: 0 });
}

/** True when the next call to this operation would fail (does not advance the sequence). */
export function isConfiguredToFail(scenarioId: string, operation: OpenFeatureOperation): boolean {
  checkOperation(operation);
  const fs = failConfig.get(scenarioId)?.get(operation);
  return !!fs && fs.sequence[Math.min(fs.index, fs.sequence.length - 1)] !== null;
}

/** Advance this operation's sequence one step; true when the current outcome is a failure. */
function nextCallFails(scenarioId: string, operation: OpenFeatureOperation): boolean {
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return false;
  const outcome = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  return outcome !== null;
}

// ---- Opt-in: run the real MySqlFlagsProvider behind this fake ----
// By default this fake answers from fake-db's rows directly, so the provider (its `blocked === 1` mapping,
// its 5 s TTL cache, stale-on-refresh-failure, initFlags() being fatal) never runs. A scenario that calls
// useRealFlagsProvider() instead gets the SDK behaviour the provider depends on, reproduced from
// @openfeature/server-sdk (OpenFeatureAPI.setAwaitableProvider / client evaluation):
//  - setProviderAndWait(p) closes a different previous provider, awaits p.initialize(), and rethrows its error
//    (the provider is then in ERROR status, which still serves evaluations — only NOT_READY/FATAL do not);
//  - getBooleanValue(key, dflt) answers the provider's resolveBooleanEvaluation value, or dflt when no provider
//    is ready or the provider throws.
// The provider reads through fake-db's opt-in pool (enableTopicFlagsPool) and refreshes on the virtual clock
// (non-determinism useVirtualIntervals / advanceVirtualClock), so a scenario can move time instead of sleeping.

interface ProviderLike {
  initialize?: () => Promise<void>;
  onClose?: () => Promise<void>;
  resolveBooleanEvaluation: (key: string, dflt: boolean, ctx: object, logger: unknown) => Promise<{ value: boolean }>;
}
interface InstalledProvider {
  provider: ProviderLike;
  status: 'NOT_READY' | 'READY' | 'ERROR' | 'FATAL';
}
const realProviderScenarios = new Set<string>();
const installedProviders = new Map<string, InstalledProvider>();

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

export function useRealFlagsProvider(scenarioId: string): void {
  realProviderScenarios.add(scenarioId);
  enableTopicFlagsPool(scenarioId);
  useVirtualIntervals(scenarioId);
}

async function setRealProviderAndWait(scenarioId: string, provider: ProviderLike): Promise<void> {
  const previous = installedProviders.get(scenarioId);
  if (previous?.provider === provider) return;
  const installed: InstalledProvider = { provider, status: 'NOT_READY' };
  // As in @openfeature/core setAwaitableProvider: start initialize(), install the new provider, then close the
  // old one without awaiting it (a failing onClose is only logged), and only then await the initialization.
  const initialization = provider.initialize?.();
  installedProviders.set(scenarioId, installed);
  previous?.provider.onClose?.()?.catch(() => {});
  try {
    await initialization;
    installed.status = 'READY';
  } catch (err) {
    installed.status = (err as { code?: string })?.code === 'PROVIDER_FATAL' ? 'FATAL' : 'ERROR';
    throw err;
  }
}

async function evaluateWithRealProvider(scenarioId: string, flagKey: string, defaultValue: boolean): Promise<boolean> {
  const installed = installedProviders.get(scenarioId);
  if (!installed || installed.status === 'NOT_READY' || installed.status === 'FATAL') return defaultValue;
  try {
    return (await installed.provider.resolveBooleanEvaluation(flagKey, defaultValue, {}, silentLogger)).value;
  } catch {
    return defaultValue;
  }
}

function throwIfUnownedExist(_scenarioId: string): void {
  // Flag reads are inputs — nothing to assert ownership on.
}

function cleanup(scenarioId: string): void {
  // Topic flag state lives in the database fake; fake-db handles its own cleanup.
  failConfig.delete(scenarioId);
  // The provider's refresh interval dies with the scenario's virtual clock (non-determinism cleanup).
  realProviderScenarios.delete(scenarioId);
  installedProviders.delete(scenarioId);
}

registerFake({ name: 'openfeature', throwIfUnownedExist, cleanup });

/** Shape injected as `@openfeature/server-sdk` into require.cache. */
export const openfeatureFake = {
  OpenFeature: {
    /**
     * SDK setProviderAndWait. Default: no-op (the fake answers from fake-db rows). After useRealFlagsProvider():
     * awaits provider.initialize() and rethrows its error, leaving the provider in ERROR (or FATAL for a
     * PROVIDER_FATAL code). Provenance: OpenFeatureAPI.setAwaitableProvider in @openfeature/core 1.x.
     */
    setProviderAndWait: async (provider: unknown): Promise<void> => {
      const scenarioId = currentScenarioId();
      if (realProviderScenarios.has(scenarioId)) await setRealProviderAndWait(scenarioId, provider as ProviderLike);
    },
    getClient: () => ({
      /**
       * SDK client getBooleanValue. Documented behaviour reproduced: never rejects; a managed topic answers its
       * stored value, an unmanaged one the caller's default, a throwing provider the default (fail()), and a
       * NOT_READY/FATAL provider the default. Exact-case lookup. Provenance: the default path (answering from rows)
       * is compared with the real SDK + provider in parity-tests/fake-db.parity.ts (flags cases). The
       * useRealFlagsProvider() path is reproduced from the @openfeature/core source and is not parity-run; its
       * NOT_READY/FATAL arms are not reached by any scenario (initFlags() awaits init; the provider never throws FATAL).
       */
      getBooleanValue: async (flagKey: string, defaultValue: boolean): Promise<boolean> => {
        const scenarioId = currentScenarioId();
        // Pass through during BeforeAll / app init — no scenario context yet.
        if (scenarioId === INIT_SENTINEL) return defaultValue;
        if (nextCallFails(scenarioId, 'openfeature.getBooleanValue')) return defaultValue;
        if (realProviderScenarios.has(scenarioId)) return evaluateWithRealProvider(scenarioId, flagKey, defaultValue);
        return peekTopicFlag(scenarioId, flagKey) ?? defaultValue;
      },
    }),
  },
};
