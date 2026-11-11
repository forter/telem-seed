import assert from 'assert';
import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import {
  seedSubscribers,
  takeOwnershipOfSubscriberCreate,
  takeOwnershipOfSubscriberRemove,
  failAllDb,
  takeOwnershipOfFailedWrites,
  FAKE_INSERT_CREATED_AT_ISO,
  FAKE_SEED_CREATED_AT,
} from '../support/fakes/fake-db';
import * as fakeKafka from '../support/fakes/fake-kafka';
import {
  takeOwnershipOfSubscriptions,
  takeOwnershipOfConsumerRunState,
  CONSUMER_GROUP_ID,
} from '../support/fakes/fake-kafka';

// Seeded rows carry the fake's fixed created_at (production uses MySQL DEFAULT CURRENT_TIMESTAMP).
const SEED_CREATED_AT_ISO = FAKE_SEED_CREATED_AT.toISOString();

// ── Given ─────────────────────────────────────────────────────────────────────

Given<WebhooksWorld>(
  'a subscriber {string} with ID {int} listens for topic {string} at URL {string}',
  function (name: string, id: number, topic: string, url: string) {
    seedSubscribers(this.scenarioId, [
      { id, name, topic, url, headers: {}, created_at: FAKE_SEED_CREATED_AT },
    ]);
    this.seededSubscriberId = id;
    this.seededSubscriberUrls.push(url);
    this.seededSubscriberIds.push(id);
  },
);

// ── Given ─ error/edge-case ───────────────────────────────────────────────────

Given<WebhooksWorld>('the database is unavailable', function () {
  // Whole-database outage — every declared operation fails (used across register/delete/list/flags/health).
  const err = new Error('Connection refused');
  this.injectedErrors.push(err);
  failAllDb(this.scenarioId, [err]);
});

// ── When ─────────────────────────────────────────────────────────────────────

When<WebhooksWorld>('I list all subscribers', async function () {
  this.response = await this.request.get('/api/subscribers');
});

// Every registration a scenario submitted, by URL, so a multi-registration Then can assert each stored row's full
// shape against what was sent (not only the field the step names).
type SubmittedRegistration = { name: string; topic: string; url: string; headers: Record<string, string> };
const submittedByWorld = new WeakMap<WebhooksWorld, Map<string, SubmittedRegistration>>();
function rememberSubmitted(world: WebhooksWorld, req: SubmittedRegistration): void {
  world.lastSubscriberRequest = req;
  const byUrl = submittedByWorld.get(world) ?? new Map<string, SubmittedRegistration>();
  submittedByWorld.set(world, byUrl.set(req.url, req));
}

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string}',
  async function (name: string, topic: string, url: string) {
    rememberSubmitted(this, { name, topic, url, headers: {} });
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url });
    this.registrationResponses.push(this.response);
  },
);

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} with headers:',
  async function (name: string, topic: string, url: string, table: DataTable) {
    // raw(), not rows(): the table has no header row, and rows() would silently drop the first header.
    const headers = Object.fromEntries(table.raw().map(([k, v]) => [k, v]));
    rememberSubmitted(this, { name, topic, url, headers });
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url, headers });
    this.registrationResponses.push(this.response);
  },
);

When<WebhooksWorld>('I delete subscriber {int}', async function (id: number) {
  this.response = await this.request.delete(`/api/subscribers/${id}`);
});

When<WebhooksWorld>(
  'I attempt to register a subscriber without the {word} field',
  async function (missingField: string) {
    const body: Record<string, string> = {
      name: 'Payments Service',
      topic: 'orders',
      url: 'https://payments.example.com/hook',
    };
    delete body[missingField];
    this.response = await this.request.post('/api/subscribers').send(body);
  },
);

When<WebhooksWorld>('I attempt to delete subscriber with ID {string}', async function (id: string) {
  this.response = await this.request.delete(`/api/subscribers/${id}`);
});

When<WebhooksWorld>(
  'I register a subscriber with a null {word}',
  async function (field: string) {
    const body: Record<string, string | null> = {
      name: 'Payments Service',
      topic: 'orders',
      url: 'https://payments.example.com/hook',
    };
    body[field] = null;
    this.response = await this.request.post('/api/subscribers').send(body);
  },
);

When<WebhooksWorld>('I send a malformed JSON body to register a subscriber', async function () {
  this.response = await this.request
    .post('/api/subscribers')
    .type('json')
    .send('{ this is not valid json }');
});

// Sends a valid registration body augmented with extra fields that the handler should ignore.
When<WebhooksWorld>('I register a subscriber with extra unknown fields', async function () {
  rememberSubmitted(this, {
    name: 'Payments Service',
    topic: 'orders',
    url: 'https://payments.example.com/hook',
    headers: {},
  });
  this.response = await this.request.post('/api/subscribers').send({
    ...this.lastSubscriberRequest,
    unknownField: 'ignored-value',
    anotherExtra: 42,
  });
});

// ── Then ─────────────────────────────────────────────────────────────────────

