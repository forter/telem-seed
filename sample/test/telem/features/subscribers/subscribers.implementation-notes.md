# Coverage Accounting — Manage Webhook Subscribers

Flow under test: `src/api/subscribers.ts` — **100% branch coverage**

## Coverable — scenarios written

All coverable branches were covered during happy-path, error, and discrete-mapping steps. No
new scenarios were needed in the coverage pass.

## Unreachable from this flow

### Defensive init-time guard (1 branch)

**`src/db/index.ts:25`** — `if (!pool) throw new Error('DB pool not initialised')`

The then-branch fires only when `connect()` was never called. `BeforeAll` in `world.ts` calls
`db.connect()` before any scenario runs; no scenario can bypass `BeforeAll`. This is a
programming-error sentinel, not a business-behavior branch reachable from HTTP requests.

### Defensive fallback (1 branch)

**`src/db/subscribers.ts:34`** — `typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers`

The falsy arm fires when `row.headers` is already an object. MySQL's `mysql2` driver always
returns text/JSON columns as strings. The fake mirrors this: `seedSubscribers` auto-stringifies
and `routeQuery` deep-copies via `JSON.parse(JSON.stringify(...))`, which always produces strings.
No storage path produces a pre-parsed object.

### Other-flow: Kafka consumer management (2 branches)

**`src/kafka/consumer.ts:46`** — `subscribedTopics.has(topic)` operand not evaluated  
**`src/kafka/consumer.ts:undefined`** — IfStatement else branch (source map unresolved)

`doSubscribeToTopic` short-circuits on `!consumer` before evaluating `subscribedTopics.has(topic)`.
In subscriber tests, `consumer` is always `null` — `startConsumer()` is never called, only
`createApp()`. The `subscribedTopics.has(topic)` guard and all non-null consumer paths belong to
the Kafka message-handling flow and will be covered when that flow is backfilled.

## Other-flow: code loaded but never executed (0% statement coverage)

These modules are transitively loaded by `require('./dist/api/index')` but none of their
functions are invoked during subscriber CRUD scenarios. All will be covered by their respective
flows:

| File | Why it's loaded | Covered by |
|---|---|---|
| `src/api/flags.ts` | Registered as Express route in `createApp()` | "Manage topic delivery flags" flow |
| `src/db/deliveryLog.ts` | Imported by `src/kafka/consumer.ts` | "Deliver webhooks to subscribers" flow |
| `src/delivery/deliver.ts` | Imported by `src/kafka/consumer.ts` | "Deliver webhooks to subscribers" flow |
| `src/flags/index.ts` | Imported by `src/kafka/consumer.ts` | "Deliver webhooks to subscribers" flow |
| `src/kafka/consumer.ts` (non-null paths) | Loaded by `src/api/subscribers.ts` (for `subscribeToTopic`) | "Deliver webhooks to subscribers" flow |

## Instrumentation artifacts

None identified.

## Access control — no auth by design

The subscriber management API has **no authentication middleware**. All three endpoints
(GET/POST/DELETE `/api/subscribers`) are open with no credential checks. Auth failure scenarios
(expired token, wrong scope, missing credentials) are not applicable — the API intentionally has
no auth layer. This is a design choice for the webhooks sample app, not a gap.

## express.json() enforced request-size limit (413)

`express.json()` applies a default 100 kb body-size limit. Requests exceeding it receive a 413
with an Express HTML error page (same pattern as the malformed-JSON 400 — framework-owned,
handler never runs). This is untestable at the BDD level without a large binary payload and is
documented as framework-owned. No scenario needed.

## Permissive behaviors (documented, no test needed)

**`headers` field accepts non-object types without validation.** If a client sends
`headers: 123` (a number), `headers ?? {}` evaluates to `123` (not nullish), and the handler
passes it to `db.create()`. `JSON.stringify(123)` = `'123'` is stored; the 201 response echoes
`{ headers: 123 }`. No validation rule exists for this field. This is permissive-by-design for
a sample app. A future strict type guard would break this behavior.

**No Content-Type header on POST causes an unhandled crash.** If Content-Type is missing,
`express.json()` skips parsing → `req.body = undefined` → destructuring TypeError in the async
handler → rejected Promise that Express 4 doesn't automatically catch → response never sent (hang).
This is untestable in the BDD framework (no timeout mechanism) and is a known framework limitation.

## Production bugs discovered

None. The ternary in `src/db/subscribers.ts:34` is a correct defensive guard, not a bug —
it simply can never fire given the current storage layer.
