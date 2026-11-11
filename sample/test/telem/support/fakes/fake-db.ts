/**
 * In-memory fake of the database layer (src/db/*), injected into require.cache at the repository
 * seam: dist/db/subscribers, dist/db/deliveryLog, dist/db/topicFlags and dist/db/index. See world.ts.
 *
 * Why the repositories and not the mysql2 driver: emulating SQL (parsing query strings, collations,
 * constraints) is impractical, so the repository is the fake boundary and the driver is left as a
 * throw-on-use safety net. The price is that the SQL in src/db/* never runs under BDD — the parity
 * suite (parity-tests/fake-db.parity.ts) is what keeps this fake honest by running the real
 * repositories against a real MySQL 8 and comparing results. Every behaviour below that is a MySQL
 * behaviour rather than app logic (collation, constraints, auto-increment, JSON columns) is pinned there.
 *
 * Two structures per scenario, kept apart on purpose:
 *   - durable rows (what reads see; changed only by a SUCCESSFUL write)
 *   - the ownership log (every write the app attempted; a later delete never rewrites it, so it can't hide
 *     an unowned write from the safety net). A write that throws — an injected fail() or a MySQL constraint —
 *     is recorded first, in `failedWrites`, then rethrown: the app still tried to write it.
 */

import type { Subscriber } from '../../../../src/db/subscribers';
import type { DeliveryAttempt } from '../../../../src/db/deliveryLog';
import type { TopicFlag } from '../../../../src/db/topicFlags';
import { currentScenarioId } from '../scenario-context';
import { registerFake } from '../fake-registry';

export type { DeliveryAttempt };

// ---- Types ----

interface SubscriberRow {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: unknown; // the JSON column as mysql2 returns it (see asJsonColumn)
  created_at: Date;
}

interface TopicFlagRow {
  topic: string;
  blocked: boolean;
}

interface CapturedCreate {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: unknown;
  owned: boolean;
}

interface CapturedRemove {
  id: number;
  affectedRows: number;
  owned: boolean;
}

interface CapturedDeliveryLog extends DeliveryAttempt {
  owned: boolean;
}

interface CapturedTopicFlagUpsert {
  topic: string;
  blocked: boolean;
  owned: boolean;
}

/** The four repository writes. Reads are inputs: a failed read is not recorded. */
export const DB_WRITE_OPERATIONS = ['subscribers.create', 'subscribers.remove', 'deliveryLog.logAttempt', 'topicFlags.upsert'] as const;
export type DbWriteOperation = (typeof DB_WRITE_OPERATIONS)[number];

/** A write that threw: what the app asked to write, and the error it got back. */
export interface FailedWrite {
  operation: DbWriteOperation;
  args: Record<string, unknown>;
  error: { message: string; code?: string };
}

interface CapturedFailedWrite extends FailedWrite {
  owned: boolean;
}

interface ScenarioState {
  // durable
  subscribers: SubscriberRow[];
  topicFlags: TopicFlagRow[];
  autoIncrement: number; // next subscribers.id, like MySQL AUTO_INCREMENT (survives deletes)
  // ownership log
  creates: CapturedCreate[];
  removes: CapturedRemove[];
  deliveryLogs: CapturedDeliveryLog[];
  topicFlagUpserts: CapturedTopicFlagUpsert[];
  failedWrites: CapturedFailedWrite[];
}

// Deterministic created_at for rows written through subscribers.create (MySQL: DEFAULT CURRENT_TIMESTAMP).
// Distinct from the seed constants so list assertions can tell seeded from created rows.
export const FAKE_INSERT_CREATED_AT = new Date('2024-01-01T12:00:00.000Z');
export const FAKE_INSERT_CREATED_AT_ISO = FAKE_INSERT_CREATED_AT.toISOString();
// created_at for a seeded row whose Given doesn't pin one — fixed, so a listing stays deterministic.
export const FAKE_SEED_CREATED_AT = new Date('2024-01-01T00:00:00.000Z');

const states = new Map<string, ScenarioState>();

function getState(scenarioId: string): ScenarioState {
  let state = states.get(scenarioId);
  if (!state) {
    state = {
      subscribers: [],
      topicFlags: [],
      autoIncrement: 1,
      creates: [],
      removes: [],
      deliveryLogs: [],
      topicFlagUpserts: [],
      failedWrites: [],
    };
    states.set(scenarioId, state);
  }
  return state;
}

