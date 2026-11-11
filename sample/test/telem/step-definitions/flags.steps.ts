import assert from 'assert';
import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import {
  seedTopicFlags,
  takeOwnershipOfTopicFlagsUpsert,
  takeOwnershipOfDeliveryLogsForSubscriber,
  takeOwnershipOfFailedWrites,
  type DeliveryAttempt,
} from '../support/fakes/fake-db';
import { fail as failFlagEvaluation } from '../support/fakes/fake-openfeature';

// ── Given ─────────────────────────────────────────────────────────────────────

Given<WebhooksWorld>(
  'the topic {string} has delivery blocked in the flags database',
  function (topic: string) {
    seedTopicFlags(this.scenarioId, [{ topic, blocked: true }]);
  },
);

Given<WebhooksWorld>(
  'the topics {string} and {string} have delivery blocked in the flags database',
  function (topic1: string, topic2: string) {
    seedTopicFlags(this.scenarioId, [{ topic: topic1, blocked: true }, { topic: topic2, blocked: true }]);
  },
);

Given<WebhooksWorld>(
  'the topic {string} has delivery explicitly unblocked in the flags database',
  function (topic: string) {
    // Seeds a row with blocked=0 — the "explicitly unblocked" state.
    // Distinct from "no row" (unmanaged): this topic will appear in GET with blocked:false.
    seedTopicFlags(this.scenarioId, [{ topic, blocked: false }]);
  },
);

// Note: "the database is unavailable" Given is defined in subscribers.steps.ts and is
// available globally — no redefinition needed here.

// Flag evaluation fails INSIDE the OpenFeature provider; the SDK swallows the error and answers with
// the caller's default (false = not blocked), so production code never sees the error. Used by the
// webhook-delivery scenarios — step definitions are global.
const FLAG_PROVIDER_ERROR = 'flag provider unavailable';

Given<WebhooksWorld>('the feature flag provider is failing on every evaluation', function () {
  failFlagEvaluation(this.scenarioId, 'openfeature.getBooleanValue', [new Error(FLAG_PROVIDER_ERROR)]);
});

Given<WebhooksWorld>('the feature flag provider fails on its first evaluation and then recovers', function () {
  failFlagEvaluation(this.scenarioId, 'openfeature.getBooleanValue', [new Error(FLAG_PROVIDER_ERROR), null]);
});

// Claims every delivery_log row of one subscriber across two messages that took different paths: the first
// was delivered, the second was suppressed by a blocked flag. Each row is expected with the payload its own
// message was sent with. [delivery-log]
Then<WebhooksWorld>(
  'the deliveries for subscriber {int} should have been logged as successful with key {string} and then blocked with key {string} [delivery-log]',
  function (subscriberId: number, deliveredKey: string, blockedKey: string) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    const expected: DeliveryAttempt[] = [
      {
        subscriber_id: subscriberId,
        message_key: deliveredKey,
        payload: this.payloadSentWithKey(deliveredKey),
        attempt_number: 1,
        status: 'success',
        http_status: 200,
        error_message: null,
      },
      {
        subscriber_id: subscriberId,
        message_key: blockedKey,
        payload: this.payloadSentWithKey(blockedKey),
        attempt_number: 1,
        status: 'blocked',
        http_status: null,
        error_message: null,
      },
    ];
    assert.deepStrictEqual(
      logs,
      expected,
      `Delivery log for subscriber ${subscriberId} did not show one success then one blocked entry. ` +
        `Probable cause: the flag provider did not fail on the first evaluation only, or the topic is not blocked. ` +
        `What to check: the "fails on its first evaluation and then recovers" Given step and blockTopic(). ` +
        `Got: ${JSON.stringify(logs)}`,
    );
  },
);

// ── When ─────────────────────────────────────────────────────────────────────

When<WebhooksWorld>('I list all delivery flags', async function () {
  this.response = await this.request.get('/api/flags');
});

When<WebhooksWorld>('I block delivery for topic {string}', async function (topic: string) {
  this.response = await this.request.patch(`/api/flags/${topic}`).send({ delivery_blocked: true });
});

When<WebhooksWorld>('I unblock delivery for topic {string}', async function (topic: string) {
  this.response = await this.request.patch(`/api/flags/${topic}`).send({ delivery_blocked: false });
});

