# Flow Analysis: Manage Webhook Subscribers

**Flow:** Manage webhook subscribers
**Technical handle:** GET/POST/DELETE /api/subscribers
**Handler:** `src/api/subscribers.ts`
---

## 1. Flow Entry Point

`src/api/index.ts` — `app.use('/api/subscribers', subscribersRouter)`
Router defined in `src/api/subscribers.ts`.

---

## 2. Handler Pipeline

Global middleware first, then route handlers:

1. **`express.json()`** (global, `src/api/index.ts`) — parses JSON body. No short-circuit.
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
- `subscribeToTopic(topic)` (fire-and-forget, not awaited) → chains onto `subscribeLock`; in tests `consumer` is the kafkajs stub's consumer model (`reseatKafkaConsumer()`), so it runs stop → subscribe → run against it; each call is an owned effect (see §5)

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
| MySQL `subscribers` table | Data store | All three endpoints | **Faked at the repository seam** — `fake-db.ts` (`subscribersFake`) wired in `world.ts` via require.cache injection of `dist/db/subscribers`. Covers `listAll`, `findByTopic`, `findDistinctTopics`, `create`, `remove`; verified against the real repository by `fake-db.parity.ts`. |
| KafkaJS consumer (`subscribeToTopic`) | Message broker (fire-and-forget) | POST only | **Fake consumer model, owned** — `consumer` is the kafkajs stub's consumer (`reseatKafkaConsumer()`: fresh module state per scenario), so `doSubscribeToTopic` runs stop → subscribe → run against `createFakeConsumer()`. Each call is recorded and claimed (`takeOwnershipOfSubscriptions`, `takeOwnershipOfConsumerRunState`; the `Kafka consumer subscribes to each newly registered topic` auto-default claims them for every registration) and can `fail()`. The POST path never commits. |

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

Relevant entries in `COLLECTED-WISDOM.md`:

- **Module Loading** — `createApp()` doesn't call `db.connect()`; `world.ts` BeforeAll does.
- **DB fake layering** — the repository (`dist/db/subscribers`) is the fake boundary, not the pool; `mysql2/promise` is a throw-on-use safety net.
- **URL slash in step text** — `CucumberExpressionError: Alternative may not be empty` if step text contains `/`. Use `I GET the subscribers list`, not `GET /api/subscribers`.

---

## 9. Missing Fakes

**None.** All IO for this flow is already covered:
- `fake-db` replaces the subscribers repository (`listAll` / `create` / `remove`); the SQL itself is covered by parity, not BDD.
- The kafkajs stub's consumer models subscribe / run / stop with KafkaJS's real errors; every call is owned (see §5).

---

## Notes

1. **`headers` is a JSON column that mysql2 returns already parsed.** The fake repositories return `headers` as an object (the parity suite pins this against real MySQL), with keys re-ordered the way MySQL stores JSON. `seedSubscribers()` accepts `string | Record<string, string>` (a string is parsed); step definitions can pass plain objects.

2. **`takeOwnershipOfSubscriberCreate` returns `headers` as an object**, so compare it directly (no `JSON.parse`).

3. **POST response omits `created_at`** — `db.create()` returns `Omit<Subscriber, 'created_at'>`. Assertions on the 201 body should not expect `created_at`.

4. **Fire-and-forget Kafka subscribe in tests** — `subscribeToTopic()` runs for real against the fake consumer, in the background of the POST. Its effects are owned (the auto-default claims them; pinning scenarios take over), and the claim steps wait for in-flight calls first. A subscribe the broker rejects (illegal topic name such as "order placed") is only logged: the registration still answers 201.

5. **DELETE 404 vs 204** — the fake's `remove` returns `affectedRows` 0 for an id that isn't seeded, so deleting a non-existent id answers 404.

6. **No feature flags** — this flow is completely flag-free. The baseline flag declaration in `features/defaults.ts` is irrelevant here; no `Given` flag steps needed.