function safeClone<T>(value: T, context: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(
      `[fake-db] structuredClone failed in ${context} on value of type ${typeof value}. ` +
        'Probable cause: the value contains non-cloneable members (functions, Symbols). ' +
        'Fix: pass plain data.',
    );
  }
}

// ---- MySQL behaviours the fake has to reproduce (each is pinned by the parity suite) ----

// Tables are created without an explicit collation, so they get the MySQL 8 default,
// utf8mb4_0900_ai_ci: accent- and case-insensitive. It governs `WHERE topic = ?`, DISTINCT,
// ORDER BY and the topic_flags primary key. ICU's 'base' sensitivity approximates it.
const collator = new Intl.Collator('en', { sensitivity: 'base' });
const sameTopic = (a: string, b: string): boolean => collator.compare(a, b) === 0;

// mysql2 error shape: callers see code/errno/sqlState (message text is MySQL's).
function mysqlError(code: string, errno: number, sqlState: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno, sqlState, sqlMessage: message });
}

// VARCHAR(n) counts characters (code points), not UTF-16 units; strict mode rejects overflow.
function assertFits(column: string, value: unknown, max: number): void {
  if (value !== null && value !== undefined && [...String(value)].length > max) {
    throw mysqlError('ER_DATA_TOO_LONG', 1406, '22001', `Data too long for column '${column}' at row 1`);
  }
}

// A scalar placeholder as a text column stores it: true → '1', 42 → '42', a plain object → '[object Object]'.
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * Bind `INSERT … VALUES (?, ?, …)` the way mysql2 query() does. req.body is JSON, so a "string" field can be
 * any JSON value: an array placeholder expands into a value list and a nested array into a row. These are
 * statement-level errors, so they come before any column check.
 */
function bindInsertValues(values: unknown[]): Array<string | null> {
  const items = values.map((v) => (Array.isArray(v) ? (v as unknown[]) : [v]));
  if (items.some((i) => i.length === 0)) {
    // MySQL quotes the rest of the statement in this message; parity compares only the code.
    throw mysqlError('ER_PARSE_ERROR', 1064, '42000', 'You have an error in your SQL syntax (empty value list)');
  }
  if (items.reduce((n, i) => n + i.length, 0) !== values.length) {
    throw mysqlError('ER_WRONG_VALUE_COUNT_ON_ROW', 1136, '21S01', "Column count doesn't match value count at row 1");
  }
  const singles = items.map((i) => i[0]);
  if (singles.some((v) => Array.isArray(v) && v.length !== 1)) {
    throw mysqlError('ER_OPERAND_COLUMNS', 1241, '21000', 'Operand should contain 1 column(s)');
  }
  return singles.map((v) => asText(Array.isArray(v) ? v[0] : v));
}

function assertNotNull(column: string, value: unknown): void {
  if (value === null || value === undefined) {
    throw mysqlError('ER_BAD_NULL_ERROR', 1048, '23000', `Column '${column}' cannot be null`);
  }
}

// What mysql2 hands back for a JSON column written as JSON.stringify(value): any JSON value (a string stays a
// string), undefined values dropped, and object keys re-ordered the way MySQL stores them — shorter first, then bytewise.
function asJsonColumn(value: unknown): unknown {
  const byMysqlKeyOrder = (a: string, b: string) =>
    Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalise);
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort(byMysqlKeyOrder).map((k) => [k, normalise(o[k])]));
  };
  return normalise(JSON.parse(JSON.stringify(value)));
}

// src/db/subscribers parseRow(): a JSON column that holds a string is JSON.parse'd again (so "abc" throws).
const parseHeaders = (stored: unknown): Record<string, string> =>
  (typeof stored === 'string' ? JSON.parse(stored) : stored) as Record<string, string>;

const DELIVERY_STATUSES =['success', 'failed', 'exhausted', 'blocked'];

// ---- Failure injection: fail(scenarioId, operation, sequence) ----
// Each repository function is a declared "operation". fail() targets one by name — a typo throws at
// setup — with a per-call `sequence` of outcomes (an Error/zero-arg factory to throw, or null to
// succeed) advanced one entry per call, the last entry repeating past the end
// ([err] = always fails, [err, null] = fail-once-then-recover). A whole-database outage is
// failAllDb, which names every operation rather than relying on a hidden default.

