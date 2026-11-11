import assert from 'assert';
import { After, Given, When, Then, DataTable } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';
import {
  dispatchKafkaMessage,
  takeOwnershipOfCommittedOffsets,
  fail as failKafka,
} from '../support/fakes/fake-kafka';
import {
  takeOwnershipOfDeliveriesForUrl,
  DeliveryCall,
  seedResponse,
  fail as failFetch,
  fetchFailedError,
  ALL_URLS,
} from '../support/fakes/fake-fetch';
import {
  takeOwnershipOfDeliveryLogsForSubscriber,
  DeliveryAttempt,
  seedSubscribers,
  fail as failDb,
  takeOwnershipOfFailedWrites,
  FAKE_SEED_CREATED_AT,
} from '../support/fakes/fake-db';
import { blockTopic } from '../support/fakes/fake-openfeature';
import * as fakeOpenFeature from '../support/fakes/fake-openfeature';
import { seedTopicFlags } from '../support/fakes/fake-db';

// The states a topic's delivery flag can be in, as isTopicBlocked() sees them. "provider-fails" is the dangerous
// one: the topic_flags row says blocked, but the provider throws and the SDK answers the caller's default (false).
const FLAG_STATES: Record<string, (world: WebhooksWorld, topic: string) => void> = {
  blocked: (world, topic) => blockTopic(world.scenarioId, topic),
  'unblocked-row': (world, topic) => seedTopicFlags(world.scenarioId, [{ topic, blocked: false }]),
  'provider-fails': (world, topic) => {
    blockTopic(world.scenarioId, topic);
    world.failFake(fakeOpenFeature, 'openfeature.getBooleanValue', [new Error('flag provider unavailable')]);
  },
};

Given<WebhooksWorld>('the delivery flag of topic {string} is {string}', function (topic: string, state: string) {
  const arrange = FLAG_STATES[state];
  assert.ok(arrange, `Unknown flag state "${state}". Known: ${Object.keys(FLAG_STATES).join(', ')}.`);
  arrange(this, topic);
});

// Deterministic UUIDs from non-determinism.ts always match this prefix pattern.
// We assert the pattern (not the exact counter value) because the counter's starting
// position within a scenario depends on execution order and shared scenario IDs.
const DETERMINISTIC_UUID_RE = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

// Standard reason phrases, pinned as literals (the fake derives its own from Node's http.STATUS_CODES, so
// reading them from it would be a tautology) — used to compute expected error_message values in delivery
// log assertions for HTTP-error exhaustion scenarios. A new status needs its row here.
const HTTP_REASON: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  300: 'Multiple Choices', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity',
  421: 'Misdirected Request', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

// What real fetch throws for any transport failure is `TypeError('fetch failed')` (the refused/DNS/reset
// detail lives only in `cause`), and deliver.ts logs err.message verbatim as the delivery_log
// error_message. Pinned as a literal so the assertion isn't a tautology reading it back out of the
// captured log (hardcoded-expected-values).
const NETWORK_FAILURE_ERROR = 'fetch failed';

// ── When ──────────────────────────────────────────────────────────────────────

// Every dispatch goes through here so a later "Kafka redelivers the same message" can replay it exactly:
// same topic, partition, offset, key and value — what KafkaJS hands the handler again after a rebalance or
// an uncommitted offset.
interface Dispatch {
  topic: string;
  payload: string | null;
  key: string | null;
  position: { partition?: number; offset?: string };
}
const lastDispatch = new Map<string, Dispatch>();
const firstHandlingError = new Map<string, Error | null>();

async function dispatch(
  world: WebhooksWorld,
  topic: string,
  payload: string | null,
  key: string | null,
  position: { partition?: number; offset?: string } = {},
): Promise<void> {
  lastDispatch.set(world.scenarioId, { topic, payload, key, position });
  await dispatchKafkaMessage(topic, payload, key, position);
}

After<WebhooksWorld>(function () {
  lastDispatch.delete(this.scenarioId);
  firstHandlingError.delete(this.scenarioId);
});

When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} with key {string} and payload {string}',
  async function (topic: string, key: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    this.dispatchedPayloadByKey.set(key, payload);
    await dispatch(this, topic, payload, key);
  },
);

When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} without a key and with payload {string}',
  async function (topic: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = null;
    await dispatch(this, topic, payload, null);
  },
);

// Empty-key variant: Buffer.from('') is truthy → message.key.toString() = '' → messageKey = ''.
// Distinct from null key (logged as null) and non-empty key (logged as the string value).
When<WebhooksWorld>(
  'a Kafka message with an empty key arrives on topic {string} with payload {string}',
  async function (topic: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = ''; // empty string — distinct from null (message_key: '' vs null in log)
    await dispatch(this, topic, payload, '');
  },
);

// Positioned variant: the message sits at a specific partition and offset, which handleMessage turns into
// the commit of offset + 1 on that partition. Kafka delivers the offset as a string; the step takes an int.
When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} partition {int} at offset {int} with key {string} and payload {string}',
  async function (topic: string, partition: number, offset: number, key: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    await dispatch(this, topic, payload, key, { partition, offset: String(offset) });
  },
);

// ── Then ──────────────────────────────────────────────────────────────────────

// Owns all outbound HTTP delivery calls to a specific URL and asserts the single expected POST shape.
// Uses per-URL claiming so multi-subscriber scenarios can assert each subscriber's calls independently. [delivery-call]
Then<WebhooksWorld>(
  'the webhook should have been posted to {string} [delivery-call]',
  function (expectedUrl: string) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(
      deliveries.length,
      1,
      `Expected exactly 1 webhook delivery to "${expectedUrl}" but got ${deliveries.length}. ` +
        `Probable cause: retries fired (check fake-fetch seedResponse) or subscriber URL mismatch. ` +
        `What to check: seedSubscribers() URL, fake-fetch default response (200), and WEBHOOK_MAX_ATTEMPTS.`,
    );
    const actual = deliveries[0];

    // X-Delivery-Id is generated by randomUUID() in deliver.ts — assert it follows the
    // deterministic pattern. The exact counter value is not pinned because it depends on
    // how many randomUUID() calls occurred before deliver() runs (including the Before hook).
    const actualDeliveryId = actual.headers['x-delivery-id'];
    assert.match(
      actualDeliveryId ?? '',
      DETERMINISTIC_UUID_RE,
      `X-Delivery-Id should be a deterministic UUID (non-determinism.ts pattern) but got: "${actualDeliveryId}". ` +
        `What to check: non-determinism.ts randomUUID patch is active and crypto.randomUUID is patched before the app loads.`,
    );

    const { 'x-delivery-id': _id, ...otherHeaders } = actual.headers;
    const expected: Omit<DeliveryCall, 'headers'> & { headers: Record<string, string> } = {
      url: expectedUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.dispatchedPayload!,
    };
    assert.deepStrictEqual(
      { ...actual, headers: otherHeaders },
      expected,
      `Webhook delivery shape did not match (excluding x-delivery-id checked separately). ` +
        `Probable cause: wrong URL, method, content-type, or payload mismatch. ` +
        `What to check: src/delivery/deliver.ts fetch call and the subscriber URL seeded in Given steps. ` +
        `Got: ${JSON.stringify({ ...actual, headers: otherHeaders })}, Expected: ${JSON.stringify(expected)}`,
    );
  },
);