// 'the response status should be {int}' is defined in common.steps.ts (used across 3+ feature files).

Then<WebhooksWorld>('the subscriber list should contain exactly:', function (table: DataTable) {
  const expected = table.hashes().map((row) => ({
    id: parseInt(row.id, 10),
    name: row.name,
    topic: row.topic,
    url: row.url,
    headers: JSON.parse(row.headers) as Record<string, string>,
    created_at: row.created_at,
  }));
  assert.deepStrictEqual(
    this.response.body,
    expected,
    `Subscriber list did not match expected shape. ` +
      `Probable cause: wrong ordering, missing fields, or seeded data mismatch. ` +
      `Got: ${JSON.stringify(this.response.body)}`,
  );
});

Then<WebhooksWorld>('the subscriber list should be empty', function () {
  assert.deepStrictEqual(
    this.response.body,
    [],
    `Expected an empty subscriber list but got ${JSON.stringify(this.response.body)}. ` +
      `Probable cause: a previous scenario leaked subscriber state, or the GET handler returned stale data. ` +
      `What to check: fake-db.ts cleanup() (per-scenario teardown) and GET /api/subscribers handler in src/api/subscribers.ts.`,
  );
});

// Owns the subscribers.create call and asserts the 201 response matches the SUBMITTED request data. [subscriber-insert, post-response]
Then<WebhooksWorld>(
  'the registered subscriber should match the submitted data [subscriber-insert, post-response]',
  function () {
    const req = this.lastSubscriberRequest!;
    // Claim the INSERT by the submitted URL (ownership); its generated id is the only field with no
    // request-side source. name/topic/url/headers come from the request, so the assertion verifies
    // the response reflects what was submitted — not a value read back out of the captured INSERT.
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, req.url);
    const expected = {
      id: insert.id,
      name: req.name,
      topic: req.topic,
      url: req.url,
      headers: req.headers,
    };
    assertStoredAndReturned(this, insert, expected);
  },
);

// The INSERT the repository received and the 201 body must both equal `expected` (id is the one field the
// server assigns, so it is taken from the INSERT). Asserting both catches a handler that stores one thing and
// answers another.
function assertStoredAndReturned(
  world: WebhooksWorld,
  insert: { id: number; name: unknown; topic: unknown; url: unknown; headers: unknown },
  expected: { id: number; name: string; topic: string; url: string; headers: Record<string, string> },
): void {
  // The INSERT is compared without its id: `expected.id` came from it, so including it would compare it to itself.
  const { id: _insertId, ...stored } = insert;
  const { id: _expectedId, ...submitted } = expected;
  assert.deepStrictEqual(
    stored,
    submitted,
    'The subscriber the repository was asked to INSERT did not match what was submitted. ' +
      'Probable cause: the POST handler passed different (or defaulted) fields to db.create(). ' +
      `What to check: the db.create() call in src/api/subscribers.ts. Got: ${JSON.stringify(insert)}, Expected: ${JSON.stringify(expected)}`,
  );
  assert.deepStrictEqual(
    world.response.body,
    expected,
    `POST response body did not match the submitted registration data. ` +
      `Probable cause: the handler returned different data than was submitted, or the response shape changed. ` +
      `What to check: src/api/subscribers.ts POST handler response serialization and src/db/subscribers.ts create() return shape. ` +
      `Got: ${JSON.stringify(world.response.body)}, Expected: ${JSON.stringify(expected)}`,
  );
}

// Each pins one submitted field to a literal from the feature file, so an Outline's varied column is asserted
// per row (not only echoed back from the request). [subscriber-insert, post-response]
Then<WebhooksWorld>(
  'the subscriber should have been stored and returned with name {string} and topic {string} [subscriber-insert, post-response]',
  function (name: string, topic: string) {
    const req = this.lastSubscriberRequest!;
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, req.url);
    assertStoredAndReturned(this, insert, { id: insert.id, name, topic, url: req.url, headers: req.headers });
  },
);

Then<WebhooksWorld>(
  'the subscriber should have been stored and returned with URL {string} [subscriber-insert, post-response]',
  function (url: string) {
    const req = this.lastSubscriberRequest!;
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, url);
    assertStoredAndReturned(this, insert, { id: insert.id, name: req.name, topic: req.topic, url, headers: req.headers });
  },
);

Then<WebhooksWorld>(
  'the subscriber should have been stored and returned with name {string} [subscriber-insert, post-response]',
  function (name: string) {
    const req = this.lastSubscriberRequest!;
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, req.url);
    assertStoredAndReturned(this, insert, { id: insert.id, name, topic: req.topic, url: req.url, headers: req.headers });
  },
);

Then<WebhooksWorld>(
  'the subscriber should have been stored and returned with no delivery headers [subscriber-insert, post-response]',
  function () {
    const req = this.lastSubscriberRequest!;
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, req.url);
    assertStoredAndReturned(this, insert, { id: insert.id, name: req.name, topic: req.topic, url: req.url, headers: {} });
  },
);

