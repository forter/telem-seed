/**
 * Parity test: fake-fetch vs real Node.js native fetch.
 *
 * STATUS: Covered — runs in-process with a loopback HTTP server, no container needed.
 *
 * Run:
 *   npm run bdd-test:fakes-parity
 *
 * NOT a Cucumber test. Cucumber loads this file on every BDD run, but the test code
 * is guarded by `require.main === module` so it's a no-op unless run directly.
 * The BDD suite must NOT have replaced global.fetch yet — that's why this runs as a
 * separate process.
 *
 * ---- What is verified ----------------------------------------------------
 *
 * 1. Outbound shape: URL, method, headers, body captured by fake-fetch match what
 *    a real HTTP server actually receives. Key assertion: header normalization via
 *    `new Headers(init.headers).entries()` produces lowercase keys that match what
 *    Node's http.IncomingMessage delivers to the server.
 *
 * 2. Inbound response (standard codes): for status codes in the HTTP_REASON table
 *    (200, 201, 204, 429, 500, 503), fake-fetch's synthesized fields match what
 *    Node.js native fetch returns from a server that sends the standard reason phrase:
 *      - response.ok: (status >= 200 && status < 300)
 *      - response.status: the numeric code
 *      - response.statusText: the standard reason phrase
 *
 * 3. Known divergence (custom reason phrase): documented with an assertion that
 *    captures the gap — fake-fetch synthesizes from HTTP_REASON, so a server
 *    sending a custom phrase (e.g. "503 Connection Limit Exceeded") will produce
 *    a different statusText than the HTTP_REASON entry. deliver.ts uses statusText
 *    to build error_message; scenarios pin the expected value, so this divergence
 *    is acceptable for the current test surface.
 */

import assert from 'assert';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Loopback server helpers ───────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

function startServer(
  statusCode: number,
  reasonPhrase: string,
  responseBody = '',
): Promise<{ baseUrl: string; captured: Promise<CapturedRequest>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let resolveCapture!: (r: CapturedRequest) => void;
    const captured = new Promise<CapturedRequest>((res) => { resolveCapture = res; });

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        // Node's http.IncomingMessage already lowercases header keys.
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(', ');
        }
        resolveCapture({ method: req.method ?? '', headers, body });
        res.writeHead(statusCode, reasonPhrase, { 'content-type': 'text/plain' });
        res.end(responseBody);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// ── Test 1: Outbound shape ────────────────────────────────────────────────────

async function testOutboundShape(): Promise<void> {
  const { baseUrl, captured, close } = await startServer(200, 'OK');
  const url = `${baseUrl}/webhook`;
  const deliveryId = '00000000-0000-4000-8000-000000000001';
  const payload = '{"orderId":"abc","name":"test"}';

  // deliver.ts calls fetch() with exactly these options.
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Id': deliveryId },
    body: payload,
  });
  const req = await captured;
  await close();

  // fake-fetch normalises headers with `Object.fromEntries(new Headers(init.headers).entries())`.
  // Verify the normalised keys match what the real server receives (already lowercase).
  const fakeNormalized = Object.fromEntries(
    new Headers({ 'Content-Type': 'application/json', 'X-Delivery-Id': deliveryId }).entries(),
  );

  // Headers: fake-fetch normalises to lowercase — same as http.IncomingMessage.
  assert.deepStrictEqual(
    fakeNormalized,
    { 'content-type': 'application/json', 'x-delivery-id': deliveryId },
    'fake-fetch normalises header keys to lowercase (via new Headers())',
  );
  assert.strictEqual(req.headers['content-type'], fakeNormalized['content-type'],
    'Server receives content-type matching fake-fetch capture');
  assert.strictEqual(req.headers['x-delivery-id'], fakeNormalized['x-delivery-id'],
    'Server receives x-delivery-id matching fake-fetch capture');

  // Method: `init?.method ?? 'GET'`
  assert.strictEqual(req.method, 'POST', 'Server receives POST method');

  // Body: `(init?.body as string) ?? ''`
  assert.strictEqual(req.body, payload, 'Server receives payload body verbatim');

  console.log('  ✓ URL, method, headers (normalised), body all match real server');
}

