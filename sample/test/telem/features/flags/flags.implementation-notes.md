# Implementation Notes: Manage Topic Delivery Flags

Covers `flags.feature` (HTTP API) and `flag-provider.feature` (the real `MySqlFlagsProvider`, observed
through Kafka delivery).

## Branch coverage classification

### `src/api/flags.ts` — 100% statements and branches

### `src/db/topicFlags.ts` — not loaded under BDD

Faked at the repository seam (`fake-db.ts` `topicFlagsFake`); its SQL is verified by `fake-db.parity.ts`.

### `src/flags/index.ts` — covered but the dead override arm (lines 14, 18-20)

`initFlags()` runs in BeforeAll and in every `flag-provider.feature` scenario (including the rejecting one).
The `__overrideFlagsReadyForTest` arm is a dead test hook (health-check flow; no step calls it).

### `src/flags/MySqlFlagsProvider.ts` — 13/19 statements, 3/6 branches

Exercised by `flag-provider.feature` via `fake-openfeature` `useRealFlagsProvider()` (the fake-db
provider-only pool plus the non-determinism virtual clock). Mutation-checked: TTL ±1 ms, `=== 1`
mapping changes, merge-instead-of-replace, `setTimeout` instead of `setInterval`, an un-awaited first
load and clear-on-failure each turn the feature red. Remaining gaps:

- **Unreachable (no production caller): `onClose()`.** The SDK calls it only when a provider is
  replaced or `OpenFeature.close()` runs; the app sets the provider once, and `shutdown()` in
  `src/index.ts` never closes OpenFeature (harmless: it calls `process.exit`). A `telem-bdd trace` of the
  reload-recovery scenario confirmed it never runs.
- **Unreachable (no production caller): `resolveStringEvaluation` / `resolveNumberEvaluation` /
  `resolveObjectEvaluation`.** `isTopicBlocked()` is the only evaluation call site and it is boolean.
- **Telemetry-only: the non-`Error` arm of the reload-failure `console.warn`.** It changes only the
  log text; mysql2 always rejects with an `Error`.

## Known Production Bugs (pinned, not fixed)

### `__proto__` topic missing from GET /api/flags

`result[flag.topic] = flag.blocked` on a plain object hits `Object.prototype`'s `__proto__` setter, which
ignores a boolean. The row is stored and enforced but invisible in the listing (and the UI). Pinned by 'A topic
named "__proto__" is silently missing from the delivery flag listing'. Fix: build the result with
`Object.create(null)` or a `Map`.

### Case-variant topic blocks

`topic_flags.topic` is the primary key under `utf8mb4_0900_ai_ci`, and `ON DUPLICATE KEY UPDATE` only
touches `blocked`, so PATCH "Orders" over an existing "orders" row answers 200 `{topic:"Orders"}` while the
row keeps "orders". The provider cache is an exact-case `Map`, so messages on Kafka topic "Orders" keep
being delivered (and a block on "orders" never applies to "Orders", although the subscriber lookup is
case-insensitive and routes "Orders" messages to "orders" subscribers). Verified against real MySQL and the
real provider in `fake-db.parity.ts` ("a case-variant upsert lands on the existing row"). Pinned in both
feature files.

## Behaviour worth knowing

- **Non-JSON PATCH does not hang.** body-parser 1.20 sets `req.body = {}` when it does not parse a body,
  so the handler answers 400 "delivery_blocked must be a boolean". Pinned by 'A flag update sent as plain
  text is rejected as a missing delivery_blocked value'.
- Oversized PATCH (413), `%2F` decoding into the topic, and a literal slash or empty topic (404) are tested.

## Deferred (knowingly out of scope)

- **No authentication or audit trail on flag mutations** — app-design decision for this sample.
- **`blocked` values other than 0/1** (TINYINT(1) accepts 2 via direct SQL): both GET and the provider map
  with `=== 1`, so 2 reads as unblocked. The fake stores a boolean and cannot seed it; parity territory.

### Production mutants and the scenario that catches each

| Mutant of `MySqlFlagsProvider` | Caught by |
|---|---|
| `ttlMs` 4000 | 'A block made through the API starts suppressing messages from the first 5-second reload after startup', 'The flag cache keeps reloading every 5 seconds, not only once after startup' |
| reload merges into the old cache instead of replacing it | 'Deleting a topic's flag row directly in MySQL returns it to the permissive default after the next reload' |
| first load not awaited in `initialize()` | 'Flag initialization at startup fails when it cannot load the flag state' |

## Harness divergence

`GET /api/flags/<topic>` falls through to the SPA catch-all. The Docker image serves `dist/public/index.html`
(200); the BDD harness has no frontend build, so it answers 404. Not pinned, because the 404 would describe
the harness, not production.

## Blind test (one round per feature file)

- `flags.feature`: 9 proposed, 7 kept. Categories: injection or hostile topic names (SQL, HTML, non-ASCII,
  `%2F` traversal), cross-topic isolation, DELETE on a topic path. Removed: GET on a topic path (the harness
  divergence above).
- `flag-provider.feature`: 9 proposed, 4 kept: topic isolation, re-block, a 60 s outage, and a block surviving a
  later outage. Removed: two used topic names Kafka rejects (SQL text, non-ASCII), and one varied only the payload,
  which plays no part in the flag decision.

## Peer review (methodology, OpenFeature/mysql2 fidelity, IO ownership, staff)

12 changes agreed and applied (fidelity cases, scenario renames, a `__proto__` enforcement scenario, the mutant table
above). Kept by agreement: two-message log steps reuse the last payload; the reload-failure `console.warn` is
unasserted; the FATAL/NOT_READY arms of the fake SDK are unexercised.