export const DB_OPERATIONS = [
  'db.ping', // db/index ping() — the /health connectivity probe
  'subscribers.listAll',
  'subscribers.findByTopic',
  'subscribers.findDistinctTopics',
  'subscribers.create',
  'subscribers.remove',
  'deliveryLog.logAttempt',
  'topicFlags.getAll',
  'topicFlags.upsert',
  'pool.query', // getPool().query() — only MySqlFlagsProvider's cache load, and only in enableTopicFlagsPool() scenarios
] as const;
export type DbOperation = (typeof DB_OPERATIONS)[number];

type Outcome = Error | (() => Error) | null;
interface FailState {
  sequence: Outcome[];
  index: number;
}
const failConfig = new Map<string, Map<DbOperation, FailState>>();

/**
 * Make a named repository operation fail for this scenario.
 *
 * @example — only delivery_log writes fail:
 * fail(this.scenarioId, 'deliveryLog.logAttempt', [new Error('connection lost')]);
 */
export function fail(scenarioId: string, operation: DbOperation, sequence: Outcome[]): void {
  if (!(DB_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(
      `[fake-db] Unknown operation "${operation}" passed to fail(). ` +
        `Declared operations: ${DB_OPERATIONS.join(', ')}. ` +
        'Fix: use one of the declared operation names (this catches typos at setup).',
    );
  }
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(
      `[fake-db] fail() sequence for "${operation}" must be a non-empty array of Error|null. ` +
        'Fix: pass e.g. [new Error(...)] to always fail, or [new Error(...), null] to fail once then recover.',
    );
  }
  if (!failConfig.has(scenarioId)) failConfig.set(scenarioId, new Map());
  failConfig.get(scenarioId)!.set(operation, { sequence, index: 0 });
}

/** Fail every declared operation — models a whole-database outage ("the database is unavailable"). */
export function failAllDb(scenarioId: string, sequence: Outcome[]): void {
  for (const op of DB_OPERATIONS) fail(scenarioId, op, sequence);
}

/**
 * Run a repository write: injected failure first (like the driver call failing), then the body (constraint
 * checks + the write). Whatever throws is recorded as a failed write before it propagates.
 */
function write<T>(sid: string, operation: DbWriteOperation, args: Record<string, unknown>, body: () => T): T {
  try {
    maybeFail(sid, operation);
    return body();
  } catch (err) {
    const { message, code } = err as Error & { code?: string };
    getState(sid).failedWrites.push({
      operation,
      args: safeClone(args, `${operation} (failed)`),
      error: code === undefined ? { message } : { message, code },
      owned: false,
    });
    throw err;
  }
}

/** Advance this operation's sequence one step and throw if the current outcome is an error. */
function maybeFail(scenarioId: string, operation: DbOperation): void {
  const fs = failConfig.get(scenarioId)?.get(operation);
  if (!fs) return;
  const o = fs.sequence[Math.min(fs.index, fs.sequence.length - 1)];
  fs.index++;
  if (o === null) return;
  throw typeof o === 'function' ? o() : o;
}

// ---- Seeding (pre-existing durable data — no IO event, so nothing to own) ----

export function seedSubscribers(
  scenarioId: string,
  rows: Array<{
    id: number;
    name: string;
    topic: string;
    url: string;
    headers: string | Record<string, string>; // a JSON string is parsed, as the column would be
    created_at?: Date;
  }>,
): void {
  const state = getState(scenarioId);
  for (const row of rows) {
    if (state.subscribers.some((s) => s.id === row.id)) {
      throw new Error(
        `[fake-db] seedSubscribers: id ${row.id} is already seeded in scenario ${scenarioId}. ` +
          'Probable cause: two Given steps seed the same subscriber id. Fix: use distinct ids.',
      );
    }
    state.subscribers.push({
      id: row.id,
      name: row.name,
      topic: row.topic,
      url: row.url,
      headers: asJsonColumn(typeof row.headers === 'string' ? (JSON.parse(row.headers) as Record<string, string>) : row.headers),
      created_at: row.created_at ?? FAKE_SEED_CREATED_AT,
    });
    state.autoIncrement = Math.max(state.autoIncrement, row.id + 1); // explicit ids move the counter, like MySQL
  }
}

/** Pre-populate topic_flags without a PATCH. Upsert semantics: same topic (per collation) updates in place. */
export function seedTopicFlags(
  scenarioId: string,
  rows: Array<{ topic: string; blocked: boolean }>,
): void {
  const state = getState(scenarioId);
  for (const row of rows) {
    const existing = state.topicFlags.find((r) => sameTopic(r.topic, row.topic));
    if (existing) existing.blocked = row.blocked;
    else state.topicFlags.push({ topic: row.topic, blocked: row.blocked });
  }
}