When<WebhooksWorld>(
  'I block delivery for topic {string} with extra fields in the body',
  async function (topic: string) {
    this.response = await this.request
      .patch(`/api/flags/${topic}`)
      .send({ delivery_blocked: true, unknownField: 'ignored', another: 42 });
  },
);

// Sends the same block request twice, one after the other (a client retry or a double click).
When<WebhooksWorld>('I block delivery for topic {string} twice', async function (topic: string) {
  this.responses = [];
  for (let i = 0; i < 2; i++) {
    this.responses.push(await this.request.patch(`/api/flags/${topic}`).send({ delivery_blocked: true }));
  }
});

// The segment goes into the URL exactly as written, so percent-encoding and slashes reach Express unchanged.
When<WebhooksWorld>('I block delivery for the raw URL path segment {string}', async function (segment: string) {
  this.response = await this.request.patch(`/api/flags/${segment}`).send({ delivery_blocked: true });
});

// Only PATCH is registered on the per-topic path; any other method must fall through to the 404 handler.
When<WebhooksWorld>(
  'I request the flag path for topic {string} with method {string}',
  async function (topic: string, method: string) {
    const verb = method.toLowerCase() as 'delete' | 'put' | 'post';
    this.response = await this.request[verb](`/api/flags/${topic}`);
  },
);

When<WebhooksWorld>('I block delivery without naming a topic', async function () {
  this.response = await this.request.patch('/api/flags/').send({ delivery_blocked: true });
});

When<WebhooksWorld>('I block delivery for a topic name of {int} characters', async function (length: number) {
  this.response = await this.request.patch(`/api/flags/${topicOfLength(length)}`).send({ delivery_blocked: true });
});

// Request bodies the PATCH route rejects, by kind: [content type, raw body].
const REJECTED_BODIES: Record<string, [string, string]> = {
  'malformed-json': ['json', '{ "delivery_blocked": tru'],
  // express.json()'s default limit is 100kb.
  oversized: ['json', JSON.stringify({ delivery_blocked: true, padding: 'x'.repeat(200 * 1024) })],
  // express.json() leaves a non-JSON body unparsed; the handler then sees no delivery_blocked at all.
  'plain-text': ['text', '{"delivery_blocked":true}'],
  'non-boolean': ['json', '{"delivery_blocked":"true"}'],
};

async function sendRejectedBody(world: WebhooksWorld, topic: string, kind: string): Promise<void> {
  const entry = REJECTED_BODIES[kind];
  if (!entry) throw new Error(`Unknown rejected body kind "${kind}" — add it to REJECTED_BODIES in flags.steps.ts`);
  world.response = await world.request.patch(`/api/flags/${topic}`).type(entry[0]).send(entry[1]);
}

When<WebhooksWorld>('I send a flag update for topic {string} with a malformed JSON body', async function (topic: string) {
  await sendRejectedBody(this, topic, 'malformed-json');
});

When<WebhooksWorld>('I send a flag update for topic {string} with an oversized JSON body', async function (topic: string) {
  await sendRejectedBody(this, topic, 'oversized');
});

When<WebhooksWorld>('I send a flag update for topic {string} as plain text instead of JSON', async function (topic: string) {
  await sendRejectedBody(this, topic, 'plain-text');
});

When<WebhooksWorld>('I send a flag update for topic {string} whose body is {word}', async function (topic: string, kind: string) {
  await sendRejectedBody(this, topic, kind);
});

const topicOfLength = (length: number): string => 't'.repeat(length);

// Maps a single-word type name to the actual delivery_blocked value used in the request.
// "missing" sends no delivery_blocked field (empty body); others send the typed value.
const INVALID_DELIVERY_BLOCKED: Record<string, unknown> = {
  null: null, number: 1, zero: 0, object: {}, array: [], string: 'true', 'empty-string': '',
};

When<WebhooksWorld>(
  'I attempt to PATCH delivery blocked for topic {string} with delivery_blocked as {word}',
  async function (topic: string, valueType: string) {
    const body: Record<string, unknown> = {};
    if (valueType !== 'missing') {
      body.delivery_blocked = INVALID_DELIVERY_BLOCKED[valueType];
    }
    this.response = await this.request.patch(`/api/flags/${topic}`).send(body);
  },
);

