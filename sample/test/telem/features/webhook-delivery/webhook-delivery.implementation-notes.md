# Implementation Notes: Deliver Webhooks to Subscribers

## Branch coverage accounting

Flow under test: `src/kafka/consumer.ts → handleMessage`, `src/delivery/deliver.ts`

Whole-suite coverage (`npm run bdd-test:coverage`): `deliver.ts` 100% statements, 91.67% branches (line 48 uncovered);
`consumer.ts` 97.10% statements (only the dead `__overrideConsumerConnectedForTest` hook, lines 81 and 85-87, is
uncovered; it belongs to the health-check flow); `flags/index.ts` 88.89% (the dead `__overrideFlagsReadyForTest` hook).

Coverage doesn't find this flow's findings. Redelivery doubling, the `NaN` attempt limit, header collisions, collation
leaks and the `message_key` limit all sit on lines that were already covered; the decision tables, config-default
reading and protocol thinking found them.

## Known production bugs (pinned as current behaviour, not fixed)

- **Non-numeric `WEBHOOK_MAX_ATTEMPTS` drops every delivery.** `Math.max(1, NaN)` is `NaN`; the loop never
  runs; the offset is committed. Scenario: "A non-numeric WEBHOOK_MAX_ATTEMPTS silently drops every delivery".
- **`X-Delivery-Id` is not an idempotency key across redelivery.** It is minted per `deliver()` call; a
  redelivered message (rebalance, failed commit, failed log write) is POSTed again under a new id.
- **A message key over 255 characters is a poison message.** The success INSERT fails after the POST, the
  offset never commits, and every redelivery POSTs again. Verified: `fake-db.parity.ts` rejects a 256-character
  key (ASCII and emoji) and accepts 255 on MySQL 8, same as the fake.
- **The header error strings come from Node's undici.** `fake-fetch.parity.ts` checks both against real fetch;
  the wording is the same on Node 22.17 and 24.19.
- **Topic matching is collation-insensitive but blocking is exact-case.** A message on `ORDERS` reaches
  `orders` subscribers and is not stopped by a block on `orders`. Verified: `fake-db.parity.ts` finds the
  `orders` subscriber for `ORDERS` and `ördérs` on MySQL 8.
- **A subscriber with string headers poisons its topic.** A registration with `"headers": "abc"` stores the JSON
  string; `findByTopic`'s `parseRow` JSON.parses it again and throws, so `handleMessage` rejects before any POST or
  log row and the offset is never committed — every message on the topic is redelivered forever. Scenario: "A
  subscriber whose headers were stored as a plain string blocks every message on its topic". Matches MySQL 8
  (`fake-db.parity.ts`, non-object headers case, incl. `findByTopic`).
- **Every failure is retried alike**: 4xx, an unfollowable 3xx and a header that fetch rejects locally all
  burn the full retry budget (characterized, arguably by design).

## Decision tables

Gitignored TSVs under `test/telem/.decision-tables/` (`webhook-delivery-fanout.tsv` subscribers × flag,
`webhook-delivery-infra.tsv` route × infra, `webhook-delivery-retry.tsv` endpoint × attempt setting);
each passes `telem-bdd check-decision-table --feature`.

**Not expressible with today's fakes:** one subscriber's log write failing while a sibling's succeeds in the
same fan-out. `fake-db`'s `fail()` sequence advances by call arrival, which the methodology forbids binding to
a particular concurrent call; it needs an args predicate (`FOLLOWUP.md` § Deferred).

---

### Coverable — covered by scenarios

**`handleMessage` — `if (failure) throw failure.reason;`.** Fires when `Promise.allSettled(ops)` holds a rejected
result, which needs subscribers readable but a `logAttempt` to throw. Covered by "DB write failure during delivery
log recording prevents delivery and causes message retry": the topic is blocked and
`fail(scenarioId, 'deliveryLog.logAttempt', [...])` fails only that operation.

---

### Unreachable — documented

**`getPool()` (`src/db/index.ts`) — `if (!pool) throw 'DB pool not initialised'`.** Fires only when `getPool()` runs
before `connect()`: a programming-error sentinel. `dist/db/index` is the fake, so none of `src/db/*` executes under
BDD (see "Coverage of `src/db/*`"). **Defensive fallback.**

