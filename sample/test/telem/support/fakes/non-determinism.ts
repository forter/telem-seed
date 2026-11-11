// Non-determinism fakes — control sources of randomness and time in the BDD harness.
//
// Three sources in this repo:
//   1. crypto.randomUUID() — deliver.ts X-Delivery-Id header
//   2. setTimeout — deliver.ts exponential backoff sleep between retries
//   3. setInterval — MySqlFlagsProvider's 5 s cache refresh (a virtual clock, opt-in per scenario)
//
// These are patched at module load (world.ts imports this). None of the patches affects real IO.
//
// The setTimeout patch runs every in-scenario timer at 0 ms (a 30 s backoff makes retry scenarios
// unusable) but RECORDS the delay production asked for, and that record goes through the ownership model
// like any other effect: the backoff schedule is observable behaviour, so a scenario that retries must
// claim it (takeOwnershipOfTimerDelays) and an unclaimed timer fails the scenario.
//
// No discriminator tells the retry sleeps from other timers: deliver.ts's sleep() is the only setTimeout set
// inside a scenario (supertest, express, cucumber and the other fakes set none). A future dependency's timer
// shows up as an unowned timer with its delay, rather than being filtered out.
//
// Known divergence (intentional): at 0 ms the relative order of CONCURRENT timers collapses to the order
// they were registered in, where real timers fire shortest-delay first. A single delivery's retries are a
// strict sequence, so only interleaving between concurrent fan-out deliveries can differ.

import crypto from 'crypto';
import { currentScenarioId, INIT_SENTINEL } from '../scenario-context';
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

// ---- setTimeout — zero-delay in test scenarios, requested delay recorded ----
// deliver.ts sleep(): return new Promise((resolve) => setTimeout(resolve, ms))
// Real delays (up to 30 s) make retry scenarios unusably slow. Inside a Cucumber scenario,
// reduce all delays to 0 so the retry loop completes in milliseconds.

/** One timer set during a scenario: the delay production asked for and its position among them. */
export interface TimerDelay {
  delayMs: number;
  /** 1-based position among this scenario's timers, in the order they were set. */
  order: number;
}

const timers = new Map<string, TimerDelay[]>();
const ownedTimers = new Map<string, Set<number>>();

/** The scenario id when a real scenario is running; null during app boot or outside any scenario. */
function activeScenarioId(): string | null {
  try {
    const id = currentScenarioId();
    return id === INIT_SENTINEL ? null : id;
  } catch {
    return null;
  }
}

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
  const scenarioId = activeScenarioId();
  if (scenarioId !== null) {
    const log = timers.get(scenarioId) ?? [];
    log.push({ delayMs: ms ?? 0, order: log.length + 1 });
    timers.set(scenarioId, log);
  }
  return originalSetTimeout(cb as TimerHandler, delay, ...args);
};

/**
 * Claim every unowned timer this scenario set with exactly `delayMs`, in the order they were set, and
 * return copies. Throws if there is none.
 *
 * The key is the delay itself: a timer does not know which subscriber or URL it belongs to, and two
 * concurrent deliveries interleave their sleeps, so "the 2nd timer" is not stable but "the timers of
 * 4000 ms" is. `order` lets a step assert the sequence for a single delivery.
 */
export function takeOwnershipOfTimerDelays(scenarioId: string, delayMs: number): TimerDelay[] {
  const log = timers.get(scenarioId) ?? [];
  const owned = ownedTimers.get(scenarioId) ?? new Set<number>();
  ownedTimers.set(scenarioId, owned);

  const claimed: TimerDelay[] = [];
  log.forEach((timer, i) => {
    if (timer.delayMs === delayMs && !owned.has(i)) {
      owned.add(i);
      claimed.push(structuredClone(timer));
    }
  });
  if (claimed.length === 0) {
    const unowned = log.filter((_, i) => !owned.has(i)).map((t) => t.delayMs);
    throw new Error(
      `[non-determinism] No unowned timer of ${delayMs} ms in scenario ${scenarioId}. ` +
        `Unowned timers: ${unowned.length === 0 ? 'none' : unowned.join(', ') + ' ms'}. ` +
        'Probable cause: the retry loop in deliver.ts slept for a different delay (or not at all), or this delay was already claimed. ' +
        'Fix: check RETRY_DELAYS in src/delivery/deliver.ts and the number of attempts the scenario configures.',
    );
  }
  return claimed;
}

