import { STATUS_CODES } from 'http';
import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// Behaviours below were probed against Node's real fetch (undici); the parity suite re-checks them
// against a loopback server (parity-tests/fake-fetch.parity.ts).

export interface DeliveryCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface SeededResponse {
  ok?: boolean;
  status: number;
  statusText?: string;
  /**
   * Where a 301/302/303/307/308 points (absolute, or relative to the request URL). Real fetch follows
   * it on its own, so deliver.ts only ever sees the final answer; every hop is still a request the
   * app caused and is captured as its own delivery call. Without it a 3xx is returned as-is, like a
   * redirect response with no Location header.
   */
  location?: string;
}

interface CapturedDelivery extends DeliveryCall {
  owned: boolean;
}

// Per-scenario state
const seededResponses = new Map<string, Map<string, SeededResponse>>();
const captured = new Map<string, CapturedDelivery[]>();

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// fetch gives up on the 21st redirect response: one initial request plus 20 followed redirects.
const MAX_REDIRECTS = 20;
// Describe the request body, so a redirect that drops the body drops them too.
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];
// Credentials fetch never forwards to another origin.
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * The error real fetch throws for EVERY transport failure (refused, DNS, reset, redirect loop): a
 * `TypeError('fetch failed')` whose `cause` carries the detail. deliver.ts logs only `err.message`,
 * so delivery_log.error_message is the literal 'fetch failed' whatever the cause.
 *
 * @example fail(scenarioId, url, [() => fetchFailedError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' })])
 */
export function fetchFailedError(cause: { code?: string; message?: string } = {}): TypeError {
  const detail: NodeJS.ErrnoException = new Error(cause.message ?? '');
  if (cause.code) detail.code = cause.code;
  return new TypeError('fetch failed', { cause: detail });
}

// ---- Failure injection: fail(scenarioId, url, sequence) ----
// fetch is a pass-through boundary, so the "operation" is the concrete outbound URL (or ALL_URLS for
// every URL). `sequence` is a per-call list of outcomes (an Error/zero-arg factory to throw = a network
// error, or null to succeed) advanced one entry per call to that URL, the last entry repeating past the
// end:
//   [err]            = always unreachable
//   [err, null]      = fail once then recover (transient failure)
//   [err, err, null] = fail twice then recover
// Every redirect hop is a call of its own, and every call is recorded before the failure is injected.
// HTTP status errors (non-2xx) are NOT failures — seed them via seedResponse.
export const ALL_URLS = '*';
type Outcome = Error | (() => Error) | null;
interface FailState {
  sequence: Outcome[];
  index: number;
}
const failConfig = new Map<string, Map<string, FailState>>();

function resolveOutcome(o: Outcome): Error | null {
  if (o === null) return null;
  return typeof o === 'function' ? o() : o;
}

function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// fetch sends (and Response.url reports) the parsed form: "https://X.com" -> "https://x.com/". Every URL the
// fake keys or records is normalised the same way, so a scenario may spell it either way.
function normaliseUrl(url: string, context: string): string {
  try {
    return new URL(url).href;
  } catch {
    throw new Error(`[fake-fetch] ${context}: "${url}" is not an absolute URL. Fix: pass the subscriber URL as stored.`);
  }
}

/**
 * Configure the fetch fake to throw a network error for calls to `url` (or ALL_URLS for every URL).
 *
 * @param sequence  Per-call outcomes: an Error (or zero-arg factory) to throw, or null to succeed.
 *                  Advanced one entry per call to this URL; the last entry repeats.
 *
 * @example — a subscriber endpoint is permanently unreachable:
 * fail(this.scenarioId, 'https://x/hook', [() => fetchFailedError({ code: 'ECONNREFUSED' })]);
 * @example — transient: fail once then recover:
 * fail(this.scenarioId, 'https://x/hook', [() => fetchFailedError({ code: 'ECONNRESET' }), null]);
 */
export function fail(scenarioId: string, url: string, sequence: Outcome[]): void {
  if (url !== ALL_URLS && !isHttpUrl(url)) {
    throw new Error(
      `[fake-fetch] fail() operation "${url}" is neither ALL_URLS nor an http(s) URL. ` +
        'Probable cause: a typo — a URL that is never requested makes the failure silently never fire. ' +
        'Fix: pass the exact subscriber URL (or ALL_URLS).',
    );
  }
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-fetch] fail() sequence for "${url}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(url === ALL_URLS ? url : normaliseUrl(url, 'fail()'), { sequence, index: 0 });
}

function failStateFor(scenarioId: string, url: string): FailState | undefined {
  const byUrl = failConfig.get(scenarioId);
  return byUrl?.get(url) ?? byUrl?.get(ALL_URLS);
}

/** Whether the next call to this url (falling back to ALL_URLS) is configured to throw (peek). */
export function isConfiguredToFail(scenarioId: string, url: string): boolean {
  const fs = failStateFor(scenarioId, normaliseUrl(url, 'isConfiguredToFail()'));
  if (!fs) return false;
  return fs.sequence[Math.min(fs.index, fs.sequence.length - 1)] !== null;
}

/** Advance this url's sequence (falling back to ALL_URLS) one step and throw if the outcome is an error. */
function maybeFail(scenarioId: string, url: string): void {
  const fs = failStateFor(scenarioId, url);
  if (!fs) return;
  const o = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  const err = resolveOutcome(o);
  if (err) throw err;
}

export function seedResponse(scenarioId: string, url: string, response: SeededResponse): void {
  // Real fetch turns 1xx into a network error, and nothing a subscriber answers is outside 200-599.
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw new Error(
      `[fake-fetch] seedResponse status ${response.status} for "${url}" is not a final HTTP status (200-599). ` +
        'Fix: use fail() to model a transport failure.',
    );
  }
  if (response.location !== undefined) {
    if (!REDIRECT_STATUSES.has(response.status)) {
      throw new Error(
        `[fake-fetch] seedResponse location for "${url}" needs a redirect status (301, 302, 303, 307, 308), got ${response.status}. ` +
          'Real fetch only follows those.',
      );
    }
    if (!isHttpUrl(new URL(response.location, 'http://placeholder.invalid').href)) {
      throw new Error(`[fake-fetch] seedResponse location "${response.location}" must be an http(s) URL or a relative reference.`);
    }
  }
  if (!seededResponses.has(scenarioId)) {
    seededResponses.set(scenarioId, new Map());
  }
  seededResponses.get(scenarioId)!.set(normaliseUrl(url, 'seedResponse()'), response);
}

