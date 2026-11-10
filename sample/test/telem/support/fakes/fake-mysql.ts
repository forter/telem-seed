/**
 * In-memory MySQL fake — injected into require.cache as `mysql2/promise` before the app loads.
 * See world.ts for the injection pattern (no proxyquire @global — that bypasses cache).
 *
 * Query routing is SQL-prefix-based (mirrors production query strings exactly).
 * Per-scenario state is keyed by scenarioId; cleanup() wipes it after each scenario.
 */

import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

// ---- Types ----

export interface DeliveryAttempt {
  subscriber_id: number;
  message_key: string | null;
  payload: string;
  attempt_number: number;
  status: 'success' | 'failed' | 'exhausted' | 'blocked';
  http_status: number | null;
  error_message: string | null;
}

interface SubscriberSeedRow {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: string; // JSON string — parseRow() in the repo layer parses it
  created_at: Date;
}

interface CapturedInsert {
  insertId: number;
  name: string;
  topic: string;
  url: string;
  headers: string;
  owned: boolean;
}

interface CapturedDelete {
  id: number;
  affectedRows: number;
  owned: boolean;
}

interface CapturedDeliveryLog extends DeliveryAttempt {
  owned: boolean;
}

interface CapturedTopicFlagsUpsert {
  topic: string;
  blocked: number; // 0 or 1
  owned: boolean;
}

interface ScenarioState {
  subscribers: SubscriberSeedRow[];
  inserts: CapturedInsert[];
  deletes: CapturedDelete[];
  deliveryLogs: CapturedDeliveryLog[];
  topicFlags: { topic: string; blocked: number }[];
  topicFlagsUpserts: CapturedTopicFlagsUpsert[];
  nextInsertId: number;
}

// Deterministic created_at for rows written by POST (INSERT branch in routeQuery).
// Distinct from SEED_CREATED_AT (midnight) so list assertions can tell seeded from inserted rows.
export const FAKE_INSERT_CREATED_AT = new Date('2024-01-01T12:00:00.000Z');
export const FAKE_INSERT_CREATED_AT_ISO = FAKE_INSERT_CREATED_AT.toISOString();

const states = new Map<string, ScenarioState>();

// ---- Failure injection: fail(scenarioId, operation, sequence) ----
// Each production-facing DB operation the fake performs is a declared "operation". fail() targets one
// by name — a typo throws at setup — with a per-call `sequence` of outcomes (an Error/zero-arg factory
// to throw, or null to succeed) advanced one entry per call, the last entry repeating past the end
// ([err] = always fails, [err, null] = fail-once-then-recover). Replaces the old whole-fake
// `configureMysql({ shouldFail, onlyFor })`: `onlyFor` becomes the operation name, and a whole-database
// outage is expressed explicitly via failAllMysql (every operation named), not a hidden default.

export const MYSQL_OPERATIONS = [
  'ping', // SELECT 1 (health-check connectivity probe)
  'select-topics', // SELECT DISTINCT topic
  'select-subscribers', // SELECT ... FROM subscribers
  'insert-subscriber', // INSERT INTO subscribers
  'delete-subscriber', // DELETE FROM subscribers
  'insert-delivery-log', // INSERT INTO delivery_log
  'select-topic-flags', // SELECT topic, blocked FROM topic_flags
  'upsert-topic-flags', // INSERT INTO topic_flags ... ON DUPLICATE KEY UPDATE
] as const;
export type MysqlOperation = (typeof MYSQL_OPERATIONS)[number];

type Outcome = Error | (() => Error) | null;
interface FailState {
  sequence: Outcome[];
  index: number;
}
const failConfig = new Map<string, Map<MysqlOperation, FailState>>();

function resolveOutcome(o: Outcome): Error | null {
  if (o === null) return null;
  return typeof o === 'function' ? o() : o;
}