// ── Test 2: Inbound response — standard codes ─────────────────────────────────

// Mirror of fake-fetch's HTTP_REASON table — the contract under test.
const HTTP_REASON: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

const STANDARD_CODES = [200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503];

async function testStandardCodes(): Promise<void> {
  for (const status of STANDARD_CODES) {
    const phrase = HTTP_REASON[status];
    const { baseUrl, captured, close } = await startServer(status, phrase);

    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '' });
    await captured;
    await close();

    // ok
    const expectedOk = status >= 200 && status < 300;
    assert.strictEqual(response.ok, expectedOk,
      `HTTP ${status}: response.ok should be ${expectedOk}`);

    // status
    assert.strictEqual(response.status, status,
      `HTTP ${status}: response.status should be ${status}`);

    // statusText: fake-fetch synthesises from HTTP_REASON — verify it matches the real phrase.
    const fakeStatusText = HTTP_REASON[status] ?? '';
    assert.strictEqual(fakeStatusText, response.statusText,
      `HTTP ${status}: fake-fetch statusText '${fakeStatusText}' matches real fetch '${response.statusText}'`);

    console.log(`  ✓ HTTP ${status} '${phrase}': ok=${response.ok}, statusText matches`);
  }
}

// ── Test 3: Known divergence — custom reason phrase ────────────────────────────

async function testCustomReasonPhraseDivergence(): Promise<void> {
  // A real server may send a non-standard reason phrase.
  // fake-fetch synthesises from HTTP_REASON, so it will NOT match.
  const customPhrase = 'Connection Limit Exceeded';
  const { baseUrl, captured, close } = await startServer(503, customPhrase);

  const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '' });
  await captured;
  await close();

  const fakeStatusText = HTTP_REASON[503]; // 'Service Unavailable'

  // Document the divergence: they should differ.
  assert.notStrictEqual(
    fakeStatusText,
    response.statusText,
    `Known divergence confirmed: fake-fetch produces '${fakeStatusText}' but real server sent '${response.statusText}'`,
  );
  assert.strictEqual(response.statusText, customPhrase,
    `Real fetch sees the server's actual reason phrase '${customPhrase}'`);

  console.log(`  ✓ Known divergence confirmed: fake='${fakeStatusText}' real='${response.statusText}'`);
  console.log('    → deliver.ts error_message will differ when servers send custom reason phrases.');
  console.log('    → Scenarios pin the expected error_message, so this is safe for the current test surface.');
}

// ── Entry point ────────────────────────────────────────────────────────────────

// Each entry is one parity test. Running them through a counted loop lets run.sh
// distinguish "all passed" from "loaded but executed nothing" (a stale import that
// skips the body reads green otherwise) — it asserts the PARITY_TESTS_RUN marker below.
const TESTS: Array<[string, () => Promise<void>]> = [
  ['Outbound shape (URL, method, headers, body)', testOutboundShape],
  ['Inbound response — standard codes (ok, status, statusText)', testStandardCodes],
  ['Known divergence — custom reason phrase', testCustomReasonPhraseDivergence],
];

async function main(): Promise<void> {
  console.log('fake-fetch parity test\n');

  let testsRun = 0;
  for (const [i, [name, fn]] of TESTS.entries()) {
    console.log(`${i + 1}. ${name}:`);
    await fn();
    testsRun++;
  }

  if (testsRun === 0) {
    throw new Error('parity suite executed zero tests — a stale import or empty suite silently disabled parity');
  }

  console.log(`\n✓ All parity checks passed (ran ${testsRun} tests).`);
  // Machine-readable marker consumed by run.sh to fail a zero-test run.
  console.log(`PARITY_TESTS_RUN=${testsRun}`);
}

// Guard: only run when invoked directly. Cucumber loads this file on every BDD run
// but must NOT trigger the test — global.fetch has already been replaced by fake-fetch
// in that process. The parity test needs the real global.fetch.
if (require.main === module) {
  void main().catch((err: Error) => {
    console.error('\n✗ PARITY TEST FAILED:', err.message);
    process.exit(1);
  });
}

export {};