// Owns all delivery_log rows and asserts the single expected first-attempt success. [delivery-log]
Then<WebhooksWorld>(
  'the delivery should have been logged as successful for subscriber {int} with key {string} [delivery-log]',
  function (subscriberId: number, key: string) {
    assertSingleSuccessLog(this, subscriberId, key);
  },
);

Then<WebhooksWorld>(
  'the delivery should have been logged as successful for subscriber {int} without a key [delivery-log]',
  function (subscriberId: number) {
    assertSingleSuccessLog(this, subscriberId, null);
  },
);

function assertSingleSuccessLog(
  world: WebhooksWorld,
  subscriberId: number,
  messageKey: string | null,
): void {
  const logs = takeOwnershipOfDeliveryLogsForSubscriber(world.scenarioId, subscriberId);
  assert.strictEqual(
    logs.length,
    1,
    `Expected exactly 1 delivery log entry but got ${logs.length}. ` +
      `Probable cause: retries produced extra log rows, or the subscriber count is wrong. ` +
      `What to check: fake-fetch default response (should be 200 so no retries fire) and subscriber seed data.`,
  );
  const expected: DeliveryAttempt = {
    subscriber_id: subscriberId,
    message_key: messageKey,
    payload: world.dispatchedPayload!,
    attempt_number: 1,
    status: 'success',
    http_status: 200,
    error_message: null,
  };
  assert.deepStrictEqual(
    logs[0],
    expected,
    `Delivery log shape did not match. ` +
      `Probable cause: wrong subscriber_id, message_key, status, or http_status. ` +
      `What to check: src/db/deliveryLog.ts logAttempt() params and fake-db deliveryLog.logAttempt(). ` +
      `Got: ${JSON.stringify(logs[0])}, Expected: ${JSON.stringify(expected)}`,
  );
}

// Empty-body negative assertions: the ownership net (throwIfUnownedExist) enforces absence, and
// meta-tests.feature verifies the net. A count-and-assert-zero would be banned by ownership-over-inspection.

// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no webhook should have been delivered', function () {});

// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no delivery should have been logged', function () {});

// ── Given ─ feature flags and failure injection ───────────────────────────────

Given<WebhooksWorld>('the topic {string} is delivery-blocked', function (topic: string) {
  blockTopic(this.scenarioId, topic);
});

