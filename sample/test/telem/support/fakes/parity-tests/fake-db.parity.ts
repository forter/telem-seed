/**
 * Parity test: fake-db (fake repositories) vs the REAL repositories (src/db/*) on a real MySQL 8.
 *
 * STATUS: Covered — container-backed (compose.parity.yaml; run.sh brings it up). Skips, with a recorded
 * marker, when MySQL is unreachable (no Docker); there is no CI, so run it locally; run.sh fails a skip with CI set.
 *
 * Run:  npm run bdd-test:fakes-parity   (or run this file alone: npx tsx <this file>, with MySQL up)
 *
 * Every case runs the SAME closure against both sides, from identical seeded state, and compares
 * return values and error shape (code / errno / sqlState / message). It verifies behaviour, never just
 * shape. The fake replaces src/db/* wholesale, so everything MySQL does that an app reader could trip
 * over has to be pinned here: collation, JSON columns, AUTO_INCREMENT, constraints, ordering.
 *
 * NOT a Cucumber test. Cucumber loads this file on every BDD run, so everything is behind
 * `require.main === module`, and src/* is loaded lazily inside main() — never at import time.
 *
 * ---- Intentional divergences (documented, never asserted) -----------------------------------------
 *  - created_at on rows written by subscribers.create: MySQL assigns CURRENT_TIMESTAMP; the fake uses a
 *    fixed instant so scenarios are deterministic. Cases that read such rows scrub the value on both
 *    sides after asserting it is a Date.
 *  - delivery_log ON DELETE CASCADE: nothing in the app reads delivery_log, so it cannot change any app
 *    behaviour; not modelled.
 *  - Integer range / fractional values for INT columns (attempt_number, http_status): the app only
 *    produces small integers; MySQL's rounding/out-of-range errors are not modelled.
 *  - An empty-array placeholder: MySQL's syntax error quotes the rest of the SQL, so only its code is compared.
 *  - Failure injection (fail()/failAllDb) is a fake-only feature; a real outage is not reproducible here.
 *  - Flag-cache lag: the real provider serves from a cache refreshed every 5 s; the fake SDK answers
 *    instantly. The flags cases only compare settled state (the provider is initialised, i.e. its cache
 *    loaded, before each case; nothing changes the table while a case runs).
 *  - Provider lifecycle: the real side runs setProviderAndWait / clearProviders on the process-wide SDK;
 *    the fake SDK has no provider, so a failed initialize() or a not-ready status is not modelled (the app
 *    aborts at startup if initFlags() fails, so no scenario can run in that state).
 */

import assert from 'assert';
import type { Pool } from 'mysql2/promise';
import type * as SubscribersRepo from '../../../../../src/db/subscribers';
import type * as DeliveryLogRepo from '../../../../../src/db/deliveryLog';
import type * as TopicFlagsRepo from '../../../../../src/db/topicFlags';
import { withScenario, isConnectionError, skipSuite } from './parity-setup';
import {
  subscribersFake,
  deliveryLogFake,
  topicFlagsFake,
  dbIndexFake,
  enableTopicFlagsPool,
  seedSubscribers,
  seedTopicFlags,
  takeOwnershipOfDeliveryLogsForSubscriber,
  cleanup,
  type DeliveryAttempt,
} from '../fake-db';
import { openfeatureFake, fail as failFlags } from '../fake-openfeature';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Repos {
  subscribers: typeof SubscribersRepo;
  deliveryLog: typeof DeliveryLogRepo;
  topicFlags: typeof TopicFlagsRepo;
  ping: () => Promise<void>;
}

/** One side of a comparison: the repositories plus the two things a repository can't do on its own. */
interface Side {
  repos: Repos;
  /** delivery_log has no read method: the real side SELECTs it (test-only); the fake side claims it. */
  readDeliveryLog(subscriberId: number): Promise<DeliveryAttempt[]>;
  /**
   * The flag-evaluation path production uses (OpenFeature.getClient().getBooleanValue):
   *   real = the real @openfeature/server-sdk with the real MySqlFlagsProvider set as its provider,
   *   fake = the fake SDK over fake-db.
   * `evaluationFails` scripts the provider: per getBooleanValue call, true = the provider throws while
   * evaluating (the last entry repeats). Real = a MySqlFlagsProvider subclass that throws; fake = fail().
   */
  openFlags(evaluationFails?: boolean[]): Promise<Flags>;
  /** MySqlFlagsProvider's cache load: real = getPool().query(PROVIDER_CACHE_SQL); fake = fake-db's provider-only pool. */
  providerCacheQuery(): Promise<unknown[]>;
}

const PROVIDER_CACHE_SQL = 'SELECT topic, blocked FROM topic_flags';
// No ORDER BY in the provider's query (it fills a Map), so compare rows in a fixed order.
const byTopic = (rows: unknown[]) =>
  (rows as Array<{ topic: string; blocked: unknown }>)
    .map((r) => ({ topic: r.topic, blocked: r.blocked, blockedType: typeof r.blocked }))
    .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));

