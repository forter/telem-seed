// Non-determinism fakes — control sources of randomness and time in the BDD harness.
//
// Two sources in this repo (per BOOTSTRAP_REPORT.md):
//   1. crypto.randomUUID() — used in deliver.ts for X-Delivery-Id header
//   2. setTimeout — used in deliver.ts for exponential backoff sleep between retries
//
// These are patched at module load (world.ts imports this). Neither patch affects real IO;
// no ownership tracking is needed — only cleanup of per-scenario UUID counter state.

import crypto from 'crypto';
import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// ---- crypto.randomUUID ----
// deliver.ts compiled output: `const crypto_1 = require('crypto'); (0, crypto_1.randomUUID)()`
// crypto_1 IS the module object, so a property patch here is visible at call time.

const originalRandomUUID = crypto.randomUUID.bind(crypto);
const uuidCounters = new Map<string, number>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(crypto as any).randomUUID = function deterministicRandomUUID() {
  let scenarioId: string;
  try {
    scenarioId = currentScenarioId();
  } catch {
    // Outside a scenario (e.g., during app startup) — fall back to real UUID.
    return originalRandomUUID();
  }
  const count = (uuidCounters.get(scenarioId) ?? 0) + 1;
  uuidCounters.set(scenarioId, count);
  // Deterministic UUID shape: 00000000-0000-4000-8000-{zero-padded counter}
  return `00000000-0000-4000-8000-${count.toString(16).padStart(12, '0')}`;
};

// ---- setTimeout — zero-delay in test scenarios ----
// deliver.ts sleep(): return new Promise((resolve) => setTimeout(resolve, ms))
// Real delays (up to 30 s) make retry scenarios unusably slow. Inside a Cucumber scenario,
// reduce all delays to 0 so the retry loop completes in milliseconds.

const originalSetTimeout = globalThis.setTimeout;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).setTimeout = function fakeSetTimeout(
  cb: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) {
  let delay = ms;
  try {
    currentScenarioId(); // throws if outside a scenario
    delay = 0;
  } catch {
    delay = ms; // not in a scenario — use real delay (Cucumber hooks, setup)
  }
  return originalSetTimeout(cb as TimerHandler, delay, ...args);
};

// ---- Registry ----
// Non-determinism has no IO to own; cleanup just resets the UUID counter.
registerFake({
  name: 'non-determinism',
  throwIfUnownedExist: (_scenarioId: string) => {
    // No owned IO — nothing to check.
  },
  cleanup: (scenarioId: string) => {
    uuidCounters.delete(scenarioId);
  },
});