/**
 * Configure the MySQL fake to fail a named operation for this scenario.
 *
 * @param operation  A declared DB operation (see MYSQL_OPERATIONS). An unknown name throws here.
 * @param sequence   Per-call outcomes: an Error (or zero-arg factory) to throw, or null to succeed.
 *                   Advanced one entry per call; the last entry repeats ([err] = always fails).
 *
 * @example — only delivery_log writes fail:
 * fail(this.scenarioId, 'insert-delivery-log', [new Error('connection lost')]);
 */
export function fail(scenarioId: string, operation: MysqlOperation, sequence: Outcome[]): void {
  if (!(MYSQL_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(
      `[fake-mysql] Unknown operation "${operation}" passed to fail(). ` +
        `Declared operations: ${MYSQL_OPERATIONS.join(', ')}. ` +
        'Fix: use one of the declared operation names (this catches typos at setup).',
    );
  }
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-mysql] fail() sequence for "${operation}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(operation, { sequence, index: 0 });
}

/**
 * Fail every declared operation with the same sequence — models a whole-database outage
 * ("the database is unavailable"). Names every operation rather than relying on a whole-fake default.
 */
export function failAllMysql(scenarioId: string, sequence: Outcome[]): void {
  for (const op of MYSQL_OPERATIONS) fail(scenarioId, op, sequence);
}

/** Whether the next call to this operation is configured to throw (peek — does not advance). */
export function isConfiguredToFail(scenarioId: string, operation: MysqlOperation): boolean {
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return false;
  return fs.sequence[Math.min(fs.index, fs.sequence.length - 1)] !== null;
}

/** Advance this operation's sequence one step and throw if the current outcome is an error. */
function maybeFail(scenarioId: string, operation: MysqlOperation): void {
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return;
  const o = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  const err = resolveOutcome(o);
  if (err) throw err;
}

function getState(scenarioId: string): ScenarioState {
  let state = states.get(scenarioId);
  if (!state) {
    state = { subscribers: [], inserts: [], deletes: [], deliveryLogs: [], topicFlags: [], topicFlagsUpserts: [], nextInsertId: 1000 };
    states.set(scenarioId, state);
  }
  return state;
}

// ---- Seeding ----

export function seedSubscribers(
  scenarioId: string,
  rows: Array<{
    id: number;
    name: string;
    topic: string;
    url: string;
    headers: string | Record<string, string>;
    created_at?: Date;
  }>,
): void {
  const state = getState(scenarioId);
  for (const row of rows) {
    state.subscribers.push({
      id: row.id,
      name: row.name,
      topic: row.topic,
      url: row.url,
      // Auto-stringify so callers can pass either form
      headers: typeof row.headers === 'string' ? row.headers : JSON.stringify(row.headers),
      created_at: row.created_at ?? new Date(),
    });
  }
}

// ---- State manipulation ----

/**
 * Remove a subscriber from the in-memory store without recording a DELETE IO event.
 * Use in Given steps that need to establish "subscriber was previously deleted" state
 * without producing an unowned delete that the ownership safety net would flag.
 */
export function removeSubscriberFromState(scenarioId: string, id: number): void {
  const state = getState(scenarioId);
  const idx = state.subscribers.findIndex((s) => s.id === id);
  if (idx >= 0) state.subscribers.splice(idx, 1);
}

// ---- topic_flags seeding ----

/**
 * Pre-populate topic_flags state for a scenario without recording an IO event.
 * Use in Given steps that establish pre-existing flag state without issuing a PATCH.
 */
export function seedTopicFlags(
  scenarioId: string,
  rows: Array<{ topic: string; blocked: 0 | 1 }>,
): void {
  const state = getState(scenarioId);
  for (const row of rows) {
    const idx = state.topicFlags.findIndex((r) => r.topic === row.topic);
    if (idx >= 0) {
      state.topicFlags[idx].blocked = row.blocked;
    } else {
      state.topicFlags.push({ topic: row.topic, blocked: row.blocked });
    }
  }
}