// ── Then ─────────────────────────────────────────────────────────────────────

Then<WebhooksWorld>('the delivery flag listing should be empty', function () {
  assert.deepStrictEqual(
    this.response.body,
    {},
    `Expected empty delivery flag listing {} but got: ${JSON.stringify(this.response.body)}. ` +
      `Probable cause: a previous PATCH seeded flags that were not cleaned up, or the fake initial state is wrong. ` +
      `What to check: per-scenario isolation in fake-db.ts (cleanup deletes scenario state).`,
  );
});

Then<WebhooksWorld>(
  'the delivery flag listing should contain exactly:',
  function (table: DataTable) {
    // DataTable rows give string values — convert "true"/"false" to boolean.
    const expected = Object.fromEntries(
      table.hashes().map((row) => [row.topic, row.blocked === 'true']),
    );
    assert.deepStrictEqual(
      this.response.body,
      expected,
      `Delivery flag listing did not match expected. ` +
        `Probable cause: wrong rows seeded in topic_flags, or GET handler changed field mapping. ` +
        `What to check: seedTopicFlags() seeding, src/db/topicFlags.ts getAll(), and src/api/flags.ts GET handler. ` +
        `Got: ${JSON.stringify(this.response.body)}, Expected: ${JSON.stringify(expected)}`,
    );
  },
);

// The listing is a JSON object, so its key order is what a client iterates; the GET query orders by topic.
Then<WebhooksWorld>('the delivery flag listing should contain, in this order:', function (table: DataTable) {
  const expected = table.hashes().map((row) => [row.topic, row.blocked === 'true']);
  assert.deepStrictEqual(
    Object.entries(this.response.body),
    expected,
    'Delivery flag listing did not match, or its topics were out of order. ' +
      'Probable cause: the GET query lost its ORDER BY topic, or the handler stopped preserving row order. ' +
      `What to check: src/db/topicFlags.ts getAll() and src/api/flags.ts GET handler. Got: ${JSON.stringify(this.response.body)}`,
  );
});

// Owns both upserts and both PATCH responses of 'I block delivery for topic … twice'. [topic-flags-upsert, patch-response]
Then<WebhooksWorld>(
  'both requests should have written topic {string} as blocked to the flags database [topic-flags-upsert, patch-response]',
  function (topic: string) {
    const upserts = [takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic), takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic)];
    assert.deepStrictEqual(
      upserts,
      [{ topic, blocked: true }, { topic, blocked: true }],
      `Expected two identical topic_flags upserts blocking "${topic}". Got: ${JSON.stringify(upserts)}`,
    );
    assert.deepStrictEqual(
      this.responses!.map((r) => ({ status: r.status, body: r.body })),
      [
        { status: 200, body: { topic, delivery_blocked: true } },
        { status: 200, body: { topic, delivery_blocked: true } },
      ],
      'Expected both block requests to succeed with the same response. ' +
        'Probable cause: the handler started rejecting a repeat request. ' +
        `Got: ${JSON.stringify(this.responses!.map((r) => ({ status: r.status, body: r.body })))}`,
    );
  },
);

Then<WebhooksWorld>(
  'delivery for the {int}-character topic should have been written as blocked to the flags database [topic-flags-upsert, patch-response]',
  function (length: number) {
    const topic = topicOfLength(length);
    assert.deepStrictEqual(
      takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic),
      { topic, blocked: true },
      `topic_flags upsert did not match for the ${length}-character topic.`,
    );
    assert.deepStrictEqual(
      this.response.body,
      { topic, delivery_blocked: true },
      `PATCH response body for the ${length}-character topic did not match. Got: ${JSON.stringify(this.response.body)}`,
    );
  },
);

