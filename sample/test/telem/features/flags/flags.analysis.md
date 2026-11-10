# Flow Analysis: Manage Topic Delivery Flags

Flow: `GET /api/flags` and `PATCH /api/flags/:topic`

> **Updated (MySQL migration):** migrated from flagd+flags.json to MySQL topic_flags table.
> The old analysis (file-based implementation) is superseded.

---

## 1. Flow Entry Point

- **File**: `src/api/flags.ts`
- **Registered**: `src/api/index.ts:16` — `app.use('/api/flags', flagsRouter)`
- **Handlers**:
  - `GET /` — line 7
  - `PATCH /:topic` — line 19

---

## 2. Handler Pipeline

**Global middleware (Express)**
1. `express.json()` — parses JSON body; needed for PATCH's `delivery_blocked`

**GET /api/flags**
1. `getAll()` (`src/db/topicFlags.ts`) — `SELECT topic, blocked FROM topic_flags ORDER BY topic`
2. Maps rows to `{ [topic]: boolean }` (`blocked === 1` → `true`)
3. Sends `res.json(result)` — 200
4. On DB error: `res.status(500).json({ error: 'Internal server error' })`

**PATCH /api/flags/:topic**
1. Extracts `topic` from `req.params.topic`
2. Extracts `delivery_blocked` from `req.body`
3. **Short-circuit**: if `typeof delivery_blocked !== 'boolean'` → 400 (no DB IO)
4. `upsert(topic, delivery_blocked)` (`src/db/topicFlags.ts`) — `INSERT ... ON DUPLICATE KEY UPDATE`
5. `res.json({ topic, delivery_blocked })` — 200
6. On DB error: `res.status(500).json({ error: 'Internal server error' })`

No writeLock — MySQL UPSERT is atomic; concurrent PATCHes are safe at the DB level.

---

## 3. Call Graph

- `getAll()` → `getPool().query('SELECT topic, blocked FROM topic_flags ORDER BY topic')`
- `upsert()` → `getPool().execute('INSERT INTO topic_flags ... ON DUPLICATE KEY UPDATE ...')`
- No sub-modules, no HTTP out, no flag reads, no Kafka.

---

## 4. Service Boundaries

MySQL only (via shared `mysql2/promise` pool). No filesystem IO. No flagd/gRPC.

---

## 5. IO Dependencies

| IO Dependency | Type | Used In | Fake Status |
|---|---|---|---|
| `mysql2/promise` pool — `topic_flags` table | Database | `src/db/topicFlags.ts` | ✅ `fake-mysql.ts` — routes `SELECT topic, blocked FROM topic_flags` and `INSERT INTO topic_flags` |

**Note on separation**: `MySqlFlagsProvider` (in `src/flags/MySqlFlagsProvider.ts`) also queries `topic_flags`, but via the OpenFeature SDK path (`isTopicBlocked()` from the Kafka handler). That SDK path is faked entirely at the `@openfeature/server-sdk` level — `MySqlFlagsProvider` never runs in BDD tests. This flow's BDD scope is: HTTP responses and MySQL topic_flags state.

---

## 6. Configuration Dimensions

| Configuration | Type | Effect |
|---|---|---|
| `topic_flags` table content | DB state | Determines what GET returns; PATCH mutates it |

No env vars captured at module scope. No module-scope state hazards (writeLock was removed).

---

## 7. Domain Sweep

```
grep -r "topic_flags\|topicFlags" src/ --include="*.ts"
```

Results:
- `src/db/topicFlags.ts` — primary repository (`getAll`, `upsert`)
- `src/flags/MySqlFlagsProvider.ts` — separate query path for OpenFeature SDK (out of this flow's scope)

The HTTP flags API and the OpenFeature provider both read `topic_flags`, but through independent code paths. This flow owns only `src/api/flags.ts` + `src/db/topicFlags.ts`.

---

## 8. COLLECTED-WISDOM Entries

Relevant entries:
- **IO boundary packages pre-stubbed in require.cache** — same pattern for `mysql2/promise`
- **fake-mysql.ts topic_flags routing** — `SELECT topic, blocked FROM topic_flags` and `INSERT INTO topic_flags` routed in `routeQuery()`

---

## 9. Three-State Flag Semantics

| DB state | GET returns | `isTopicBlocked()` |
|---|---|---|
| No row for topic | Topic absent from response | `false` (defaultValue) |
| Row with `blocked=0` | `{ topic: false }` | `false` |
| Row with `blocked=1` | `{ topic: true }` | `true` |

PATCH always upserts — it never deletes rows. Unblocking sets `blocked=0`, not removes the row.

---

## 10. Notes

- **`delivery_blocked` type validation is strict**: only `boolean` passes; `"true"`, `null`, `undefined`, `1` all return 400.
- **Unblocking writes a row with `blocked=0`** — the topic remains visible in GET with `blocked: false`. This is distinct from "never managed" (absent from GET). Three states, not two.
- **`__proto__` topic name works correctly** — parameterized SQL stores it as a plain VARCHAR. The old file-based bug (prototype setter silently dropped the entry) is fixed.
- **No auth on flag mutations** — any caller with network access can block/unblock. By design for this sample app.