/**
 * Claim only unowned deliveries to a specific URL — a redirect hop is claimed by its own (absolute) URL.
 * Use in multi-subscriber scenarios where different subscribers have different outcomes
 * and each subscriber's calls must be asserted independently.
 */
export function takeOwnershipOfDeliveriesForUrl(scenarioId: string, url: string): DeliveryCall[] {
  const calls = captured.get(scenarioId) ?? [];
  const href = normaliseUrl(url, 'takeOwnershipOfDeliveriesForUrl()');
  const unowned = calls.filter((c) => !c.owned && c.url === href);
  if (unowned.length === 0) {
    throw new Error(
      `[fake-fetch] No unowned deliveries for URL "${url}" in scenario ${scenarioId}. ` +
        'Probable cause: the webhook fan-out flow never delivered to this URL, or all calls were already claimed. ' +
        'Fix: verify the subscriber is seeded with this URL, the topic matches, and no earlier ownership call consumed these calls.',
    );
  }
  for (const call of unowned) {
    call.owned = true;
  }
  return JSON.parse(JSON.stringify(unowned.map(({ owned: _owned, ...rest }) => rest))) as DeliveryCall[];
}

function throwIfUnownedExist(scenarioId: string): void {
  // A failure that never fired is a setup that silently did nothing (typo'd URL, or the flow never
  // reached the call), so the scenario would pass without exercising the failure path it claims to.
  const unfired = [...(failConfig.get(scenarioId) ?? [])].filter(([, fs]) => fs.index === 0).map(([u]) => u);
  if (unfired.length > 0) {
    throw new Error(
      `[fake-fetch] A network failure was configured for ${unfired.join(', ')} but nothing requested it in scenario ${scenarioId}. ` +
        'Probable cause: the URL does not match what the app fetched (compare with the subscriber URL), or the flow never reached the delivery. ' +
        'Fix: correct the URL in the Given step, or drop the failure the scenario does not exercise.',
    );
  }
  const calls = captured.get(scenarioId);
  if (!calls) return;
  const unownedCount = calls.filter((c) => !c.owned).length;
  if (unownedCount > 0) {
    throw new Error(
      `[fake-fetch] ${unownedCount} delivery call(s) were captured but never owned ` +
        `in scenario ${scenarioId}. ` +
        'Probable cause: missing Then step, or the scenario triggered more retries than expected. ' +
        'Fix: add a Then step that calls takeOwnershipOfDeliveriesForUrl(url) and asserts on the captured calls, or seed a successful response to prevent retries.',
    );
  }
}

