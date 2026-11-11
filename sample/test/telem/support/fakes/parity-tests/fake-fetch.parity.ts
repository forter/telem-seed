/**
 * Parity test: fake-fetch vs real Node.js native fetch (undici).
 *
 * STATUS: Covered — runs in-process against loopback HTTP servers, no container needed.
 *
 * Run:
 *   npm run bdd-test:fakes-parity
 *
 * NOT a Cucumber test. Cucumber loads this file on every BDD run, but the test code is guarded by
 * `require.main === module` so it's a no-op unless run directly. It must run in its own process: the
 * fake replaces global.fetch when it loads, so main() grabs the native fetch first, loads the fake,
 * then keeps both side by side.
 *
 * ---- What is verified ----------------------------------------------------
 *
 * Every case starts two loopback servers (two origins), then makes the SAME request through the real
 * fetch (against the servers) and through the fake (seeded to answer the way the servers do), and
 * compares (a) what the caller observes — ok / status / statusText / redirected / final url, or the
 * error — and (b) what each request looked like on arrival (method, body, the headers the app set), per
 * URL. The fake is the real fake: nothing here mirrors its tables.
 *
 *  1. Outbound shape and header-name normalisation, incl. names that differ only in case.
 *  2. Every status in http.STATUS_CODES from 200 to 599 (407 is a network error in real fetch).
 *  3. 3xx responses without a Location: returned as-is.
 *  4. Redirects (301/302/303/307/308) for POST: which ones drop the method and body, and the body
 *     headers that go with them.
 *  5. Method rules for non-POST methods; Location forms (absolute, relative, no leading slash);
 *     chained redirects; a redirect that lands on an error status.
 *  6. The redirect limit (20 followed; the 21st redirect response fails; a self-loop fails).
 *  7. Which request headers survive a redirect, same-origin and cross-origin.
 *  8. Network-error shape: `TypeError('fetch failed')` with a `cause` (refused, closed socket).
 *  9. A custom reason phrase: the fake's default differs (documented), a seeded statusText matches.
 * 10. URLs are normalised (no path → "/", case, percent-encoding, dot segments) on the wire and in Response.url.
 * 11. Rejections before any request: an unparseable URL ("Failed to parse URL from …"), an invalid header
 *     name, a non-Latin-1 or CR/LF header value. Same wording on Node 22.17 and 24.19.
 *
 * ---- Intentional divergences (not asserted) --------------------------------
 *  - The fake never adds the headers the transport adds on its own: content-length, host, accept,
 *    user-agent, ... (only headers the app set are compared).
 *  - A string body with no explicit Content-Type gets `text/plain;charset=UTF-8` from real fetch; the
 *    fake adds nothing. deliver.ts always sets Content-Type.
 *  - A transport failure injected through fail() is still recorded as a request (the app attempted it),
 *    even when the real failure (refused connection) means no server ever received it.
 *  - The `cause` of an injected error is a plain Error carrying the code and message you give it; real
 *    undici may use a subclass (SocketError). deliver.ts only logs err.message.
 *  - Statuses outside http.STATUS_CODES (299, 599): the fake has no phrase unless seeded; the loopback
 *    server invents one, so there is nothing stable to compare.
 *  - Status 1xx and >599, and a response body that resets mid-read: not modelled (seedResponse rejects
 *    non-final statuses; deliver.ts never reads the body).
 *  - DNS failure (ENOTFOUND) and non-http(s) schemes: probed (same `fetch failed` shape, the code only in
 *    cause), not asserted — DNS would need the network, and the API rejects other schemes.
 */

import assert from 'assert';
import http, { STATUS_CODES } from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { withScenario } from './parity-setup';
import { cleanupScenario, throwIfAnyUnownedExist } from '../../fake-registry';

type FakeModule = typeof import('../fake-fetch');
let realFetch: typeof fetch;
let fakeFetch: typeof fetch;
let fake: FakeModule;

// ── Loopback servers ──────────────────────────────────────────────────────────

interface Route {
  status: number;
  /** Reason phrase the server sends; defaults to Node's standard one. */
  reason?: string;
  /** Raw Location header value. */
  location?: string;
}
type Routes = Record<string, Route>;