interface Flags {
  isBlocked(topic: string, defaultValue?: boolean): Promise<boolean>;
  close(): Promise<void>;
}

interface SeedSubscriber {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: Record<string, string>;
  created_at: Date;
}

interface Seed {
  subscribers?: SeedSubscriber[];
  topicFlags?: Array<{ topic: string; blocked: boolean }>;
}

interface Case {
  name: string;
  seed?: Seed;
  /** created_at on rows made by subscribers.create is DB-assigned (see header): scrub after checking it is a Date. */
  scrubCreatedAt?: boolean;
  run(side: Side): Promise<unknown>;
}

// ── Comparison helpers ────────────────────────────────────────────────────────

type Settled = { ok: unknown } | { err: { code?: string; errno?: number; sqlState?: string; message: string } };

async function settle(fn: () => Promise<unknown>): Promise<Settled> {
  try {
    // structuredClone drops class prototypes (mysql2 rows are TextRow, not plain) but keeps Dates.
    return { ok: structuredClone(await fn()) };
  } catch (e) {
    const err = e as { code?: string; errno?: number; sqlState?: string; message: string };
    return { err: { code: err.code, errno: err.errno, sqlState: err.sqlState, message: err.message } };
  }
}

function scrubCreatedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubCreatedAt);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'created_at') {
      assert.ok(v instanceof Date, `created_at must be a Date on both sides, got ${typeof v}`);
      out[k] = '<db-assigned>';
    } else {
      out[k] = scrubCreatedAt(v);
    }
  }
  return out;
}

const T0 = new Date('2024-01-01T00:00:00.000Z');
const sub = (id: number, topic = 'orders', over: Partial<SeedSubscriber> = {}): SeedSubscriber => ({
  id,
  name: `sub-${id}`,
  topic,
  url: `https://s${id}.example.com/hook`,
  headers: {},
  created_at: T0,
  ...over,
});

// ── Real side ─────────────────────────────────────────────────────────────────

async function resetReal(pool: Pool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['delivery_log', 'subscribers', 'topic_flags']) await conn.query(`TRUNCATE TABLE ${t}`); // resets AUTO_INCREMENT
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

async function seedReal(pool: Pool, seed: Seed): Promise<void> {
  for (const s of seed.subscribers ?? []) {
    await pool.query('INSERT INTO subscribers (id, name, topic, url, headers, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      s.id, s.name, s.topic, s.url, JSON.stringify(s.headers), s.created_at,
    ]);
  }
  for (const f of seed.topicFlags ?? []) {
    await pool.query('INSERT INTO topic_flags (topic, blocked) VALUES (?, ?)', [f.topic, f.blocked ? 1 : 0]);
  }
}

// ── Cases ─────────────────────────────────────────────────────────────────────

const long = (ch: string, n: number) => ch.repeat(n);

// Values that change meaning if a repository interpolates them into SQL instead of binding them.
const SQL_SPECIAL = ["o'reilly", "x'); DROP TABLE t; --", 'a\\b', 'tab\\t', 'say "hi"', 'back`tick'];

/** Run one operation, recording success or error without aborting the case (so a case can probe several). */
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<[string, Settled]> {
  return [label, await settle(fn)];
}

