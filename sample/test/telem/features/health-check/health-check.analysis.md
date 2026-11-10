# Flow Analysis: Health Check

**Flow:** GET /health  
**Checklist entry:** Flow 4  
**Complexity:** Low-Medium (was Low — updated after dependency-probe feature)

## 1. Flow Entry Point

- **File:** `src/api/index.ts`
- **Route:** `GET /health`
- **Handler:** async function — probes MySQL, Kafka, and OpenFeature; returns 200 (all ok) or 503 (any error)

## 2. Handler Pipeline

| Order | Handler | Short-circuits? | Modifies req/res? |
|---|---|---|---|
| 1 | `express.json()` (global) | No (GET has no body) | No |
| 2 | async health handler | Yes — always terminates | Writes JSON response (200 or 503) |

The route is registered before the REST API routers and before the static file serving / SPA catch-all. It is the first route registered.

## 3. Call Graph (Axis 2)

```
GET /health
  → ping()                         src/db/index.ts       → pool.query('SELECT 1')
  → isConsumerConnected()          src/kafka/consumer.ts → consumer !== null (with test override)
  → isFlagsReady()                 src/flags/index.ts    → flagsInitialized (with test override)
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
| `mysql2/promise` (SELECT 1) | `fake-mysql` | Read-only probe; no ownership tracking needed |
| Kafka consumer state | none (in-process) | In-process check only |
| OpenFeature provider state | none (in-process) | In-process check only |

`SELECT 1` routes to the fake's unknown-SQL fallback and returns `[[], {}]` — no ownership event recorded. The `assertNoUnownedChanges` default still holds: SELECT 1 is a read, not a tracked write.

## 6. Configuration Dimensions

Three binary dep states × 2^3 = 8 observable combinations (all covered in the feature file):

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

`grep -rn "health\|ping\|isConsumerConnected\|isFlagsReady" src/` found:
- `src/api/index.ts` — health handler, imports ping, isConsumerConnected, isFlagsReady (accounted for)
- `src/db/index.ts` — ping() (accounted for)
- `src/kafka/consumer.ts` — isConsumerConnected(), __overrideConsumerConnectedForTest() (accounted for)
- `src/flags/index.ts` — isFlagsReady(), __overrideFlagsReadyForTest(), flagsInitialized (accounted for)
- `src/index.ts` — comment ("Start Express first so /health responds immediately") — documentation only

No unaccounted-for code.

## 8. COLLECTED-WISDOM Entries

`initFlags()` must be called in world.ts BeforeAll to set `flagsInitialized = true` — the harness was
calling `db.connect()` and `initKafkaFake()` but not `initFlags()`, leaving `isFlagsReady()` returning
false in all tests. Fixed by adding `flagsModule.initFlags()` after `createApp()` in BeforeAll.

## 9. Missing Fakes

None — MySQL SELECT 1 is handled by the existing fake-mysql; Kafka and OpenFeature state checks are in-process.

## Notes

- Test overrides (`__overrideConsumerConnectedForTest`, `__overrideFlagsReadyForTest`) are exported test
  hooks in production code. They are the minimal touch that avoids stopping/restarting the real consumer
  or re-initializing the flags module between scenarios.
- The previous implementation was a single-expression unconditional 200. This analysis supersedes the
  original which said "no IO dependencies" and "call graph has no sub-module calls."