interface Hop {
  server: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface Servers {
  bases: string[];
  hops: Hop[];
  setRoutes: (routes: Routes[]) => void;
  close: () => Promise<void>;
}

async function startServers(count: number): Promise<Servers> {
  const hops: Hop[] = [];
  let routes: Routes[] = [];
  const servers = Array.from({ length: count }, (_, index) =>
    http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        hops.push({ server: index, method: req.method ?? '', path: req.url ?? '', headers, body });
        const route = routes[index]?.[new URL(req.url ?? '/', 'http://x').pathname];
        if (!route) { res.writeHead(404, 'Not Found'); res.end(); return; }
        res.writeHead(route.status, route.reason ?? STATUS_CODES[route.status] ?? '', route.location !== undefined ? { Location: route.location } : {});
        res.end();
      });
    }),
  );
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
  return {
    bases: servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    hops,
    setRoutes: (r) => { routes = r; },
    close: () => Promise.all(servers.map((s) => new Promise<void>((res) => s.close(() => res())))).then(() => undefined),
  };
}

// ── Observation ───────────────────────────────────────────────────────────────

// The headers the app sets (and the ones fetch's rules touch on a redirect); transport-added ones differ by design.
const APP_HEADERS = [
  'authorization', 'cookie', 'proxy-authorization', 'x-custom', 'x-delivery-id',
  'content-type', 'content-encoding', 'content-language', 'content-location',
];

function pick(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => APP_HEADERS.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}

type Outcome =
  | { response: { ok: boolean; status: number; statusText: string; redirected: boolean; url: string } }
  | { error: { name: string; message: string; causeMessage: string | undefined; causeCode: string | undefined } };

// Replace the ephemeral origins so both sides compare equal: http://127.0.0.1:41234/x -> #0/x
function normalise(text: string, bases: string[]): string {
  return bases.reduce((t, base, i) => t.split(base).join(`#${i}`), text);
}

async function observe(run: () => Promise<Response>, bases: string[]): Promise<Outcome> {
  try {
    const r = await run();
    return { response: { ok: r.ok, status: r.status, statusText: r.statusText, redirected: r.redirected, url: normalise(r.url, bases) } };
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    return { error: { name: err.name, message: err.message, causeMessage: err.cause?.message, causeCode: err.cause?.code } };
  }
}

type HopInfo = { method: string; headers: Record<string, string>; body: string };
type HopMap = Record<string, HopInfo[]>;

// ── Case runner ───────────────────────────────────────────────────────────────

interface Spec {
  name: string;
  /** Routes per server (index = server), built once the ports are known. */
  routes: (bases: string[]) => Routes[];
  request: (bases: string[]) => { url: string; init: RequestInit };
  /** Also seed the server's custom reason phrase as the fake's statusText. */
  seedReason?: boolean;
}

const PAYLOAD = '{"orderId":"abc","name":"test"}';
const DELIVER_HEADERS = { 'Content-Type': 'application/json', 'X-Delivery-Id': '00000000-0000-4000-8000-000000000001' };
const post = (path: string, headers: Record<string, string> = DELIVER_HEADERS, method = 'POST') =>
  (bases: string[]) => ({ url: `${bases[0]}${path}`, init: { method, headers, body: PAYLOAD } as RequestInit });