/**
 * Read the current blocked state for a topic without claiming ownership.
 * Used by fake-openfeature to route isTopicBlocked() through MySQL fake state.
 */
export function peekTopicFlagBlocked(scenarioId: string, topic: string): boolean {
  const state = states.get(scenarioId);
  if (!state) return false;
  const row = state.topicFlags.find((r) => r.topic === topic);
  return row !== undefined && row.blocked === 1;
}

// ---- Ownership ----

/**
 * Claim the unowned subscriber INSERT for a specific URL and return it.
 * Requires the URL (a concrete identifier the caller submitted) rather than claiming "the next"
 * insert — a claim-next sweep silently absorbs the wrong insert in a multi-POST scenario
 * (the ownership-claim-integrity lint rule flags that).
 * Throws if no matching unowned insert exists.
 */
export function takeOwnershipOfSubscriberInsert(
  scenarioId: string,
  url: string,
): { id: number; name: string; topic: string; url: string; headers: string } {
  const state = getState(scenarioId);
  const unowned = state.inserts.find((i) => !i.owned && i.url === url);
  if (!unowned) {
    throw new Error(
      `[fake-mysql] No unowned subscriber insert for url "${url}" in scenario ${scenarioId}. ` +
        'Probable cause: the POST /api/subscribers request was never made, the submitted URL differs, or the insert was already claimed. ' +
        'Fix: add a When step that POSTs to /api/subscribers with this URL, and claim it with the same URL.',
    );
  }
  unowned.owned = true;
  return { id: unowned.insertId, name: unowned.name, topic: unowned.topic, url: unowned.url, headers: unowned.headers };
}

/**
 * Claim the unowned DELETE for a specific subscriber id.
 * Throws if no matching unowned delete exists.
 */
export function takeOwnershipOfSubscriberDelete(
  scenarioId: string,
  id: number,
): { affectedRows: number } {
  const state = getState(scenarioId);
  const unowned = state.deletes.find((d) => d.id === id && !d.owned);
  if (!unowned) {
    throw new Error(
      `[fake-mysql] No unowned subscriber delete for id=${id} in scenario ${scenarioId}. ` +
        'Probable cause: the DELETE /api/subscribers/:id request was never made, the id does not match a seeded subscriber, or the delete was already claimed. ' +
        'Fix: verify the id matches a seeded subscriber, ensure the When step calls DELETE, and call takeOwnershipOfSubscriberDelete() with the correct id.',
    );
  }
  unowned.owned = true;
  return { affectedRows: unowned.affectedRows };
}

/**
 * Return a snapshot of ALL delivery_log rows (owned and unowned) for a scenario.
 * Does not claim ownership. Use for negative assertions like "no log was written for subscriber N".
 */
export function peekAllDeliveryLogs(scenarioId: string): DeliveryAttempt[] {
  const state = states.get(scenarioId);
  if (!state) return [];
  return JSON.parse(JSON.stringify(state.deliveryLogs.map(({ owned: _owned, ...rest }) => rest))) as DeliveryAttempt[];
}

/**
 * Claim all unowned delivery_log rows for a specific subscriber and return them.
 * Use in multi-subscriber scenarios where different subscribers have different outcomes
 * and assertions need to target each subscriber's log rows independently.
 */
export function takeOwnershipOfDeliveryLogsForSubscriber(
  scenarioId: string,
  subscriberId: number,
): DeliveryAttempt[] {
  const state = getState(scenarioId);
  const unowned = state.deliveryLogs.filter((d) => !d.owned && d.subscriber_id === subscriberId);
  if (unowned.length === 0) {
    throw new Error(
      `[fake-mysql] No unowned delivery log entries for subscriber ${subscriberId} in scenario ${scenarioId}. ` +
        'Probable cause: no delivery was logged for this subscriber, or all entries were already claimed. ' +
        'Fix: verify the Kafka message topic matches this subscriber and the delivery completed.',
    );
  }
  for (const entry of unowned) {
    entry.owned = true;
  }
  return JSON.parse(JSON.stringify(unowned.map(({ owned: _owned, ...rest }) => rest))) as DeliveryAttempt[];
}

