import assert from 'assert';
import path from 'path';
import { After, Given, Then } from '@cucumber/cucumber';
import { takeOwnershipOfTimerDelays, type TimerDelay } from '../support/fakes/non-determinism';
import type { WebhooksWorld } from '../support/world';

// ── Retry limit ─────────────────────────────────────────────────────────────────
// deliver.ts reads WEBHOOK_MAX_ATTEMPTS once, at module load, so the limit is frozen for the whole run
// (COLLECTED-WISDOM.md). Production must not change for tests, so this step loads a second copy of that ONE
// leaf module under the requested limit and points the already-loaded module's `deliver` export at it —
// consumer.ts looks `deliver_1.deliver` up at call time, so it picks the copy up. The After hook puts the
// original back. Nothing else is reloaded (the fakes seeded in require.cache stay the same objects).

const DELIVER_MODULE = path.join(__dirname, '../../../dist/delivery/deliver');
const restoreDeliver = new Map<string, () => void>();

Given<WebhooksWorld>('deliveries are limited to {int} attempt(s)', function (limit: number) {
  assert.ok(limit >= 1, `The attempt limit must be at least 1 (deliver.ts clamps lower values to 1), got ${limit}.`);
  loadDeliverWithAttemptLimit(this, String(limit));
});

// The raw setting, exactly as an operator would write it in the environment — for the values deliver.ts has to
// interpret (`Math.max(1, parseInt(value || '6', 10))`) rather than a plain limit.
Given<WebhooksWorld>('the WEBHOOK_MAX_ATTEMPTS setting is {string}', function (raw: string) {
  loadDeliverWithAttemptLimit(this, raw);
});

function loadDeliverWithAttemptLimit(world: WebhooksWorld, raw: string): void {
  const cacheKey = require.resolve(DELIVER_MODULE);
  const loaded = require.cache[cacheKey];
  assert.ok(
    loaded,
    `dist/delivery/deliver is not loaded. Probable cause: the app was not loaded in BeforeAll. What to check: world.ts BeforeAll.`,
  );
  const originalDeliver = loaded.exports.deliver;
  const savedLimit = process.env.WEBHOOK_MAX_ATTEMPTS;

  delete require.cache[cacheKey];
  process.env.WEBHOOK_MAX_ATTEMPTS = raw;
  let copy: { deliver: typeof originalDeliver };
  try {
    copy = require(cacheKey);
  } finally {
    require.cache[cacheKey] = loaded;
    if (savedLimit === undefined) delete process.env.WEBHOOK_MAX_ATTEMPTS;
    else process.env.WEBHOOK_MAX_ATTEMPTS = savedLimit;
  }
  loaded.exports.deliver = copy.deliver;
  restoreDeliver.set(world.scenarioId, () => {
    loaded.exports.deliver = originalDeliver;
  });
}

After<WebhooksWorld>(function () {
  restoreDeliver.get(this.scenarioId)?.();
  restoreDeliver.delete(this.scenarioId);
});

// ── Backoff schedule ────────────────────────────────────────────────────────────

const SECONDS = /^(\d+)s$/;

// Claims the timers the retry loop set and asserts them against the expected schedule, in order. The
// schedule is a literal in the scenario, not computed from the production formula (that would restate
// the code under test). Each distinct delay is claimed by value because concurrent deliveries interleave
// their sleeps; the k-th expected occurrence of a delay is paired with the k-th timer of that delay and
// the pairs must be in the order the timers were set — which pins the sequence for a single delivery.
function parseSchedule(schedule: string): number[] {
  return schedule.split(',').map((token) => {
    const match = SECONDS.exec(token.trim());
    assert.ok(match, `"${token.trim()}" is not a whole number of seconds like "4s". What to check: the schedule in the scenario.`);
    return Number(match[1]) * 1000;
  });
}

Then<WebhooksWorld>('the retries should have waited {string} between attempts', function (schedule: string) {
  const expectedMs = parseSchedule(schedule);

  const claimed = new Map<number, TimerDelay[]>();
  for (const delayMs of new Set(expectedMs)) {
    claimed.set(delayMs, takeOwnershipOfTimerDelays(this.scenarioId, delayMs));
  }

  for (const [delayMs, timers] of claimed) {
    const expectedCount = expectedMs.filter((ms) => ms === delayMs).length;
    assert.strictEqual(
      timers.length,
      expectedCount,
      `Expected ${expectedCount} wait(s) of ${delayMs / 1000}s but the retry loop waited ${timers.length} time(s). ` +
        'Probable cause: RETRY_DELAYS in src/delivery/deliver.ts changed, or the number of attempts differs. ' +
        'What to check: the attempt limit the scenario configures and the delay formula.',
    );
  }

  const nextOfDelay = new Map<number, number>();
  const orders = expectedMs.map((delayMs) => {
    const index = nextOfDelay.get(delayMs) ?? 0;
    nextOfDelay.set(delayMs, index + 1);
    return claimed.get(delayMs)![index].order;
  });
  assert.deepStrictEqual(
    orders,
    [...orders].sort((a, b) => a - b),
    `The waits did not happen in the order "${schedule}". Probable cause: the delay index in the retry loop is wrong ` +
      '(e.g. shrinking or shifted delays). What to check: RETRY_DELAYS[attempt - 1] in src/delivery/deliver.ts.',
  );
});

// Several deliveries retrying at once (fan-out). Production does not order one delivery's sleeps against
// another's (that depends on how long each endpoint takes to fail), so only each delivery's own sequence is
// pinned: the timers, in the order they were set, must split into `count` copies of the schedule, each in order.
// A timer does not know its delivery, so it extends any copy whose next expected wait it is (copies at the same
// point are interchangeable).
Then<WebhooksWorld>('each of the {int} deliveries should have waited {string} between attempts', function (count: number, schedule: string) {
  const expectedMs = parseSchedule(schedule);
  const timers = [...new Set(expectedMs)]
    .flatMap((delayMs) => takeOwnershipOfTimerDelays(this.scenarioId, delayMs))
    .sort((a, b) => a.order - b.order);
  assert.strictEqual(
    timers.length,
    count * expectedMs.length,
    `Expected ${count} × "${schedule}" = ${count * expectedMs.length} waits but the retry loops waited ${timers.length} time(s) ` +
      `(${timers.map((t) => t.delayMs / 1000 + 's').join(', ')}). What to check: the attempt limit and RETRY_DELAYS in src/delivery/deliver.ts.`,
  );
  const position = Array.from({ length: count }, () => 0);
  for (const timer of timers) {
    const chain = position.findIndex((p) => expectedMs[p] === timer.delayMs);
    assert.ok(
      chain >= 0,
      `A ${timer.delayMs / 1000}s wait came before any delivery was due for it: the waits ` +
        `${timers.map((t) => t.delayMs / 1000 + 's').join(', ')} do not split into ${count} in-order copies of "${schedule}". ` +
        'Probable cause: the delay index in the retry loop is wrong. What to check: RETRY_DELAYS[attempt - 1] in src/delivery/deliver.ts.',
    );
    position[chain]++;
  }
});