Given<WebhooksWorld>('the subscriber webhook endpoint is unreachable', function () {
  // fake-fetch records each request before throwing, so every attempt is a delivery call to own as well as a
  // failed delivery-log row. ALL_URLS + [err]: every fetch always throws.
  failFetch(this.scenarioId, ALL_URLS, [() => fetchFailedError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 203.0.113.7:443' })]);
});

Given<WebhooksWorld>('the database fails on delivery log writes', function () {
  // Only logAttempt fails, so findByTopic still succeeds. The rejected op makes handleMessage rethrow before the
  // commit, so KafkaJS redelivers (at-least-once).
  const err = new Error('MySQL: connection lost during delivery log write');
  this.injectedErrors.push(err);
  failDb(this.scenarioId, 'deliveryLog.logAttempt', [err]);
});

Given<WebhooksWorld>('committing the Kafka offset fails', function () {
  // The commit is last, so delivery and logging have already happened: KafkaJS redelivers and the subscriber
  // gets the message again.
  const err = new Error('Kafka: broker unreachable while committing the offset');
  this.injectedErrors.push(err);
  failKafka(this.scenarioId, 'kafka.commitOffsets', [err]);
});

// Named apart from meta-tests.feature's harness step of the same effect, which also asserts the fake's state.
Given<WebhooksWorld>('the broker rejects the first offset commit and accepts the next', function () {
  failKafka(this.scenarioId, 'kafka.commitOffsets', [new Error('Kafka: broker unreachable while committing the offset'), null]);
});

Given<WebhooksWorld>(
  'the subscriber endpoint at {string} responds with status {int}',
  function (url: string, status: number) {
    seedResponse(this.scenarioId, url, { status });
  },
);

// fetch re-sends a request once when the server answers 421, so each delivery attempt is two identical
// POSTs on the wire (same X-Delivery-Id, same payload). [delivery-call]
Then<WebhooksWorld>(
  'every one of the {int} delivery attempts to {string} should have been received twice by the subscriber [delivery-call]',
  function (attempts: number, expectedUrl: string) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(
      deliveries.length,
      attempts * 2,
      `Expected ${attempts} attempts x 2 = ${attempts * 2} POSTs to "${expectedUrl}" but got ${deliveries.length}. ` +
        'Probable cause: the 421 re-send is not modelled, or the subscriber answered something other than 421.',
    );
    const deliveryId = deliveries[0].headers['x-delivery-id'];
    assert.match(deliveryId ?? '', DETERMINISTIC_UUID_RE);
    for (const delivery of deliveries) {
      assert.deepStrictEqual(
        delivery,
        {
          url: expectedUrl,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-delivery-id': deliveryId },
          body: this.dispatchedPayload!,
        },
        'Every POST of every attempt (and its 421 re-send) should be identical, sharing the X-Delivery-Id.',
      );
    }
  },
);

Given<WebhooksWorld>(
  'the subscriber endpoint at {string} answers with status {int} redirecting to {string}',
  function (url: string, status: number, location: string) {
    seedResponse(this.scenarioId, url, { status, location });
  },
);

// Claims the follow-up request real fetch made on its own after a 301/302/303 redirect: a GET with no
// body, and without the headers that describe the dropped body (content-type). [delivery-call]
Then<WebhooksWorld>(
  'the redirected request to {string} should have been downgraded to a GET without a body [delivery-call]',
  function (redirectedUrl: string) {
    const [call, ...rest] = takeOwnershipOfDeliveriesForUrl(this.scenarioId, redirectedUrl);
    assert.strictEqual(
      rest.length,
      0,
      `Expected exactly 1 redirected request to "${redirectedUrl}" but got ${rest.length + 1}. ` +
        'Probable cause: the delivery was retried, or the redirect target was requested by another path.',
    );
    const { 'x-delivery-id': deliveryId, ...otherHeaders } = call.headers;
    assert.match(deliveryId ?? '', DETERMINISTIC_UUID_RE, 'The redirected request should keep the original X-Delivery-Id header.');
    assert.deepStrictEqual(
      { url: call.url, method: call.method, headers: otherHeaders, body: call.body },
      { url: redirectedUrl, method: 'GET', headers: {}, body: '' },
      'A 301/302/303 redirect must re-request with GET and no body or body headers (real fetch behaviour). ' +
        `Got: ${JSON.stringify(call)}`,
    );
  },
);

// Claims the follow-up request after a 307/308 redirect: the method, headers and body are replayed as sent. [delivery-call]
Then<WebhooksWorld>(
  'the redirected request to {string} should have replayed the original POST with its payload [delivery-call]',
  function (redirectedUrl: string) {
    const [call, ...rest] = takeOwnershipOfDeliveriesForUrl(this.scenarioId, redirectedUrl);
    assert.strictEqual(
      rest.length,
      0,
      `Expected exactly 1 redirected request to "${redirectedUrl}" but got ${rest.length + 1}. ` +
        'Probable cause: the delivery was retried, or the redirect target was requested by another path.',
    );
    const { 'x-delivery-id': deliveryId, ...otherHeaders } = call.headers;
    assert.match(deliveryId ?? '', DETERMINISTIC_UUID_RE, 'The redirected request should keep the original X-Delivery-Id header.');
    assert.deepStrictEqual(
      { url: call.url, method: call.method, headers: otherHeaders, body: call.body },
      { url: redirectedUrl, method: 'POST', headers: { 'content-type': 'application/json' }, body: this.dispatchedPayload! },
      'A 307/308 redirect must replay the POST with its payload and headers (real fetch behaviour). ' +
        `Got: ${JSON.stringify(call)}`,
    );
  },
);

// Claims a same-origin 307/308 follow-up: fetch strips only credentials that would cross origins, so the
// subscriber's custom headers (Authorization included) travel with the replayed POST. [delivery-call]
Then<WebhooksWorld>(
  'the redirected request to {string} should have replayed the original POST with its payload and the subscriber\'s custom headers [delivery-call]',
  function (redirectedUrl: string) {
    const [call, ...rest] = takeOwnershipOfDeliveriesForUrl(this.scenarioId, redirectedUrl);
    assert.strictEqual(
      rest.length,
      0,
      `Expected exactly 1 redirected request to "${redirectedUrl}" but got ${rest.length + 1}. ` +
        'Probable cause: the delivery was retried, or the redirect target was requested by another path.',
    );
    const { 'x-delivery-id': deliveryId, ...otherHeaders } = call.headers;
    assert.match(deliveryId ?? '', DETERMINISTIC_UUID_RE, 'The redirected request should keep the original X-Delivery-Id header.');
    const customHeaders = Object.fromEntries(
      Object.entries(this.seededSubscriberHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.deepStrictEqual(
      { url: call.url, method: call.method, headers: otherHeaders, body: call.body },
      { url: redirectedUrl, method: 'POST', headers: { 'content-type': 'application/json', ...customHeaders }, body: this.dispatchedPayload! },
      'A same-origin 307/308 redirect must replay the POST with its payload and every header. ' +
        `Got: ${JSON.stringify(call)}`,
    );
  },
);

// ── When ─ error-path variant ─────────────────────────────────────────────────

// Captures errors from handleMessage() instead of propagating them.
// Use for scenarios where the handler is expected to throw (DB failure, etc.)
// so the Then steps can assert the error and verify absence of side effects.
When<WebhooksWorld>(
  'I attempt to dispatch a Kafka message on topic {string} with key {string} and payload {string}',
  async function (topic: string, key: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    try {
      await dispatch(this, topic, payload, key);
      this.thrownError = null;
    } catch (err) {
      this.thrownError = err instanceof Error ? err : new Error(String(err));
    }
  },
);

When<WebhooksWorld>(
  'I attempt to dispatch a Kafka message on topic {string} partition {int} at offset {int} with key {string} and payload {string}',
  async function (topic: string, partition: number, offset: number, key: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    try {
      await dispatch(this, topic, payload, key, { partition, offset: String(offset) });
      this.thrownError = null;
    } catch (err) {
      this.thrownError = err instanceof Error ? err : new Error(String(err));
    }
  },
);

// ── Then ─ error assertions ────────────────────────────────────────────────────

// Asserts that handleMessage threw — the at-least-once guarantee: the offset is
// not committed when the handler errors, so KafkaJS will redeliver the message.
// The headers column as a registration with `"headers": "<value>"` leaves it: the JSON string "<value>".
Given<WebhooksWorld>(
  'a subscriber {string} with ID {int} listens for topic {string} at URL {string} with its headers stored as the string {string}',
  function (name: string, id: number, topic: string, url: string, headers: string) {
    seedSubscribers(this.scenarioId, [{ id, name, topic, url, headers: JSON.stringify(headers), created_at: FAKE_SEED_CREATED_AT }]);
    this.seededSubscriberId = id;
    this.seededSubscriberUrls.push(url);
    this.seededSubscriberIds.push(id);
  },
);

Then<WebhooksWorld>('the message handler should have thrown the JSON parse error {string}', function (message: string) {
  assert.deepStrictEqual(
    this.thrownError ? { name: this.thrownError.name, message: this.thrownError.message } : null,
    { name: 'SyntaxError', message },
    `Expected handleMessage() to reject with SyntaxError "${message}" from reading the subscriber's headers. ` +
      'Probable cause: parseRow no longer JSON.parses a string headers column (the bug is fixed), or the lookup changed. ' +
      'What to check: parseRow in src/db/subscribers.ts.',
  );
});

// Identity, not just "something threw": a TypeError raised before the injected failure fires must not pass.
Then<WebhooksWorld>('the message handler should have thrown due to an infrastructure failure', function () {
  assert.ok(
    this.thrownError,
    `Expected handleMessage() to throw (for at-least-once delivery) but it completed successfully. ` +
      `What to check: verify the database is unavailable (Given step) and that the fake propagates errors correctly.`,
  );
  assert.ok(
    this.injectedErrors.length > 0,
    'No failure-injecting Given recorded an error, so the thrown one cannot be checked. ' +
      'Fix: push the injected Error onto this.injectedErrors in the Given, or use a step that names the expected error.',
  );
  assert.ok(
    this.injectedErrors.includes(this.thrownError),
    `handleMessage() threw, but not the injected failure: ${this.thrownError.name}: ${this.thrownError.message}. ` +
      'Probable cause: the handler failed for another reason before (or instead of) reaching the failing IO. ' +
      `Injected: ${this.injectedErrors.map((e) => e.message).join(' | ')}.`,
  );
});

// A failure the fake raises itself (strict mode's VARCHAR(255) limit on message_key), not one a Given injected.
Then<WebhooksWorld>('the message handler should have thrown because the key does not fit the delivery log', function () {
  const code = 'ER_DATA_TOO_LONG';
  const message = "Data too long for column 'message_key' at row 1";
  const err = this.thrownError as (Error & { code?: string }) | null | undefined;
  assert.deepStrictEqual(
    err ? { code: err.code, message: err.message } : null,
    { code, message },
    `Expected handleMessage() to reject with MySQL ${code} "${message}". ` +
      'What to check: the delivery_log column limits in fake-db.ts (assertFits) and the handler\'s rethrow in src/kafka/consumer.ts.',
  );
});

// Owns delivery_log rows for a specific subscriber and asserts the single expected blocked entry. [delivery-log]
Then<WebhooksWorld>(
  'the delivery should have been logged as blocked for subscriber {int} [delivery-log]',
  function (subscriberId: number) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    assert.strictEqual(
      logs.length,
      1,
      `Expected exactly 1 blocked delivery log entry but got ${logs.length}. ` +
        `What to check: isTopicBlocked() returns true for the topic and subscriber seed matches the topic.`,
    );
    const expected: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: this.dispatchedKey ?? null,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'blocked',
      http_status: null,
      error_message: null,
    };
    assert.deepStrictEqual(
      logs[0],
      expected,
      `Blocked delivery log shape did not match. ` +
        `Got: ${JSON.stringify(logs[0])}, Expected: ${JSON.stringify(expected)}`,
    );
  },
);

// Owns delivery_log rows per subscriber and asserts each is blocked. [delivery-log]
Then<WebhooksWorld>(
  'the deliveries for subscribers {int} and {int} should have been logged as blocked [delivery-log]',
  function (subscriberId1: number, subscriberId2: number) {
    const logs1 = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId1);
    const logs2 = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId2);
    const logs = [...logs1, ...logs2].sort((a, b) => a.subscriber_id - b.subscriber_id);
    assert.strictEqual(
      logs.length,
      2,
      `Expected 2 blocked delivery log entries (one per subscriber) but got ${logs.length}. ` +
        `What to check: both subscribers are seeded for the topic and blockTopic() was called.`,
    );
    const sorted = logs;
    for (const [i, subscriberId] of [subscriberId1, subscriberId2].entries()) {
      const expected: DeliveryAttempt = {
        subscriber_id: subscriberId,
        message_key: this.dispatchedKey ?? null,
        payload: this.dispatchedPayload!,
        attempt_number: 1,
        status: 'blocked',
        http_status: null,
        error_message: null,
      };
      assert.deepStrictEqual(
        sorted[i],
        expected,
        `Blocked delivery log for subscriber ${subscriberId} did not match. ` +
          `Got: ${JSON.stringify(sorted[i])}, Expected: ${JSON.stringify(expected)}`,
      );
    }
  },
);

