# Flow Analysis: Manage Topic Delivery Flags

Flow: `GET /api/flags` and `PATCH /api/flags/:topic`

---

## 1. Flow Entry Point

- **File**: `src/api/flags.ts`
- **Registered**: `src/api/index.ts` — `app.use('/api/flags', flagsRouter)`
- **Handlers**: `GET /` and `PATCH /:topic`

---

## 2. Handler Pipeline

**Global middleware (Express)**
1. `express.json()` — parses JSON body; needed for PATCH's `delivery_blocked`

**GET /api/flags**
1. `getAll()` (`src/db/topicFlags.ts`) — `SELECT topic, blocked FROM topic_flags ORDER BY topic`, mapping `blocked === 1` to a boolean
2. The handler assigns each row into a plain object, `result[flag.topic] = flag.blocked`
3. Sends `res.json(result)` — 200
4. On DB error: `res.status(500).json({ error: 'Internal server error' })`

**PATCH /api/flags/:topic**
1. Extracts `topic` from `req.params.topic`
2. Extracts `delivery_blocked` from `req.body`
3. **Short-circuit**: if `typeof delivery_blocked !== 'boolean'` → 400 (no DB IO)
4. `upsert(topic, delivery_blocked)` (`src/db/topicFlags.ts`) — `INSERT ... ON DUPLICATE KEY UPDATE`
5. `res.json({ topic, delivery_blocked })` — 200
6. On DB error: `res.status(500).json({ error: 'Internal server error' })`

No application lock: the MySQL upsert is atomic, so concurrent PATCHes are safe at the DB level.

---

## 3. Call Graph

- `getAll()` → `getPool().query('SELECT topic, blocked FROM topic_flags ORDER BY topic')`
- `upsert()` → `getPool().execute('INSERT INTO topic_flags ... ON DUPLICATE KEY UPDATE ...')`
- No sub-modules, no HTTP out, no flag reads, no Kafka.

---

## 4. Service Boundaries

MySQL only (via shared `mysql2/promise` pool). No filesystem IO.

---

## 5. IO Dependencies

| IO Dependency | Type | Used In | Fake Status |
|---|---|---|---|
| `topic_flags` table (via the `src/db/topicFlags.ts` repository) | Database | `src/db/topicFlags.ts` | ✅ `fake-db.ts` (`topicFlagsFake`) — repository-level fake: `getAll()` (ordered by topic, collation-aware) and `upsert()`; verified against the real repository by `fake-db.parity.ts` |
| `topic_flags` table (via `getPool().query`, bypassing the repository) | Database | `src/flags/MySqlFlagsProvider.ts` `loadCache()` | ✅ `fake-db.ts` provider-only pool (`enableTopicFlagsPool`, operation `pool.query`) — answers only `SELECT topic, blocked FROM topic_flags`, blocked as 0/1; opt-in per scenario |
| `@openfeature/server-sdk` | Flag SDK | `src/flags/index.ts` | ✅ `fake-openfeature.ts`. Default: answers from fake-db rows (provider never runs). With `useRealFlagsProvider()`: runs the real provider, reproducing `setProviderAndWait` / `getBooleanValue` semantics |
| `setInterval` (5 s cache reload) | Timer | `MySqlFlagsProvider.initialize()` | ✅ `non-determinism.ts` virtual clock (`useVirtualIntervals` / `advanceVirtualClock`), opt-in per scenario |

**Two feature files**: `flags.feature` covers the HTTP API, where the provider is invisible. `flag-provider.feature` opts into the real provider and observes it through Kafka delivery and `delivery_log` (three startup states, the 5 s reload boundary, repeated reloads, out-of-band row delete, stale-on-reload-failure and recovery, fatal `initFlags()`, exact-case cache lookups).

---

## 6. Configuration Dimensions

| Configuration | Type | Effect |
|---|---|---|
| `topic_flags` table content | DB state | Determines what GET returns; PATCH mutates it |

No env vars captured at module scope.

---

## 7. Domain Sweep

```
grep -r "topic_flags\|topicFlags" src/ --include="*.ts"
```

Results:
- `src/db/topicFlags.ts` — primary repository (`getAll`, `upsert`)
- `src/flags/MySqlFlagsProvider.ts` — separate query path for the OpenFeature SDK (covered by `flag-provider.feature`)

The HTTP flags API and the OpenFeature provider both read `topic_flags`, through independent code paths with different key semantics: the table (and so the API) is case-insensitive, while the provider's cache is a JS `Map` and is exact-case. This flow owns `src/api/flags.ts`, `src/db/topicFlags.ts`, `src/flags/index.ts` and `src/flags/MySqlFlagsProvider.ts`.

### Provider pipeline (`flag-provider.feature`)
1. `initFlags()` → `setProviderAndWait(new MySqlFlagsProvider())` → `initialize()` → `loadCache()` (awaited; a rejection makes `initFlags()` reject, and `src/index.ts` `main()` exits the process) → `setInterval(loadCache, 5000)`
2. Each reload builds a new `Map` and replaces the cache (deleted rows disappear); a failed reload is logged and the old cache is kept
3. `isTopicBlocked(topic)` → `getBooleanValue(topic, false)` → `resolveBooleanEvaluation` → `cache.get(topic)` (exact-case), or the default `false` on a miss

---

## 8. COLLECTED-WISDOM Entries

"The DB fake is at the repository seam" (parity pins collation: a re-cased topic is the same `topic_flags` row) and "fake-openfeature is backed by fake-db".

---

## 9. Three-State Flag Semantics

| DB state | GET returns | `isTopicBlocked()` |
|---|---|---|
| No row for topic | Topic absent from response | `false` (defaultValue) |
| Row with `blocked=0` | `{ topic: false }` | `false` |
| Row with `blocked=1` | `{ topic: true }` | `true` |

PATCH always upserts — it never deletes rows. Unblocking sets `blocked=0`, not removes the row.

`isTopicBlocked()` reads the provider's cache, not the table: a change appears at the first reload after it (up to 5 s later, on a fixed period from startup), and a reload that cannot reach MySQL keeps the previous state (stale, not fail-open).

---

## 10. Notes

- **`delivery_blocked` type validation is strict**: only `boolean` passes; `"true"`, `null`, `undefined`, `1` all return 400.
- **Unblocking writes a row with `blocked=0`** — the topic remains visible in GET with `blocked: false`. This is distinct from "never managed" (absent from GET). Three states, not two.
- **`__proto__` topic name is half-fixed** — PATCH stores and enforces it (parameterized SQL), but the GET handler's `result[flag.topic] = flag.blocked` hits the `__proto__` setter, so the row is missing from the listing. Pinned in `flags.feature`.
- **Case-variant topics** — PATCH "Orders" lands on an existing "orders" row (collation) and keeps the old spelling; the exact-case cache then never blocks "Orders". Pinned in both feature files.
- **Non-JSON bodies** — body-parser 1.x sets `req.body = {}` when it does not parse, so a plain-text PATCH gets the normal 400 (it does not hang).
- **No auth on flag mutations** — any caller with network access can block/unblock. By design for this sample app.