// A write MySQL rejects is still a write the app attempted (fake-db records it before rethrowing). [topic-flags-upsert]
Then<WebhooksWorld>(
  'the delivery flag write for the {int}-character topic should have been rejected by MySQL as too long [topic-flags-upsert]',
  function (length: number) {
    // MySQL strict mode's VARCHAR overflow error, pinned as a literal.
    const error = { message: "Data too long for column 'topic' at row 1", code: 'ER_DATA_TOO_LONG' };
    assert.deepStrictEqual(
      takeOwnershipOfFailedWrites(this.scenarioId, 'topicFlags.upsert'),
      [{ operation: 'topicFlags.upsert', args: { topic: topicOfLength(length), blocked: true }, error }],
      `Expected exactly one topic_flags upsert for the ${length}-character topic, rejected with ER_DATA_TOO_LONG. ` +
        'What to check: topic_flags.topic is VARCHAR(255) (init.sql) and the handler does not validate length first.',
    );
  },
);

// Owns both the topic_flags upsert and the PATCH response body. [topic-flags-upsert, patch-response]
Then<WebhooksWorld>(
  'delivery for topic {string} should have been written as blocked to the flags database [topic-flags-upsert, patch-response]',
  function (topic: string) {
    const upserted = takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic);
    assert.deepStrictEqual(
      upserted,
      { topic, blocked: true },
      `topic_flags upsert did not match for blocked topic "${topic}". ` +
        `Probable cause: PATCH handler wrote wrong blocked value or wrong topic. ` +
        `What to check: src/api/flags.ts PATCH handler and src/db/topicFlags.ts upsert(). ` +
        `Got: ${JSON.stringify(upserted)}`,
    );
    assert.deepStrictEqual(
      this.response.body,
      { topic, delivery_blocked: true },
      `PATCH response body for blocking "${topic}" did not match. ` +
        `Probable cause: handler returned wrong topic or delivery_blocked value. ` +
        `What to check: src/api/flags.ts PATCH handler res.json(). ` +
        `Got: ${JSON.stringify(this.response.body)}`,
    );
  },
);

// Owns both the topic_flags upsert and the PATCH response body. [topic-flags-upsert, patch-response]
Then<WebhooksWorld>(
  'delivery for topic {string} should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]',
  function (topic: string) {
    const upserted = takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic);
    assert.deepStrictEqual(
      upserted,
      { topic, blocked: false },
      `topic_flags upsert did not match for unblocked topic "${topic}". ` +
        `Probable cause: PATCH handler wrote wrong blocked value (expected false) or wrong topic. ` +
        `What to check: src/api/flags.ts PATCH handler and src/db/topicFlags.ts upsert(). ` +
        `Got: ${JSON.stringify(upserted)}`,
    );
    assert.deepStrictEqual(
      this.response.body,
      { topic, delivery_blocked: false },
      `PATCH response body for unblocking "${topic}" did not match. ` +
        `Probable cause: handler returned wrong topic or delivery_blocked value. ` +
        `What to check: src/api/flags.ts PATCH handler res.json(). ` +
        `Got: ${JSON.stringify(this.response.body)}`,
    );
  },
);

// Empty-body negative assertion — the ownership safety net (throwIfUnownedExist) enforces absence:
// a rejected request on the flags endpoint must not leak a topic_flags upsert. Earns its place because
// the endpoint family (PATCH) does mutate, so a reader expects a possible write here.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no delivery flag should have been modified', function () {});

// A failed upsert is still a write the app attempted (fake-db records it before rethrowing). [topic-flags-upsert]
Then<WebhooksWorld>(
  'the delivery flag write blocking topic {string} should have been attempted and failed with {string} [topic-flags-upsert]',
  function (topic: string, message: string) {
    assertFailedUpsert(this, topic, true, message);
  },
);

Then<WebhooksWorld>(
  'the delivery flag write unblocking topic {string} should have been attempted and failed with {string} [topic-flags-upsert]',
  function (topic: string, message: string) {
    assertFailedUpsert(this, topic, false, message);
  },
);

function assertFailedUpsert(world: WebhooksWorld, topic: string, blocked: boolean, message: string): void {
  assert.deepStrictEqual(
    takeOwnershipOfFailedWrites(world.scenarioId, 'topicFlags.upsert'),
    [{ operation: 'topicFlags.upsert', args: { topic, blocked }, error: { message } }],
    `Expected exactly one failed topic_flags upsert (topic "${topic}", blocked=${blocked}) with the injected error. ` +
      'What to check: the "database is unavailable" Given, and that PATCH /api/flags/:topic reached upsert().',
  );
}
