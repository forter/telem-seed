# Health Check — Implementation Notes

## Coverage Summary

The `/health` handler is an async function with branches on three independent boolean checks
(`mysqlOk`, `isConsumerConnected()`, `isFlagsReady()`). All 8 combinations (2^3) are exercised by the
feature file's scenarios.

The `healthy` variable gates the HTTP status code (200 vs 503) and the `status` field (`'ok'` vs
`'degraded'`). All branches of the `deps` object construction and the `healthy` boolean are covered.

## IO Produced by This Flow

`ping()` calls `pool.query('SELECT 1')`. The MySQL fake's `routeQuery` routes unknown SQL to the
fallback `return [[], {}]` — no ownership event is recorded. The `assertNoUnownedChanges` default
continues to hold: reads are not tracked by the ownership safety net.

## Authentication

No authentication on any endpoint by design. Auth failure modes are vacuously N/A.

## Belt-and-Suspenders Scenario

"Health check endpoint is read-only" (POST /health → 404) guards against accidental mutation-traffic
exposure. Zero `src/` lines execute (404 is Express's routing fallthrough).

## Framework-Owned Protocol Branches (no scenarios)

| Method | Body state | Response | Reason: framework-owned |
|---|---|---|---|
| GET | Malformed JSON | 400 | `express.json()` rejects before handler runs |
| GET | Oversized (>100kb) | 413 | `express.json()` rejects before handler runs |
| HEAD | any | 200 empty | Express auto-derives HEAD from GET — no src/ branching |
| POST | Malformed JSON | 400 | `express.json()` rejects before 404 fallthrough |
| POST | Oversized (>100kb) | 413 | `express.json()` rejects before 404 fallthrough |

## Test Hooks in Production Code

`__overrideConsumerConnectedForTest(value)` and `__overrideFlagsReadyForTest(value)` are exported from
`consumer.ts` and `flags/index.ts` respectively. They exist to let step definitions simulate dep failure
without stopping the real consumer or re-initializing the flags module between scenarios. The `__`
prefix marks them as test-only.

## Uncovered Lines in src/api/index.ts (SPA catch-all)

```ts
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
```

Out-of-scope. Exercising it requires `GET /some-client-path` — a future "static serving / React Router
fallback" flow. No branch arms are missing inside this handler.

## Globally Uncovered Arms (other files — not in health-check call path)

| File | Branch | Belongs to |
|---|---|---|
| `src/db/index.ts` | `getPool()` throws when pool uninitialised | DB error path — subscriber/delivery flows |
| `src/db/subscribers.ts` | `headers` ternary falsy branch | Subscriber flow |
| `src/kafka/consumer.ts` | `subscribedTopics.has(topic)` short-circuit | Kafka consumer flow |
| `src/kafka/consumer.ts` | Unnamed `IfStatement` else branch | Kafka consumer flow |