function cleanup(scenarioId: string): void {
  seededResponses.delete(scenarioId);
  captured.delete(scenarioId);
  failConfig.delete(scenarioId);
}

// Register with the fake registry so world.ts After hook can call throwIfUnownedExist + cleanup.
registerFake({ name: 'fetch', throwIfUnownedExist, cleanup });

/**
 * Replaces global.fetch at module load time. Documented behaviour reproduced (WHATWG fetch / undici): URL parsed and
 * normalised before the headers; header names lowercased and validated by Headers; 301/302/303/307/308 followed
 * with the method/body/credential rules, 20 redirects max; 407 is a network error; 421 re-sent once. Every request
 * is recorded before an injected failure throws. Injection: fail(sid, url | ALL_URLS, [...]).
 * Provenance: parity-tests/fake-fetch.parity.ts. deliver.ts reads only ok, status and statusText; a caller that reads
 * the body or response headers must enrich this fake first.
 */
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const scenarioId = currentScenarioId();
  const raw = input instanceof Request ? input.url : String(input);
  // Parsed before the headers, like new Request(); nothing is sent, so nothing is recorded.
  let url: string;
  try {
    url = new URL(raw).href;
  } catch (cause) {
    throw new TypeError(`Failed to parse URL from ${raw}`, { cause });
  }
  let method = init?.method ?? 'GET';
  // new Headers() normalises header names to lowercase — mirrors real HTTP behaviour.
  let headers: Record<string, string> = Object.fromEntries(new Headers(init?.headers).entries());
  let body = (init?.body as string) ?? '';
  let redirects = 0;
  // fetch re-sends a request once when the server answers 421 (Misdirected Request), as the spec says for
  // a reused connection; it cannot tell a new connection from a reused one, so it always does.
  let retriedMisdirected = false;

  for (;;) {
    // Record first: every request the app attempted is a delivery call it owns, including one whose
    // transport then fails. The outcome (status or network error) is asserted through the delivery log.
    if (!captured.has(scenarioId)) {
      captured.set(scenarioId, []);
    }
    captured.get(scenarioId)!.push({ url, method, headers, body, owned: false });

    // Network-error injection — global (ALL_URLS), per-URL, and transient (fail-then-recover) via the
    // per-call sequence.
    maybeFail(scenarioId, url);

    const seeded = seededResponses.get(scenarioId)?.get(url);
    const status = seeded?.status ?? 200;
    // Unseeded URLs default to 200 (success) rather than throwing.
    // This is intentional: unexpected calls are caught by the ownership safety net
    // (throwIfUnownedExist) — a missing seed means the call is unowned, not invisible.
    // Seeding is needed only when testing non-2xx behavior (retries, errors).

    if (status === 421 && !retriedMisdirected) {
      retriedMisdirected = true;
      continue;
    }

    // The request reached the server, but fetch treats a proxy-auth challenge as a network error.
    if (status === 407) throw fetchFailedError();

    if (REDIRECT_STATUSES.has(status) && seeded?.location !== undefined) {
      if (redirects === MAX_REDIRECTS) throw fetchFailedError({ message: 'redirect count exceeded' });
      redirects++;
      retriedMisdirected = false;
      const next = new URL(seeded.location, url).href;
      headers = { ...headers };
      // 301/302 only rewrite a POST; 303 rewrites everything except GET/HEAD. 307/308 replay as sent.
      const verb = method.toUpperCase();
      if (((status === 301 || status === 302) && verb === 'POST') || (status === 303 && verb !== 'GET' && verb !== 'HEAD')) {
        method = 'GET';
        body = '';
        for (const name of BODY_HEADERS) delete headers[name];
      }
      if (new URL(url).origin !== new URL(next).origin) {
        for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) delete headers[name];
      }
      url = next;
      continue;
    }

    // Default to Node's own reason phrases (what a real server sends) so deliver.ts produces realistic
    // error_message values ("HTTP 504 Gateway Timeout", not "HTTP 504 "). Seed statusText to override.
    const statusText = seeded?.statusText ?? STATUS_CODES[status] ?? '';
    // ok can be overridden explicitly; defaults to 2xx range check.
    const ok = seeded?.ok ?? (status >= 200 && status < 300);
    return { ok, status, statusText, redirected: redirects > 0, url } as unknown as Response;
  }
};
