import assert from 'assert';
import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import {
  seedTopicFlags,
  takeOwnershipOfTopicFlagsUpsert,
} from '../support/fakes/fake-mysql';

// ── Given ─────────────────────────────────────────────────────────────────────

Given<WebhooksWorld>(
  'the topic {string} has delivery blocked in the flags database',
  function (topic: string) {
    seedTopicFlags(this.scenarioId, [{ topic, blocked: 1 }]);
  },
);

Given<WebhooksWorld>(
  'the topics {string} and {string} have delivery blocked in the flags database',
  function (topic1: string, topic2: string) {
    seedTopicFlags(this.scenarioId, [{ topic: topic1, blocked: 1 }, { topic: topic2, blocked: 1 }]);
  },
);

Given<WebhooksWorld>(
  'the topic {string} has delivery explicitly unblocked in the flags database',
  function (topic: string) {
    // Seeds a row with blocked=0 — the "explicitly unblocked" state.
    // Distinct from "no row" (unmanaged): this topic will appear in GET with blocked:false.
    seedTopicFlags(this.scenarioId, [{ topic, blocked: 0 }]);
  },
);

// Note: "the database is unavailable" Given is defined in subscribers.steps.ts and is
// available globally — no redefinition needed here.

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

// Maps a single-word type name to the actual delivery_blocked value used in the request.
// "missing" sends no delivery_blocked field (empty body); others send the typed value.
const INVALID_DELIVERY_BLOCKED: Record<string, unknown> = {
  null: null, number: 1, object: {}, array: [], string: 'true',
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
      `What to check: per-scenario isolation in fake-mysql.ts (cleanup deletes scenario state).`,
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

// Owns both the topic_flags upsert and the PATCH response body. [topic-flags-upsert, patch-response]
Then<WebhooksWorld>(
  'delivery for topic {string} should be blocked in the flags database [topic-flags-upsert, patch-response]',
  function (topic: string) {
    const upserted = takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic);
    assert.deepStrictEqual(
      upserted,
      { topic, blocked: 1 },
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
  'delivery for topic {string} should be unblocked in the flags database [topic-flags-upsert, patch-response]',
  function (topic: string) {
    const upserted = takeOwnershipOfTopicFlagsUpsert(this.scenarioId, topic);
    assert.deepStrictEqual(
      upserted,
      { topic, blocked: 0 },
      `topic_flags upsert did not match for unblocked topic "${topic}". ` +
        `Probable cause: PATCH handler wrote wrong blocked value (expected 0) or wrong topic. ` +
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