Then<WebhooksWorld>(
  'the subscriber should have been stored and returned with a {int}-character {word} [subscriber-insert, post-response]',
  function (length: number, field: string) {
    const req = this.lastSubscriberRequest!;
    // Guards the valueOfLength helper itself: an off-by-one there would silently move the scenario off the limit.
    const value = (req as unknown as Record<string, string>)[field];
    assert.strictEqual(
      [...value].length,
      length,
      `The scenario was meant to submit a ${length}-character ${field} but submitted ${[...value].length} characters. ` +
        'What to check: the "whose {word} is {int} characters long" When step.',
    );
    const insert = takeOwnershipOfSubscriberCreate(this.scenarioId, req.url);
    assertStoredAndReturned(this, insert, { id: insert.id, name: req.name, topic: req.topic, url: req.url, headers: req.headers });
  },
);

Then<WebhooksWorld>('the error response body should be {string}', function (errorMessage: string) {
  assert.deepStrictEqual(
    this.response.body,
    { error: errorMessage },
    `Expected error body { error: "${errorMessage}" } but got: ${JSON.stringify(this.response.body)}. ` +
      `Probable cause: wrong error message, unexpected success, or handler returned a different shape. ` +
      `What to check: validation logic and error response construction in src/api/subscribers.ts.`,
  );
});

// Owns the subscribers.remove call for a non-existent row (affectedRows === 0). [subscriber-delete]
Then<WebhooksWorld>(
  'the attempt to remove subscriber {int} found no matching subscriber [subscriber-delete]',
  function (id: number) {
    const deleted = takeOwnershipOfSubscriberRemove(this.scenarioId, id);
    assert.strictEqual(
      deleted.affectedRows,
      0,
      `Expected 0 affected rows when removing non-existent subscriber ${id} but got ${deleted.affectedRows}. ` +
        `Probable cause: a subscriber with id=${id} was unexpectedly seeded, or the DELETE matched a wrong row.`,
    );
  },
);

// Owns the subscribers.remove call and asserts the row was found and removed. [subscriber-delete]
Then<WebhooksWorld>(
  'subscriber {int} should have been removed [subscriber-delete]',
  function (id: number) {
    const deleted = takeOwnershipOfSubscriberRemove(this.scenarioId, id);
    assert.strictEqual(
      deleted.affectedRows,
      1,
      `Expected 1 affected row for DELETE on subscriber ${id} but got ${deleted.affectedRows}. ` +
        `Probable cause: subscriber ${id} was not in the fake's seed data, or the DELETE was not issued.`,
    );
  },
);

// Verifies that registering a subscriber when one already exists creates a SECOND independent
// entry rather than deduplicating. Issues GET internally — the POST response is still on
// `this.response` for the first entry's field values.
Then<WebhooksWorld>('both subscribers should appear in the list', async function () {
  const listResp = await this.request.get('/api/subscribers');
  assert.strictEqual(
    listResp.status,
    200,
    `Expected 200 from GET /api/subscribers but got ${listResp.status}. ` +
      `Probable cause: GET handler hit a DB error or the app wasn't started correctly. ` +
      `What to check: verify no DB failure was injected via fail()/failAllDb(), and check the app startup log. ` +
      `Body: ${JSON.stringify(listResp.body)}`,
  );
  assert.strictEqual(
    listResp.body.length,
    2,
    `Expected 2 subscribers after duplicate registration but got ${listResp.body.length}. ` +
      `Probable cause: duplicate entries are silently deduplicated or merged, or the second POST was never issued. ` +
      `What to check: verify the POST When step ran and that the fake records two separate inserts. ` +
      `List: ${JSON.stringify(listResp.body)}`,
  );
  // Build both expected rows from the submitted request data — the scenario registers the SAME data
  // that was seeded, so both rows share name/topic/url/headers. Only the generated ids differ: the
  // seeded id, and the registered id (already verified against the INSERT by the preceding match Then).
  const req = this.lastSubscriberRequest!;
  const seededId = this.seededSubscriberId ?? 1;
  const registeredId = (this.response.body as { id: number }).id;
  assert.deepStrictEqual(
    listResp.body[0],
    { id: seededId, name: req.name, topic: req.topic, url: req.url, headers: req.headers, created_at: SEED_CREATED_AT_ISO },
    `Seeded subscriber (id=${seededId}) did not match in the list. ` +
      `Probable cause: seed state was not preserved across the POST/GET, or the GET response excludes the seeded row. ` +
      `What to check: SEED_CREATED_AT_ISO value, seedSubscribers() call in the Given step, and fake-db subscribers.listAll(). ` +
      `Got: ${JSON.stringify(listResp.body[0])}`,
  );
  assert.deepStrictEqual(
    listResp.body[1],
    { id: registeredId, name: req.name, topic: req.topic, url: req.url, headers: req.headers, created_at: FAKE_INSERT_CREATED_AT_ISO },
    `Newly registered subscriber did not match in the list. ` +
      `Probable cause: FAKE_INSERT_CREATED_AT_ISO doesn't match the created_at set by fake-db's subscribers.create(), ` +
      `or the GET response shape differs from the submitted data. ` +
      `What to check: FAKE_INSERT_CREATED_AT constant in fake-db.ts and the submitted request body. ` +
      `Got: ${JSON.stringify(listResp.body[1])}`,
  );
});