/** Runs one request through the real fetch and the fake; returns the divergences (empty = parity). */
async function compare(spec: Spec): Promise<string[]> {
  const servers = await startServers(2);
  try {
    const { bases, hops } = servers;
    const routes = spec.routes(bases);
    servers.setRoutes(routes);
    const { url, init } = spec.request(bases);

    const real = await observe(() => realFetch(url, init), bases);
    const realHops: HopMap = {};
    const order: Array<{ key: string; server: number; path: string }> = [];
    for (const h of hops) {
      const key = `#${h.server}${h.path}`;
      if (!realHops[key]) { realHops[key] = []; order.push({ key, server: h.server, path: h.path }); }
      realHops[key].push({ method: h.method, headers: pick(h.headers), body: h.body });
    }

    const { outcome, fakeHops, problems } = await withScenario(cleanupScenario, async (scenarioId) => {
      routes.forEach((table, server) => {
        for (const [path, route] of Object.entries(table)) {
          fake.seedResponse(scenarioId, `${bases[server]}${path}`, {
            status: route.status,
            ...(route.location !== undefined ? { location: route.location } : {}),
            ...(spec.seedReason && route.reason !== undefined ? { statusText: route.reason } : {}),
          });
        }
      });
      const result = await observe(() => fakeFetch(url, init), bases);
      const mine: HopMap = {};
      const issues: string[] = [];
      for (const { key, server, path } of order) {
        try {
          mine[key] = fake.takeOwnershipOfDeliveriesForUrl(scenarioId, `${bases[server]}${path}`).map((c) => ({ method: c.method, headers: pick(c.headers), body: c.body }));
        } catch {
          issues.push(`the real server received a request for ${key} but the fake recorded none`);
        }
      }
      try { throwIfAnyUnownedExist(scenarioId); } catch (e) { issues.push(`the fake made requests the real server never saw: ${(e as Error).message}`); }
      return { outcome: result, fakeHops: mine, problems: issues };
    });

    const divergences = [...problems];
    try { assert.deepStrictEqual(outcome, real); } catch { divergences.push(`outcome — real: ${JSON.stringify(real)}  fake: ${JSON.stringify(outcome)}`); }
    const expectedHops = Object.fromEntries(Object.entries(realHops).filter(([k]) => k in fakeHops));
    try { assert.deepStrictEqual(fakeHops, expectedHops); } catch { divergences.push(`requests received — real: ${JSON.stringify(realHops)}  fake: ${JSON.stringify(fakeHops)}`); }
    return divergences.map((d) => `${spec.name}: ${d}`);
  } finally {
    await servers.close();
  }
}

async function compareAll(specs: Spec[]): Promise<void> {
  const divergences: string[] = [];
  for (const spec of specs) divergences.push(...(await compare(spec)));
  if (divergences.length > 0) {
    throw new Error(`fake-fetch diverges from real fetch in ${divergences.length} place(s):\n  - ${divergences.join('\n  - ')}`);
  }
}

// ── Cases ─────────────────────────────────────────────────────────────────────

const ok = (): Routes => ({ '/final': { status: 200 } });
const single = (path: string, route: Route) => (): Routes[] => [{ [path]: route }, {}];

async function testOutboundShape(): Promise<void> {
  await compareAll([
    { name: 'deliver.ts-shaped POST', routes: single('/webhook', { status: 200 }), request: post('/webhook') },
    {
      name: 'subscriber custom header on top of the defaults',
      routes: single('/webhook', { status: 200 }),
      request: post('/webhook', { ...DELIVER_HEADERS, 'X-Custom': 'keep' }),
    },
    {
      // new Headers() joins names that differ only in case — the same on both sides.
      name: 'header names differing only in case',
      routes: single('/webhook', { status: 200 }),
      request: post('/webhook', { 'Content-Type': 'application/json', 'content-type': 'text/plain', 'X-Delivery-Id': 'abc' }),
    },
    {
      name: 'subscriber custom header with an empty value',
      routes: single('/webhook', { status: 200 }),
      request: post('/webhook', { ...DELIVER_HEADERS, 'X-Custom': '' }),
    },
  ]);
}

// Every status the standard table knows: 2xx, 4xx, 5xx. 3xx need a Location to mean anything (below).
const FINAL_STATUSES = Object.keys(STATUS_CODES).map(Number).filter((c) => c >= 200 && c <= 599 && !(c >= 300 && c < 400));

async function testEveryStandardStatus(): Promise<void> {
  await compareAll(FINAL_STATUSES.map((status) => ({
    name: `HTTP ${status}`,
    routes: single('/s', { status }),
    request: post('/s'),
  })));
}

const NO_LOCATION_REDIRECTS = [300, 301, 302, 303, 304, 305, 307, 308];

async function testRedirectStatusWithoutLocation(): Promise<void> {
  await compareAll(NO_LOCATION_REDIRECTS.map((status) => ({
    name: `HTTP ${status} without Location`,
    routes: single('/s', { status }),
    request: post('/s'),
  })));
}