**`parseRow` headers parse (`src/db/subscribers.ts`) — `typeof row.headers === 'string' ? … : row.headers`.**
mysql2 returns a `JSON` column already parsed (default `jsonStrings` unset; verified against MySQL 8 and the parity
`listAll` case), so production takes the **object** arm; the `typeof === 'string'` arm is defensive (reachable only with
`jsonStrings: true` or a MariaDB `LONGTEXT` column). Neither arm executes under BDD. **Defensive fallback.**

**`deliver()` catch (`src/delivery/deliver.ts:48`) — `err instanceof Error ? err.message : String(err)`, falsy arm.**
Node's `fetch()` throws a `TypeError` for network failures (always `TypeError('fetch failed')`; `fetchFailedError()`
builds the same shape) and for local header validation (pinned by "A subscriber with an invalid header name is never
contacted and exhausts its retries"), and its abort error is a `DOMException`, also an `Error`. **Defensive fallback.**
(`telem-bdd trace` could not settle this: the tracer records `fetch` and the fakes as absent, not as leaves.)

---

### Startup/shutdown infrastructure

`main()` in `src/index.ts` and the `SIGTERM`/`SIGINT` handlers never run under BDD, which calls `createApp()` and
`db.connect()` directly.

**`src/db/index.ts` — `close()`.** Called only from `shutdown()`. The BDD harness has no `AfterAll` that calls it: the
fake needs no teardown.

`consumer.ts`'s `startConsumer()` and `stopConsumer()` are covered, through the health-check flow's steps that stop
the consumer and rerun `startConsumer()` after seeding. `initFlags()` runs in BeforeAll.

---

## Coverage of `src/db/*`

The database is faked at the repository seam, so **no line of `src/db/*.ts` executes under BDD** —
`subscribers.ts`, `deliveryLog.ts`, `topicFlags.ts` and `index.ts` show as uncovered. That is expected, not a gap
to fill with scenarios. Classification: **replaced by fake — verified by parity**: `npm run bdd-test:fakes-parity`
runs these files against a real MySQL 8 (`parity-tests/fake-db.parity.ts`). `src/flags/MySqlFlagsProvider.ts` runs
under BDD only in `flag-provider.feature`; the default fake SDK replaces it elsewhere, and the parity suite's flags
cases exercise it through the real OpenFeature SDK (including a provider that throws: the SDK answers with the
caller's default, so a failing provider fails open — see the "Feature flag evaluation failures" scenarios).

## Blind test (4 rounds, stopped after round 4 by decision)

Blind test (Step 15): complete — 4 rounds, stopped on decision

| Round | Proposed | Kept | Categories | Removed and why |
|---|---|---|---|---|
| 1 | 14 | 12 | retry-limit boundaries, non-matching topics (prefix, LIKE wildcard, injection), key shapes (Unicode, SQL, whitespace), 3-way fan-out | invalid URL (`not a url`) and non-ASCII URL path: they asserted fake behaviour, not what real fetch puts on the wire |
| 2 | 12 | 11 | `parseInt` quirks of WEBHOOK_MAX_ATTEMPTS (`3abc` → 3, `1e3` → 1, `0x10` → 1), a non-Latin-1 header value, trailing-space topic, same key at two offsets, offset 0, keyless blocked message, all-subscribers-unreachable fan-out | invalid URL again; a "line break" key was renamed (Cucumber `{string}` keeps `\n` literal) |
| 3 | 12 | 3 | whitespace-only payload, header value with a line break, empty header value (parity cases added for the first and last) | 9 duplicates, fake-only or not reachable from a real broker: empty-string and HTML payloads, path-traversal key, injection and empty topics, offset over 2^64, same-offset replay, blocked topic with an unreachable endpoint; URL credentials (fake differs from real fetch) |
| 4 | 15 | 3 | over-long key on a blocked topic, Authorization dropped on a cross-origin redirect and kept on a same-origin one | 12 duplicates or fake-only: invalid URL (the API rejects it), wildcard and injection topics, reversed trailing-space topic, empty or case-colliding header names, upper-case host, partition 2^31-1, `null` and escaped-newline payloads; URL credentials and fragment, padded header value (not expressible) |

Peer review removed blind survivors that only exercise the in-memory fake (the `ord%` and injection topic rows, the
backslash key: the SQL never runs under BDD, so they belong in `fake-db.parity`), merged the `0x10`/`1e3` rows into
the clamp outline and dropped the plain `4` row. The "SQL-special key" survivor was kept: like the payload passthrough
scenario it pins that the *app* does not sanitise the key.