// Empty-body negative assertion — the ownership safety net (throwIfUnownedExist) enforces absence:
// a rejected registration must not leak a subscriber INSERT. Earns its place (per the negative-assertion
// rule) because the happy path's POST does persist, so a reader expects a write here.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no subscriber should have been persisted', function () {});

// Empty body, same pattern: a stray subscribers.remove would be left unowned and fail the scenario.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no subscriber should have been removed', function () {});

// ── Kafka consumer subscription ───────────────────────────────────────────────
// POST /api/subscribers fires subscribeToTopic() WITHOUT awaiting it: stop the running consumer, subscribe the
// topic, run again. The claim steps below wait for that background work (takeOwnershipOf* settle first).
// Each of them takes over from the "Kafka consumer subscribes to each newly registered topic" auto-default
// (features/defaults.ts), which covers every scenario that does not pin the lifecycle itself.
const SUBSCRIPTION_DEFAULT = 'Kafka consumer subscribes to each newly registered topic';

function pinsKafkaLifecycle(world: WebhooksWorld): void {
  world._skippedDefaults = (world._skippedDefaults ?? new Set()).add(SUBSCRIPTION_DEFAULT);
}

Given<WebhooksWorld>('subscribing the Kafka consumer to a topic fails', function () {
  this.failFake(fakeKafka, 'kafka.subscribe', [new Error('Injected Kafka subscribe failure')]);
});

Given<WebhooksWorld>('subscribing the Kafka consumer to a topic fails for the second registration only', function () {
  this.failFake(fakeKafka, 'kafka.subscribe', [null, new Error('Injected Kafka subscribe failure'), null]);
});

Given<WebhooksWorld>('starting the Kafka consumer fails', function () {
  this.failFake(fakeKafka, 'kafka.run', [new Error('Injected Kafka run failure')]);
});

Given<WebhooksWorld>('stopping the Kafka consumer fails', function () {
  this.failFake(fakeKafka, 'kafka.stop', [new Error('Injected Kafka stop failure')]);
});

// Both requests are in flight together, so their subscribe calls reach the consumer at the same time unless
// production serialises them (the subscribeLock in src/kafka/consumer.ts).
When<WebhooksWorld>(
  'I register subscribers for topics {string} and {string} at the same time',
  async function (firstTopic: string, secondTopic: string) {
    const registrations = [
      { name: 'First Service', topic: firstTopic, url: 'https://first.example.com/hook', headers: {} },
      { name: 'Second Service', topic: secondTopic, url: 'https://second.example.com/hook', headers: {} },
    ];
    registrations.forEach((r) => rememberSubmitted(this, r));
    this.responses = await Promise.all(
      registrations.map(({ name, topic, url }) => this.request.post('/api/subscribers').send({ name, topic, url })),
    );
    this.response = this.responses[0];
  },
);

Then<WebhooksWorld>('both registrations should have succeeded', function () {
  assert.deepStrictEqual(
    (this.responses ?? []).map((r: { status: number }) => r.status),
    [201, 201],
    `Expected both concurrent registrations to answer 201. Got: ${JSON.stringify((this.responses ?? []).map((r: { status: number; body: unknown }) => [r.status, r.body]))}. ` +
      'Probable cause: a registration was rejected, or the Kafka subscribe failure leaked into the HTTP response. ' +
      'What to check: the POST handler in src/api/subscribers.ts (subscribeToTopic must stay fire-and-forget).',
  );
  for (const want of submittedByWorld.get(this)?.values() ?? []) {
    // The two INSERTs race, so which one gets which id is not fixed; the rest of each row is.
    const { id, ...stored } = takeOwnershipOfSubscriberCreate(this.scenarioId, want.url);
    assert.ok(Number.isInteger(id), `Expected the registration at ${want.url} to be assigned an integer id, got ${id}.`);
    assert.deepStrictEqual(
      stored,
      want,
      `The concurrent registration at ${want.url} was not stored as submitted. Got: ${JSON.stringify(stored)}. ` +
        'What to check: the POST handler in src/api/subscribers.ts.',
    );
  }
});

// Claims the subscribers.create of a registration made earlier in the scenario (one per URL) and asserts the stored
// row is what that registration submitted, for the topic the step names.
Then<WebhooksWorld>(
  'the subscriber registered at URL {string} should have been stored for topic {string} [subscriber-insert]',
  function (url: string, topic: string) {
    const submitted = submittedByWorld.get(this)?.get(url);
    assert.ok(submitted, `No registration at ${url} was submitted in this scenario — check the When steps.`);
    const { id, ...stored } = takeOwnershipOfSubscriberCreate(this.scenarioId, url);
    assert.ok(Number.isInteger(id), `Expected the registration at ${url} to be assigned an integer id, got ${id}.`);
    assert.deepStrictEqual(
      stored,
      { ...submitted, topic },
      `Expected the registration at ${url} to be stored as submitted, for topic "${topic}". Got: ${JSON.stringify(stored)}. ` +
        'Probable cause: the handler stored a different topic (or other field) than the one submitted.',
    );
  },
);