async function testPostRedirectStatuses(): Promise<void> {
  await compareAll([301, 302, 303, 307, 308].map((status) => ({
    name: `POST redirected with ${status}`,
    routes: (): Routes[] => [{ '/start': { status, location: '/final' }, ...ok() }, {}],
    request: post('/start', { ...DELIVER_HEADERS, 'X-Custom': 'keep' }),
  })));
}

async function testNonPostRedirectMethods(): Promise<void> {
  const cases: Array<[string, number]> = [['PUT', 301], ['PUT', 302], ['PUT', 303], ['PATCH', 301], ['DELETE', 303]];
  await compareAll(cases.map(([method, status]) => ({
    name: `${method} redirected with ${status}`,
    routes: (): Routes[] => [{ '/start': { status, location: '/final' }, ...ok() }, {}],
    request: post('/start', DELIVER_HEADERS, method),
  })));
}

async function testLocationForms(): Promise<void> {
  await compareAll([
    { name: 'absolute Location on another origin', routes: (b: string[]): Routes[] => [{ '/start': { status: 307, location: `${b[1]}/final` } }, ok()], request: post('/start') },
    { name: 'Location with a leading slash', routes: (): Routes[] => [{ '/dir/start': { status: 302, location: '/final' }, ...ok() }, {}], request: post('/dir/start') },
    { name: 'relative Location without a leading slash', routes: (): Routes[] => [{ '/dir/start': { status: 302, location: 'sub/final' }, '/dir/sub/final': { status: 200 } }, {}], request: post('/dir/start') },
    { name: 'Location climbing out of the directory', routes: (): Routes[] => [{ '/dir/start': { status: 307, location: '../final' }, ...ok() }, {}], request: post('/dir/start') },
    { name: 'Location with a query string', routes: (): Routes[] => [{ '/start': { status: 307, location: '/final?a=1&b=2' }, ...ok() }, {}], request: post('/start') },
  ]);
}

async function testChainedAndFailingRedirects(): Promise<void> {
  await compareAll([
    {
      name: '307 then 301 then 200 (method kept, then dropped)',
      routes: (): Routes[] => [{ '/a': { status: 307, location: '/b' }, '/b': { status: 301, location: '/c' }, '/c': { status: 200 } }, {}],
      request: post('/a'),
    },
    {
      name: '302 landing on a 503',
      routes: (): Routes[] => [{ '/start': { status: 302, location: '/down' }, '/down': { status: 503 } }, {}],
      request: post('/start'),
    },
    {
      name: '307 landing on a proxy-auth challenge (network error)',
      routes: (): Routes[] => [{ '/start': { status: 307, location: '/proxy' }, '/proxy': { status: 407 } }, {}],
      request: post('/start'),
    },
  ]);
}

function chain(length: number): Routes {
  const routes: Routes = {};
  for (let i = 0; i < length; i++) routes[`/c${i}`] = { status: 307, location: `/c${i + 1}` };
  routes[`/c${length}`] = { status: 200 };
  return routes;
}

async function testRedirectLimit(): Promise<void> {
  await compareAll([
    { name: '20 redirects are followed', routes: (): Routes[] => [chain(20), {}], request: post('/c0') },
    { name: 'the 21st redirect response fails', routes: (): Routes[] => [chain(21), {}], request: post('/c0') },
    { name: 'a redirect loop fails', routes: (): Routes[] => [{ '/loop': { status: 302, location: '/loop' } }, {}], request: post('/loop') },
  ]);
}

