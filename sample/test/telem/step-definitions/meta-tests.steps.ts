import assert from 'assert';
import { Given, Then } from '@cucumber/cucumber';
import { throwIfAnyUnownedExist } from '../support/fake-registry';
import { takeOwnershipOfSubscriberCreate, failAllDb } from '../support/fakes/fake-db';
import {
  dispatchKafkaMessage,
  takeOwnershipOfCommittedOffsets,
  fail as failKafka,
  isConfiguredToFail as kafkaConfiguredToFail,
  type KafkaOperation,
} from '../support/fakes/fake-kafka';
import {
  openfeatureFake,
  fail as failFlags,
  isConfiguredToFail as flagsConfiguredToFail,
  type OpenFeatureOperation,
} from '../support/fakes/fake-openfeature';
import { fail as failFetch, fetchFailedError, seedResponse as seedFetchResponse, takeOwnershipOfDeliveriesForUrl } from '../support/fakes/fake-fetch';
import type { WebhooksWorld } from '../support/world';

Given('a subscriber is created via the API without claiming ownership', async function (this: WebhooksWorld) {
  // POST /api/subscribers — writes to the database fake (one unowned subscribers.create).
  // Intentionally NOT claiming ownership here — the Then step verifies the check catches it.
  const res = await this.request
    .post('/api/subscribers')
    .send({ name: 'Meta Test Sub', topic: 'meta-test', url: 'https://meta.example.com/wh' });
  assert.strictEqual(
    res.status, 201,
    `POST /api/subscribers returned ${res.status}. Check that the database fake is wired and db.connect() was called in BeforeAll. Response: ${JSON.stringify(res.body)}`,
  );
});

Given('the MySQL fake is configured to fail', function (this: WebhooksWorld) {
  failAllDb(this.scenarioId, [new Error('Injected DB failure')]);
});

Then('the unowned IO check catches the unclaimed subscriber write', function (this: WebhooksWorld) {
  // Verify the check throws before ownership is claimed.
  let caught: Error | undefined;
  try {
    throwIfAnyUnownedExist(this.scenarioId);
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(
    caught !== undefined,
    'throwIfAnyUnownedExist did not throw. Probable cause: fake-registry not wired or create not captured. Check that fake-db registered itself and the POST route ran.',
  );
  assert.ok(
    caught.message.toLowerCase().includes('subscriber insert') || caught.message.toLowerCase().includes('insert'),
    `Error message did not mention a subscriber insert. Got: "${caught.message}". Check fake-db's throwIfUnownedExist reports subscriber inserts.`,
  );
  // Claim ownership now so the After hook does not throw a second time (by the URL POSTed above).
  takeOwnershipOfSubscriberCreate(this.scenarioId, 'https://meta.example.com/wh');
});

// ── Kafka fake ────────────────────────────────────────────────────────────────

Given('a Kafka message is dispatched without claiming its offset commit', async function (this: WebhooksWorld) {
  // No subscribers for the topic: the only IO is the offset commit. Intentionally NOT claimed here — the
  // Then step verifies the net sees it; the commit auto-default claims it afterwards in the After hook.
  await dispatchKafkaMessage('meta-topic', 'meta', null, { partition: 4, offset: '9' });
});

Then('the unowned IO check catches the unclaimed offset commit', function (this: WebhooksWorld) {
  let caught: Error | undefined;
  try {
    throwIfAnyUnownedExist(this.scenarioId);
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(
    caught !== undefined,
    'throwIfAnyUnownedExist did not throw. Probable cause: fake-kafka did not register with the fake registry or the stub did not record the commit.',
  );
  assert.ok(
    caught.message.includes('offset commit') && caught.message.includes('meta-topic'),
    `Error message did not name the unclaimed offset commit and its topic. Got: "${caught.message}".`,
  );
});

Given('committing the Kafka offset fails once and then recovers', function (this: WebhooksWorld) {
  failKafka(this.scenarioId, 'kafka.commitOffsets', [new Error('Injected commit failure'), null]);
  assert.strictEqual(
    kafkaConfiguredToFail(this.scenarioId, 'kafka.commitOffsets'),
    true,
    'isConfiguredToFail should be true before the first commit. Probable cause: fail() did not store the sequence.',
  );
});

Then(
  'the first commit attempt failed and the second succeeded for topic {string} partition {int}',
  function (this: WebhooksWorld, topic: string, partition: number) {
    // Both attempts are in the log (the failed one is recorded before the failure fires), in call order.
    assert.deepStrictEqual(takeOwnershipOfCommittedOffsets(this.scenarioId, topic, partition), [
      { topic, partition, offset: '11', failed: true },
      { topic, partition, offset: '12', failed: false },
    ]);
    assert.strictEqual(
      kafkaConfiguredToFail(this.scenarioId, 'kafka.commitOffsets'),
      false,
      'isConfiguredToFail should be false once the sequence has recovered (the last entry, null, repeats).',
    );
    // This scenario owns its commits itself; the generic offset+1 auto-default has nothing left to claim.
    this._skippedDefaults = (this._skippedDefaults ?? new Set()).add('Kafka offset is committed after a dispatched message');
  },
);

Then('configuring failure for an undeclared Kafka operation is rejected', function (this: WebhooksWorld) {
  assert.throws(
    () => failKafka(this.scenarioId, 'kafka.commitOfsets' as KafkaOperation, [new Error('typo')]),
    /Unknown operation "kafka\.commitOfsets".*kafka\.commitOffsets/,
    'fail() must reject an undeclared operation name at setup and list the declared ones.',
  );
});

const FLAG_OPERATION: OpenFeatureOperation = 'openfeature.getBooleanValue';

// The failed evaluation answers the caller's default (false) even though the topic is blocked; a
// healthy one answers the blocked state (true) — that difference is how these steps see the outcome.
Then(
  'the flag evaluation for topic {string} reports its injected failure until it is consumed',
  async function (this: WebhooksWorld, topic: string) {
    const client = openfeatureFake.OpenFeature.getClient();
    assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), true,
      'isConfiguredToFail should be true before the first evaluation. Probable cause: fail() did not store the sequence.');
    assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), true,
      'isConfiguredToFail advanced the sequence. Probable cause: it consumes an outcome instead of peeking.');

    assert.strictEqual(await client.getBooleanValue(topic, false), false,
      'The first evaluation should have failed and answered the default (false), not the blocked state.');
    assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), false,
      'isConfiguredToFail should be false once the sequence has recovered (the last entry, null, repeats).');
    assert.strictEqual(await client.getBooleanValue(topic, false), true,
      'The second evaluation should have recovered and answered the blocked state (true).');
    // Past the end of the sequence the last entry (null) repeats; reading beyond it must not look like a failure.
    assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), false,
      'isConfiguredToFail should stay false after the sequence ran past its end. Probable cause: it reads the sequence without repeating the last entry.');
  },
);

