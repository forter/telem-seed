# Flow Analysis: Health Check

**Flow:** GET /health
**Complexity:** Low-Medium

## 1. Flow Entry Point

- **File:** `src/api/index.ts`
- **Route:** `GET /health`
- **Handler:** async function — probes MySQL, Kafka, and OpenFeature; returns 200 (all ok) or 503 (any error)

## 2. Handler Pipeline

| Order | Handler | Short-circuits? | Modifies req/res? |
|---|---|---|---|
| 1 | `express.json()` (global) | Yes — 400 malformed or undecodable gzip / 413 oversized (gzip measured inflated) / 415 unsupported `Content-Encoding`, for any method, before routing and before any probe | No |
| 2 | async health handler (GET, and HEAD derived from it) | Yes — always terminates | Writes JSON response (200 or 503) |
| 3 | `express.static(publicDir)` | Serves files under `dist/public`; a `..` path gets 403 internally, which `fallthrough` turns into `next()` | No |
| 4 | SPA catch-all `app.get('*')` | Yes — `sendFile(index.html)`; GET only, so other methods fall to Express's 404 | No |

The route is registered before the REST API routers and before the static file serving / SPA catch-all. It is the first route registered.

## 3. Call Graph (Axis 2)

```
GET /health
  → ping()                         src/db/index.ts       → pool.query('SELECT 1')
  → isConsumerConnected()          src/kafka/consumer.ts → consumer !== null (an unused test override short-circuits it).
                                   startConsumer() assigns `consumer` before connect/subscribe/run, so a failed start still reads ok
  → isFlagsReady()                 src/flags/index.ts    → flagsInitialized (an unused test override short-circuits it)
```

Response:
- All three ok → 200 `{ status: 'ok', dependencies: { mysql: 'ok', kafka: 'ok', flags: 'ok' } }`
- Any error → 503 `{ status: 'degraded', dependencies: { ... } }`

## 4. Service Boundaries (Axis 3)

- **MySQL** (read) — `SELECT 1` via the pool. Failure is caught; does not propagate to a 5xx.
- **Kafka consumer state** — in-process module-level `consumer` variable. No network call.
- **OpenFeature provider state** — in-process `flagsInitialized` boolean. No network call.

## 5. IO Dependencies

| Boundary | Fake | Access type |
|---|---|---|
| `db.ping()` (`src/db/index.ts`; `SELECT 1` against real MySQL) | `fake-db` (`dbIndexFake.ping`, failure-injectable as `db.ping`) | Read-only probe; no ownership tracking needed |
| Kafka consumer state | none (in-process) | In-process check only |
| OpenFeature provider state | none (in-process) | In-process check only |

`db.ping` is a read on the repository-seam fake: it records nothing to own, and `fail(sid, 'db.ping', seq)` drives its failure. The Kafka scenarios that restart or stop the consumer produce owned lifecycle effects (subscribe / run / stop).

## 6. Configuration Dimensions

Three binary dependency states give 2^3 = 8 combinations, all covered in the feature file. There is no short-circuit: every probe runs whatever the others return. The full decision tables (adding the Kafka startup outcomes, the HEAD verb, method × body and path variants) are the gitignored TSVs named in the implementation notes.

| mysql | kafka | flags | status |
|---|---|---|---|
| ok | ok | ok | 200 |
| error | ok | ok | 503 |
| ok | error | ok | 503 |
| ok | ok | error | 503 |
| error | ok | error | 503 |
| error | error | ok | 503 |
| ok | error | error | 503 |
| error | error | error | 503 |

## 7. Domain-Wide Sweep Results

`grep -rn "health\|ping\|isConsumerConnected\|isFlagsReady" src/` found only the call graph above plus the two `__override…ForTest` hooks and `flagsInitialized`; `src/index.ts` has a comment only ("Start Express first so /health responds immediately"). Nothing else.

## 8. Harness requirements

`world.ts` BeforeAll calls `initFlags()` after `createApp()`; without it `isFlagsReady()` is false in every scenario.

## 9. Missing Fakes

None — `db.ping()` is handled by fake-db; Kafka and OpenFeature state checks are in-process.

## Notes

- `__overrideConsumerConnectedForTest` and `__overrideFlagsReadyForTest` are exported test hooks in production code that no step uses: the steps stop the real consumer and swap in an uninitialised copy of the flags module, so the real probes answer. Both are proposed for deletion (`FOLLOWUP.md`).
