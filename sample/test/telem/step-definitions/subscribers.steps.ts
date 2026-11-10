import assert from 'assert';
import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import {
  seedSubscribers,
  removeSubscriberFromState,
  takeOwnershipOfSubscriberInsert,
  takeOwnershipOfSubscriberDelete,
  failAllMysql,
  FAKE_INSERT_CREATED_AT_ISO,
} from '../support/fakes/fake-mysql';

// Fixed timestamp used when seeding subscribers — avoids non-deterministic new Date() in seeds.
// Production uses MySQL DEFAULT CURRENT_TIMESTAMP; the fake substitutes this constant.
const SEED_CREATED_AT = new Date('2024-01-01T00:00:00.000Z');
const SEED_CREATED_AT_ISO = SEED_CREATED_AT.toISOString();

// ── Given ─────────────────────────────────────────────────────────────────────

Given<WebhooksWorld>(
  'a subscriber {string} with ID {int} listens for topic {string} at URL {string}',
  function (name: string, id: number, topic: string, url: string) {
    seedSubscribers(this.scenarioId, [
      { id, name, topic, url, headers: {}, created_at: SEED_CREATED_AT },
    ]);
    this.seededSubscriberId = id;
    this.seededSubscriberUrls.push(url);
    this.seededSubscriberIds.push(id);
  },
);

// ── Given ─ error/edge-case ───────────────────────────────────────────────────

Given<WebhooksWorld>('the database is unavailable', function () {
  // Whole-database outage — every declared operation fails (used across register/delete/list/flags/health).
  failAllMysql(this.scenarioId, [new Error('Connection refused')]);
});

// Removes the subscriber directly from fake state without recording a DELETE IO event.
// Use in Given steps that establish "subscriber was deleted before this scenario's action"
// so the ownership safety net doesn't flag an unowned delete.
Given<WebhooksWorld>('subscriber {int} has been deleted', function (id: number) {
  removeSubscriberFromState(this.scenarioId, id);
});

// ── When ─────────────────────────────────────────────────────────────────────

When<WebhooksWorld>('I list all subscribers', async function () {
  this.response = await this.request.get('/api/subscribers');
});

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string}',
  async function (name: string, topic: string, url: string) {
    this.lastSubscriberRequest = { name, topic, url, headers: {} };
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url });
  },
);

When<WebhooksWorld>(
  'I register subscriber {string} for topic {string} at URL {string} with headers:',
  async function (name: string, topic: string, url: string, table: DataTable) {
    const headers = Object.fromEntries(table.rows().map(([k, v]) => [k, v]));
    this.lastSubscriberRequest = { name, topic, url, headers };
    this.response = await this.request.post('/api/subscribers').send({ name, topic, url, headers });
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
  this.lastSubscriberRequest = {
    name: 'Payments Service',
    topic: 'orders',
    url: 'https://payments.example.com/hook',
    headers: {},
  };
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
      `What to check: fake-mysql.ts cleanup() (per-scenario teardown) and GET /api/subscribers handler in src/api/subscribers.ts.`,
  );
});

// Owns the MySQL INSERT and asserts the 201 response matches the SUBMITTED request data. [subscriber-insert, post-response]
Then<WebhooksWorld>(
  'the registered subscriber should match the submitted data [subscriber-insert, post-response]',
  function () {
    const req = this.lastSubscriberRequest!;
    // Claim the INSERT by the submitted URL (ownership); its generated id is the only field with no
    // request-side source. name/topic/url/headers come from the request, so the assertion verifies
    // the response reflects what was submitted — not a value read back out of the captured INSERT.
    const insert = takeOwnershipOfSubscriberInsert(this.scenarioId, req.url);
    const expected = {
      id: insert.id,
      name: req.name,
      topic: req.topic,
      url: req.url,
      headers: req.headers,
    };
    assert.deepStrictEqual(
      this.response.body,
      expected,
      `POST response body did not match the submitted registration data. ` +
        `Probable cause: the handler returned different data than was submitted, or the response shape changed. ` +
        `What to check: src/api/subscribers.ts POST handler response serialization and src/db/subscribers.ts create() return shape. ` +
        `Got: ${JSON.stringify(this.response.body)}, Expected: ${JSON.stringify(expected)}`,
    );
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

// Owns the MySQL DELETE for a non-existent row (affectedRows === 0). [subscriber-delete]
Then<WebhooksWorld>(
  'the attempt to remove subscriber {int} found no matching subscriber [subscriber-delete]',
  function (id: number) {
    const deleted = takeOwnershipOfSubscriberDelete(this.scenarioId, id);
    assert.strictEqual(
      deleted.affectedRows,
      0,
      `Expected 0 affected rows when removing non-existent subscriber ${id} but got ${deleted.affectedRows}. ` +
        `Probable cause: a subscriber with id=${id} was unexpectedly seeded, or the DELETE matched a wrong row.`,
    );
  },
);

// Owns the MySQL DELETE and asserts the row was found and removed. [subscriber-delete]
Then<WebhooksWorld>(
  'subscriber {int} should have been removed [subscriber-delete]',
  function (id: number) {
    const deleted = takeOwnershipOfSubscriberDelete(this.scenarioId, id);
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
      `What to check: verify no DB failure was injected via fail()/failAllMysql(), and check the app startup log. ` +
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
      `What to check: SEED_CREATED_AT_ISO value, seedSubscribers() call in the Given step, and fake-mysql SELECT routing. ` +
      `Got: ${JSON.stringify(listResp.body[0])}`,
  );
  assert.deepStrictEqual(
    listResp.body[1],
    { id: registeredId, name: req.name, topic: req.topic, url: req.url, headers: req.headers, created_at: FAKE_INSERT_CREATED_AT_ISO },
    `Newly registered subscriber did not match in the list. ` +
      `Probable cause: FAKE_INSERT_CREATED_AT_ISO doesn't match the created_at set in fake-mysql's INSERT branch, ` +
      `or the GET response shape differs from the submitted data. ` +
      `What to check: FAKE_INSERT_CREATED_AT constant in fake-mysql.ts and the submitted request body. ` +
      `Got: ${JSON.stringify(listResp.body[1])}`,
  );
});

// Empty-body negative assertion — the ownership safety net (throwIfUnownedExist) enforces absence:
// a rejected registration must not leak a subscriber INSERT. Earns its place (per the negative-assertion
// rule) because the happy path's POST does persist, so a reader expects a write here.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no subscriber should have been persisted', function () {});
