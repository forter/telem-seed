import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { Given, When, Then, After, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import * as fakeDb from '../support/fakes/fake-db';
import * as fakeKafka from '../support/fakes/fake-kafka';

// ── Per-scenario module swap tracking ──────────────────────────────────────────
// Module-level state is safe here: Cucumber runs scenarios sequentially.

let _originalIsFlagsReady: (() => boolean) | undefined;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const consumerModule = () => require(path.join(__dirname, '../../../dist/kafka/consumer'));

// ── Given ─────────────────────────────────────────────────────────────────────

// Note: "the database is unavailable" is defined in subscribers.steps.ts (globally available).

// Shuts the consumer down the way production's SIGTERM handler does, so the real probe (`consumer !== null`)
// answers; __overrideConsumerConnectedForTest would short-circuit it. The next scenario gets a fresh
// consumer (reseatKafkaConsumer).
async function stopKafkaConsumer(): Promise<void> {
  await consumerModule().stopConsumer();
}

// Drives the real readiness probe (`flagsInitialized` in isFlagsReady) into the state production is in between
// Express listening and initFlags() resolving (src/index.ts starts Express first): a fresh copy of the flags
// module whose initFlags() has not run. Its isFlagsReady replaces the shared module's for this scenario, so
// /health's call-time `flags_2.isFlagsReady()` reads it; the After hook puts the original back. Only that export is
// swapped: it is the only one /health reads, and it closes over the fresh copy's own `flagsInitialized`.
// __overrideFlagsReadyForTest is not used: it short-circuits the probe (WRITING-TESTS.md "Drive real state").
function makeFlagsNotReady(): void {
  const modulePath = require.resolve(path.join(__dirname, '../../../dist/flags/index'));
  const original = require.cache[modulePath]!;
  delete require.cache[modulePath];
  let fresh: { isFlagsReady: () => boolean };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fresh = require(modulePath);
  } finally {
    // A throwing reload must not leave later scenarios loading their own copy of the flags module.
    require.cache[modulePath] = original;
  }
  _originalIsFlagsReady ??= original.exports.isFlagsReady;
  original.exports.isFlagsReady = fresh.isFlagsReady;
}

Given<WebhooksWorld>('the Kafka consumer has been shut down', async function () {
  await stopKafkaConsumer();
});

Given<WebhooksWorld>('the flags provider is not ready', function () {
  makeFlagsNotReady();
});

Given<WebhooksWorld>('the {word} health dependency is down', async function (dependency: string) {
  switch (dependency) {
    case 'mysql':
      // ping() is the only DB call /health makes, so failing just it is the whole outage as the probe sees it.
      this.failFake(fakeDb, 'db.ping', [new Error('Connection refused')]);
      return;
    case 'kafka':
      await stopKafkaConsumer();
      return;
    case 'flags':
      makeFlagsNotReady();
      return;
    default:
      throw new Error(`Unknown health dependency "${dependency}" — expected mysql, kafka or flags`);
  }
});

Given<WebhooksWorld>('the database answers the first health probe and fails the next one', function () {
  this.failFake(fakeDb, 'db.ping', [null, new Error('Connection refused')]);
});

Given<WebhooksWorld>('the database fails the first health probe and answers the next one', function () {
  this.failFake(fakeDb, 'db.ping', [new Error('Connection refused'), null]);
});

Given<WebhooksWorld>('the Kafka consumer cannot connect to the broker', function () {
  this.failFake(fakeKafka, 'kafka.connect', [new Error('Injected Kafka connect failure')]);
});