/** Establish "the topic_flags row was deleted out-of-band" (no API deletes one) without recording IO. */
export function removeTopicFlagFromState(scenarioId: string, topic: string): void {
  const state = getState(scenarioId);
  state.topicFlags = state.topicFlags.filter((r) => !sameTopic(r.topic, topic));
}

/**
 * Whether a topic is blocked, as the real MySqlFlagsProvider would answer it: its cache is a JS Map
 * keyed by the stored topic string, so the lookup is exact-case (unlike the table's own collation).
 * Used by fake-openfeature, which stands in for the SDK + provider. Reading is not an IO event.
 */
export function peekTopicFlagBlocked(scenarioId: string, topic: string): boolean {
  return peekTopicFlag(scenarioId, topic) === true;
}

/** The stored blocked value for a topic, or undefined when it has no row (unmanaged) — the SDK then answers with its caller's default. */
export function peekTopicFlag(scenarioId: string, topic: string): boolean | undefined {
  return states.get(scenarioId)?.topicFlags.find((r) => r.topic === topic)?.blocked;
}

// ---- Ownership ----

/**
 * Claim the unowned subscribers.create for a specific URL and return what was created.
 * Requires the URL (a concrete identifier the caller submitted) rather than "the next" create —
 * a claim-next sweep silently absorbs the wrong write in a multi-POST scenario.
 */
export function takeOwnershipOfSubscriberCreate(
  scenarioId: string,
  url: string,
): { id: number; name: string; topic: string; url: string; headers: Record<string, string> } {
  const state = getState(scenarioId);
  const unowned = state.creates.find((c) => !c.owned && c.url === url);
  if (!unowned) {
    throw new Error(
      `[fake-db] No unowned subscribers.create for url "${url}" in scenario ${scenarioId}. ` +
        'Probable cause: the POST /api/subscribers request was never made, the submitted URL differs, or the create was already claimed. ' +
        'Fix: add a When step that POSTs to /api/subscribers with this URL, and claim it with the same URL.',
    );
  }
  unowned.owned = true;
  return safeClone(
    { id: unowned.id, name: unowned.name, topic: unowned.topic, url: unowned.url, headers: unowned.headers as Record<string, string> },
    'takeOwnershipOfSubscriberCreate',
  );
}

/**
 * Topics of the subscribers this scenario CREATED (POST path; seeded rows are not creates), in creation order,
 * duplicates included. A read of what the repository was asked to write — like the driver's input record in
 * fake-kafka — not an ownership claim: it lets an auto-default work out which topics the Kafka consumer
 * must have been subscribed to.
 */
export function listCreatedSubscriberTopics(scenarioId: string): string[] {
  return getState(scenarioId).creates.map((c) => c.topic);
}

/** Claim the unowned subscribers.remove for a specific subscriber id. */
export function takeOwnershipOfSubscriberRemove(scenarioId: string, id: number): { affectedRows: number } {
  const state = getState(scenarioId);
  const unowned = state.removes.find((d) => d.id === id && !d.owned);
  if (!unowned) {
    throw new Error(
      `[fake-db] No unowned subscribers.remove for id=${id} in scenario ${scenarioId}. ` +
        'Probable cause: the DELETE /api/subscribers/:id request was never made, the id differs, or the remove was already claimed. ' +
        'Fix: ensure the When step calls DELETE, and call takeOwnershipOfSubscriberRemove() with the same id.',
    );
  }
  unowned.owned = true;
  return { affectedRows: unowned.affectedRows };
}

/**
 * Claim all unowned deliveryLog.logAttempt rows for one subscriber. Per-subscriber so a mixed
 * fan-out (one subscriber succeeds, another fails) can assert each outcome independently.
 */
export function takeOwnershipOfDeliveryLogsForSubscriber(
  scenarioId: string,
  subscriberId: number,
): DeliveryAttempt[] {
  const state = getState(scenarioId);
  const unowned = state.deliveryLogs.filter((d) => !d.owned && d.subscriber_id === subscriberId);
  if (unowned.length === 0) {
    throw new Error(
      `[fake-db] No unowned delivery log entries for subscriber ${subscriberId} in scenario ${scenarioId}. ` +
        'Probable cause: no delivery was logged for this subscriber, or all entries were already claimed. ' +
        'Fix: verify the Kafka message topic matches this subscriber and the delivery completed.',
    );
  }
  for (const entry of unowned) entry.owned = true;
  return unowned.map(({ owned: _owned, ...rest }) => safeClone(rest, 'takeOwnershipOfDeliveryLogsForSubscriber'));
}

