import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// Standard HTTP reason phrases for common status codes — used as default statusText.
const HTTP_REASON: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

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
}

interface CapturedDelivery extends DeliveryCall {
  owned: boolean;
}

// Per-scenario state
const seededResponses = new Map<string, Map<string, SeededResponse>>();
const captured = new Map<string, CapturedDelivery[]>();

// ---- Failure injection: fail(scenarioId, url, sequence) ----
// fetch is a pass-through boundary, so the "operation" is the concrete outbound URL (or ALL_URLS for
// every URL). `sequence` is a per-call list of outcomes (an Error/zero-arg factory to throw = a network
// error, or null to succeed) advanced one entry per call to that URL, the last entry repeating past the
// end:
//   [err]            = always unreachable
//   [err, null]      = fail once then recover (transient failure)
//   [err, err, null] = fail twice then recover
// A thrown network error is not recorded (the request never completed at the HTTP layer) — same contract
// as the pre-fail() configureFetch / configureUrlFetch / configureTransientFailure it replaces. HTTP
// status errors (non-2xx) are NOT failures — seed them via seedResponse (they return and are recorded).
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

// Stable message for injected transient failures. Kept constant (no per-attempt detail) so step
// definitions can pin it as an expected literal — deriving error_message from the asserted log row
// would be a tautology the hardcoded-expected-values lint rule flags.
export const TRANSIENT_FAILURE_ERROR =
  '[fake-fetch] Injected transient network failure (configured via fail)';

/**
 * Configure the fetch fake to throw a network error for calls to `url` (or ALL_URLS for every URL).
 *
 * @param sequence  Per-call outcomes: an Error (or zero-arg factory) to throw, or null to succeed.
 *                  Advanced one entry per call to this URL; the last entry repeats.
 *
 * @example — a subscriber endpoint is permanently unreachable:
 * fail(this.scenarioId, 'https://x/hook', [new Error('ECONNREFUSED')]);
 * @example — transient: fail once then recover:
 * fail(this.scenarioId, 'https://x/hook', [new Error(TRANSIENT_FAILURE_ERROR), null]);
 */
export function fail(scenarioId: string, url: string, sequence: Outcome[]): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('[fake-fetch] fail() requires a non-empty url (or ALL_URLS) as the operation.');
  }
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-fetch] fail() sequence for "${url}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(url, { sequence, index: 0 });
}

/** Whether the next call to this url (falling back to ALL_URLS) is configured to throw (peek). */
export function isConfiguredToFail(scenarioId: string, url: string): boolean {
  const fs = failConfig.get(scenarioId)?.get(url) ?? failConfig.get(scenarioId)?.get(ALL_URLS);
  if (!fs) return false;
  return fs.sequence[Math.min(fs.index, fs.sequence.length - 1)] !== null;
}

/** Advance this url's sequence (falling back to ALL_URLS) one step and throw if the outcome is an error. */
function maybeFail(scenarioId: string, url: string): void {
  const byUrl = failConfig.get(scenarioId);
  if (!byUrl) return;
  const fs = byUrl.get(url) ?? byUrl.get(ALL_URLS);
  if (!fs) return;
  const o = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  const err = resolveOutcome(o);
  if (err) throw err;
}

/**
 * Return a snapshot of all captured delivery calls (owned and unowned) for a scenario.
 * Does not claim ownership. Use for negative assertions (e.g. "was not posted to X").
 */
export function peekAllDeliveries(scenarioId: string): DeliveryCall[] {
  const calls = captured.get(scenarioId) ?? [];
  return JSON.parse(JSON.stringify(calls.map(({ owned: _owned, ...rest }) => rest))) as DeliveryCall[];
}

export function seedResponse(scenarioId: string, url: string, response: SeededResponse): void {
  if (!seededResponses.has(scenarioId)) {
    seededResponses.set(scenarioId, new Map());
  }
  seededResponses.get(scenarioId)!.set(url, response);
}

/**
 * Claim only unowned deliveries to a specific URL.
 * Use in multi-subscriber scenarios where different subscribers have different outcomes
 * and each subscriber's calls must be asserted independently.
 */
export function takeOwnershipOfDeliveriesForUrl(scenarioId: string, url: string): DeliveryCall[] {
  const calls = captured.get(scenarioId) ?? [];
  const unowned = calls.filter((c) => !c.owned && c.url === url);
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

// Replace global.fetch at module load time.
// deliver.ts reads exactly three fields: response.ok, response.status, response.statusText.
// Any code path that reads response.json()/.text()/.headers must enrich this fake first.
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const scenarioId = currentScenarioId();

  // Network-error injection — throws before recording (a thrown network error never completed at the
  // HTTP layer, so no delivery call is captured). Covers global (ALL_URLS), per-URL, and transient
  // (fail-then-recover) failures via the per-call sequence.
  maybeFail(scenarioId, url);

  const seeded = seededResponses.get(scenarioId)?.get(url);
  const status = seeded?.status ?? 200;
  // Unseeded URLs default to 200 (success) rather than throwing.
  // This is intentional: unexpected calls are caught by the ownership safety net
  // (throwIfUnownedExist) — a missing seed means the call is unowned, not invisible.
  // Seeding is needed only when testing non-2xx behavior (retries, errors).
  // Default to standard HTTP reason phrases so deliver.ts produces realistic error_message values
  // (e.g. "HTTP 500 Internal Server Error" not "HTTP 500 "). Seed statusText explicitly to override.
  const statusText = seeded?.statusText ?? HTTP_REASON[status] ?? '';
  // ok can be overridden explicitly; defaults to 2xx range check.
  const ok = seeded?.ok ?? (status >= 200 && status < 300);

  // Record before returning so assertions see calls even on error paths.
  if (!captured.has(scenarioId)) {
    captured.set(scenarioId, []);
  }
  captured.get(scenarioId)!.push({
    url,
    method: init?.method ?? 'GET',
    // new Headers() normalises header names to lowercase — mirrors real HTTP behaviour.
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: (init?.body as string) ?? '',
    owned: false,
  });

  return { ok, status, statusText } as unknown as Response;
};