// Replays step 4 of main() in src/index.ts: a consumer start that rejects is logged and swallowed, the app keeps
// serving. Pair with a failing-consumer Given and a seeded subscriber so there is a topic to subscribe to.
Given<WebhooksWorld>('the instance has run its Kafka consumer startup', async function () {
  await stopKafkaConsumer();
  const log = console.error;
  console.error = () => undefined;
  try {
    await consumerModule().startConsumer();
  } catch (err) {
    // Mirrors main(): "Kafka consumer failed to start" is logged and the app carries on. Only the failure a Given
    // injected is swallowed (the kafka Givens all name theirs "Injected Kafka … failure"); anything else is a
    // broken step or stub, and swallowing it would let a scenario pass without reaching the call it fails.
    if (!(err instanceof Error && /^Injected Kafka \w+ failure$/.test(err.message))) throw err;
  } finally {
    console.error = log;
  }
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

When<WebhooksWorld>('I request the health check at path {string}', async function (urlPath: string) {
  this.response = await this.request.get(urlPath);
});

When<WebhooksWorld>('I request the health check with a well-formed JSON body', async function () {
  this.response = await this.request.get('/health').type('json').send({ verbose: true });
});

When<WebhooksWorld>('I send an OPTIONS request to the health check endpoint', async function () {
  this.response = await this.request.options('/health');
});

const METHODS = ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const BODIES: Record<string, string> = {
  'well-formed': JSON.stringify({ verbose: true }),
  malformed: '{ this is not valid json }',
  oversized: JSON.stringify({ payload: 'x'.repeat(200 * 1024) }), // express.json()'s default limit is 100kb
};

When<WebhooksWorld>(
  'I send a {word} request with a {word} JSON body to the health check endpoint',
  async function (method: string, bodyKind: string) {
    if (!(METHODS as readonly string[]).includes(method)) throw new Error(`Unsupported method "${method}" — expected one of ${METHODS.join(', ')}`);
    const body = BODIES[bodyKind];
    if (body === undefined) throw new Error(`Unknown body kind "${bodyKind}" — expected one of ${Object.keys(BODIES).join(', ')}`);
    this.response = await sendRaw(this.request.get('/health').url, method, body);
  },
);

// Each kind is the body plus the Content-Encoding it is labelled with. body-parser inflates gzip itself and applies
// the 100kb limit to the inflated size.
const ENCODED_BODIES: Record<string, { encoding: string; body: Buffer }> = {
  'a gzip bomb': { encoding: 'gzip', body: zlib.gzipSync(JSON.stringify({ payload: 'x'.repeat(5 * 1024 * 1024) })) },
  'not really gzip': { encoding: 'gzip', body: Buffer.from(JSON.stringify({ verbose: true })) },
  'in an unsupported encoding': { encoding: 'compress', body: Buffer.from(JSON.stringify({ verbose: true })) },
};

When<WebhooksWorld>(
  'I send a {word} request to the health check endpoint whose JSON body is {string}',
  async function (method: string, bodyKind: string) {
    if (!(['GET', ...METHODS] as readonly string[]).includes(method)) throw new Error(`Unsupported method "${method}" — expected GET or one of ${METHODS.join(', ')}`);
    const encoded = ENCODED_BODIES[bodyKind];
    if (encoded === undefined) throw new Error(`Unknown body kind "${bodyKind}" — expected one of ${Object.keys(ENCODED_BODIES).join(', ')}`);
    this.response = await sendRaw(this.request.get('/health').url, method, encoded.body, { 'content-encoding': encoded.encoding });
  },
);

// Plain node:http rather than supertest: superagent silently drops the body of a HEAD request while keeping its
// Content-Length, so body-parser 400s on the short read and a HEAD row would pass for the wrong reason.
function sendRaw(
  url: string,
  method: string,
  body: string | Buffer,
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders };
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined; // not JSON (an error page, or a HEAD's empty body)
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// %2f keeps the HTTP client from collapsing the ".." segments before the request leaves.
When<WebhooksWorld>('I request the repository manifest through an encoded path traversal', async function () {
  this.response = await this.request.get('/..%2f..%2fpackage.json');
});

When<WebhooksWorld>('I send a POST request to an API path that does not exist', async function () {
  this.response = await this.request.post('/api/does-not-exist');
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

Then<WebhooksWorld>('a second health check should answer {int} with:', async function (httpStatus: number, dataTable: DataTable) {
  const { status, ...dependencies } = dataTable.rowsHash();
  const second = await this.request.get('/health');
  assert.deepStrictEqual(
    { httpStatus: second.status, body: second.body },
    { httpStatus, body: { status, dependencies } },
    `What failed: the second /health call did not reflect the database's state at that moment. ` +
      `Actual: ${second.status} ${JSON.stringify(second.body)}. ` +
      `Probable cause: the handler cached or latched an earlier probe result instead of pinging on every request. ` +
      `What to check: the /health handler in src/api/index.ts must call ping() per request.`,
  );
});

Then<WebhooksWorld>('the allowed methods should be advertised as {string}', function (allowed: string) {
  // The Allow header is the contract; Express also echoes it as the body, which is incidental.
  assert.deepStrictEqual(
    this.response.headers['allow'],
    allowed,
    `What failed: OPTIONS /health did not advertise exactly ${allowed}. ` +
      `Probable cause: a new method was registered on /health, or an app-wide OPTIONS/CORS handler now answers first. ` +
      `What to check: the routes registered on /health in src/api/index.ts.`,
  );
});

Then<WebhooksWorld>('the error page should expose the JSON parser stack trace', function () {
  const text: string = this.response.text ?? '';
  assert.deepStrictEqual(
    {
      contentType: this.response.headers['content-type'],
      parseError: /<pre>SyntaxError: [^<]*JSON/.test(text),
      // Any rendered stack frame (finalhandler escapes "\n    at" as "<br> &nbsp; &nbsp;at"). Which frames, and
      // body-parser's file layout, are the dependency's, not the leak's.
      stackFrames: /<br>(?:\s|&nbsp;)*at \S/.test(text),
    },
    { contentType: 'text/html; charset=utf-8', parseError: true, stackFrames: true },
    `What failed: the malformed-body error page no longer matches Express's development-mode page. ` +
      `Actual body: ${text.slice(0, 300)}. ` +
      `Probable cause (good news): NODE_ENV=production is now set, or an error handler was added that hides the stack. ` +
      `What to check: update this scenario to the new, non-leaking response.`,
  );
});

Then<WebhooksWorld>('the repository manifest should not have been served', function () {
  const manifest = fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8');
  const name: string = JSON.parse(manifest).name;
  const text: string = this.response.text ?? '';
  assert.deepStrictEqual(
    { servesManifest: text.includes(manifest.trim()), mentionsPackageName: text.includes(`"name": "${name}"`) },
    { servesManifest: false, mentionsPackageName: false },
    `What failed: a ".." path escaped the public directory and served package.json (status ${this.response.status}). ` +
      `Probable cause: static serving was replaced by a handler that joins the request path onto a directory itself. ` +
      `What to check: express.static and the SPA catch-all in src/api/index.ts.`,
  );
});

// Pins that Express's own 404 answered (an HTML page naming the method and path), not its exact wording.
Then<WebhooksWorld>('the request should be refused with Express\'s own 404 page', function () {
  const text: string = this.response.text ?? '';
  assert.deepStrictEqual(
    { contentType: this.response.headers['content-type'], namesRequest: /POST \/api\/does-not-exist/.test(text) },
    { contentType: 'text/html; charset=utf-8', namesRequest: true },
    `What failed: POST to an unknown /api path did not reach Express's default 404. ` +
      `Actual body: ${(this.response.text ?? '').slice(0, 300)}. ` +
      `Probable cause: a catch-all now answers non-GET methods, or an API 404 handler was added. ` +
      `What to check: the routers and the SPA catch-all in src/api/index.ts.`,
  );
});

Then<WebhooksWorld>(
  'the startup subscription to topic {string} should have been attempted and failed [kafka-subscribe]',
  async function (topic: string) {
    assert.deepStrictEqual(
      await fakeKafka.takeOwnershipOfSubscriptions(this.scenarioId, topic),
      [{ op: 'subscribe', topic, fromBeginning: false, failed: true }],
      `What failed: startConsumer() did not attempt (exactly once) the subscription it was told to fail. ` +
        `What to check: startConsumer in src/kafka/consumer.ts subscribes each topic from findDistinctTopics().`,
    );
  },
);

Then<WebhooksWorld>(
  'the startup run of the Kafka consumer on topic {string} should have been attempted and failed [kafka-subscribe, kafka-run]',
  async function (topic: string) {
    assert.deepStrictEqual(
      {
        subscriptions: await fakeKafka.takeOwnershipOfSubscriptions(this.scenarioId, topic),
        runState: await fakeKafka.takeOwnershipOfConsumerRunState(this.scenarioId, fakeKafka.CONSUMER_GROUP_ID),
      },
      {
        subscriptions: [{ op: 'subscribe', topic, fromBeginning: false, failed: false }],
        runState: [{ op: 'run', groupId: fakeKafka.CONSUMER_GROUP_ID, topics: [topic], failed: true }],
      },
      `What failed: startConsumer() did not subscribe to "${topic}" and then attempt (exactly once) the run it was told to fail. ` +
        `What to check: startConsumer and startRunning in src/kafka/consumer.ts.`,
    );
  },
);

Then<WebhooksWorld>(
  'the consumer should have subscribed to topic {string}, run, and then stopped [kafka-subscribe, kafka-run]',
  async function (topic: string) {
    assert.deepStrictEqual(
      {
        subscriptions: await fakeKafka.takeOwnershipOfSubscriptions(this.scenarioId, topic),
        runState: await fakeKafka.takeOwnershipOfConsumerRunState(this.scenarioId, fakeKafka.CONSUMER_GROUP_ID),
      },
      {
        subscriptions: [{ op: 'subscribe', topic, fromBeginning: false, failed: false }],
        runState: [
          { op: 'run', groupId: fakeKafka.CONSUMER_GROUP_ID, topics: [topic], failed: false },
          { op: 'stop', groupId: fakeKafka.CONSUMER_GROUP_ID, failed: false },
        ],
      },
      `What failed: the consumer did not start on topic "${topic}" and then stop before disconnecting. ` +
        `What to check: startConsumer and stopConsumer in src/kafka/consumer.ts.`,
    );
  },
);

// ── Defensive probes ──────────────────────────────────────────────────────────

When<WebhooksWorld>('I request the health check accepting only {string}', async function (accept: string) {
  this.response = await this.request.get('/health').set('Accept', accept);
});

When<WebhooksWorld>('I request the health check {int} times concurrently', async function (count: number) {
  this.responses = await Promise.all(Array.from({ length: count }, () => this.request.get('/health')));
});

Then<WebhooksWorld>(
  'every concurrent health check should answer {int} with:',
  function (httpStatus: number, dataTable: DataTable) {
    const { status, ...dependencies } = dataTable.rowsHash();
    const responses = this.responses ?? [];
    assert.ok(responses.length > 1, `What failed: no concurrent /health responses were captured (got ${responses.length}).`);
    assert.deepStrictEqual(
      responses.map((r) => ({ httpStatus: r.status, body: r.body })),
      responses.map(() => ({ httpStatus, body: { status, dependencies } })),
      `What failed: concurrent /health probes disagreed with the expected verdict. ` +
        `Probable cause: shared mutable state in the handler or the probes (a shared in-flight ping, a latched result). ` +
        `What to check: the /health handler in src/api/index.ts.`,
    );
  },
);

When<WebhooksWorld>(
  'I request the health check with the header {string} set to {string}',
  async function (header: string, value: string) {
    this.response = await this.request.get('/health').set(header, value);
  },
);

When<WebhooksWorld>('I request the health check with a query string of {int} characters', async function (length: number) {
  this.response = await this.request.get(`/health?q=${'a'.repeat(length)}`);
});

// Bodies and the Content-Type label they are sent under (default application/json).
const RAW_BODIES: Record<string, { body: string; contentType?: string }> = {
  empty: { body: '' },
  'a bare number': { body: '123' },
  'a bare string': { body: '"hello"' },
  'plain text labelled text/plain': { body: 'not json at all', contentType: 'text/plain' },
  'labelled with a Latin-1 charset': { body: '{}', contentType: 'application/json; charset=iso-8859-1' },
  'a __proto__ key': { body: '{"__proto__":{"status":"degraded"}}' },
};

When<WebhooksWorld>('I send a GET request to the health check endpoint whose body is {string}', async function (kind: string) {
  const raw = RAW_BODIES[kind];
  if (raw === undefined) throw new Error(`Unknown body kind "${kind}" — expected one of ${Object.keys(RAW_BODIES).join(', ')}`);
  const headers = raw.contentType ? { 'content-type': raw.contentType } : {};
  this.response = await sendRaw(this.request.get('/health').url, 'GET', raw.body, headers);
});

Then<WebhooksWorld>(
  "a conditional health check using the first answer's ETag should answer {int}",
  async function (httpStatus: number) {
    const etag: string | undefined = this.response.headers['etag'];
    assert.ok(etag, `What failed: the first /health answer carried no ETag to replay. Headers: ${JSON.stringify(this.response.headers)}`);
    const second = await this.request.get('/health').set('If-None-Match', etag);
    assert.strictEqual(
      second.status,
      httpStatus,
      `What failed: a conditional /health probe answered ${second.status}, expected ${httpStatus}. ` +
        `Probable cause: the handler or a caching layer revalidated a stale verdict. ` +
        `What to check: the /health handler in src/api/index.ts.`,
    );
  },
);

// ── After ─────────────────────────────────────────────────────────────────────
// Hooks run in reverse registration order, so this restores the swapped flags module before the
// defaults.steps.ts After hook runs.

After<WebhooksWorld>(function () {
  if (_originalIsFlagsReady) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path.join(__dirname, '../../../dist/flags/index')).isFlagsReady = _originalIsFlagsReady;
    _originalIsFlagsReady = undefined;
  }
});