async function testHeaderSurvival(): Promise<void> {
  const credentials = {
    ...DELIVER_HEADERS, Authorization: 'Bearer t', Cookie: 'a=b', 'Proxy-Authorization': 'Basic x', 'X-Custom': 'keep',
  };
  await compareAll([
    { name: 'same-origin 307 keeps everything', routes: (): Routes[] => [{ '/start': { status: 307, location: '/final' }, ...ok() }, {}], request: post('/start', credentials) },
    { name: 'cross-origin 307 drops credentials only', routes: (b: string[]): Routes[] => [{ '/start': { status: 307, location: `${b[1]}/final` } }, ok()], request: post('/start', credentials) },
    { name: 'same-origin 302 drops the body headers, keeps credentials', routes: (): Routes[] => [{ '/start': { status: 302, location: '/final' }, ...ok() }, {}], request: post('/start', { ...credentials, 'Content-Encoding': 'identity', 'Content-Language': 'en', 'Content-Location': '/x' }) },
    { name: 'cross-origin 303 drops the body headers and credentials', routes: (b: string[]): Routes[] => [{ '/start': { status: 303, location: `${b[1]}/final` } }, ok()], request: post('/start', { ...credentials, 'Content-Encoding': 'identity' }) },
  ]);
}

// ── Network errors ────────────────────────────────────────────────────────────

/** A port nothing listens on: bind, note the port, close. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** Real error from `url`, then the fake's injected error built from what the real cause carried. */
async function compareNetworkError(label: string, url: string): Promise<void> {
  const init = { method: 'POST', headers: DELIVER_HEADERS, body: PAYLOAD };
  const real = await observe(() => realFetch(url, init), []);
  assert.ok('error' in real, `${label}: real fetch should have failed but resolved`);
  const injected = await withScenario(cleanupScenario, async (scenarioId) => {
    fake.fail(scenarioId, url, [() => fake.fetchFailedError({ code: real.error.causeCode, message: real.error.causeMessage })]);
    return observe(() => fakeFetch(url, init), []);
  });
  assert.deepStrictEqual(injected, real, `${label}: the injected error differs from the real one`);
  assert.strictEqual('error' in real && real.error.message, 'fetch failed', `${label}: real fetch always reports 'fetch failed'`);
}

async function testNetworkErrorShape(): Promise<void> {
  await compareNetworkError('connection refused', `http://127.0.0.1:${await closedPort()}/hook`);

  // The server accepts the connection, reads the request and hangs up without answering.
  const hangUp = net.createServer((socket) => { socket.once('data', () => socket.destroy()); });
  await new Promise<void>((resolve) => hangUp.listen(0, '127.0.0.1', resolve));
  try {
    await compareNetworkError('socket closed before any response', `http://127.0.0.1:${(hangUp.address() as AddressInfo).port}/hook`);
  } finally {
    await new Promise<void>((resolve) => hangUp.close(() => resolve()));
  }
}

// ── URL normalisation and requests fetch refuses to send ─────────────────────────

async function testUrlNormalisation(): Promise<void> {
  await compareAll([
    { name: 'no path is sent as "/"', routes: single('/', { status: 200 }), request: (b) => ({ url: b[0], init: post('/')(b).init }) },
    { name: 'upper-case scheme', routes: single('/webhook', { status: 200 }), request: (b) => ({ url: b[0].replace('http:', 'HTTP:') + '/webhook', init: post('/')(b).init }) },
    { name: 'non-ASCII path is percent-encoded', routes: single('/w%C3%A9bhook', { status: 200 }), request: (b) => ({ url: `${b[0]}/wébhook`, init: post('/')(b).init }) },
    { name: 'dot segments are resolved', routes: single('/webhook', { status: 200 }), request: (b) => ({ url: `${b[0]}/a/../webhook`, init: post('/')(b).init }) },
  ]);
}

/** A request fetch rejects before any connection: same error on both sides, nothing reaches the server, nothing recorded. */
async function compareRejected(label: string, url: (base: string) => string, headers: Record<string, string>): Promise<void> {
  const servers = await startServers(1);
  try {
    const init = { method: 'POST', headers, body: PAYLOAD };
    const target = url(servers.bases[0]);
    const real = await observe(() => realFetch(target, init), servers.bases);
    assert.ok('error' in real, `${label}: real fetch should have rejected`);
    assert.strictEqual(servers.hops.length, 0, `${label}: real fetch should not have sent anything`);
    const fakeOutcome = await withScenario(cleanupScenario, async (scenarioId) => {
      const outcome = await observe(() => fakeFetch(target, init), servers.bases);
      throwIfAnyUnownedExist(scenarioId); // nothing recorded
      return outcome;
    });
    assert.deepStrictEqual(fakeOutcome, real, `${label}: the fake's error differs from real fetch`);
  } finally {
    await servers.close();
  }
}