// Owns delivery log rows for a network-error exhaustion sequence. [delivery-log]
// Pinned assertions: http_status=null, error_message=NETWORK_FAILURE_ERROR.
Then<WebhooksWorld>(
  'all {int} delivery attempts should have been logged for subscriber {int} due to a network error with the last marked as exhausted [delivery-log]',
  function (expectedCount: number, subscriberId: number) {
    assertExhaustionLogs(this, subscriberId, expectedCount, null, NETWORK_FAILURE_ERROR);
  },
);

// Owns delivery log rows for an HTTP-error exhaustion sequence. [delivery-log]
// Pinned assertions: http_status=status, error_message="HTTP {status} {reason}".
Then<WebhooksWorld>(
  'all {int} HTTP {int} delivery attempts should have been logged for subscriber {int} with the last marked as exhausted [delivery-log]',
  function (expectedCount: number, httpStatus: number, subscriberId: number) {
    const expectedErrorMessage = `HTTP ${httpStatus} ${HTTP_REASON[httpStatus] ?? ''}`.trimEnd();
    assertExhaustionLogs(this, subscriberId, expectedCount, httpStatus, expectedErrorMessage);
  },
);

// The logged message when it starts with `prefix` (so deepStrictEqual passes), otherwise a marker that fails it.
function prefixed(actual: string | null, prefix: string): string {
  return actual?.startsWith(prefix) ? actual : `<an error starting with ${JSON.stringify(prefix)}>`;
}

function assertExhaustionLogs(
  world: WebhooksWorld,
  subscriberId: number,
  expectedCount: number,
  httpStatus: number | null,
  errorMessage: string | { prefix: string },
): void {
  const logs = takeOwnershipOfDeliveryLogsForSubscriber(world.scenarioId, subscriberId);
  assert.strictEqual(
    logs.length,
    expectedCount,
    `Expected ${expectedCount} delivery log entries for subscriber ${subscriberId} but got ${logs.length}. ` +
      `Probable cause: WEBHOOK_MAX_ATTEMPTS default (6) may have changed, or the subscriber URL is not seeded. ` +
      `What to check: WEBHOOK_MAX_ATTEMPTS env var and subscriber seed data.`,
  );
  for (let i = 0; i < logs.length; i++) {
    const attempt = i + 1;
    const expected: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: world.dispatchedKey ?? null,
      payload: world.dispatchedPayload!,
      attempt_number: attempt,
      status: attempt === expectedCount ? 'exhausted' : 'failed',
      http_status: httpStatus,
      error_message: typeof errorMessage === 'string' ? errorMessage : prefixed(logs[i].error_message, errorMessage.prefix),
    };
    assert.deepStrictEqual(
      logs[i],
      expected,
      `Delivery log entry for attempt ${attempt} did not match. ` +
        `Probable cause: wrong http_status or error_message recorded by deliver.ts — ` +
        `check if the fetch response status/statusText differs from what is seeded. ` +
        `What to check: src/delivery/deliver.ts logAttempt() call and fake-fetch seedResponse config. ` +
        `Got: ${JSON.stringify(logs[i])}, Expected: ${JSON.stringify(expected)}`,
    );
  }
}

// Owns all outbound HTTP calls to a specific URL for a retry-exhaustion sequence. [delivery-call]
// Uses per-URL claiming so mixed fan-out scenarios can assert each subscriber independently.
// Each retry shares the same X-Delivery-Id (idempotency key generated once per delivery sequence).
Then<WebhooksWorld>(
  'all {int} delivery attempts to {string} should have been made [delivery-call]',
  function (expectedCount: number, expectedUrl: string) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(
      deliveries.length,
      expectedCount,
      `Expected ${expectedCount} delivery attempts but got ${deliveries.length}. ` +
        `What to check: WEBHOOK_MAX_ATTEMPTS default (6) and fake-fetch seedResponse config.`,
    );
    // All retry attempts share the same X-Delivery-Id — verify pattern and consistency.
    const actualDeliveryId = deliveries[0].headers['x-delivery-id'];
    assert.match(
      actualDeliveryId ?? '',
      DETERMINISTIC_UUID_RE,
      `X-Delivery-Id should be a deterministic UUID but got: "${actualDeliveryId}"`,
    );
    for (const delivery of deliveries) {
      assert.strictEqual(
        delivery.headers['x-delivery-id'],
        actualDeliveryId,
        `All retry attempts must share the same X-Delivery-Id (idempotency key) ` +
          `but got "${delivery.headers['x-delivery-id']}" — expected "${actualDeliveryId}".`,
      );
      const { 'x-delivery-id': _id, ...otherHeaders } = delivery.headers;
      assert.deepStrictEqual(
        { ...delivery, headers: otherHeaders },
        {
          url: expectedUrl,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: this.dispatchedPayload!,
        },
        `Delivery attempt shape did not match. Got: ${JSON.stringify({ ...delivery, headers: otherHeaders })}`,
      );
    }
  },
);

// ── Then ─ multi-subscriber assertions ────────────────────────────────────────

// Owns outbound delivery calls per seeded subscriber URL and asserts full shape. [delivery-call]
Then<WebhooksWorld>('the webhook should have been posted to both subscriber URLs [delivery-call]', function () {
  assert.strictEqual(
    this.seededSubscriberUrls.length,
    2,
    `Expected 2 seeded subscriber URLs but found ${this.seededSubscriberUrls.length}. ` +
      `Probable cause: not enough subscriber-seeding Given steps ran before this Then step.`,
  );
  // Claim per-URL so any unexpected extra deliveries remain unowned and fail the safety net.
  const all = this.seededSubscriberUrls.flatMap((url) =>
    takeOwnershipOfDeliveriesForUrl(this.scenarioId, url),
  );
  assert.strictEqual(
    all.length,
    2,
    `Expected exactly 2 webhook deliveries (one per subscriber) but got ${all.length}. ` +
      `What to check: both subscribers are seeded for the topic and delivery succeeded.`,
  );
  // Sort by URL for deterministic assertion (Promise.allSettled order is non-deterministic).
  const sorted = [...all].sort((a, b) => a.url.localeCompare(b.url));
  // Each subscriber gets its own X-Delivery-Id (randomUUID called once per deliver() invocation).
  const ids = sorted.map((d) => d.headers['x-delivery-id']);
  for (const id of ids) {
    assert.match(id ?? '', DETERMINISTIC_UUID_RE, `X-Delivery-Id should follow deterministic pattern but got: "${id}"`);
  }
  assert.notStrictEqual(ids[0], ids[1], `Each subscriber should have a distinct X-Delivery-Id but both are: "${ids[0]}"`);
  // Assert full shape of each delivery call (excluding the per-subscriber delivery ID).
  for (const delivery of sorted) {
    const { 'x-delivery-id': _id, ...otherHeaders } = delivery.headers;
    assert.deepStrictEqual(
      { method: delivery.method, headers: otherHeaders, body: delivery.body },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.dispatchedPayload! },
      `Delivery call shape did not match for URL ${delivery.url}. Got: ${JSON.stringify({ ...delivery, headers: otherHeaders })}`,
    );
  }
});