/** Claim the unowned topicFlags.upsert for a specific topic (exactly as the caller spelled it). */
export function takeOwnershipOfTopicFlagsUpsert(
  scenarioId: string,
  topic: string,
): { topic: string; blocked: boolean } {
  const state = getState(scenarioId);
  const unowned = state.topicFlagUpserts.find((u) => u.topic === topic && !u.owned);
  if (!unowned) {
    throw new Error(
      `[fake-db] No unowned topicFlags.upsert for topic "${topic}" in scenario ${scenarioId}. ` +
        'Probable cause: the PATCH handler did not upsert this topic, or the upsert was already claimed. ' +
        'Fix: verify the PATCH handler calls topicFlags.upsert() for the correct topic; confirm no prior Then step already claimed it.',
    );
  }
  unowned.owned = true;
  return { topic: unowned.topic, blocked: unowned.blocked };
}

/**
 * Claim every unowned failed write of one operation, in the order attempted, and return copies. Throws if
 * there is none. A failure scenario owns the write the app attempted exactly like a successful one.
 */
export function takeOwnershipOfFailedWrites(scenarioId: string, operation: DbWriteOperation): FailedWrite[] {
  const unowned = getState(scenarioId).failedWrites.filter((w) => !w.owned && w.operation === operation);
  if (unowned.length === 0) {
    throw new Error(
      `[fake-db] No unowned failed ${operation} in scenario ${scenarioId}. ` +
        'Probable cause: the write succeeded, was never attempted, or this failure was already claimed. ' +
        'Fix: check the fail() / failAllDb() Given and that the flow reaches this write.',
    );
  }
  for (const w of unowned) w.owned = true;
  return unowned.map(({ owned: _owned, ...rest }) => safeClone(rest, 'takeOwnershipOfFailedWrites'));
}

// ---- Fake registry interface ----

export function throwIfUnownedExist(scenarioId: string): void {
  const state = states.get(scenarioId);
  if (!state) return;

  const msgs: string[] = [];
  const unownedCreates = state.creates.filter((c) => !c.owned);
  const unownedRemoves = state.removes.filter((d) => !d.owned);
  const unownedLogs = state.deliveryLogs.filter((d) => !d.owned);
  const unownedUpserts = state.topicFlagUpserts.filter((u) => !u.owned);
  const unownedFailed = state.failedWrites.filter((w) => !w.owned);

  if (unownedCreates.length > 0) msgs.push(`${unownedCreates.length} subscriber insert(s) (subscribers.create)`);
  if (unownedRemoves.length > 0) msgs.push(`${unownedRemoves.length} subscriber delete(s) (subscribers.remove)`);
  if (unownedLogs.length > 0) msgs.push(`${unownedLogs.length} delivery log(s) (deliveryLog.logAttempt)`);
  if (unownedUpserts.length > 0) msgs.push(`${unownedUpserts.length} topic_flags upsert(s) (topicFlags.upsert)`);
  if (unownedFailed.length > 0) {
    msgs.push(`${unownedFailed.length} failed write(s) (${[...new Set(unownedFailed.map((w) => w.operation))].join(', ')} — claim with takeOwnershipOfFailedWrites)`);
  }

  if (msgs.length > 0) {
    throw new Error(
      `[fake-db] Unowned database IO in scenario ${scenarioId}: ${msgs.join(', ')}. ` +
        'Probable cause: the scenario executed database writes that no Then step asserted on. ' +
        'Fix: add Then steps that call takeOwnershipOfSubscriberCreate(), takeOwnershipOfSubscriberRemove(), ' +
        'takeOwnershipOfDeliveryLogsForSubscriber(), takeOwnershipOfTopicFlagsUpsert() and/or (for a write that threw) ' +
        'takeOwnershipOfFailedWrites() to claim and verify the unowned IO.',
    );
  }
}

export function cleanup(scenarioId: string): void {
  states.delete(scenarioId);
  failConfig.delete(scenarioId);
  topicFlagsPoolScenarios.delete(scenarioId);
}