async function testRejectedBeforeSending(): Promise<void> {
  await compareRejected('unparseable URL', () => 'not a url', DELIVER_HEADERS);
  await compareRejected('invalid header name', (b) => `${b}/hook`, { ...DELIVER_HEADERS, 'X Bad Header': 'v' });
  await compareRejected('header value outside Latin-1', (b) => `${b}/hook`, { ...DELIVER_HEADERS, 'X-Custom': '日本' });
  await compareRejected('header value with CR LF', (b) => `${b}/hook`, { ...DELIVER_HEADERS, 'X-Custom': 'a\r\nb' });
  // new Request() parses the URL before the headers.
  await compareRejected('unparseable URL and invalid header', () => 'not a url', { 'X Bad Header': 'v' });
}

// ── Custom reason phrase ──────────────────────────────────────────────────────

async function testCustomReasonPhrase(): Promise<void> {
  const route: Route = { status: 503, reason: 'Connection Limit Exceeded' };
  // Without a seeded statusText the fake answers with the standard phrase — the documented divergence.
  const unseeded = await compare({ name: 'custom reason, not seeded', routes: single('/s', route), request: post('/s') });
  assert.strictEqual(unseeded.length, 1, `Expected exactly the statusText divergence, got: ${JSON.stringify(unseeded)}`);
  assert.match(unseeded[0], /Connection Limit Exceeded/, 'The divergence must be the server\'s custom phrase');
  assert.match(unseeded[0], /Service Unavailable/, 'The fake falls back to the standard phrase');
  // Seeding the phrase the server sends closes the gap.
  assert.deepStrictEqual(await compare({ name: 'custom reason, seeded', routes: single('/s', route), request: post('/s'), seedReason: true }), []);
  console.log('  ✓ Known divergence confirmed: fake=\'Service Unavailable\' real=\'Connection Limit Exceeded\'; a seeded statusText matches');
  console.log('    → deliver.ts error_message differs when servers send custom reason phrases unless the scenario seeds statusText.');
}

// ── Entry point ────────────────────────────────────────────────────────────────

// Each entry is one parity test. Running them through a counted loop lets run.sh
// distinguish "all passed" from "loaded but executed nothing" (a stale import that
// skips the body reads green otherwise) — it asserts the PARITY_TESTS_RUN marker below.
const TESTS: Array<[string, () => Promise<void>]> = [
  ['Outbound shape and header-name normalisation', testOutboundShape],
  ['Every standard status 200-599 (ok, status, statusText; 407 is a network error)', testEveryStandardStatus],
  ['3xx without a Location is returned as-is', testRedirectStatusWithoutLocation],
  ['POST redirected with 301/302/303/307/308', testPostRedirectStatuses],
  ['Non-POST methods across redirects', testNonPostRedirectMethods],
  ['Location forms (absolute, relative, query)', testLocationForms],
  ['Chained redirects and redirects landing on errors', testChainedAndFailingRedirects],
  ['Redirect limit and loops', testRedirectLimit],
  ['Request headers across a redirect (same- and cross-origin)', testHeaderSurvival],
  ['Network-error shape (TypeError "fetch failed" + cause)', testNetworkErrorShape],
  ['URL normalisation (recorded and reported as the parsed href)', testUrlNormalisation],
  ['Rejected before sending: unparseable URL, invalid header name / value', testRejectedBeforeSending],
  ['Custom reason phrase (documented divergence)', testCustomReasonPhrase],
];

async function main(): Promise<void> {
  console.log('fake-fetch parity test\n');

  // Grab the native fetch BEFORE the fake replaces global.fetch on load.
  realFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fake = require('../fake-fetch') as FakeModule;
  fakeFetch = globalThis.fetch;
  globalThis.fetch = realFetch;
  assert.notStrictEqual(fakeFetch, realFetch, 'loading fake-fetch should have replaced global.fetch');

  let testsRun = 0;
  for (const [i, [name, fn]] of TESTS.entries()) {
    console.log(`${i + 1}. ${name}:`);
    await fn();
    console.log('  ✓ matches');
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