// Owns delivery_log rows per seeded subscriber and asserts each succeeded. [delivery-log]
Then<WebhooksWorld>('each subscriber\'s delivery should have been logged as successful [delivery-log]', function () {
  assert.strictEqual(
    this.seededSubscriberIds.length,
    2,
    `Expected 2 seeded subscriber IDs but found ${this.seededSubscriberIds.length}. ` +
      `Probable cause: not enough subscriber-seeding Given steps ran before this Then step.`,
  );
  const all = this.seededSubscriberIds.flatMap((id) =>
    takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, id),
  );
  assert.strictEqual(
    all.length,
    2,
    `Expected 2 delivery log entries (one per subscriber) but got ${all.length}. ` +
      `What to check: both subscriber URLs returned 200 and delivery completed.`,
  );
  // Sort both the seeded ids and the logs by subscriber_id, then pair by position — the expected
  // subscriber_id comes from the seeded list (a pinned input), never read back from the log row.
  const expectedIds = [...this.seededSubscriberIds].sort((a, b) => a - b);
  const sorted = [...all].sort((a, b) => a.subscriber_id - b.subscriber_id);
  for (const [i, log] of sorted.entries()) {
    const expected: DeliveryAttempt = {
      subscriber_id: expectedIds[i],
      message_key: this.dispatchedKey ?? null,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'success',
      http_status: 200,
      error_message: null,
    };
    assert.deepStrictEqual(
      log,
      expected,
      `Delivery log for subscriber ${log.subscriber_id} did not match. Got: ${JSON.stringify(log)}`,
    );
  }
});

// ── Optional-property steps ────────────────────────────────────────────────────

// Seeds a subscriber with custom headers; stores them on the World for delivery assertions.
Given<WebhooksWorld>(
  'a subscriber {string} with ID {int} listens for topic {string} at URL {string} with custom headers:',
  function (name: string, id: number, topic: string, url: string, table: DataTable) {
    // raw(), not rows(): the table has no header row, and rows() would silently drop the first header.
    const headers = Object.fromEntries(table.raw().map(([k, v]) => [k, v]));
    this.seededSubscriberHeaders = headers;
    seedSubscribers(this.scenarioId, [{ id, name, topic, url, headers, created_at: FAKE_SEED_CREATED_AT }]);
    this.seededSubscriberUrls.push(url);
    this.seededSubscriberIds.push(id);
  },
);

// ── URL-specific and transient failure injection ─────────────────────────────

// URL-specific unreachable: only calls to this URL throw; other URLs use their seeded response.
// Each failing call is still recorded as a delivery call (fake-fetch records before it throws).
Given<WebhooksWorld>('the subscriber endpoint at {string} is unreachable', function (url: string) {
  failFetch(this.scenarioId, url, [() => fetchFailedError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 203.0.113.7:443' })]);
});

// Transient failure: first N calls to the URL throw, subsequent calls succeed.
// Every call, failed or not, is a delivery call; the delivery log has a 'failed' row per failed attempt.
// Sequence = [err × N, null]: the trailing null repeats, so every call after the Nth recovers.
Given<WebhooksWorld>(
  'the subscriber endpoint at {string} fails {int} time(s) then succeeds',
  function (url: string, failCount: number) {
    failFetch(this.scenarioId, url, [
      ...Array.from({ length: failCount }, () => () => fetchFailedError({ code: 'ECONNRESET', message: 'read ECONNRESET' })),
      null,
    ]);
  },
);

// ── When ─ no key, no value ───────────────────────────────────────────────────

When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} with no key and no value',
  async function (topic: string) {
    this.dispatchedPayload = ''; // handleMessage: message.value null → payload = ''
    this.dispatchedKey = null;
    await dispatch(this, topic, null, null);
  },
);

// ── Then ─ negative delivery-call assertion ───────────────────────────────────

// Documents that no delivery should have been posted to a specific URL.
// The actual guarantee is provided by the After-hook ownership safety net:
// any delivery to this URL would be an unowned captured call and would cause the
// scenario to fail at cleanup. This step is intentionally a no-op for readability.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('the webhook should not have been posted to {string} [delivery-call]', function (_url: string) {});

// ── Then ─ negative delivery-log assertion ────────────────────────────────────

// Documents that no delivery should have been logged for a specific subscriber.
// The actual guarantee is provided by the After-hook ownership safety net:
// any log entry for this subscriber would be unowned and would cause the
// scenario to fail at cleanup. This step is intentionally a no-op for readability.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('no delivery should have been logged for subscriber {int}', function (_subscriberId: number) {});

// ── Then ─ per-subscriber positive log assertion ──────────────────────────────

// Claims only the delivery_log rows for a specific subscriber — use in multi-subscriber scenarios
// where different subscribers have different outcomes and need independent assertions.
Then<WebhooksWorld>(
  'the delivery for subscriber {int} should have been logged as successful with key {string} [delivery-log]',
  function (subscriberId: number, key: string) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    assert.strictEqual(
      logs.length,
      1,
      `Expected exactly 1 success log entry for subscriber ${subscriberId} but got ${logs.length}. ` +
        `What to check: fake-fetch default response (should be 200) and the subscriber URL seed.`,
    );
    const expected: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: key,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'success',
      http_status: 200,
      error_message: null,
    };
    assert.deepStrictEqual(
      logs[0],
      expected,
      `Per-subscriber delivery log shape did not match. ` +
        `Got: ${JSON.stringify(logs[0])}, Expected: ${JSON.stringify(expected)}`,
    );
  },
);

// ── Then ─ non-200 2xx success assertion ─────────────────────────────────────

// Like assertSingleSuccessLog but pins the actual http_status rather than hardcoding 200.
// Use when the subscriber endpoint returns a non-200 2xx (e.g. 201 Created, 204 No Content).
Then<WebhooksWorld>(
  'the delivery should have been logged as successful for subscriber {int} with key {string} and http status {int} [delivery-log]',
  function (subscriberId: number, key: string, httpStatus: number) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    assert.strictEqual(
      logs.length,
      1,
      `Expected exactly 1 delivery log entry but got ${logs.length}. ` +
        `What to check: the subscriber endpoint returns a non-200 2xx on the first attempt so no retries fire.`,
    );
    const expected: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: key,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'success',
      http_status: httpStatus,
      error_message: null,
    };
    assert.deepStrictEqual(
      logs[0],
      expected,
      `Delivery log shape (non-200 2xx) did not match. ` +
        `Probable cause: deliver.ts does not treat this status as ok, or http_status is not recorded correctly. ` +
        `Got: ${JSON.stringify(logs[0])}, Expected: ${JSON.stringify(expected)}`,
    );
  },
);

// ── Then ─ transient failure recovery assertion ───────────────────────────────