Then<WebhooksWorld>('the Kafka consumer should have subscribed to topic {string} once', async function (topic: string) {
  pinsKafkaLifecycle(this);
  assert.deepStrictEqual(
    await takeOwnershipOfSubscriptions(this.scenarioId, topic),
    [{ op: 'subscribe', topic, fromBeginning: false, failed: false }],
    `Expected exactly one successful subscribe for topic "${topic}". ` +
      'Probable cause: the consumer subscribed the topic twice (the subscribedTopics check is gone), not at all, or the subscribe failed. ' +
      'What to check: doSubscribeToTopic in src/kafka/consumer.ts.',
  );
});

Then<WebhooksWorld>('the Kafka consumer subscription to topic {string} should have failed', async function (topic: string) {
  pinsKafkaLifecycle(this);
  assert.deepStrictEqual(
    await takeOwnershipOfSubscriptions(this.scenarioId, topic),
    [{ op: 'subscribe', topic, fromBeginning: false, failed: true }],
    `Expected exactly one FAILED subscribe attempt for topic "${topic}". ` +
      'Probable cause: the Given that makes the subscribe fail is missing, or the attempt was repeated or never made. ' +
      'What to check: the "subscribing the Kafka consumer to a topic fails" Given and doSubscribeToTopic in src/kafka/consumer.ts.',
  );
});

// A run carries the topics the consumer joins its group with: KafkaJS keeps subscriptions across stop(), so a
// restart must still consume every earlier topic.
Then<WebhooksWorld>('the Kafka consumer should have been started consuming topic {string}', async function (topic: string) {
  pinsKafkaLifecycle(this);
  assert.deepStrictEqual(
    await takeOwnershipOfConsumerRunState(this.scenarioId, CONSUMER_GROUP_ID),
    [{ op: 'run', groupId: CONSUMER_GROUP_ID, topics: [topic], failed: false }],
    `Expected the consumer to be run exactly once, consuming only "${topic}" (no stop first: it was not running). ` +
      'Probable cause: it was stopped needlessly, run twice, or never run after the subscribe. ' +
      'What to check: doSubscribeToTopic / startRunning in src/kafka/consumer.ts.',
  );
});

Then<WebhooksWorld>(
  'the Kafka consumer should have been started and then restarted to consume topics {string} and {string} [kafka-subscribe, kafka-run]',
  async function (first: string, second: string) {
    pinsKafkaLifecycle(this);
    assert.deepStrictEqual(
      await takeOwnershipOfConsumerRunState(this.scenarioId, CONSUMER_GROUP_ID),
      [
        { op: 'run', groupId: CONSUMER_GROUP_ID, topics: [first], failed: false },
        { op: 'stop', groupId: CONSUMER_GROUP_ID, failed: false },
        { op: 'run', groupId: CONSUMER_GROUP_ID, topics: [first, second], failed: false },
      ],
      `Expected run for "${first}", then stop and run again for both topics, one registration after the other. ` +
        'Probable cause: the two subscribes interleaved (the subscribeLock is gone) so the consumer was never restarted in between, ' +
        'the consumer was not stopped before the second subscribe, or the restart dropped the first topic. ' +
        'What to check: subscribeToTopic, subscribeLock and doSubscribeToTopic in src/kafka/consumer.ts.',
    );
  },
);

Then<WebhooksWorld>('the Kafka consumer should have failed to start consuming topic {string}', async function (topic: string) {
  pinsKafkaLifecycle(this);
  assert.deepStrictEqual(
    await takeOwnershipOfConsumerRunState(this.scenarioId, CONSUMER_GROUP_ID),
    [{ op: 'run', groupId: CONSUMER_GROUP_ID, topics: [topic], failed: true }],
    `Expected exactly one FAILED run attempt for "${topic}". ` +
      'Probable cause: the Given that makes the consumer fail to start is missing, or the run was never attempted after the subscribe. ' +
      'What to check: doSubscribeToTopic / startRunning in src/kafka/consumer.ts.',
  );
});

