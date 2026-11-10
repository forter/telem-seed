# Flow Analysis: Manage Webhook Subscribers

**Flow:** Manage webhook subscribers
**Technical handle:** GET/POST/DELETE /api/subscribers
**Handler:** `src/api/subscribers.ts`
---

## 1. Flow Entry Point

`src/api/index.ts:15` — `app.use('/api/subscribers', subscribersRouter)`
Router defined in `src/api/subscribers.ts`.

---

## 2. Handler Pipeline

Global middleware first, then route handlers:

1. **`express.json()`** (global, `src/api/index.ts:9`) — parses JSON body. No short-circuit.
2. **GET `/`** (`src/api/subscribers.ts:17`) — calls `db.listAll()`; returns 200 JSON array. 500 on error.
3. **POST `/`** (`src/api/subscribers.ts:28`) — validates required fields (`name`, `topic`, `url`); validates URL protocol; calls `db.create()`; fires `subscribeToTopic()` fire-and-forget; returns 201 with subscriber object. Short-circuits with 400 on validation failure, 500 on DB error.
4. **DELETE `/:id`** (`src/api/subscribers.ts:60`) — parses `:id` as int; calls `db.remove()`; returns 204 on success, 404 if no rows affected, 400 if id is NaN, 500 on DB error.

---

## 3. Call Graph (Axis 2)

### GET /api/subscribers
- `db.listAll()` → `getPool().query('SELECT id, name, topic, url, headers, created_at FROM subscribers ORDER BY id')` → `parseRow()` per row (JSON.parses `headers` string)

### POST /api/subscribers
- `isValidWebhookUrl(url)` — pure function; parses URL via `new URL()`, checks `protocol === 'http:' || 'https:'`
- `db.create({ name, topic, url, headers })` → `getPool().query('INSERT INTO subscribers (name, topic, url, headers) VALUES (?, ?, ?, ?)')` → returns `{ id: result.insertId, name, topic, url, headers }`
- `subscribeToTopic(topic)` (fire-and-forget, not awaited) → chains onto `subscribeLock`; in tests `consumer === null` so `doSubscribeToTopic` returns immediately — no Kafka IO occurs

**POST response shape:** `Omit<Subscriber, 'created_at'>` — `{ id, name, topic, url, headers }`. No `created_at` in the response.

### DELETE /api/subscribers/:id
- `parseInt(req.params.id, 10)` — pure
- `db.remove(id)` → `getPool().query('DELETE FROM subscribers WHERE id = ?')` → returns `affectedRows`
- 404 when `affectedRows === 0` (id didn't match any row)

---

## 4. Service Boundaries (Axis 3)

None. All logic within the Express app; no cross-service calls.

---

## 5. IO Dependencies

| IO Dependency | Type | Used In | Fake Status |
|---|---|---|---|
| MySQL `subscribers` table | Data store | All three endpoints | **Faked** — `fake-mysql.ts` wired in `world.ts` via require.cache injection. Covers SELECT (listAll + findByTopic), INSERT, DELETE. |
| KafkaJS consumer (`subscribeToTopic`) | Message broker (fire-and-forget) | POST only | **No-op stub** — `consumer === null` in tests; `doSubscribeToTopic` returns immediately. No fake registration needed; no IO occurs. |

**No missing fakes** for this flow.

---

## 6. Configuration Dimensions

| Configuration | Type | Effect | Values |
|---|---|---|---|
| None | — | No flags, no env vars read in handler | — |

The handler reads no feature flags and no env vars. MySQL connection vars are loaded at startup (bypassed in tests). No behavioral dimensions to test.

---

## 7. Domain Sweep Results

`grep -rn "subscriber"` also matched:
- `src/kafka/consumer.ts` — uses `findByTopic()` / `findDistinctTopics()` for the Kafka fan-out flow (different flow, different test file)
- `src/delivery/deliver.ts` — uses `Subscriber` type for the delivery flow

No code outside the subscriber management call graph exercises this flow's handler. No dynamically loaded modules or plugin dispatch found.

---

## 8. COLLECTED-WISDOM Entries

Relevant entries found (line refs into `COLLECTED-WISDOM.md`):

- **Pool initialization** — `db.connect()` is called in `BeforeAll`, not by `createApp()`. Already handled correctly in `world.ts`.
- **require.cache pattern** — pool is shared because `dist/db/index.js` is pre-loaded before `createApp()`. No proxyquire eviction.
- **MySQL fake layering** — pool IS the IO boundary; `dist/db/subscribers.js` is a thin SQL wrapper covered transitively.
- **URL slash in step text** — `CucumberExpressionError: Alternative may not be empty` if step text contains `/`. Use `GET the subscribers list`, not `GET /api/subscribers`.

---

## 9. Missing Fakes

**None.** All IO for this flow is already covered:
- MySQL fake handles SELECT / INSERT / DELETE for the `subscribers` table.
- KafkaJS is a no-op stub (fire-and-forget path returns early; no assertions needed).

---

## Notes

1. **`headers` JSON serialization** — MySQL stores `headers` as a JSON string; `parseRow()` JSON.parses it on SELECT. The fake's `seedSubscribers()` accepts `string | Record<string, string>`. Step definitions seeding subscriber rows can pass plain objects; the fake auto-stringifies.

2. **`takeOwnershipOfSubscriberInsert` returns headers as a JSON string** — step definitions asserting on the returned insert must `JSON.parse(result.headers)` to compare as an object.

3. **POST response omits `created_at`** — `db.create()` returns `Omit<Subscriber, 'created_at'>`. Assertions on the 201 body should not expect `created_at`.

4. **Fire-and-forget Kafka subscribe in tests** — `subscribeToTopic()` is called but consumer is null; `doSubscribeToTopic` returns immediately. The ownership safety net does not flag this (no Kafka IO is written). No special handling needed in scenarios.

5. **DELETE 404 vs 204** — the fake's DELETE handler correctly tracks `affectedRows` (0 if id not in `state.subscribers`). Scenarios for non-existent id deletion will get 404.

6. **No feature flags** — this flow is completely flag-free. The baseline flag declaration in `features/defaults.ts` is irrelevant here; no `Given` flag steps needed.