// ---- The pool, for the one caller that bypasses the repositories ----
// MySqlFlagsProvider loads its cache with getPool().query() instead of topicFlags.getAll(). A scenario
// that runs the real provider (fake-openfeature useRealFlagsProvider) opts in here; getPool() then hands
// it a pool that answers exactly that query from this scenario's topic_flags rows and rejects any other
// SQL, so the safety net below still catches any new direct-pool caller. Everyone else still gets the throw.

const topicFlagsPoolScenarios = new Set<string>();

export function enableTopicFlagsPool(scenarioId: string): void {
  topicFlagsPoolScenarios.add(scenarioId);
}

const PROVIDER_CACHE_SQL = 'SELECT topic, blocked FROM topic_flags';

const topicFlagsPool = {
  /**
   * mysql2 `pool.query(sql)` for the provider's cache load. Documented behaviour reproduced:
   *  - resolves `[rows, fields]`; TINYINT(1) `blocked` arrives as a number 0/1, not a boolean;
   *  - no ORDER BY, so row order is unspecified (the provider puts rows in a Map, so order is unobservable).
   * Injection: fail(sid, 'pool.query', [...]) rejects the call, as a lost connection would.
   * Provenance: compared with the real pool.query on MySQL 8 in parity-tests/fake-db.parity.ts
   * ("pool.query — the flag provider's cache load returns every row with blocked as 0/1").
   */
  async query(sql: string): Promise<[Array<{ topic: string; blocked: number }>, unknown[]]> {
    const sid = currentScenarioId();
    if (sql.replace(/\s+/g, ' ').trim() !== PROVIDER_CACHE_SQL) {
      throw new Error(
        `[fake-db] The BDD pool only answers "${PROVIDER_CACHE_SQL}" (MySqlFlagsProvider's cache load), got: ${sql}. ` +
          'Probable cause: new production code queries the pool directly. Fix: route it through a repository, or fake the new query.',
      );
    }
    maybeFail(sid, 'pool.query');
    // TINYINT(1) comes back from mysql2 as a number, not a boolean — the provider maps it with `=== 1`.
    return [getState(sid).topicFlags.map((r) => ({ topic: r.topic, blocked: r.blocked ? 1 : 0 })), []];
  },
};

// ---- The repositories (shapes match src/db/*.ts exactly) ----

const toSubscriber = (row: SubscriberRow): Subscriber => {
  const copy = safeClone(row, 'subscribers read');
  return { ...copy, headers: parseHeaders(copy.headers) };
};