const CASES: Case[] = [
  // ---- subscribers.listAll ----
  { name: 'subscribers.listAll — empty table', run: ({ repos }) => repos.subscribers.listAll() },
  {
    name: 'subscribers.listAll — ordered by id; headers are parsed objects; created_at is a Date',
    seed: {
      subscribers: [
        sub(5, 'a', { headers: { 'x-b': '2', 'x-a': '1' } }),
        sub(2, 'b', { headers: {} }),
        sub(9, 'c', { headers: { 'X-Üni': 'çödé 😀' } }),
      ],
    },
    run: async ({ repos }) => {
      const rows = await repos.subscribers.listAll();
      assert.ok(rows.every((r) => r.created_at instanceof Date && typeof r.headers === 'object'));
      // deepStrictEqual ignores key order; MySQL's JSON column does not preserve it, so compare it explicitly.
      return { rows, keyOrder: rows.map((r) => Object.keys(r.headers)) };
    },
  },

  // ---- subscribers.findByTopic ----
  {
    name: 'subscribers.findByTopic — exact hit, miss, and LIKE wildcards are plain characters',
    seed: { subscribers: [sub(1, 'orders'), sub(2, 'refunds'), sub(3, 'o%')] },
    run: async ({ repos }) =>
      Object.fromEntries([
        await attempt('hit', () => repos.subscribers.findByTopic('orders')),
        await attempt('miss', () => repos.subscribers.findByTopic('nothing')),
        await attempt('percent', () => repos.subscribers.findByTopic('o%')),
        await attempt('underscore', () => repos.subscribers.findByTopic('order_')),
      ]),
  },
  {
    name: 'subscribers.findByTopic — default collation: case- and accent-insensitive, trailing space significant',
    seed: {
      subscribers: [sub(1, 'Orders'), sub(2, 'orders'), sub(3, 'ORDERS'), sub(4, 'cafe'), sub(5, 'café'), sub(6, 'orders ')],
    },
    run: async ({ repos }) =>
      Object.fromEntries([
        await attempt('orders', () => repos.subscribers.findByTopic('orders')),
        await attempt('CAFÉ', () => repos.subscribers.findByTopic('CAFÉ')),
        await attempt('orders␠', () => repos.subscribers.findByTopic('orders ')),
        await attempt('orders␠␠', () => repos.subscribers.findByTopic('orders  ')),
      ]),
  },
  {
    // webhook-delivery pins cross-topic delivery on this: a message on ORDERS or ördérs reaches "orders" subscribers.
    name: 'subscribers.findByTopic — ORDERS and ördérs find the "orders" subscriber',
    seed: { subscribers: [sub(1, 'orders'), sub(2, 'refunds')] },
    run: async ({ repos }) =>
      Object.fromEntries([
        await attempt('ORDERS', () => repos.subscribers.findByTopic('ORDERS')),
        await attempt('ördérs', () => repos.subscribers.findByTopic('ördérs')),
      ]),
  },
  {
    name: 'subscribers.findByTopic — one topic comes back ordered by id whatever the insert order',
    seed: { subscribers: [sub(7, 'orders'), sub(3, 'orders'), sub(5, 'orders'), sub(4, 'other')] },
    run: ({ repos }) => repos.subscribers.findByTopic('orders'),
  },

  // ---- subscribers.findDistinctTopics ----
  { name: 'subscribers.findDistinctTopics — empty table', run: ({ repos }) => repos.subscribers.findDistinctTopics() },
  {
    name: 'subscribers.findDistinctTopics — duplicates and case variants collapse; collation order incl. punctuation',
    seed: {
      subscribers: [
        'b', 'a.b', 'Orders', 'a-b', 'orders', 'a_b', 'a b', 'ORDERS', 'a1', 'aB', 'Ab', '1', '_x', '-x', 'Z', 'café', 'cafe',
      ].map((t, i) => sub(i + 1, t)),
    },
    run: ({ repos }) => repos.subscribers.findDistinctTopics(),
  },

  // ---- subscribers.create ----
  {
    name: 'subscribers.create — returns the generated id and the input; ids continue after the highest seeded id',
    seed: { subscribers: [sub(5, 'seeded')] },
    scrubCreatedAt: true,
    run: async ({ repos }) => ({
      first: await repos.subscribers.create({ name: 'n', topic: 't', url: 'https://x.example.com/h', headers: { a: '1' } }),
      defaultHeaders: await repos.subscribers.create({ name: 'n2', topic: 't', url: 'https://x2.example.com/h' }),
      list: await repos.subscribers.listAll(),
    }),
  },
  {
    name: 'subscribers.create — ids are never reused after a remove',
    run: async ({ repos }) => {
      const a = await repos.subscribers.create({ name: 'a', topic: 't', url: 'https://a.example.com/h' });
      const removed = await repos.subscribers.remove(a.id);
      const b = await repos.subscribers.create({ name: 'b', topic: 't', url: 'https://b.example.com/h' });
      return { a, removed, b };
    },
  },
  {
    name: 'subscribers.create — a rejected create does not shift the id sequence',
    run: async ({ repos }) => {
      const rejected = await settle(() => repos.subscribers.create({ name: 'n', topic: long('t', 256), url: 'https://x.example.com/h' }));
      const next = await repos.subscribers.create({ name: 'n', topic: 't', url: 'https://x.example.com/h' });
      return { rejected, next };
    },
  },
  {
    name: 'subscribers.create — headers are stored as JSON (key order normalised, undefined dropped) but the input is echoed',
    scrubCreatedAt: true,
    run: async ({ repos }) => {
      const created = await repos.subscribers.create({
        name: 'n',
        topic: 't',
        url: 'https://x.example.com/h',
        headers: { b: '2', a: '1', gone: undefined as unknown as string },
      });
      return { created, keys: Object.keys((await repos.subscribers.listAll())[0].headers), list: await repos.subscribers.listAll() };
    },
  },
  {
    name: 'subscribers.create — column limits: VARCHAR counts characters (255/256), url 2048/2049',
    run: async ({ repos }) => {
      const mk = (over: Partial<{ name: string; topic: string; url: string }>) =>
        repos.subscribers.create({ name: 'n', topic: 't', url: 'https://x.example.com/h', ...over });
      return Object.fromEntries([
        await attempt('name255', () => mk({ name: long('n', 255) })),
        await attempt('name256', () => mk({ name: long('n', 256) })),
        await attempt('emoji255', () => mk({ name: long('😀', 255) })),
        await attempt('emoji256', () => mk({ name: long('😀', 256) })),
        await attempt('topic255', () => mk({ topic: long('t', 255) })),
        await attempt('topic256', () => mk({ topic: long('t', 256) })),
        await attempt('url2048', () => mk({ url: 'https://x.example.com/' + long('u', 2048 - 22) })),
        await attempt('url2049', () => mk({ url: 'https://x.example.com/' + long('u', 2049 - 22) })),
      ]);
    },
  },

  {
    // req.body is JSON, so POST can hand create() a number, boolean or array where a string is typed.
    name: 'subscribers.create — non-string name/topic/url: scalars are stored as text, arrays expand into the value list',
    scrubCreatedAt: true,
    run: async ({ repos }) => {
      const mk = (over: Record<string, unknown>) =>
        repos.subscribers.create({ name: 'n', topic: 't', url: 'https://x.example.com/h', ...over } as never);
      const results = Object.fromEntries([
        await attempt('numberName', () => mk({ name: 123 })),
        await attempt('numberTopic', () => mk({ topic: 42 })),
        await attempt('floatTopic', () => mk({ topic: 1.5 })),
        await attempt('trueTopic', () => mk({ topic: true })),
        await attempt('falseTopic', () => mk({ topic: false })),
        await attempt('objectTopic', () => mk({ topic: { a: 1 } })),
        await attempt('arrayTopic', () => mk({ topic: ['a', 'b'] })),
        await attempt('singleArrayTopic', () => mk({ topic: ['a'] })),
        await attempt('nestedArrayTopic', () => mk({ topic: [['a', 'b']] })),
        await attempt('nullInArrayTopic', () => mk({ topic: [null] })),
        await attempt('arrayUrl', () => mk({ url: ['https://x.example.com/h'] })),
      ]);
      // MySQL quotes the rest of the SQL in a syntax error; only the code is the fake's to match.
      const empty = await settle(() => mk({ topic: [] }));
      const emptyArrayTopicCode = 'err' in empty ? empty.err.code : 'resolved';
      return { results, emptyArrayTopicCode, list: await settle(() => repos.subscribers.listAll()) };
    },
  },
  {
    // parseRow JSON.parses a column that comes back as a string, so a stored "abc" breaks every read.
    name: 'subscribers.create — non-object headers are stored as JSON; a non-JSON string makes listAll throw',
    scrubCreatedAt: true,
    run: async ({ repos }) => {
      const mk = (headers: unknown) =>
        repos.subscribers.create({ name: 'n', topic: 't', url: 'https://x.example.com/h', headers } as never);
      const created = Object.fromEntries([
        await attempt('number', () => mk(5)),
        await attempt('array', () => mk(['a', 'b'])),
        await attempt('true', () => mk(true)),
        await attempt('null', () => mk(null)),
        await attempt('jsonText', () => mk('{"x":"1"}')),
        await attempt('nested', () => mk({ zz: { b: '2', a: '1' } })),
        await attempt('numberValue', () => mk({ 'X-Retries': 3 })),
      ]);
      const listBefore = await settle(() => repos.subscribers.listAll());
      const string = await settle(() => mk('abc'));
      return {
        created,
        listBefore,
        string,
        listAfter: await settle(() => repos.subscribers.listAll()),
        findByTopicAfter: await settle(() => repos.subscribers.findByTopic('t')),
      };
    },
  },

  // ---- subscribers.remove ----
  {
    name: 'subscribers.remove — affected rows 1 for a hit, 0 for missing / zero / negative; row is gone afterwards',
    seed: { subscribers: [sub(1), sub(2)] },
    run: async ({ repos }) => ({
      hit: await repos.subscribers.remove(1),
      again: await repos.subscribers.remove(1),
      zero: await repos.subscribers.remove(0),
      negative: await repos.subscribers.remove(-1),
      huge: await repos.subscribers.remove(2147483647),
      left: (await repos.subscribers.listAll()).map((s) => s.id),
    }),
  },

  // ---- deliveryLog.logAttempt ----
  {
    name: 'deliveryLog.logAttempt — persists every column; undefined and null both become NULL; empty string stays',
    seed: { subscribers: [sub(1)] },
    run: async ({ repos, readDeliveryLog }) => {
      const base = { subscriber_id: 1, payload: '{"k":"v"}', attempt_number: 1, status: 'success' as const };
      await repos.deliveryLog.logAttempt({ ...base, message_key: 'key-1', http_status: 200, error_message: null });
      await repos.deliveryLog.logAttempt({ ...base, attempt_number: 2, message_key: undefined as unknown as null, http_status: undefined as unknown as null, error_message: undefined as unknown as null });
      await repos.deliveryLog.logAttempt({ ...base, attempt_number: 3, message_key: null, http_status: null, error_message: null });
      await repos.deliveryLog.logAttempt({ ...base, attempt_number: 4, status: 'failed', message_key: '', http_status: 503, error_message: 'Service Unavailable' });
      await repos.deliveryLog.logAttempt({ ...base, attempt_number: 5, status: 'exhausted', message_key: null, http_status: null, error_message: 'ünï 😀 "quoted"' });
      await repos.deliveryLog.logAttempt({ ...base, attempt_number: 6, status: 'blocked', payload: 'x'.repeat(200_000) + '😀', message_key: null, http_status: null, error_message: null });
      return readDeliveryLog(1);
    },
  },
  {
    name: 'deliveryLog.logAttempt — foreign key: an unknown or removed subscriber is rejected',
    seed: { subscribers: [sub(1), sub(2)] },
    run: async ({ repos }) => {
      const row = (subscriber_id: number) => ({ subscriber_id, message_key: null, payload: 'p', attempt_number: 1, status: 'success' as const, http_status: 200, error_message: null });
      await repos.subscribers.remove(2);
      return Object.fromEntries([
        await attempt('known', () => repos.deliveryLog.logAttempt(row(1))),
        await attempt('unknown', () => repos.deliveryLog.logAttempt(row(99))),
        await attempt('removed', () => repos.deliveryLog.logAttempt(row(2))),
      ]);
    },
  },
  {
    name: 'deliveryLog.logAttempt — NOT NULL, ENUM and VARCHAR(255) constraints',
    seed: { subscribers: [sub(1)] },
    run: async ({ repos, readDeliveryLog }) => {
      const row = (over: Record<string, unknown>) =>
        ({ subscriber_id: 1, message_key: null, payload: 'p', attempt_number: 1, status: 'success', http_status: 200, error_message: null, ...over }) as DeliveryAttempt;
      const results = Object.fromEntries([
        await attempt('payloadNull', () => repos.deliveryLog.logAttempt(row({ payload: null }))),
        await attempt('payloadEmpty', () => repos.deliveryLog.logAttempt(row({ payload: '' }))),
        await attempt('subscriberNull', () => repos.deliveryLog.logAttempt(row({ subscriber_id: null }))),
        await attempt('badStatus', () => repos.deliveryLog.logAttempt(row({ status: 'nope' }))),
        await attempt('key255', () => repos.deliveryLog.logAttempt(row({ message_key: long('k', 255) }))),
        await attempt('key256', () => repos.deliveryLog.logAttempt(row({ message_key: long('k', 256) }))),
        // webhook-delivery's "poison message" pin rests on these two.
        await attempt('emojiKey255', () => repos.deliveryLog.logAttempt(row({ message_key: long('😀', 255) }))),
        await attempt('emojiKey256', () => repos.deliveryLog.logAttempt(row({ message_key: long('😀', 256) }))),
      ]);
      return { results, persisted: (await readDeliveryLog(1)).map((r) => ({ ...r, payload: r.payload.length, message_key: r.message_key?.length ?? null })) };
    },
  },

  // ---- topicFlags ----
  { name: 'topicFlags.getAll — empty table', run: ({ repos }) => repos.topicFlags.getAll() },
  {
    name: 'topicFlags.getAll — ordered by topic under the collation; blocked is a boolean',
    seed: {
      topicFlags: ['b', 'a.b', 'a-b', 'A', 'a_b', 'a b', 'a1', '1', 'Z', 'café'].map((topic, i) => ({ topic, blocked: i % 2 === 0 })),
    },
    run: ({ repos }) => repos.topicFlags.getAll(),
  },
  {
    name: 'topicFlags.upsert — inserts, then updates in place',
    run: async ({ repos }) => {
      await repos.topicFlags.upsert('a', true);
      await repos.topicFlags.upsert('b', true);
      await repos.topicFlags.upsert('a', false);
      return repos.topicFlags.getAll();
    },
  },
  {
    name: 'topicFlags.upsert — case and accent variants are the same row; the first spelling is kept',
    run: async ({ repos }) => {
      await repos.topicFlags.upsert('Orders', true);
      await repos.topicFlags.upsert('orders', false);
      await repos.topicFlags.upsert('ORDERS', true);
      await repos.topicFlags.upsert('café', true);
      await repos.topicFlags.upsert('CAFE', false);
      return repos.topicFlags.getAll();
    },
  },
  {
    name: 'topicFlags.upsert — topic limit 255 ok, 256 rejected',
    run: async ({ repos }) =>
      Object.fromEntries([
        await attempt('topic255', () => repos.topicFlags.upsert(long('t', 255), true)),
        await attempt('topic256', () => repos.topicFlags.upsert(long('t', 256), true)),
      ]),
  },

  // ---- Parameter binding: SQL-special characters ----
  // The BDD "SQL-special characters" scenarios stop at the fake repository, so only these cases see the SQL.
  // A value interpolated into the statement instead of bound breaks the quote rows and rewrites the backslash one.
  {
    name: 'topicFlags.upsert / getAll — quotes, backslashes and SQL text are bound, stored and read back verbatim',
    run: async ({ repos }) => {
      const upserted: Record<string, Settled> = {};
      for (const [i, topic] of SQL_SPECIAL.entries()) {
        upserted[topic] = await settle(() => repos.topicFlags.upsert(topic, i % 2 === 0));
      }
      return { upserted, rows: await settle(() => repos.topicFlags.getAll()) };
    },
  },
  {
    name: 'subscribers.create / findByTopic — quotes, backslashes and SQL text are bound, stored and read back verbatim',
    scrubCreatedAt: true,
    run: async ({ repos }) => {
      const created: Record<string, Settled> = {};
      for (const v of SQL_SPECIAL) {
        created[v] = await settle(() => repos.subscribers.create({ name: v, topic: v, url: `https://x.example.com/${v}`, headers: { 'x-v': v } }));
      }
      const found: Record<string, Settled> = {};
      for (const v of SQL_SPECIAL) found[v] = await settle(() => repos.subscribers.findByTopic(v));
      return { created, found, list: await settle(() => repos.subscribers.listAll()) };
    },
  },
  {
    name: 'deliveryLog.logAttempt — quotes, backslashes and SQL text in message_key, payload and error_message are stored verbatim',
    seed: { subscribers: [sub(1)] },
    run: async ({ repos, readDeliveryLog }) => {
      const results: Record<string, Settled> = {};
      for (const [i, v] of SQL_SPECIAL.entries()) {
        results[v] = await settle(() =>
          repos.deliveryLog.logAttempt({ subscriber_id: 1, message_key: v, payload: v, attempt_number: i + 1, status: 'failed', http_status: null, error_message: v }),
        );
      }
      return { results, persisted: await readDeliveryLog(1) };
    },
  },
  {
    // LONGTEXT does no trailing-space removal, unlike CHAR: https://dev.mysql.com/doc/refman/8.0/en/blob.html
    name: 'deliveryLog.logAttempt — a whitespace-only or whitespace-edged payload is stored untrimmed',
    seed: { subscribers: [sub(1)] },
    run: async ({ repos, readDeliveryLog }) => {
      for (const [i, payload] of ['   ', '  x  ', '\t\n'].entries()) {
        await repos.deliveryLog.logAttempt({ subscriber_id: 1, message_key: null, payload, attempt_number: i + 1, status: 'success', http_status: 200, error_message: null });
      }
      return { persisted: await readDeliveryLog(1) };
    },
  },

  // ---- db.ping ----
  { name: 'db.ping — resolves with no value against a live database', run: async ({ repos }) => ({ resolved: await repos.ping() }) },

  // ---- The flag-evaluation path: fake SDK (over fake-db) vs the real SDK + real MySqlFlagsProvider ----
  {
    name: 'flags — unmanaged, blocked, explicitly unblocked, empty and exact-case lookups through getBooleanValue',
    seed: {
      topicFlags: [
        { topic: 'blocked-topic', blocked: true },
        { topic: 'unblocked-topic', blocked: false },
        { topic: 'Mixed-Case', blocked: true },
        { topic: '', blocked: true },
      ],
    },
    run: async (side) => {
      const flags = await side.openFlags();
      try {
        return Object.fromEntries([
          await attempt('unmanaged', () => flags.isBlocked('no-row')),
          await attempt('blocked', () => flags.isBlocked('blocked-topic')),
          await attempt('unblocked', () => flags.isBlocked('unblocked-topic')),
          // The provider's cache is a JS Map keyed by the stored spelling — lookups are exact-case even though the table is not.
          await attempt('exactCase', () => flags.isBlocked('Mixed-Case')),
          await attempt('otherCase', () => flags.isBlocked('mixed-case')),
          await attempt('emptyKey', () => flags.isBlocked('')),
        ]);
      } finally {
        await flags.close();
      }
    },
  },
  {
    // PATCH "Orders" over an existing "orders" row: the row keeps "orders", so only that spelling reads as blocked.
    name: 'flags — a case-variant upsert lands on the existing row; the cache answers only the stored spelling',
    seed: { topicFlags: [{ topic: 'orders', blocked: false }] },
    run: async (side) => {
      await side.repos.topicFlags.upsert('Orders', true);
      const rows = await side.repos.topicFlags.getAll();
      const flags = await side.openFlags();
      try {
        return {
          rows,
          ...Object.fromEntries([
            await attempt('requestSpelling', () => flags.isBlocked('Orders')),
            await attempt('storedSpelling', () => flags.isBlocked('orders')),
          ]),
        };
      } finally {
        await flags.close();
      }
    },
  },
  {
    // The query MySqlFlagsProvider.loadCache() runs: TINYINT(1) `blocked` comes back as a number, and every row
    // (including case variants and "__proto__") as-is. Pins fake-db's provider-only pool (enableTopicFlagsPool).
    name: "pool.query — the flag provider's cache load returns every row with blocked as 0/1",
    seed: {
      topicFlags: [
        { topic: 'blocked-topic', blocked: true },
        { topic: 'unblocked-topic', blocked: false },
        { topic: 'Mixed-Case', blocked: true },
        { topic: '__proto__', blocked: true },
      ],
    },
    run: (side) => side.providerCacheQuery(),
  },
  {
    // GET /api/flags then assigns result[topic] = blocked; the repository must hand back the row as-is.
    name: 'topicFlags.getAll — a "__proto__" topic comes back as an ordinary row',
    seed: { topicFlags: [{ topic: '__proto__', blocked: true }, { topic: 'orders', blocked: true }] },
    run: async ({ repos }) => repos.topicFlags.getAll(),
  },
  {
    // Production always passes false, so the default only shows here: an unmanaged topic answers with
    // the caller's default, a managed one with its stored value regardless of the default.
    name: "flags — a managed topic ignores the caller's default; an unmanaged topic answers with it",
    seed: {
      topicFlags: [
        { topic: 'blocked-topic', blocked: true },
        { topic: 'unblocked-topic', blocked: false },
      ],
    },
    run: async (side) => {
      const flags = await side.openFlags();
      try {
        return Object.fromEntries([
          await attempt('unmanagedDefaultTrue', () => flags.isBlocked('no-row', true)),
          await attempt('unmanagedDefaultFalse', () => flags.isBlocked('no-row', false)),
          await attempt('blockedDefaultFalse', () => flags.isBlocked('blocked-topic', false)),
          await attempt('unblockedDefaultTrue', () => flags.isBlocked('unblocked-topic', true)),
        ]);
      } finally {
        await flags.close();
      }
    },
  },
  {
    // The SDK catches whatever the provider throws and answers with the caller's default; it never rejects.
    // With production's default (false) a blocked topic therefore reads as NOT blocked: fail-open.
    name: "flags — a provider that throws while evaluating makes getBooleanValue answer with the caller's default",
    seed: { topicFlags: [{ topic: 'blocked-topic', blocked: true }] },
    run: async (side) => {
      const flags = await side.openFlags([true]);
      try {
        return Object.fromEntries([
          await attempt('blockedDefaultFalse', () => flags.isBlocked('blocked-topic', false)),
          await attempt('blockedDefaultTrue', () => flags.isBlocked('blocked-topic', true)),
          await attempt('unmanagedDefaultFalse', () => flags.isBlocked('no-row', false)),
          await attempt('unmanagedDefaultTrue', () => flags.isBlocked('no-row', true)),
        ]);
      } finally {
        await flags.close();
      }
    },
  },
  {
    name: 'flags — fail once then recover: the failing evaluation falls back to the default, later ones read the row',
    seed: { topicFlags: [{ topic: 'blocked-topic', blocked: true }] },
    run: async (side) => {
      const flags = await side.openFlags([true, false]);
      try {
        return Object.fromEntries([
          await attempt('first', () => flags.isBlocked('blocked-topic')),
          await attempt('second', () => flags.isBlocked('blocked-topic')),
          await attempt('third', () => flags.isBlocked('blocked-topic')),
        ]);
      } finally {
        await flags.close();
      }
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('fake-db parity test (fake repositories vs src/db/* on MySQL)\n');

  process.env.MYSQL_HOST = process.env.MYSQL_HOST ?? 'localhost';
  process.env.MYSQL_PORT = process.env.PARITY_MYSQL_PORT ?? process.env.MYSQL_PORT ?? '3307';

  // Loaded lazily and from src (via tsx), so parity always exercises the current code, not a stale dist/.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const realDb = require('../../../../../src/db/index') as typeof import('../../../../../src/db/index');
  const realRepos: Repos = {
    subscribers: require('../../../../../src/db/subscribers'),
    deliveryLog: require('../../../../../src/db/deliveryLog'),
    topicFlags: require('../../../../../src/db/topicFlags'),
    ping: realDb.ping,
  };
  const { MySqlFlagsProvider } = require('../../../../../src/flags/MySqlFlagsProvider') as typeof import('../../../../../src/flags/MySqlFlagsProvider');
  // The REAL SDK: nothing seeds require.cache in this process, so this is the npm package, not the fake.
  const { OpenFeature } = require('@openfeature/server-sdk') as typeof import('@openfeature/server-sdk');
  /* eslint-enable @typescript-eslint/no-require-imports */

  // The real provider with a scripted failure: per resolveBooleanEvaluation call, true = throw (the last entry repeats).
  class ScriptedFailureProvider extends MySqlFlagsProvider {
    private calls = 0;
    private readonly failures: boolean[];
    constructor(failures: boolean[]) {
      super();
      this.failures = failures;
    }
    async resolveBooleanEvaluation(...args: Parameters<InstanceType<typeof MySqlFlagsProvider>['resolveBooleanEvaluation']>) {
      const fails = this.failures[Math.min(this.calls++, this.failures.length - 1)];
      if (fails) throw new Error('provider down');
      return super.resolveBooleanEvaluation(...args);
    }
  }

  try {
    await realDb.connect();
  } catch (err) {
    if (isConnectionError(err)) {
      skipSuite('fake-db', `MySQL not reachable on ${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT} (${(err as { code?: string }).code ?? (err as Error).message}). Start it with run.sh (needs Docker).`);
    }
    throw err;
  }
  const pool = realDb.getPool();

  const realSide: Side = {
    repos: realRepos,
    async readDeliveryLog(subscriberId) {
      const [rows] = await pool.query(
        'SELECT subscriber_id, message_key, payload, attempt_number, status, http_status, error_message FROM delivery_log WHERE subscriber_id = ? ORDER BY id',
        [subscriberId],
      );
      return rows as DeliveryAttempt[];
    },
    async openFlags(evaluationFails) {
      const provider = evaluationFails ? new ScriptedFailureProvider(evaluationFails) : new MySqlFlagsProvider();
      // setProviderAndWait runs provider.initialize(): the cache is loaded before the first lookup.
      await OpenFeature.setProviderAndWait(provider);
      const client = OpenFeature.getClient();
      return {
        isBlocked: (topic, defaultValue = false) => client.getBooleanValue(topic, defaultValue),
        // The SDK is a process-wide singleton: clear it so the next case starts without a provider.
        // clearProviders also closes the provider; onClose is idempotent and guarantees the refresh timer stops.
        close: async () => {
          await OpenFeature.clearProviders();
          await provider.onClose();
        },
      };
    },
    async providerCacheQuery() {
      const [rows] = await pool.query(PROVIDER_CACHE_SQL);
      return byTopic(rows as unknown[]);
    },
  };

  let testsRun = 0;
  const divergences: string[] = [];
  try {
    for (const [i, c] of CASES.entries()) {
      console.log(`${i + 1}. ${c.name}`);

      await resetReal(pool);
      await seedReal(pool, c.seed ?? {});
      const real = await settle(() => c.run(realSide));

      const fake = await withScenario(cleanup, async (scenarioId) => {
        seedSubscribers(scenarioId, c.seed?.subscribers ?? []);
        seedTopicFlags(scenarioId, c.seed?.topicFlags ?? []);
        const fakeSide: Side = {
          repos: {
            subscribers: subscribersFake as unknown as typeof SubscribersRepo,
            deliveryLog: deliveryLogFake as unknown as typeof DeliveryLogRepo,
            topicFlags: topicFlagsFake as unknown as typeof TopicFlagsRepo,
            ping: dbIndexFake.ping,
          },
          async readDeliveryLog(subscriberId) {
            return takeOwnershipOfDeliveryLogsForSubscriber(scenarioId, subscriberId);
          },
          async openFlags(evaluationFails) {
            if (evaluationFails) {
              failFlags(scenarioId, 'openfeature.getBooleanValue', evaluationFails.map((f) => (f ? new Error('provider down') : null)));
            }
            const client = openfeatureFake.OpenFeature.getClient();
            return { isBlocked: (topic, defaultValue = false) => client.getBooleanValue(topic, defaultValue), close: async () => {} };
          },
          async providerCacheQuery() {
            enableTopicFlagsPool(scenarioId);
            const [rows] = await dbIndexFake.getPool().query(PROVIDER_CACHE_SQL);
            return byTopic(rows);
          },
        };
        return settle(() => c.run(fakeSide));
      });

      const [a, b] = c.scrubCreatedAt ? [scrubCreatedAt(real), scrubCreatedAt(fake)] : [real, fake];
      try {
        assert.deepStrictEqual(b, a);
        testsRun++;
      } catch {
        // Keep going: one run should list every divergence, not just the first.
        divergences.push(`  - "${c.name}"\n      real: ${JSON.stringify(a).slice(0, 700)}\n      fake: ${JSON.stringify(b).slice(0, 700)}`);
      }
    }
  } finally {
    await realDb.close();
  }

  if (divergences.length > 0) {
    throw new Error(
      `fake-db diverges from real MySQL in ${divergences.length} case(s):\n${divergences.join('\n')}\n` +
        'Probable cause: the fake reimplements a MySQL behaviour differently (see the header for intentional divergences). ' +
        'Fix: change the fake to match the real result (never loosen an assertion), then re-run the BDD suite.',
    );
  }

  if (testsRun === 0) {
    throw new Error('parity suite executed zero tests — a stale import or empty suite silently disabled parity');
  }
  console.log(`\n✓ All parity checks passed (ran ${testsRun} tests).`);
  // Machine-readable marker consumed by run.sh to fail a zero-test run.
  console.log(`PARITY_TESTS_RUN=${testsRun}`);
}

// Guard: only run when invoked directly — Cucumber loads this file on every BDD run and must not trigger it.
if (require.main === module) {
  void main().catch((err: Error) => {
    console.error('\n✗ PARITY TEST FAILED:', err.message);
    process.exit(1);
  });
}