// Asserts that delivery recovered after N failed attempts: N "failed" log entries followed by
// one "success" entry. http_status and error_message are pinned literals (network error: null, 'fetch failed').
Then<WebhooksWorld>(
  'the delivery should have recovered for subscriber {int} after {int} failed attempt(s) with key {string} [delivery-log]',
  function (subscriberId: number, failCount: number, key: string) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    const expectedTotal = failCount + 1;
    assert.strictEqual(
      logs.length,
      expectedTotal,
      `Expected ${expectedTotal} delivery log entries (${failCount} failed + 1 success) but got ${logs.length}. ` +
        `What to check: the "fails N time then succeeds" failCount matches the Given step and retries are enabled.`,
    );
    // First N entries should be "failed" with null http_status (network error, not HTTP error)
    for (let i = 0; i < failCount; i++) {
      const expected: DeliveryAttempt = {
        subscriber_id: subscriberId,
        message_key: key,
        payload: this.dispatchedPayload!,
        attempt_number: i + 1,
        status: 'failed',
        http_status: null,
        error_message: NETWORK_FAILURE_ERROR, // pinned literal, not read back from the log
      };
      assert.deepStrictEqual(
        logs[i],
        expected,
        `Recovery log entry for attempt ${i + 1} should be "failed" but did not match. ` +
          `Got: ${JSON.stringify(logs[i])}, Expected: ${JSON.stringify(expected)}`,
      );
    }
    // Final entry should be "success"
    const successEntry = logs[failCount];
    const expectedSuccess: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: key,
      payload: this.dispatchedPayload!,
      attempt_number: failCount + 1,
      status: 'success',
      http_status: 200,
      error_message: null,
    };
    assert.deepStrictEqual(
      successEntry,
      expectedSuccess,
      `Recovery log entry for attempt ${failCount + 1} should be "success" but did not match. ` +
        `Got: ${JSON.stringify(successEntry)}, Expected: ${JSON.stringify(expectedSuccess)}`,
    );
  },
);

// When step for a message with a null value (message.value = null → handleMessage produces payload = '').
When<WebhooksWorld>(
  'a Kafka message with key {string} and no value arrives on topic {string}',
  async function (key: string, topic: string) {
    this.dispatchedPayload = ''; // handleMessage produces '' when message.value is null
    this.dispatchedKey = key;
    await dispatch(this, topic, null, key);
  },
);

// Owns delivery calls to the expected URL and asserts full shape including custom headers. [delivery-call]
Then<WebhooksWorld>(
  'the webhook should have been posted to {string} with the subscriber\'s custom headers [delivery-call]',
  function (expectedUrl: string) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(
      deliveries.length,
      1,
      `Expected exactly 1 webhook delivery but got ${deliveries.length}.`,
    );
    const actual = deliveries[0];
    const actualDeliveryId = actual.headers['x-delivery-id'];
    assert.match(
      actualDeliveryId ?? '',
      DETERMINISTIC_UUID_RE,
      `X-Delivery-Id should be a deterministic UUID but got: "${actualDeliveryId}"`,
    );

    // Build the expected headers: defaults + subscriber's custom headers (lowercased by new Headers()).
    const customHeaders = Object.fromEntries(
      Object.entries(this.seededSubscriberHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const { 'x-delivery-id': _id, ...actualWithoutId } = actual.headers;
    const expectedHeaders = { 'content-type': 'application/json', ...customHeaders };
    assert.deepStrictEqual(
      { ...actual, headers: actualWithoutId },
      { url: expectedUrl, method: 'POST', headers: expectedHeaders, body: this.dispatchedPayload! },
      `Webhook delivery shape with custom headers did not match. ` +
        `Custom headers should be merged on top of Content-Type and X-Delivery-Id. ` +
        `Got: ${JSON.stringify({ ...actual, headers: actualWithoutId })}`,
    );
  },
);

// ── at-least-once semantics — Kafka offset commit assertions ─────────────────

// The offset commit is owned by ownership, not read-only inspection (ownership-over-inspection).
// Positive: the "Kafka offset is committed after a dispatched message" auto-default (features/defaults.ts)
// already claims and asserts the single commit for every dispatched scenario. This step is a readable
// no-op that documents the guarantee at the point the scenario cares about it.
// eslint-disable-next-line @typescript-eslint/no-empty-function
Then<WebhooksWorld>('the Kafka offset should have been committed', function () {});

// Negative: the handler is expected to throw, so no commit should occur. Opt out of the positive
// auto-default; the ownership net (fake-kafka throwIfUnownedExist) enforces absence — any commit that
// did happen would be unowned and fail the scenario at the After hook. No count inspection here.
const KAFKA_COMMIT_DEFAULT = 'Kafka offset is committed after a dispatched message';

function optOutOfKafkaCommitDefault(world: WebhooksWorld): void {
  if (!world._skippedDefaults) world._skippedDefaults = new Set();
  world._skippedDefaults.add(KAFKA_COMMIT_DEFAULT);
}

Then<WebhooksWorld>('the Kafka offset should not have been committed', function () {
  optOutOfKafkaCommitDefault(this);
});

// Explicit offset assertions. A scenario that pins offsets takes over from the auto-default (which only
// knows the generic rule, committed = dispatched + 1) and owns every partition it asserts; a commit on a
// partition it never asserts stays unowned and fails the scenario.
// "Should be" values are literals, not recomputed from the dispatched offset, so the rule isn't asserted
// by restating the implementation.
function claimCommittedOffsets(world: WebhooksWorld, topic: string, partition: number, expected: string[]): void {
  optOutOfKafkaCommitDefault(world);
  const committed = takeOwnershipOfCommittedOffsets(world.scenarioId, topic, partition);
  assert.deepStrictEqual(
    committed,
    expected.map((offset) => ({ topic, partition, offset, failed: false })),
    `Committed offsets for "${topic}" partition ${partition} did not match [${expected.join(', ')}]. ` +
      'Probable cause: handleMessage() committed the wrong offset (it must be the next offset to read: ' +
      "the message's own offset + 1), partition or topic, or committed more or fewer times. " +
      'What to check: the commitOffsets call at the end of src/kafka/consumer.ts handleMessage().',
  );
}

Then<WebhooksWorld>(
  'the committed offset for topic {string} partition {int} should be {int}',
  function (topic: string, partition: number, offset: number) {
    claimCommittedOffsets(this, topic, partition, [String(offset)]);
  },
);

Then<WebhooksWorld>(
  'the offsets committed for topic {string} partition {int} should be:',
  function (topic: string, partition: number, table: DataTable) {
    claimCommittedOffsets(this, topic, partition, table.raw().map(([offset]) => offset));
  },
);

// The commit attempt is recorded before the injected failure fires, so it is owned like any other IO.
Then<WebhooksWorld>(
  'a failed offset commit should have been attempted for topic {string} partition {int} at offset {int}',
  function (topic: string, partition: number, offset: number) {
    optOutOfKafkaCommitDefault(this);
    assert.deepStrictEqual(
      takeOwnershipOfCommittedOffsets(this.scenarioId, topic, partition),
      [{ topic, partition, offset: String(offset), failed: true }],
      `Expected exactly one failed commit attempt at offset ${offset} for "${topic}" partition ${partition}. ` +
        'Probable cause: the commit never ran (the handler threw earlier), succeeded, or used another offset/partition. ' +
        'What to check: the Given that makes the Kafka commit fail, and the commitOffsets call in handleMessage().',
    );
  },
);

// A delivery-log INSERT that throws is still a write the app attempted (fake-db records it before rethrowing),
// so the scenario owns the row it tried to write — a 'blocked' row, attempt 1, no HTTP outcome. [delivery-log]
Then<WebhooksWorld>(
  'the blocked delivery log write for subscriber {int} should have been attempted and failed with {string} [delivery-log]',
  function (subscriberId: number, message: string) {
    assert.deepStrictEqual(
      takeOwnershipOfFailedWrites(this.scenarioId, 'deliveryLog.logAttempt'),
      [{
        operation: 'deliveryLog.logAttempt',
        args: {
          subscriber_id: subscriberId,
          message_key: this.dispatchedKey ?? null,
          payload: this.dispatchedPayload!,
          attempt_number: 1,
          status: 'blocked',
          http_status: null,
          error_message: null,
        },
        error: { message },
      }],
      `Expected exactly one failed 'blocked' delivery-log write for subscriber ${subscriberId} with the injected error. ` +
        'What to check: the "database fails on delivery log writes" Given, and the blocked branch of handleMessage().',
    );
  },
);

// ── Redelivery (at-least-once) ────────────────────────────────────────────────

// KafkaJS hands the same record to eachMessage again after a rebalance or when the handler threw before
// committing. The replay is the identical message — same position, key and value — so whatever the handler
// does a second time is what the receiver gets a second time. Captures a throw like the "I attempt" steps.
When<WebhooksWorld>('Kafka redelivers the same message', async function () {
  const previous = lastDispatch.get(this.scenarioId);
  assert.ok(
    previous,
    'No message was dispatched before "Kafka redelivers the same message". What to check: the scenario needs a Kafka message When step first.',
  );
  // Keep the first handling's outcome: thrownError is about to describe the redelivery instead.
  firstHandlingError.set(this.scenarioId, this.thrownError ?? null);
  try {
    await dispatchKafkaMessage(previous.topic, previous.payload, previous.key, previous.position);
    this.thrownError = null;
  } catch (err) {
    this.thrownError = err instanceof Error ? err : new Error(String(err));
  }
});

Then<WebhooksWorld>('the first handling of the message should have failed', function () {
  assert.ok(
    firstHandlingError.get(this.scenarioId),
    'Expected the first handling of the message to throw (that is what makes Kafka redeliver it) but it completed. ' +
      'Probable cause: the injected failure did not fire. What to check: the failure Given and the "I attempt to dispatch" When.',
  );
});

Then<WebhooksWorld>('the redelivered message should have been handled without an error', function () {
  assert.strictEqual(
    this.thrownError,
    null,
    `Expected the redelivered message to be handled cleanly but handleMessage() threw: ${this.thrownError?.message}. ` +
      'Probable cause: the failure injected for the first delivery did not recover. What to check: the failure sequence in the Given step.',
  );
});

// Owns every POST to the URL and asserts each is the same webhook, but that no two share an X-Delivery-Id:
// deliver.ts mints the id once per deliver() call, so a redelivered message is a new delivery to the receiver. [delivery-call]
Then<WebhooksWorld>(
  'the webhook should have been posted to {string} {int} times, each under a different delivery id [delivery-call]',
  function (expectedUrl: string, times: number) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(
      deliveries.length,
      times,
      `Expected ${times} POSTs to "${expectedUrl}" but got ${deliveries.length}. ` +
        'Probable cause: a redelivery was skipped (dedup added?) or a delivery retried. What to check: handleMessage() and the seeded responses.',
    );
    const ids = deliveries.map((d) => d.headers['x-delivery-id']);
    for (const id of ids) {
      assert.match(id ?? '', DETERMINISTIC_UUID_RE, `X-Delivery-Id should be a deterministic UUID but got "${id}".`);
    }
    assert.strictEqual(
      new Set(ids).size,
      times,
      `Expected every POST to carry its own X-Delivery-Id but got ${JSON.stringify(ids)}. ` +
        'Probable cause: the id is now derived from the Kafka message (idempotent redelivery). If that is intended, rewrite this scenario.',
    );
    for (const delivery of deliveries) {
      const { 'x-delivery-id': _id, ...otherHeaders } = delivery.headers;
      assert.deepStrictEqual(
        { ...delivery, headers: otherHeaders },
        { url: expectedUrl, method: 'POST', headers: { 'content-type': 'application/json' }, body: this.dispatchedPayload! },
        `Delivery shape did not match. Got: ${JSON.stringify(delivery)}`,
      );
    }
  },
);

