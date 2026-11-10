import assert from 'assert';
import path from 'path';
import { Given, When, Then, After, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';

// ── Per-scenario override tracking ─────────────────────────────────────────────
// Module-level booleans are safe here: Cucumber runs scenarios sequentially.

let _kafkaOverrideSet = false;
let _flagsOverrideSet = false;

// ── Given ─────────────────────────────────────────────────────────────────────

// Note: "the database is unavailable" is defined in subscribers.steps.ts (globally available).

Given<WebhooksWorld>('the Kafka consumer is not connected', function () {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const consumerModule = require(path.join(__dirname, '../../../dist/kafka/consumer'));
  consumerModule.__overrideConsumerConnectedForTest(false);
  _kafkaOverrideSet = true;
});

Given<WebhooksWorld>('the flags provider is not ready', function () {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flagsModule = require(path.join(__dirname, '../../../dist/flags/index'));
  flagsModule.__overrideFlagsReadyForTest(false);
  _flagsOverrideSet = true;
});

// ── When ──────────────────────────────────────────────────────────────────────

When<WebhooksWorld>('I request the health check', async function () {
  this.response = await this.request.get('/health');
});

When<WebhooksWorld>('I send a POST request to the health check endpoint', async function () {
  this.response = await this.request.post('/health');
});

When<WebhooksWorld>('I send a PUT request to the health check endpoint', async function () {
  this.response = await this.request.put('/health');
});

When<WebhooksWorld>('I send a DELETE request to the health check endpoint', async function () {
  this.response = await this.request.delete('/health');
});

When<WebhooksWorld>('I send a PATCH request to the health check endpoint', async function () {
  this.response = await this.request.patch('/health');
});

When<WebhooksWorld>('I request the health check with query parameter {string}', async function (queryParam: string) {
  this.response = await this.request.get(`/health?${queryParam}`);
});

When<WebhooksWorld>('I request the health check without any authentication headers', async function () {
  // Explicitly issue the request with no Authorization header to document that /health
  // must be reachable by unauthenticated Kubernetes readiness probes and load balancers.
  this.response = await this.request.get('/health');
});

// ── Then ──────────────────────────────────────────────────────────────────────

Then<WebhooksWorld>('the health check response should be:', function (dataTable: DataTable) {
  const { status, ...dependencies } = dataTable.rowsHash();
  assert.deepStrictEqual(
    this.response.body,
    { status, dependencies },
    `What failed: health check response body does not match expected shape. ` +
      `Expected status="${status}" with dependencies=${JSON.stringify(dependencies)}. ` +
      `Actual: ${JSON.stringify(this.response.body)}. ` +
      `Probable cause: a dependency probe returned the wrong state, or the /health handler ` +
      `is not yet probing all three dependencies (MySQL, Kafka, OpenFeature). ` +
      `What to check: src/api/index.ts health handler + src/db/index.ts ping() + ` +
      `src/kafka/consumer.ts isConsumerConnected() + src/flags/index.ts isFlagsReady().`,
  );
});

Then<WebhooksWorld>('the health check response should only contain documented fields', function () {
  const keys = Object.keys(this.response.body ?? {});
  // The contract is exactly two top-level keys: status + dependencies.
  // Extra keys (e.g. stack traces, internal hostnames) would be an info-leak.
  assert.deepStrictEqual(
    keys.sort(),
    ['dependencies', 'status'],
    `What failed: /health response contains undocumented top-level keys. ` +
      `Actual keys: ${JSON.stringify(keys)}. ` +
      `Expected only: ["dependencies", "status"]. ` +
      `Probable cause: a new field was added to the /health handler without updating the contract. ` +
      `What to check: src/api/index.ts health handler — the object passed to res.json() must have exactly "status" and "dependencies".`,
  );
});

Then<WebhooksWorld>('the response content type should be JSON', function () {
  const contentType: string = this.response.headers['content-type'] ?? '';
  assert.ok(
    contentType.includes('application/json'),
    `What failed: Content-Type header is not application/json. ` +
      `Actual: ${contentType}. ` +
      `Probable cause: the /health handler was changed from res.json() to res.send() or similar. ` +
      `What to check: src/api/index.ts health handler must call res.json(), not res.send().`,
  );
});

// ── After ─────────────────────────────────────────────────────────────────────
// Runs before defaults.steps.ts After hook (LIFO registration order) — overrides are
// cleared before the ownership safety net runs, so no stale state bleeds into cleanup.

After<WebhooksWorld>(function () {
  if (_kafkaOverrideSet) {
    _kafkaOverrideSet = false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path.join(__dirname, '../../../dist/kafka/consumer')).__overrideConsumerConnectedForTest(null);
  }
  if (_flagsOverrideSet) {
    _flagsOverrideSet = false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path.join(__dirname, '../../../dist/flags/index')).__overrideFlagsReadyForTest(null);
  }
});
