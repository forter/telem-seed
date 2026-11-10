import assert from 'assert';
import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { seedSubscribers } from '../support/fakes/fake-mysql';
import type { WebhooksWorld } from '../support/world';

Given('no subscribers are seeded', function (this: WebhooksWorld) {
  // Explicit no-op step — documents that this scenario begins with an empty subscriber table.
});

Given('the following subscribers are seeded:', function (this: WebhooksWorld, table: DataTable) {
  const rows = table.hashes().map((row) => ({
    id: parseInt(row.id, 10),
    name: row.name,
    topic: row.topic,
    url: row.url,
    headers: row.headers ?? '{}',
  }));
  seedSubscribers(this.scenarioId, rows);
});

When('I GET the subscribers list', async function (this: WebhooksWorld) {
  this.response = await this.request.get('/api/subscribers');
});

Then('the response status is {int}', function (this: WebhooksWorld, status: number) {
  assert.strictEqual(
    this.response.status,
    status,
    `Expected HTTP ${status}, got ${this.response.status}. ` +
      `Probable cause: MySQL fake not wired, DB pool not initialized, or Express route threw. ` +
      `Check: BeforeAll logs for "MySQL connected", response body for error details: ${JSON.stringify(this.response.body).slice(0, 200)}`,
  );
});

Then('the response body contains {int} subscriber(s)', function (this: WebhooksWorld, count: number) {
  const body = this.response.body as unknown[];
  assert.strictEqual(
    body.length,
    count,
    `Expected ${count} subscribers, got ${body.length}. ` +
      `Probable cause: seedSubscribers() data didn't persist (wrong scenarioId or scenario isolation bug) or the query filter is wrong. ` +
      `Check: the DataTable parse in the Given step and the fake-mysql SELECT routing.`,
  );
});

Then('the first subscriber has name {string}', function (this: WebhooksWorld, name: string) {
  const body = this.response.body as Array<{ name: string }>;
  assert.strictEqual(body[0].name, name, `Expected first subscriber name "${name}", got "${body[0]?.name}"`);
});

Then('the second subscriber has name {string}', function (this: WebhooksWorld, name: string) {
  const body = this.response.body as Array<{ name: string }>;
  assert.strictEqual(body[1].name, name, `Expected second subscriber name "${name}", got "${body[1]?.name}"`);
});

Then('the response body is an empty array', function (this: WebhooksWorld) {
  // Full-shape assertion: deep-equal to [] verifies both the array type and its emptiness in one check.
  assert.deepStrictEqual(
    this.response.body,
    [],
    `Expected an empty array but got ${JSON.stringify(this.response.body).slice(0, 200)}. ` +
      `Probable cause: subscriber data leaked from a previous scenario (cleanup did not run), this scenario ` +
      `seeded data unintentionally, or the GET handler returned a non-array shape. ` +
      `Check: scenario isolation in fake-mysql cleanup() and the "no subscribers are seeded" Given step.`,
  );
});
