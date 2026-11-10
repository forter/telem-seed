# Implementation Notes: Deliver Webhooks to Subscribers

## Branch coverage accounting

Flow under test: `src/kafka/consumer.ts → handleMessage`, `src/delivery/deliver.ts`

`npx telem-bdd explore-branches` (unfiltered, all loaded files) reports 4 uncovered arms across
4 files — all classified below. Additional uncovered functions and lines in modules loaded
transitively by the app entry are classified in "Startup/shutdown infrastructure" and
"Instrumentation-artifact" sections.

---

### Coverable — scenarios written in this pass

**`src/kafka/consumer.ts:32` — `if (failure) throw failure.reason;` then branch**

Fires when `Promise.allSettled(ops)` contains at least one rejected result inside
`handleMessage`. This requires a partial DB failure: subscribers must be readable (so the
flow enters the blocked/delivery branch) but a `logAttempt` call must then throw.

Covered by: *"DB write failure during delivery log recording causes the handler to rethrow for
at-least-once retry"* — topic is blocked, MySQL configured to fail only `INSERT INTO
delivery_log` (not SELECT), so `findByTopic` succeeds and `logAttempt` throws, producing a
rejected `Promise.allSettled` result.

Required a `fake-mysql.ts` extension: added `onlyFor?: RegExp` to `configureMysql` so
delivery-log writes can be failed independently of subscriber reads.

---

### Unreachable from this flow — documented

**`src/db/index.ts:25` — `if (!pool) throw new Error('DB pool not initialised')` (then branch)**

Fires only when `getPool()` is called before `connect()`. `BeforeAll` in `world.ts` calls
`db.connect()` before any scenario runs; no scenario can bypass `BeforeAll`. This is a
programming-error sentinel, not a business-behavior branch reachable from the Kafka flow.
Classification: **defensive fallback**.

---

**`src/db/subscribers.ts:34` — `typeof row.headers === 'string' ? ... : row.headers` (falsy branch)**

The falsy arm fires when `row.headers` is already an object rather than a JSON string. MySQL's
`mysql2` driver always returns the `VARCHAR`/`JSON` `headers` column as a string; `fake-mysql`
mirrors this (`seedSubscribers` auto-stringifies; `routeQuery` deep-copies via
`JSON.parse(JSON.stringify(...))`, preserving strings). No storage path produces a pre-parsed
object.
Classification: **defensive fallback**.

---

**`src/delivery/deliver.ts:48` — `err instanceof Error ? err.message : String(err)` (falsy branch)**

The `String(err)` arm fires when `fetch()` throws a non-`Error` value (e.g. a plain string or
object). In practice, Node.js's native `fetch()` throws `TypeError` (an `Error` subclass) for
network failures; `fake-fetch` also always throws `Error` objects (`configureFetch` wraps booleans
into `new Error(...)`). The `String(err)` path is an unreachable defensive guard.
Classification: **defensive fallback**.

---

**`src/kafka/consumer.ts` — `if (topics.length === 0) return;` (else branch, no source line)**

`startConsumer()` is called exactly once during `BeforeAll` via `initKafkaFake()`. At that point
the scenario-context is `INIT_SENTINEL`, which causes `findDistinctTopics()` to return `[]`.
So `topics.length === 0` is always true and the `if` always returns early. The else path
(subscribe to pre-existing topics and start running) never fires from within the BDD setup.

Covering this would require seeding subscribers before calling `startConsumer()` — not possible
in a `BeforeAll` context where scenario state has not yet been established. The branch tests the
startup behavior of a production node that already has subscribers in MySQL; it is not exercisable
from per-scenario hooks.
Classification: **unreachable from BDD setup / startup-time branch**.

---

### Startup/shutdown infrastructure — not exercisable from BDD scenarios

These functions are called only during process startup (`main()` in `src/index.ts`) or shutdown
(`SIGTERM`/`SIGINT` handlers). The BDD harness bypasses `main()` entirely — it calls
`createApp()` and `db.connect()` directly. No scenario can trigger startup or shutdown paths.

**`src/flags/index.ts:4-9` — `initFlags()` function body**

`initFlags()` connects to the flagd gRPC daemon via OpenFeature. It is called from `main()` at
step 3 of startup. The BDD harness injects `@openfeature/server-sdk` as a pre-stubbed fake in
`require.cache` and never calls `initFlags()`. Lines 4-9 (the entire function body) are never
reached.

**`src/db/index.ts:29-34` — `close()` function body**

`close()` ends the MySQL connection pool. It is called from `shutdown()` (the SIGTERM/SIGINT
handler in `src/index.ts`). The BDD harness has no `AfterAll` that calls `db.close()` — the
fake MySQL pool requires no real teardown, and the Node process exits cleanly without it.

**`src/kafka/consumer.ts:92-99` — `startConsumer()` topics loop**

The loop at lines 92-99 subscribes to each pre-existing topic found in DB at startup. It is
gated by `if (topics.length === 0) return;` (line 87-89). During `initKafkaFake()` /
`BeforeAll`, the subscribers table is empty so `topics.length === 0` is always true and the
loop is never reached. Covering this would require pre-seeding the DB before `startConsumer()`
— structurally incompatible with per-scenario isolation.

**`src/kafka/consumer.ts:67-76` — `stopConsumer()` function body**

`stopConsumer()` is teardown infrastructure called from `shutdown()`. No scenario calls it.

---

### Instrumentation-artifact — V8 function-coverage tracking

V8 coverage tracks every function definition as a separate coverage unit, including inline
callbacks. When a `.map()`, `.catch()`, or similar higher-order call happens on an empty
collection or a never-rejected promise, the registered callback function is never invoked. V8
reports those callback bodies as uncovered lines even though the surrounding statement is reached.

**`src/db/subscribers.ts:56` — `.map((r) => r.topic)` callback in `findDistinctTopics()`**

`findDistinctTopics()` is called during `BeforeAll` via `initKafkaFake() → startConsumer()`.
The subscribers table is empty at init time, so `rows` is `[]` and the `(r) => r.topic` lambda
is never invoked. V8 marks the callback body as uncovered. The `return rows.map(...)` statement
itself is reached; the zero-iteration loop is the artifact.

**`src/kafka/consumer.ts:63` — `.catch(() => {})` callback in `subscribeToTopic()`**

`subscribeToTopic()` is called fire-and-forget from `POST /api/subscribers` in scenarios that
create a subscriber. Line 63 registers an error-swallowing catch handler
(`subscribeLock = next.catch(() => {})`). The handler `() => {}` is never invoked because the
fake Kafka never throws during `doSubscribeToTopic`. V8 reports the zero-body callback as
uncovered even though the `.catch()` registration on line 63 is executed.

---

### Other-flow and out-of-scope — not part of this flow's coverage target

**`src/api/index.ts:24-26` — SPA catch-all `app.get('*', ...)` handler**

Serves `index.html` for any non-API GET path, enabling React Router client-side navigation.
No BDD scenario makes a request to a non-API path. This handler has no observable business
behavior beyond serving a static file — it is frontend routing plumbing, not a testable product
concern. Classification: **out-of-scope (frontend SPA infrastructure)**.

**`src/api/subscribers.ts:49-50` — fire-and-forget `.catch()` on `subscribeToTopic()`**

After persisting the subscriber and returning 201, the POST handler calls
`subscribeToTopic(topic).catch(err => console.error(...))`. The `.catch()` callback (lines 49-50)
fires if `subscribeToTopic` rejects asynchronously. Since the Kafka stub never throws, the
callback body is never reached. Even if it were: the 201 response has already been sent; the
only effect is a `console.error` log. Classification: **telemetry-only** (log-only path, no
observable API behavior difference) within the subscriber management flow (flow 1).

---

## `fake-mysql.ts` extension: `onlyFor` selective failure

Added `onlyFor?: RegExp` to `configureMysql`. When set, only SQL queries matching the pattern
are failed; all other queries pass through. This enables partial-failure scenarios (e.g. reads
succeed but writes fail) that are needed to cover mid-flight rejection propagation inside
`handleMessage` without breaking `findByTopic`.