export const subscribersFake = {
  /**
   * `SELECT … FROM subscribers ORDER BY id`. Documented behaviour reproduced: id order; headers as mysql2 parses the
   * JSON column, then parseRow (a stored string is JSON.parsed again and can throw); created_at a Date.
   * Injection: fail(sid, 'subscribers.listAll', [...]). Provenance: parity-tests/fake-db.parity.ts ("subscribers.listAll — …").
   */
  async listAll(): Promise<Subscriber[]> {
    const sid = currentScenarioId();
    maybeFail(sid, 'subscribers.listAll');
    return [...getState(sid).subscribers].sort((a, b) => a.id - b.id).map(toSubscriber); // ORDER BY id
  },

  /**
   * `WHERE topic = ?` under utf8mb4_0900_ai_ci. Documented behaviour reproduced: case- and accent-insensitive
   * (`ORDERS`, `ördérs` match `orders`), trailing space significant, LIKE wildcards literal, rows by id.
   * Injection: fail(sid, 'subscribers.findByTopic', [...]). Provenance: parity-tests/fake-db.parity.ts ("subscribers.findByTopic — …").
   */
  async findByTopic(topic: string): Promise<Subscriber[]> {
    const sid = currentScenarioId();
    maybeFail(sid, 'subscribers.findByTopic');
    // No ORDER BY in SQL; the topic index yields (topic, id) order, so equal topics come back by id.
    return getState(sid)
      .subscribers.filter((s) => sameTopic(s.topic, topic))
      .sort((a, b) => a.id - b.id)
      .map(toSubscriber);
  },

  /**
   * `SELECT DISTINCT topic`. Documented behaviour reproduced: collation-equal spellings collapse to the lowest id's,
   * in collation order. Injection: fail(sid, 'subscribers.findDistinctTopics', [...]).
   * Provenance: parity-tests/fake-db.parity.ts ("subscribers.findDistinctTopics — …").
   */
  async findDistinctTopics(): Promise<string[]> {
    const sid = currentScenarioId();
    maybeFail(sid, 'subscribers.findDistinctTopics');
    // DISTINCT walks the topic index: collation order, and among spellings that collate equal the
    // first row by id represents the group.
    const byIndexOrder = [...getState(sid).subscribers].sort(
      (a, b) => collator.compare(a.topic, b.topic) || a.id - b.id,
    );
    const distinct: string[] = [];
    for (const s of byIndexOrder) {
      if (!distinct.some((t) => sameTopic(t, s.topic))) distinct.push(s.topic);
    }
    return distinct;
  },

  /**
   * `INSERT INTO subscribers … VALUES (?, ?, ?, ?)` via mysql2 query(). Documented behaviour reproduced: placeholder
   * binding (scalars as text, arrays expanded — bindInsertValues), NOT NULL, VARCHAR limits by character, headers
   * stored as JSON, AUTO_INCREMENT ids (a rejected insert consumes none); returns the input as-is with the new id.
   * Every attempt is recorded (a failed one in failedWrites). Injection: fail(sid, 'subscribers.create', [...]).
   * Provenance: parity-tests/fake-db.parity.ts ("subscribers.create — …").
   */
  async create({
    name,
    topic,
    url,
    headers = {},
  }: {
    name: string;
    topic: string;
    url: string;
    headers?: Record<string, string>;
  }): Promise<Omit<Subscriber, 'created_at'>> {
    const sid = currentScenarioId();
    return write(sid, 'subscribers.create', { name, topic, url, headers }, () => {
      const [nameText, topicText, urlText] = bindInsertValues([name, topic, url, JSON.stringify(headers)]);
      assertNotNull('name', nameText);
      assertNotNull('topic', topicText);
      assertNotNull('url', urlText);
      assertFits('name', nameText, 255);
      assertFits('topic', topicText, 255);
      assertFits('url', urlText, 2048);
      const state = getState(sid);
      const id = state.autoIncrement++;
      // Rows hold what the columns hold (text, JSON); create() itself returns the input as-is.
      const row = { id, name: nameText!, topic: topicText!, url: urlText!, headers: asJsonColumn(headers) };
      state.subscribers.push({ ...row, created_at: FAKE_INSERT_CREATED_AT });
      state.creates.push({ ...safeClone(row, 'subscribers.create'), owned: false });
      return safeClone({ id, name, topic, url, headers }, 'subscribers.create');
    });
  },

  /**
   * `DELETE FROM subscribers WHERE id = ?`. Documented behaviour reproduced: affectedRows 1 for a hit, 0 for a missing,
   * zero or negative id. The attempt is recorded either way. Injection: fail(sid, 'subscribers.remove', [...]).
   * Provenance: parity-tests/fake-db.parity.ts ("subscribers.remove — …").
   */
  async remove(id: number): Promise<number> {
    const sid = currentScenarioId();
    return write(sid, 'subscribers.remove', { id }, () => {
      const state = getState(sid);
      const affectedRows = state.subscribers.some((s) => s.id === id) ? 1 : 0;
      // delivery_log's ON DELETE CASCADE is not modelled: nothing in the app reads delivery_log back, so the
      // cascade can't change any app behaviour. The FK itself (logAttempt for a missing subscriber) is.
      state.subscribers = state.subscribers.filter((s) => s.id !== id);
      state.removes.push({ id, affectedRows, owned: false });
      return affectedRows;
    });
  },
};

export const deliveryLogFake = {
  /**
   * `INSERT INTO delivery_log …`. Documented behaviour reproduced: undefined → NULL for the nullable columns, NOT NULL
   * payload/subscriber_id, VARCHAR(255) message_key by character, the status ENUM, the subscribers foreign key.
   * Every attempt is recorded (a failed one in failedWrites). Injection: fail(sid, 'deliveryLog.logAttempt', [...]).
   * Provenance: parity-tests/fake-db.parity.ts ("deliveryLog.logAttempt — …").
   */
  async logAttempt({
    subscriber_id,
    message_key,
    payload,
    attempt_number,
    status,
    http_status,
    error_message,
  }: DeliveryAttempt): Promise<void> {
    const sid = currentScenarioId();
    // The repository normalises undefined → NULL for the three nullable columns.
    const row: DeliveryAttempt = {
      subscriber_id,
      message_key: message_key ?? null,
      payload,
      attempt_number,
      status,
      http_status: http_status ?? null,
      error_message: error_message ?? null,
    };
    write(sid, 'deliveryLog.logAttempt', { ...row }, () => {
      const state = getState(sid);
      assertNotNull('payload', row.payload);
      assertNotNull('subscriber_id', row.subscriber_id);
      assertFits('message_key', row.message_key, 255);
      if (!DELIVERY_STATUSES.includes(row.status)) {
        throw mysqlError('WARN_DATA_TRUNCATED', 1265, '01000', `Data truncated for column 'status' at row 1`);
      }
      if (!state.subscribers.some((s) => s.id === row.subscriber_id)) {
        throw mysqlError(
          'ER_NO_REFERENCED_ROW_2',
          1452,
          '23000',
          'Cannot add or update a child row: a foreign key constraint fails ' +
            '(`webhooks`.`delivery_log`, CONSTRAINT `delivery_log_ibfk_1` FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers` (`id`) ON DELETE CASCADE)',
        );
      }
      state.deliveryLogs.push({ ...row, owned: false });
    });
  },
};