// The consumer's whole run history, in call order, for the scenarios whose sequence is the point (a failed call,
// a restart that never happens). Columns: action (start | stop), the topics a start consumes (comma-separated;
// empty for a stop), outcome (succeeded | failed).
Then<WebhooksWorld>('the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:', async function (table: DataTable) {
  pinsKafkaLifecycle(this);
  const expected = table.hashes().map((row) =>
    row.action === 'start'
      ? { op: 'run', groupId: CONSUMER_GROUP_ID, topics: row.topics.split(',').map((t) => t.trim()), failed: row.outcome === 'failed' }
      : { op: 'stop', groupId: CONSUMER_GROUP_ID, failed: row.outcome === 'failed' },
  );
  assert.deepStrictEqual(
    await takeOwnershipOfConsumerRunState(this.scenarioId, CONSUMER_GROUP_ID),
    expected,
    'The consumer did not start and stop in the expected order. ' +
      'Probable cause: a restart that should have happened did not (or the other way round), a topic was dropped on restart, or a failure was not injected. ' +
      'What to check: doSubscribeToTopic / startRunning in src/kafka/consumer.ts — the consumer is stopped BEFORE the subscribe and only started again after a successful one.',
  );
});

// ── Then ─ failed writes ──────────────────────────────────────────────────────
// A write that throws is still IO the app attempted (the fake records it before rethrowing), so a failure
// scenario owns it: what the app asked to write, and the error it got back. [subscriber-insert, subscriber-delete]

Then<WebhooksWorld>(
  'the subscriber insert should have been attempted and failed with {string} [subscriber-insert]',
  function (message: string) {
    assert.deepStrictEqual(
      takeOwnershipOfFailedWrites(this.scenarioId, 'subscribers.create'),
      [{ operation: 'subscribers.create', args: { ...this.lastSubscriberRequest! }, error: { message } }],
      'Expected exactly one failed subscriber insert carrying the submitted fields and the injected error. ' +
        'What to check: the "database is unavailable" Given, and that POST /api/subscribers reached db.create().',
    );
  },
);

Then<WebhooksWorld>(
  'the subscriber insert should have been attempted and rejected by MySQL with {word} {string} [subscriber-insert]',
  function (code: string, message: string) {
    assert.deepStrictEqual(
      takeOwnershipOfFailedWrites(this.scenarioId, 'subscribers.create'),
      [{ operation: 'subscribers.create', args: { ...this.lastSubscriberRequest! }, error: { message, code } }],
      `Expected exactly one subscriber insert rejected by MySQL with ${code}. ` +
        'What to check: the column limits fake-db enforces (pinned against MySQL by fake-db.parity.ts).',
    );
  },
);

Then<WebhooksWorld>(
  'the delete of subscriber {int} should have been attempted and failed with {string} [subscriber-delete]',
  function (id: number, message: string) {
    assert.deepStrictEqual(
      takeOwnershipOfFailedWrites(this.scenarioId, 'subscribers.remove'),
      [{ operation: 'subscribers.remove', args: { id }, error: { message } }],
      `Expected exactly one failed delete of subscriber ${id} with the injected error. ` +
        'What to check: the "database is unavailable" Given, and that DELETE /api/subscribers/:id reached db.remove().',
    );
  },
);

// ── Request shapes beyond the plain JSON registration ─────────────────────────

Given<WebhooksWorld>(
  'a subscriber {string} with ID {int} listens for topic {string} at URL {string} with headers:',
  function (name: string, id: number, topic: string, url: string, table: DataTable) {
    const headers = Object.fromEntries(table.raw().map(([k, v]) => [k, v]));
    seedSubscribers(this.scenarioId, [{ id, name, topic, url, headers, created_at: FAKE_SEED_CREATED_AT }]);
    this.seededSubscriberId = id;
    this.seededSubscriberUrls.push(url);
    this.seededSubscriberIds.push(id);
  },
);

// req.body is JSON, so `headers` can be a string; `headers ?? {}` passes it through to db.create().
When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} with headers set to the string {string}',
  async function (name: string, topic: string, url: string, headers: string) {
    rememberSubmitted(this, { name, topic, url, headers: headers as unknown as Record<string, string> });
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url, headers });
  },
);

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} with headers set to null',
  async function (name: string, topic: string, url: string) {
    rememberSubmitted(this, { name, topic, url, headers: {} });
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url, headers: null });
  },
);

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} with an empty headers object',
  async function (name: string, topic: string, url: string) {
    rememberSubmitted(this, { name, topic, url, headers: {} });
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url, headers: {} });
  },
);