// Owns the subscriber's delivery_log rows: one first-attempt success per handled copy of the message. [delivery-log]
Then<WebhooksWorld>(
  'the delivery should have been logged as successful {int} times for subscriber {int} with key {string} [delivery-log]',
  function (times: number, subscriberId: number, key: string) {
    const logs = takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId);
    const one: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: key,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'success',
      http_status: 200,
      error_message: null,
    };
    assert.deepStrictEqual(
      logs,
      Array.from({ length: times }, () => one),
      `Expected ${times} identical first-attempt success rows for subscriber ${subscriberId}. Got: ${JSON.stringify(logs).slice(0, 200)}. ` +
        'Probable cause: a redelivery was deduplicated, or a copy retried. What to check: handleMessage() and deliver().',
    );
  },
);

// Owns the subscriber's delivery_log rows: one 'blocked' row per handled copy of the message. [delivery-log]
Then<WebhooksWorld>(
  'the delivery should have been logged as blocked {int} times for subscriber {int} [delivery-log]',
  function (times: number, subscriberId: number) {
    const one: DeliveryAttempt = {
      subscriber_id: subscriberId,
      message_key: this.dispatchedKey ?? null,
      payload: this.dispatchedPayload!,
      attempt_number: 1,
      status: 'blocked',
      http_status: null,
      error_message: null,
    };
    assert.deepStrictEqual(
      takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId),
      Array.from({ length: times }, () => one),
      `Expected ${times} 'blocked' rows for subscriber ${subscriberId}, one per handled copy of the message. ` +
        'Probable cause: a redelivery was deduplicated or the block was not applied. What to check: the blocked branch of handleMessage().',
    );
  },
);

// Owns every commit attempt on the partition, in order, failed ones included.
Then<WebhooksWorld>(
  'the commit attempts for topic {string} partition {int} should have been:',
  function (topic: string, partition: number, table: DataTable) {
    optOutOfKafkaCommitDefault(this);
    const expected = table.hashes().map((row) => ({ topic, partition, offset: row.offset, failed: row.outcome === 'failed' }));
    assert.deepStrictEqual(
      takeOwnershipOfCommittedOffsets(this.scenarioId, topic, partition),
      expected,
      `Commit attempts for "${topic}" partition ${partition} did not match ${JSON.stringify(expected)}. ` +
        'Probable cause: the redelivery committed a different offset, or a commit is missing. What to check: commitOffsets in handleMessage().',
    );
  },
);

// ── Delivery-log write failures ───────────────────────────────────────────────

// The first INSERT INTO delivery_log throws, every later one succeeds: one bad moment for the database, not an outage.
Given<WebhooksWorld>('the delivery log rejects its first write and then recovers', function () {
  failDb(this.scenarioId, 'deliveryLog.logAttempt', [new Error('MySQL: connection lost during delivery log write'), null]);
});