export const topicFlagsFake = {
  /**
   * `SELECT topic, blocked FROM topic_flags ORDER BY topic`. Documented behaviour reproduced: collation order,
   * TINYINT(1) mapped to a boolean, a `__proto__` topic returned as an ordinary row.
   * Injection: fail(sid, 'topicFlags.getAll', [...]). Provenance: parity-tests/fake-db.parity.ts ("topicFlags.getAll — …").
   */
  async getAll(): Promise<TopicFlag[]> {
    const sid = currentScenarioId();
    maybeFail(sid, 'topicFlags.getAll');
    return [...getState(sid).topicFlags]
      .sort((a, b) => collator.compare(a.topic, b.topic)) // ORDER BY topic
      .map((r) => safeClone(r, 'topicFlags.getAll'));
  },

  /**
   * `INSERT … ON DUPLICATE KEY UPDATE blocked`. Documented behaviour reproduced: a collation-equal spelling updates
   * the existing row and keeps its first spelling; a topic over 255 characters is ER_DATA_TOO_LONG. Every attempt is
   * recorded (a failed one in failedWrites). Injection: fail(sid, 'topicFlags.upsert', [...]).
   * Provenance: parity-tests/fake-db.parity.ts ("topicFlags.upsert — …").
   */
  async upsert(topic: string, blocked: boolean): Promise<void> {
    const sid = currentScenarioId();
    write(sid, 'topicFlags.upsert', { topic, blocked }, () => {
      assertFits('topic', topic, 255);
      const state = getState(sid);
      // PRIMARY KEY (topic) under the ai_ci collation: a differently-cased spelling is the same row,
      // and ON DUPLICATE KEY UPDATE only touches `blocked`, so the first spelling stays.
      const existing = state.topicFlags.find((r) => sameTopic(r.topic, topic));
      if (existing) existing.blocked = blocked;
      else state.topicFlags.push({ topic, blocked });
      state.topicFlagUpserts.push({ topic, blocked, owned: false });
    });
  },
};

// db/index: there is no pool in BDD — the repositories are faked above it, so nothing may reach for one.
export const dbIndexFake = {
  async connect(): Promise<void> {
    // Production verifies connectivity at startup; nothing to connect to here.
  },
  /**
   * db/index getPool(). In a scenario that called enableTopicFlagsPool() it returns the provider-only pool above;
   * everywhere else it throws, because BDD fakes the repositories, not the driver.
   */
  getPool(): typeof topicFlagsPool {
    if (topicFlagsPoolScenarios.has(currentScenarioId())) return topicFlagsPool;
    throw new Error(
      '[fake-db] getPool() was called, but BDD fakes the repositories, not the mysql2 pool. ' +
        'Probable cause: production code bypasses src/db/* and queries the pool directly (MySqlFlagsProvider does; flag-provider.feature opts in via enableTopicFlagsPool). ' +
        'Fix: route the access through a repository, or fake the new boundary.',
    );
  },
  async ping(): Promise<void> {
    maybeFail(currentScenarioId(), 'db.ping');
  },
  async close(): Promise<void> {},
};

// Safety net for the real driver: nothing should ever construct a pool.
export const mysql2SafetyNet = {
  createPool(): never {
    throw new Error(
      '[fake-db] mysql2.createPool() was called under BDD. ' +
        'Probable cause: dist/db/index was loaded for real instead of the fake. ' +
        'Fix: check the require.cache seeds in world.ts happen before the app loads.',
    );
  },
};

registerFake({ name: 'db', throwIfUnownedExist, cleanup });
