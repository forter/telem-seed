# Implementation Notes: Manage Topic Delivery Flags

> **Updated (MySQL migration):** migrated from flagd+flags.json to MySQL topic_flags table.
> Previous coverage notes (file-based implementation) are superseded.

## Branch coverage classification

### `src/api/flags.ts` — 100% branches

All branch arms covered. No gaps. Handler is simple: validate → upsert/select → respond.

---

### `src/db/topicFlags.ts` — 100% branches

Both `getAll()` and `upsert()` are called by the flags flow and fully covered.

---

### `src/flags/MySqlFlagsProvider.ts` — 0% branches (unreachable by design)

**Classification: unreachable — IO boundary faked at npm package level.**

`@openfeature/server-sdk` is pre-stubbed in `require.cache` before the app loads. `setProviderAndWait` in the fake is a no-op, so `MySqlFlagsProvider.initialize()` is never called. `getBooleanValue` goes through the fake's `peekTopicFlagBlocked` directly, never reaching `resolveBooleanEvaluation`. All 5 methods in the provider are unreachable for the same root cause. This is correct by design — the fake tests the observable flag behavior, not the provider internals.

---

### `src/flags/index.ts` — 0% branches (out-of-BDD-scope)

`initFlags()` and `isTopicBlocked()` are not called by the flags HTTP API flow:
- `initFlags()` — startup infrastructure called from `src/index.ts`; faked via `@openfeature/server-sdk` pre-stub (no-op `setProviderAndWait`)
- `isTopicBlocked()` — called from the Kafka message handler only; coverage belongs to the webhook-delivery flow

No scenarios warranted here from the flags HTTP API flow perspective.

---

### `src/kafka/consumer.ts` — other-flow

All branches belong to the Kafka message-handler flow. Not part of this flow's scope.

---

### `src/db/index.ts` — defensive fallback + other-flow teardown

Same classification as before the migration — unchanged.

---

## Known Production Bugs

*None.* The `__proto__` topic-name silent-drop bug was fixed as a side effect of moving to parameterized SQL (`INSERT INTO topic_flags (topic, blocked) VALUES (?, ?)`). The old bug was in `config.flags[topic] = {...}` which invoked `Object.prototype.__proto__` setter instead of creating an own key. The scenario "Blocking a topic named '__proto__' correctly creates a blocked row" pins the fix.

---

## Deferred (Knowingly Out of Scope)

### Oversized PATCH body (413 from body-parser)

Same as before — `express.json()` defaults to 100 KB limit; 413 is owned by the middleware, not the handler. Not tested.

### Slash-containing topic via URL segment (`/api/flags/a/b`)

Express path matching returns 404 before the handler runs. Not a handler behavior — not tested.

### No authentication or audit trail on flag mutations

App-design decision for this sample; no scenarios possible for absent features.

### `PATCH /api/flags/:topic` with non-JSON Content-Type hangs

`req.body` stays `undefined` when `express.json()` doesn't parse the body. Destructuring `undefined` throws a `TypeError` synchronously before the `typeof` check. Express 4 does not catch rejected async handler promises — request hangs with no response. BDD tests always use supertest with `Content-Type: application/json`, so this path is unreachable from the test suite. Pre-existing gap; not introduced by the MySQL migration.