/**
 * Claim the unowned topic_flags upsert for a specific topic and return it.
 * Requires explicit topic identification — prevents "claim next" patterns that silently
 * absorb upserts to the wrong topic.
 * Throws if no matching unowned upsert exists.
 */
export function takeOwnershipOfTopicFlagsUpsert(
  scenarioId: string,
  topic: string,
): { topic: string; blocked: number } {
  const state = getState(scenarioId);
  const unowned = state.topicFlagsUpserts.find((u) => u.topic === topic && !u.owned);
  if (!unowned) {
    throw new Error(
      `[fake-mysql] No unowned topic_flags upsert for topic "${topic}" in scenario ${scenarioId}. ` +
        'Probable cause: the PATCH handler did not write to topic_flags for this topic, or the upsert was already claimed. ' +
        'Fix: verify the PATCH handler runs INSERT INTO topic_flags ... ON DUPLICATE KEY UPDATE for the correct topic; confirm no prior Then step already claimed it.',
    );
  }
  unowned.owned = true;
  return { topic: unowned.topic, blocked: unowned.blocked };
}

// ---- Fake registry interface ----

export function throwIfUnownedExist(scenarioId: string): void {
  const state = states.get(scenarioId);
  if (!state) return;

  const msgs: string[] = [];
  const unownedInserts = state.inserts.filter((i) => !i.owned);
  const unownedDeletes = state.deletes.filter((d) => !d.owned);
  const unownedLogs = state.deliveryLogs.filter((d) => !d.owned);
  const unownedUpserts = state.topicFlagsUpserts.filter((u) => !u.owned);

  if (unownedInserts.length > 0) msgs.push(`${unownedInserts.length} subscriber insert(s)`);
  if (unownedDeletes.length > 0) msgs.push(`${unownedDeletes.length} subscriber delete(s)`);
  if (unownedLogs.length > 0) msgs.push(`${unownedLogs.length} delivery log(s)`);
  if (unownedUpserts.length > 0) msgs.push(`${unownedUpserts.length} topic_flags upsert(s)`);

  if (msgs.length > 0) {
    throw new Error(
      `[fake-mysql] Unowned MySQL IO in scenario ${scenarioId}: ${msgs.join(', ')}. ` +
        'Probable cause: the scenario executed database writes that no Then step asserted on. ' +
        'Fix: add Then steps that call takeOwnershipOfSubscriberInsert(), takeOwnershipOfSubscriberDelete(), and/or takeOwnershipOfDeliveryLogsForSubscriber() to claim and verify the unowned IO.',
    );
  }
}

export function cleanup(scenarioId: string): void {
  states.delete(scenarioId);
  failConfig.delete(scenarioId);
}

// ---- Pool implementation ----