// Owns the delivery_log writes that threw, with the row each tried to insert. Values are literals in the table;
// an empty cell is NULL. [delivery-log]
Then<WebhooksWorld>(
  'these delivery log writes for subscriber {int} should have been attempted and failed with {string} [delivery-log]:',
  function (subscriberId: number, message: string, table: DataTable) {
    const orNull = (v: string) => (v === '' ? null : v);
    const expected = table.hashes().map((row) => ({
      operation: 'deliveryLog.logAttempt',
      args: {
        subscriber_id: subscriberId,
        message_key: this.dispatchedKey ?? null,
        payload: this.dispatchedPayload!,
        attempt_number: Number(row.attempt_number),
        status: row.status,
        http_status: orNull(row.http_status) === null ? null : Number(row.http_status),
        error_message: orNull(row.error_message),
      },
      error: { message },
    }));
    const actual = takeOwnershipOfFailedWrites(this.scenarioId, 'deliveryLog.logAttempt').map(({ error, ...rest }) => ({
      ...rest,
      error: { message: error.message },
    }));
    assert.deepStrictEqual(
      actual,
      expected,
      `The failed delivery-log writes did not match. Got: ${JSON.stringify(actual).slice(0, 200)}. ` +
        'Probable cause: the write that failed was a different attempt/status, or the retry loop kept going. ' +
        'What to check: the logAttempt calls in src/delivery/deliver.ts.',
    );
  },
);

// ── Header collisions ─────────────────────────────────────────────────────────

const GENERATED_DELIVERY_ID = '<generated delivery id>';
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Owns the single POST and asserts its exact header set (lower-cased, as on the wire). A value may contain
// "<generated delivery id>", standing for the deterministic UUID deliver.ts minted. [delivery-call]
Then<WebhooksWorld>(
  'the webhook should have been posted to {string} with exactly these headers [delivery-call]:',
  function (expectedUrl: string, table: DataTable) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(deliveries.length, 1, `Expected exactly 1 webhook delivery to "${expectedUrl}" but got ${deliveries.length}.`);
    const [actual] = deliveries;
    const expectedHeaders = Object.fromEntries(table.raw());
    assert.deepStrictEqual(
      Object.keys(actual.headers).sort(),
      Object.keys(expectedHeaders).sort(),
      `Header names did not match. Got: ${JSON.stringify(actual.headers)}. ` +
        'Probable cause: a subscriber header no longer merges with or overrides a default one. What to check: the headers object in deliver.ts.',
    );
    const uuid = DETERMINISTIC_UUID_RE.source.slice(1, -1);
    for (const [name, value] of Object.entries(expectedHeaders)) {
      const pattern = new RegExp(`^${value.split(GENERATED_DELIVERY_ID).map(escapeRegExp).join(uuid)}$`);
      assert.match(actual.headers[name], pattern, `Header "${name}" should be "${value}" but was "${actual.headers[name]}".`);
    }
    assert.deepStrictEqual(
      { url: actual.url, method: actual.method, body: actual.body },
      { url: expectedUrl, method: 'POST', body: this.dispatchedPayload! },
      `Webhook delivery did not match. Got: ${JSON.stringify(actual)}`,
    );
  },
);

// ── Two subscribers on one URL ────────────────────────────────────────────────

// Owns both subscribers' success rows: one each, keyed by subscriber id, though both went to one URL. [delivery-log]
Then<WebhooksWorld>(
  'the delivery should have been logged as successful once for each of subscribers {int} and {int} with key {string} [delivery-log]',
  function (first: number, second: number, key: string) {
    for (const subscriberId of [first, second]) {
      const expected: DeliveryAttempt = {
        subscriber_id: subscriberId,
        message_key: key,
        payload: this.dispatchedPayload!,
        attempt_number: 1,
        status: 'success',
        http_status: 200,
        error_message: null,
      };
      assert.deepStrictEqual(
        takeOwnershipOfDeliveryLogsForSubscriber(this.scenarioId, subscriberId),
        [expected],
        `Subscriber ${subscriberId} should have exactly one success row although it shares its URL with another subscriber.`,
      );
    }
  },
);

// ── Transport-owned outcomes ──────────────────────────────────────────────────

// Owns every request fetch made inside ONE delivery attempt (e.g. a redirect loop it follows on its own before
// giving up) and asserts they are identical POSTs sharing the attempt's X-Delivery-Id. [delivery-call]
Then<WebhooksWorld>(
  '{int} identical POSTs to {string} should have been made within a single delivery attempt [delivery-call]',
  function (count: number, expectedUrl: string) {
    const deliveries = takeOwnershipOfDeliveriesForUrl(this.scenarioId, expectedUrl);
    assert.strictEqual(deliveries.length, count, `Expected ${count} requests to "${expectedUrl}" but got ${deliveries.length}.`);
    const id = deliveries[0].headers['x-delivery-id'];
    assert.match(id ?? '', DETERMINISTIC_UUID_RE, `X-Delivery-Id should be a deterministic UUID but got "${id}".`);
    for (const delivery of deliveries) {
      assert.deepStrictEqual(
        delivery,
        { url: expectedUrl, method: 'POST', headers: { 'content-type': 'application/json', 'x-delivery-id': id }, body: this.dispatchedPayload! },
        'Every request of the attempt should be the same POST with the same X-Delivery-Id.',
      );
    }
  },
);

// Owns a delivery sequence that failed with a specific error message rather than the generic 'fetch failed'. [delivery-log]
Then<WebhooksWorld>(
  'all {int} delivery attempts should have been logged for subscriber {int} with the error {string} and the last marked as exhausted [delivery-log]',
  function (expectedCount: number, subscriberId: number, errorMessage: string) {
    assertExhaustionLogs(this, subscriberId, expectedCount, null, errorMessage);
  },
);

// For an error whose wording belongs to the runtime (undici's Headers validation), pin only its stable start.
Then<WebhooksWorld>(
  'all {int} delivery attempts should have been logged for subscriber {int} with an error starting {string} and the last marked as exhausted [delivery-log]',
  function (expectedCount: number, subscriberId: number, prefix: string) {
    assertExhaustionLogs(this, subscriberId, expectedCount, null, { prefix });
  },
);

// ── Message keys at the column limit ──────────────────────────────────────────

// delivery_log.message_key is VARCHAR(255): the key's length is the boundary under test, so the step builds it.
When<WebhooksWorld>(
  'I attempt to dispatch a Kafka message on topic {string} with a {int}-character key and payload {string}',
  async function (topic: string, length: number, payload: string) {
    const key = 'k'.repeat(length);
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    try {
      await dispatch(this, topic, payload, key);
      this.thrownError = null;
    } catch (err) {
      this.thrownError = err instanceof Error ? err : new Error(String(err));
    }
  },
);

When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} with a {int}-character key and payload {string}',
  async function (topic: string, length: number, payload: string) {
    const key = 'k'.repeat(length);
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    await dispatch(this, topic, payload, key);
  },
);

Then<WebhooksWorld>(
  'the delivery should have been logged as successful for subscriber {int} with that key [delivery-log]',
  function (subscriberId: number) {
    assertSingleSuccessLog(this, subscriberId, this.dispatchedKey ?? null);
  },
);

// ── Offsets beyond 2^53 ───────────────────────────────────────────────────────

// Kafka offsets are int64 and KafkaJS hands them over as strings; a Cucumber {int} would round them, so the
// offset is quoted and compared as a string.
When<WebhooksWorld>(
  'a Kafka message arrives on topic {string} partition {int} at offset {string} with key {string} and payload {string}',
  async function (topic: string, partition: number, offset: string, key: string, payload: string) {
    this.dispatchedPayload = payload;
    this.dispatchedKey = key;
    await dispatch(this, topic, payload, key, { partition, offset });
  },
);

Then<WebhooksWorld>(
  'the committed offset for topic {string} partition {int} should be {string}',
  function (topic: string, partition: number, offset: string) {
    claimCommittedOffsets(this, topic, partition, [offset]);
  },
);
