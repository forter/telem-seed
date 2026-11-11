import assert from 'assert';
import path from 'path';
import { Given, When, Then } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import * as fakeDb from '../support/fakes/fake-db';
import { removeTopicFlagFromState, takeOwnershipOfDeliveryLogsForSubscriber, type DeliveryAttempt } from '../support/fakes/fake-db';
import { useRealFlagsProvider } from '../support/fakes/fake-openfeature';
import { advanceVirtualClock } from '../support/fakes/non-determinism';

// The app's own flags module: initFlags() constructs the real MySqlFlagsProvider and hands it to the SDK.
const flagsModulePath = path.join(__dirname, '../../../dist/flags/index');

// Pinned literal for the injected MySQL failure, so the startup assertion doesn't read it back from the error.
const FLAG_CACHE_MYSQL_ERROR = 'connect ECONNREFUSED 127.0.0.1:3306';

async function startPlatformFlags(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flags = require(flagsModulePath) as { initFlags(): Promise<void> };
  await flags.initFlags();
}

// ── Given ─────────────────────────────────────────────────────────────────────

Given<WebhooksWorld>('the platform evaluates delivery flags through its MySQL flag cache', function () {
  useRealFlagsProvider(this.scenarioId);
});

Given<WebhooksWorld>('the platform has started', async function () {
  await startPlatformFlags();
});

Given<WebhooksWorld>('the flag cache cannot reach MySQL from now on', function () {
  this.failFake(fakeDb, 'pool.query', [new Error(FLAG_CACHE_MYSQL_ERROR)]);
});

Given<WebhooksWorld>('the flag cache cannot reach MySQL on its next reload only', function () {
  this.failFake(fakeDb, 'pool.query', [new Error(FLAG_CACHE_MYSQL_ERROR), null]);
});

// ── When ─────────────────────────────────────────────────────────────────────

When<WebhooksWorld>('the platform starts', async function () {
  try {
    await startPlatformFlags();
    this.thrownError = null;
  } catch (err) {
    this.thrownError = err as Error;
  }
});

When<WebhooksWorld>('{int} second(s) pass(es)', async function (seconds: number) {
  await advanceVirtualClock(this.scenarioId, seconds * 1000);
});

When<WebhooksWorld>('{int} millisecond(s) pass(es)', async function (ms: number) {
  await advanceVirtualClock(this.scenarioId, ms);
});

// The no-change arm of the out-of-band edit (the belt outline crosses it with the delete below).
// eslint-disable-next-line @typescript-eslint/no-empty-function
When<WebhooksWorld>('the flag row for topic {string} is left as it is', function (_topic: string) {});

// No API deletes a topic_flags row; this is an operator editing MySQL by hand.
When<WebhooksWorld>('the flag row for topic {string} is deleted directly in the database', function (topic: string) {
  removeTopicFlagFromState(this.scenarioId, topic);
});

// ── Then ─────────────────────────────────────────────────────────────────────

Then<WebhooksWorld>('flag initialization should have failed with the MySQL error', function () {
  assert.ok(
    this.thrownError,
    'Expected initFlags() to reject when the flag cache cannot load, but it resolved. ' +
      'Probable cause: MySqlFlagsProvider.initialize() no longer awaits its first load, or the SDK fake swallowed the error. ' +
      'What to check: src/flags/MySqlFlagsProvider.ts initialize() and setRealProviderAndWait() in fake-openfeature.ts.',
  );
  assert.strictEqual(
    this.thrownError.message,
    FLAG_CACHE_MYSQL_ERROR,
    `initFlags() rejected with an unexpected error: ${this.thrownError.message}. ` +
      'What to check: that the startup failure is the MySQL error from the cache load, not a harness error.',
  );
});

// Mirror of 'the deliveries for subscriber … logged as successful … and then blocked …' (flags.steps.ts):
// the first message was suppressed, the second delivered. Each row is expected with its own message's payload. [delivery-log]
Then<WebhooksWorld>(
  'the deliveries for subscriber {int} should have been logged as blocked with key {string} and then successful with key {string} [delivery-log]',
  function (subscriberId: number, blockedKey: string, deliveredKey: string) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    const expected: DeliveryAttempt[] = [
      {
        subscriber_id: subscriberId,
        message_key: blockedKey,
        payload: this.payloadSentWithKey(blockedKey),
        attempt_number: 1,
        status: 'blocked',
        http_status: null,
        error_message: null,
      },
      {
        subscriber_id: subscriberId,
        message_key: deliveredKey,
        payload: this.payloadSentWithKey(deliveredKey),
        attempt_number: 1,
        status: 'success',
        http_status: 200,
        error_message: null,
      },
    ];
    assert.deepStrictEqual(
      logs,
      expected,
      `Delivery log for subscriber ${subscriberId} did not show one blocked then one successful entry. ` +
        'Probable cause: the flag cache reloaded earlier or later than expected, or did not replace its contents. ' +
        'What to check: the time-passing steps, MySqlFlagsProvider.loadCache(), and the 5 s ttlMs. ' +
        `Got: ${JSON.stringify(logs)}`,
    );
  },
);