// ---- setInterval — a virtual clock, opt-in per scenario ----
// MySqlFlagsProvider refreshes its cache on setInterval(5000). A real interval would outlive its scenario
// and fire into whichever scenario runs next, and waiting 5 s is not an option. A scenario that opts in
// (useVirtualIntervals) gets intervals that only fire when it advances its own clock (advanceVirtualClock).
// Every other scenario, and setup outside scenarios, gets the real setInterval, unchanged.

interface VirtualInterval {
  cb: () => void;
  periodMs: number;
  nextAtMs: number;
  cleared: boolean;
}
interface VirtualClock {
  nowMs: number;
  intervals: VirtualInterval[];
}
const virtualClocks = new Map<string, VirtualClock>();

export function useVirtualIntervals(scenarioId: string): void {
  if (!virtualClocks.has(scenarioId)) virtualClocks.set(scenarioId, { nowMs: 0, intervals: [] });
}

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).setInterval = function fakeSetInterval(cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const scenarioId = activeScenarioId();
  const clock = scenarioId === null ? undefined : virtualClocks.get(scenarioId);
  if (!clock) return originalSetInterval(cb as TimerHandler, ms, ...args);
  if (clock.intervals.some((i) => !i.cleared)) {
    throw new Error(
      `[non-determinism] A second virtual setInterval in scenario ${scenarioId}. ` +
        'Probable cause: the platform was started twice, or new production code sets its own interval. ' +
        'Fix: start the platform once per scenario, or teach the virtual clock to tell the intervals apart.',
    );
  }
  const periodMs = Math.max(1, ms ?? 0); // Node clamps a 0/undefined interval to 1 ms
  const handle: VirtualInterval = { cb: () => cb(...args), periodMs, nextAtMs: clock.nowMs + periodMs, cleared: false };
  clock.intervals.push(handle);
  // Mirror the NodeJS.Timeout surface so a production .unref() doesn't throw only under BDD.
  return Object.assign(handle, {
    ref: () => handle,
    unref: () => handle,
    hasRef: () => true,
    refresh: () => handle,
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).clearInterval = function fakeClearInterval(handle: unknown) {
  for (const clock of virtualClocks.values()) {
    const v = clock.intervals.find((i) => i === handle);
    if (v) {
      v.cleared = true;
      return;
    }
  }
  return originalClearInterval(handle as Parameters<typeof clearInterval>[0]);
};

/**
 * Move this scenario's virtual clock forward, firing every due interval in time order (an interval due
 * several times fires several times). After each firing the event loop is drained once, so the async work
 * the callback started (the provider's cache load against the in-memory DB fake) has settled before the
 * next firing or the next step.
 */
export async function advanceVirtualClock(scenarioId: string, ms: number): Promise<void> {
  const clock = virtualClocks.get(scenarioId);
  if (!clock) {
    throw new Error(
      `[non-determinism] advanceVirtualClock: scenario ${scenarioId} has no virtual clock. ` +
        'Probable cause: the scenario moves time without having opted into virtual intervals (e.g. a missing ' +
        '"the platform evaluates delivery flags through its MySQL flag cache" Given). ' +
        'Fix: call useVirtualIntervals(scenarioId) before production code sets its interval.',
    );
  }
  const target = clock.nowMs + ms;
  for (;;) {
    const due = clock.intervals.filter((i) => !i.cleared && i.nextAtMs <= target).sort((a, b) => a.nextAtMs - b.nextAtMs)[0];
    if (!due) break;
    clock.nowMs = due.nextAtMs;
    due.nextAtMs += due.periodMs;
    due.cb();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  clock.nowMs = target;
}

// ---- Registry ----
registerFake({
  name: 'non-determinism',
  throwIfUnownedExist: (scenarioId: string) => {
    const log = timers.get(scenarioId) ?? [];
    const owned = ownedTimers.get(scenarioId) ?? new Set<number>();
    const unowned = log.filter((_, i) => !owned.has(i));
    if (unowned.length > 0) {
      throw new Error(
        `[non-determinism] ${unowned.length} timer(s) were set but never owned in scenario ${scenarioId} ` +
          `(delays: ${unowned.map((t) => `${t.delayMs} ms`).join(', ')}). ` +
          'Probable cause: a retrying delivery slept between attempts and no Then step claimed the backoff schedule. ' +
          'Fix: add "the retries should have waited … between attempts" to the scenario.',
      );
    }
  },
  cleanup: (scenarioId: string) => {
    uuidCounters.delete(scenarioId);
    timers.delete(scenarioId);
    ownedTimers.delete(scenarioId);
    virtualClocks.delete(scenarioId); // its intervals can never fire again
  },
});