function routeQuery(sql: string, params?: unknown[]): [unknown, unknown] {
  // currentScenarioId() throws outside a scenario context — intentional
  const scenarioId = currentScenarioId();
  const state = getState(scenarioId);
  const trimmed = sql.trimStart();

  // SELECT 1 — health-check connectivity probe (src/db/index.ts ping()). Return value is ignored.
  if (trimmed.startsWith('SELECT 1')) {
    maybeFail(scenarioId, 'ping');
    return [[], {}];
  }

  // SELECT DISTINCT topic must come before the broader SELECT subscribers check
  if (trimmed.startsWith('SELECT DISTINCT topic')) {
    maybeFail(scenarioId, 'select-topics');
    const topics = [...new Set(state.subscribers.map((s) => s.topic))];
    return [topics.map((topic) => ({ topic })), {}];
  }

  if (trimmed.startsWith('SELECT') && trimmed.includes('FROM subscribers')) {
    maybeFail(scenarioId, 'select-subscribers');
    if (trimmed.includes('WHERE topic = ?') && Array.isArray(params) && params.length > 0) {
      const topic = params[0] as string;
      return [deepCopy(state.subscribers.filter((s) => s.topic === topic)), {}];
    }
    // ORDER BY id
    return [deepCopy([...state.subscribers].sort((a, b) => a.id - b.id)), {}];
  }

  if (trimmed.startsWith('INSERT INTO subscribers')) {
    // Guard before recording: a failed write is not persisted and — this repo having no
    // fallback-datastore pattern — is not logged as an ownable call, preserving the pre-fail() scope.
    maybeFail(scenarioId, 'insert-subscriber');
    const [name, topic, url, headers] = params as [string, string, string, string];
    const insertId = state.nextInsertId++;
    state.inserts.push({ insertId, name, topic, url, headers, owned: false });
    // Reflect the inserted row in subsequent SELECTs within the same scenario
    state.subscribers.push({ id: insertId, name, topic, url, headers, created_at: FAKE_INSERT_CREATED_AT });
    return [{ insertId }, {}];
  }

  if (trimmed.startsWith('DELETE FROM subscribers')) {
    maybeFail(scenarioId, 'delete-subscriber');
    const id = (params as [number])[0];
    const idx = state.subscribers.findIndex((s) => s.id === id);
    const affectedRows = idx >= 0 ? 1 : 0;
    if (idx >= 0) state.subscribers.splice(idx, 1);
    state.deletes.push({ id, affectedRows, owned: false });
    return [{ affectedRows }, {}];
  }

  if (trimmed.startsWith('INSERT INTO delivery_log')) {
    maybeFail(scenarioId, 'insert-delivery-log');
    const [subscriber_id, message_key, payload, attempt_number, status, http_status, error_message] =
      params as [number, string | null, string, number, 'success' | 'failed' | 'exhausted' | 'blocked', number | null, string | null];
    state.deliveryLogs.push({ subscriber_id, message_key, payload, attempt_number, status, http_status, error_message, owned: false });
    return [{}, {}];
  }

  if (trimmed.startsWith('SELECT topic, blocked FROM topic_flags')) {
    maybeFail(scenarioId, 'select-topic-flags');
    return [deepCopy(state.topicFlags), {}];
  }

  // INSERT INTO topic_flags (topic, blocked) VALUES (?, ?) ON DUPLICATE KEY UPDATE blocked = ?, ...
  if (trimmed.startsWith('INSERT INTO topic_flags')) {
    maybeFail(scenarioId, 'upsert-topic-flags');
    // params: [topic, blocked_insert, blocked_update] — blocked appears twice (INSERT + ON DUPLICATE KEY)
    const [topic, blocked] = params as [string, number, number];
    const idx = state.topicFlags.findIndex((r) => r.topic === topic);
    if (idx >= 0) {
      state.topicFlags[idx].blocked = blocked;
    } else {
      state.topicFlags.push({ topic, blocked });
    }
    state.topicFlagsUpserts.push({ topic, blocked, owned: false });
    return [{}, {}];
  }

  // Unknown SQL — return empty result set rather than crashing
  return [[], {}];
}

function createFakePool() {
  return {
    // Called by db/index.ts connect() to verify connectivity
    async getConnection() {
      return { release: () => {} };
    },
    async query(sql: string, params?: unknown[]) {
      return routeQuery(sql, params);
    },
    async execute(sql: string, params?: unknown[]) {
      return routeQuery(sql, params);
    },
    async end() {},
  };
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---- Export for require.cache injection ----
// world.ts injects this directly into require.cache['mysql2/promise'] before the app loads.
// Same pattern as kafkajs — both are cache-injected, no proxyquire. See world.ts for the rationale.
export const mysqlFake = {
  createPool: createFakePool,
};

registerFake({ name: 'mysql', throwIfUnownedExist, cleanup });