Then(
  'the flag evaluation for topic {string} keeps failing across repeated evaluations',
  async function (this: WebhooksWorld, topic: string) {
    const client = openfeatureFake.OpenFeature.getClient();
    for (let call = 1; call <= 3; call++) {
      assert.strictEqual(await client.getBooleanValue(topic, false), false,
        `Evaluation ${call} should have failed and answered the default (false). Probable cause: the last sequence entry stopped repeating.`);
      assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), true,
        `isConfiguredToFail should still be true after evaluation ${call}.`);
    }
  },
);

Then('no flag evaluation failure is reported for a scenario that configured none', function (this: WebhooksWorld) {
  assert.strictEqual(flagsConfiguredToFail(this.scenarioId, FLAG_OPERATION), false,
    'isConfiguredToFail should be false when no failure was configured. Probable cause: state leaked from another scenario.');
});

Then('no flag evaluation failure is reported for another scenario', function (this: WebhooksWorld) {
  assert.strictEqual(flagsConfiguredToFail('meta-tests-other-scenario', FLAG_OPERATION), false,
    'isConfiguredToFail reported a failure for a scenario that configured none. Probable cause: failure state is not keyed by scenario id.');
});

Then('configuring or querying failure for an undeclared flag operation is rejected', function (this: WebhooksWorld) {
  const typo = 'openfeature.getBoolValue' as OpenFeatureOperation;
  const message = /Unknown operation "openfeature\.getBoolValue".*openfeature\.getBooleanValue/;
  assert.throws(() => failFlags(this.scenarioId, typo, [new Error('typo')]), message,
    'fail() must reject an undeclared operation name at setup and list the declared ones.');
  assert.throws(() => flagsConfiguredToFail(this.scenarioId, typo), message,
    'isConfiguredToFail() must reject an undeclared operation name instead of silently answering false.');
});

Then('configuring a flag failure with an empty sequence is rejected', function (this: WebhooksWorld) {
  assert.throws(() => failFlags(this.scenarioId, FLAG_OPERATION, []), /non-empty array/,
    'fail() must reject an empty sequence: it would be indistinguishable from not configuring a failure.');
});

// ── fetch fake ────────────────────────────────────────────────────────────────

Given('a network failure is configured for a URL the app never requests', function (this: WebhooksWorld) {
  failFetch(this.scenarioId, 'https://never-requested.example.com/hook', [() => fetchFailedError({ code: 'ECONNREFUSED' })]);
});

Then('the unowned IO check catches the network failure that never fired', async function (this: WebhooksWorld) {
  let caught: Error | undefined;
  try {
    throwIfAnyUnownedExist(this.scenarioId);
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(
    caught !== undefined,
    'throwIfAnyUnownedExist did not throw. Probable cause: fake-fetch no longer reports a configured failure nothing requested.',
  );
  assert.ok(
    caught.message.includes('never-requested.example.com') && caught.message.includes('nothing requested it'),
    `Error message did not name the URL whose failure never fired. Got: "${caught.message}".`,
  );
  // Fire the failure now so the After hook's own check finds nothing left over — the request is recorded
  // before the error is thrown, so own it too.
  await assert.rejects(fetch('https://never-requested.example.com/hook'), { name: 'TypeError', message: 'fetch failed' });
  assert.deepStrictEqual(
    takeOwnershipOfDeliveriesForUrl(this.scenarioId, 'https://never-requested.example.com/hook'),
    [{ url: 'https://never-requested.example.com/hook', method: 'GET', headers: {}, body: '' }],
    'fake-fetch should record a request before throwing its injected network error.',
  );
});

Then('configuring a network failure for something that is not a request URL is rejected', function (this: WebhooksWorld) {
  assert.throws(
    () => failFetch(this.scenarioId, 'payments.example.com/hook', [() => fetchFailedError()]),
    /neither ALL_URLS nor an http\(s\) URL/,
    'fail() must reject an operation that is not ALL_URLS or an http(s) URL: a typo\'d URL would otherwise never fire.',
  );
});

Then('seeding a response that real fetch would never hand back is rejected', function (this: WebhooksWorld) {
  const url = 'https://payments.example.com/hook';
  assert.throws(() => seedFetchResponse(this.scenarioId, url, { status: 103 }), /not a final HTTP status/,
    '1xx is a network error in real fetch, so it must not be seedable as an answer.');
  assert.throws(() => seedFetchResponse(this.scenarioId, url, { status: 200, location: '/elsewhere' }), /needs a redirect status/,
    'Only 301/302/303/307/308 are followed, so a Location on any other status must be rejected.');
});