// A form post: express.json() is the only body parser, so the fields never reach the handler.
When<WebhooksWorld>('I register a subscriber with a form-encoded body', async function () {
  this.response = await this.request
    .post('/api/subscribers')
    .type('form')
    .send({ name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook' });
});

When<WebhooksWorld>('I send an oversized JSON body to register a subscriber', async function () {
  // express.json()'s default limit is 100kb; the body is otherwise a valid registration.
  this.response = await this.request
    .post('/api/subscribers')
    .type('json')
    .send(JSON.stringify({ name: 'x'.repeat(200 * 1024), topic: 'orders', url: 'https://payments.example.com/hook' }));
});

// A bare JSON string is valid JSON but not an object or array, which express.json()'s strict mode refuses.
When<WebhooksWorld>('I send a JSON string to register a subscriber', async function () {
  this.response = await this.request.post('/api/subscribers').type('json').send('"Payments Service"');
});

// Kept here rather than common.steps.ts (only this feature uses it); a DELETE needs an id, so the collection 404s.
When<WebhooksWorld>('I send an unsupported DELETE request to the {word} endpoint', async function (name: string) {
  if (name !== 'subscribers') throw new Error(`Only the subscribers endpoint is wired for this step, got "${name}"`);
  this.response = await this.request.delete('/api/subscribers');
});

When<WebhooksWorld>('I send a JSON array to register a subscriber', async function () {
  this.response = await this.request
    .post('/api/subscribers')
    .type('json')
    .send(JSON.stringify([{ name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook' }]));
});

// JSON.parse keeps the last of two same-named members; the raw body is built by hand because a JS object
// literal cannot carry a duplicate key.
When<WebhooksWorld>(
  'I register a subscriber whose body gives the name twice, first {string} and then {string}',
  async function (first: string, second: string) {
    const url = 'https://payments.example.com/hook';
    rememberSubmitted(this, { name: second, topic: 'orders', url, headers: {} });
    this.response = await this.request
      .post('/api/subscribers')
      .type('json')
      .send(`{"name":${JSON.stringify(first)},"name":${JSON.stringify(second)},"topic":"orders","url":"${url}"}`);
  },
);

// A value of exactly `length` characters, so a scenario can sit on either side of a column limit.
function valueOfLength(field: string, length: number): string {
  if (field === 'url') {
    const prefix = 'https://example.com/';
    return prefix + 'p'.repeat(length - prefix.length);
  }
  return (field === 'name' ? 'N' : 't').repeat(length);
}

When<WebhooksWorld>(
  'I register a subscriber whose {word} is {int} characters long',
  async function (field: string, length: number) {
    if (!['name', 'topic', 'url'].includes(field)) throw new Error(`Unknown subscriber field "${field}"`);
    const body = { name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook', headers: {} };
    (body as Record<string, unknown>)[field] = valueOfLength(field, length);
    rememberSubmitted(this, body);
    const { name, topic, url } = body;
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url });
  },
);

// A JSON number where a string belongs: the guard only checks truthiness, so the type is the handler's problem.
When<WebhooksWorld>(
  'I register a subscriber whose {word} is the number {int}',
  async function (field: string, value: number) {
    if (!['name', 'topic', 'url'].includes(field)) throw new Error(`Unknown subscriber field "${field}"`);
    const body: Record<string, unknown> = { name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook' };
    body[field] = value;
    this.response = await this.request.post('/api/subscribers').send(body);
  },
);

// Sequential, like a client that retries after not seeing the first answer.
When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} twice',
  async function (name: string, topic: string, url: string) {
    rememberSubmitted(this, { name, topic, url, headers: {} });
    this.responses = [];
    for (let i = 0; i < 2; i++) this.responses.push(await this.request.post('/api/subscribers').send({ name, topic, url }));
    this.response = this.responses[1];
  },
);

When<WebhooksWorld>('I delete subscriber {int} twice', async function (id: number) {
  this.responses = [];
  for (let i = 0; i < 2; i++) this.responses.push(await this.request.delete(`/api/subscribers/${id}`));
  this.response = this.responses[1];
});

Then<WebhooksWorld>(
  'both registrations should have been stored as separate subscribers with IDs {int} and {int} [subscriber-insert, post-response]',
  function (firstId: number, secondId: number) {
    const req = this.lastSubscriberRequest!;
    [firstId, secondId].forEach((id, i) => {
      const expected = { id, name: req.name, topic: req.topic, url: req.url, headers: {} };
      assert.deepStrictEqual(
        takeOwnershipOfSubscriberCreate(this.scenarioId, req.url),
        expected,
        `Registration #${i + 1} was not stored as its own subscriber ${id}. ` +
          'Probable cause: the API deduplicated the repeated registration, or reused an id. What to check: POST /api/subscribers.',
      );
      assert.deepStrictEqual(
        [this.responses![i].status, this.responses![i].body],
        [201, expected],
        `Registration #${i + 1} did not answer 201 with subscriber ${id}. ` +
          `Got: ${JSON.stringify([this.responses![i].status, this.responses![i].body])}. What to check: POST /api/subscribers.`,
      );
    });
  },
);

Then<WebhooksWorld>(
  'the first deletion of subscriber {int} should have removed it and the second should have found nothing [subscriber-delete]',
  function (id: number) {
    const answers = this.responses!.map((r: { status: number; body: unknown; text: string }) => [r.status, r.status === 204 ? r.text : r.body]);
    assert.deepStrictEqual(
      answers,
      [[204, ''], [404, { error: 'Subscriber not found' }]],
      `Expected DELETE ${id} to answer 204 (empty) and then 404. Got: ${JSON.stringify(answers)}. ` +
        'Probable cause: the handler does not report affectedRows === 0 as not found. What to check: DELETE /api/subscribers/:id.',
    );
    assert.deepStrictEqual(
      [takeOwnershipOfSubscriberRemove(this.scenarioId, id), takeOwnershipOfSubscriberRemove(this.scenarioId, id)],
      [{ affectedRows: 1 }, { affectedRows: 0 }],
      `Expected two removes of subscriber ${id}: the first matching the row, the second matching nothing. ` +
        'What to check: db.remove() is called once per DELETE request.',
    );
  },
);

// ── Kafka consumer: failures that change what the next registration does ─────

Given<WebhooksWorld>('starting the Kafka consumer fails the first time only', function () {
  this.failFake(fakeKafka, 'kafka.run', [new Error('Injected Kafka run failure'), null]);
});

Given<WebhooksWorld>('starting the Kafka consumer fails the second time only', function () {
  this.failFake(fakeKafka, 'kafka.run', [null, new Error('Injected Kafka run failure'), null]);
});

Given<WebhooksWorld>('stopping the Kafka consumer fails the first time only', function () {
  this.failFake(fakeKafka, 'kafka.stop', [new Error('Injected Kafka stop failure'), null]);
});

// Empty body: a subscribe for this topic would stay unowned and fail the scenario (throwIfUnownedExist).
// Pins the lifecycle, so the subscription auto-default does not demand the subscribe this step says never happened.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
Then<WebhooksWorld>('the Kafka consumer should never have subscribed to topic {string}', function (_topic: string) {
  pinsKafkaLifecycle(this);
});

Then<WebhooksWorld>('the Kafka consumer subscription to the {int}-character topic should have failed', async function (length: number) {
  pinsKafkaLifecycle(this);
  const topic = valueOfLength('topic', length);
  assert.deepStrictEqual(
    await takeOwnershipOfSubscriptions(this.scenarioId, topic),
    [{ op: 'subscribe', topic, fromBeginning: false, failed: true }],
    `Expected exactly one FAILED subscribe for the ${length}-character topic (Kafka topic names stop at 249 characters). ` +
      'What to check: doSubscribeToTopic in src/kafka/consumer.ts.',
  );
});

// ── Further request shapes ────────────────────────────────────────────────────

const CLIENT_CHOSEN_ID = 999;

When<WebhooksWorld>('I register a subscriber that tries to choose its own id', async function () {
  const body = { name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook', headers: {} };
  rememberSubmitted(this, body);
  this.response = await this.request.post('/api/subscribers').send({ ...body, id: CLIENT_CHOSEN_ID });
});

Then<WebhooksWorld>('the registered subscriber should have an id other than the one the client asked for', function () {
  assert.notStrictEqual(
    (this.response.body as { id: number }).id,
    CLIENT_CHOSEN_ID,
    `The client-chosen id ${CLIENT_CHOSEN_ID} was used. What to check: the db.create() call in src/api/subscribers.ts must not spread the request body.`,
  );
});

When<WebhooksWorld>('I register a subscriber with delivery header values that are a number and a nested object', async function () {
  const headers = { 'X-Retries': 3, 'X-Nested': { a: 'b' } } as unknown as Record<string, string>;
  const body = { name: 'Payments Service', topic: 'orders', url: 'https://payments.example.com/hook', headers };
  rememberSubmitted(this, body);
  this.response = await this.request.post('/api/subscribers').send(body);
});

When<WebhooksWorld>('I list all subscribers with the query string {string}', async function (query: string) {
  this.response = await this.request.get(`/api/subscribers${query}`);
});

When<WebhooksWorld>('I register a subscriber whose name is {int} emoji long', async function (length: number) {
  const body = { name: '🎉'.repeat(length), topic: 'orders', url: 'https://payments.example.com/hook', headers: {} };
  rememberSubmitted(this, body);
  this.response = await this.request.post('/api/subscribers').send({ name: body.name, topic: body.topic, url: body.url });
});

When<WebhooksWorld>('I delete subscriber {int} twice at the same time', async function (id: number) {
  this.responses = await Promise.all([
    this.request.delete(`/api/subscribers/${id}`),
    this.request.delete(`/api/subscribers/${id}`),
  ]);
  this.response = this.responses[0];
});

Then<WebhooksWorld>(
  'exactly one of the two deletions of subscriber {int} should have removed it [subscriber-delete]',
  function (id: number) {
    const statuses = this.responses!.map((r: { status: number }) => r.status).sort();
    assert.deepStrictEqual(
      statuses,
      [204, 404],
      `Expected one DELETE ${id} to answer 204 and the other 404. Got: ${JSON.stringify(statuses)}. ` +
        'Probable cause: both requests reported the row removed, or neither did. What to check: DELETE /api/subscribers/:id.',
    );
    const affected = [takeOwnershipOfSubscriberRemove(this.scenarioId, id), takeOwnershipOfSubscriberRemove(this.scenarioId, id)]
      .map((r) => r.affectedRows)
      .sort();
    assert.deepStrictEqual(affected, [0, 1], `Expected the two removes of subscriber ${id} to affect 0 and 1 rows. Got ${JSON.stringify(affected)}.`);
  },
);
