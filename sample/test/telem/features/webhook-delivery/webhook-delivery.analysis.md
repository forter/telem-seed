# Flow Analysis: Deliver webhooks to subscribers

**Flow:** Kafka message → flag check → HTTP fan-out → delivery log

---

## 1. Flow Entry Point

- **File:** `src/kafka/consumer.ts`
- **Function:** `handleMessage` (exported)
- **Signature:** `({ topic, partition, message }: EachMessagePayload) => Promise<void>`
- **How triggered in production:** KafkaJS `consumer.run({ eachMessage: handleMessage })`
- **How triggered in tests:** called directly (it's exported; no KafkaJS consumer needed)

---

## 2. Handler Pipeline

No middleware chain — single async function.

| Step | Code | Short-circuits? | IO? |
|---|---|---|---|
| Parse message | `message.key.toString()`, `message.value.toString()` | No | No |
| `findByTopic(topic)` | DB SELECT subscribers WHERE topic = ? | Yes — if 0 subscribers, jumps to commitOffsets | MySQL read |
| `isTopicBlocked(topic)` | OpenFeature flag check | Yes (path-diverting) — determines block vs deliver branch | OpenFeature |
| **Blocked branch** | `logAttempt(..., 'blocked', ...)` per subscriber | — | MySQL write |
| **Delivery branch** | `deliver(sub, topic, key, payload)` per subscriber | — | HTTP + MySQL write per attempt |
| `Promise.allSettled(ops)` | Fan out all ops concurrently | — | — |
| Rejection propagation | `if (failure) throw failure.reason` | Yes — throws, prevents offset commit → KafkaJS retries | — |
| `consumer!.commitOffsets(...)` | Commit next offset | No | Kafka (stubbed) |

### `deliver()` internals (`src/delivery/deliver.ts`)

| Step | IO |
|---|---|
| `randomUUID()` | non-determinism (faked) |
| `fetch(subscriber.url, { POST, headers, body: payload })` | HTTP (fake-fetch) |
| `logAttempt(..., 'success', ...)` on 2xx | database write (fake-db) |
| `logAttempt(..., 'failed'/'exhausted', ...)` on non-2xx / network error | database write (fake-db) |
| `sleep(RETRY_DELAYS[attempt-1])` | setTimeout (runs at 0ms; the requested delay is recorded and owned — `takeOwnershipOfTimerDelays`) |

Retry loop runs up to `WEBHOOK_MAX_ATTEMPTS` times (env var, default 6, captured at module scope). The wait after failed attempt `i + 1` is `min(1000 * 2^i, 30000)` ms; scenarios assert the schedule with `the retries should have waited "…" between attempts` and vary the limit with `deliveries are limited to N attempts`.

---

## 3. IO Dependencies

| IO Dependency | Type | Used In | Fake Status |
|---|---|---|---|
| MySQL — `subscribers` table (`findByTopic`) | Data store | `findByTopic` (`src/db/subscribers.ts`) | ✅ Faked + wired (`fake-db.ts` → `seedSubscribers`, `subscribersFake.findByTopic`) |
| MySQL — `delivery_log` table (`logAttempt`) | Data store | `logAttempt` (`src/db/deliveryLog.ts`) | ✅ Faked + wired (`fake-db.ts` → `deliveryLogFake.logAttempt`; FK to `subscribers` enforced) |
| OpenFeature SDK (`isTopicBlocked`) | Feature flag | `isTopicBlocked(topic)` (`src/flags/index.ts`) | ✅ Faked + wired (`fake-openfeature.ts` → `blockTopic`, `fail` for provider failures) |
| HTTP outbound (`fetch`) | External service | `deliver()` fetch call (`src/delivery/deliver.ts`) | ✅ Faked + wired (`fake-fetch.ts` → `seedResponse`, `fail`, `takeOwnershipOfDeliveriesForUrl`) |
| `crypto.randomUUID` | Non-determinism | `deliveryId` in `deliver()` | ✅ Faked (non-determinism.ts — deterministic counter) |
| `setTimeout` | Non-determinism | `sleep()` in `src/delivery/deliver.ts` | ✅ Faked (non-determinism.ts — 0ms in scenario, requested delay recorded and owned) |
| `kafkajs` Consumer (`consumer.commitOffsets`) | External service (outbound commit) + inbound driver | end of `handleMessage` | ✅ Faked + wired (`fake-kafka.ts` → `dispatchKafkaMessage`, `takeOwnershipOfCommittedOffsets`, `fail('kafka.commitOffsets')`; parity vs Apache Kafka — see §7) |

---

## 4. Configuration Dimensions

| Config | Type | Where Read | Default | Effect |
|---|---|---|---|---|
| `WEBHOOK_MAX_ATTEMPTS` | Env var (int, ≥1) | `MAX_ATTEMPTS` in `src/delivery/deliver.ts` — **module scope** | `6` | Total delivery attempts. Captured once at module load; a scenario overrides it with the `deliveries are limited to N attempts` step (loads a second copy of `deliver.ts`) |
| `<topic>` OpenFeature flag | Binary (dynamic key = topic string) | `isTopicBlocked(topic)` (`src/flags/index.ts`), called from `handleMessage` | `false` (not blocked) | Path-diverting: `true` → all subscribers get `logAttempt(blocked)`, no HTTP delivery |

**`WEBHOOK_MAX_ATTEMPTS` module-scope capture:** `deliver.ts` evaluates `Math.max(1, parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10))` at module load. Per-scenario `process.env` changes have no effect — the value is frozen at `6` unless a scenario uses `deliveries are limited to N attempts` or `the WEBHOOK_MAX_ATTEMPTS setting is "…"` (both load a second copy of `deliver.ts`; see COLLECTED-WISDOM.md).

How each value is read (every row pinned by a scenario): unset or `''` → 6; `0` / negative → 1 (clamped); `2.5` → 2 (truncated); **non-numeric → `NaN`, because `Math.max(1, NaN)` is `NaN` — the retry loop never runs, so no POST, no log row, and the offset is committed (silent drop; production bug).** The default schedule is 1, 2, 4, 8, 16 s; the 30 s cap is only reached at 7+ attempts.

---

## 5. Domain Sweep Results

Grepped `src/` for `handleMessage`, `deliver`, `delivery_log`, `logAttempt`, `isTopicBlocked`, `commitOffset`: `src/kafka/consumer.ts` (entry point), `src/delivery/deliver.ts`, `src/db/deliveryLog.ts`, `src/flags/index.ts`, `src/api/flags.ts` (flags flow) and `src/index.ts` (startup, never loaded). Nothing outside the traced call graph.

---

## 6. COLLECTED-WISDOM Entries

"The Kafka fake", "The Kafka consumer lifecycle" (the stub's subscribe/run/stop are an owned model; `connect`/`disconnect` are plain state; `commitOffsets` captures `{topic, partition, offset}`), "WEBHOOK_MAX_ATTEMPTS is frozen at module load" and "Scenario ids and randomUUID".

---

## 7. Fakes and parity

### Inbound Kafka

`consumer` in `src/kafka/consumer.ts` is a module-level variable that is `null` until `startConsumer()` runs, which only `src/index.ts` does, and tests never load it. `handleMessage` ends with:

```typescript
await consumer!.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
```

which would throw a `TypeError` on every direct call. `fake-kafka.ts` therefore:
1. `reseatKafkaConsumer()` (alias `initKafkaFake()`) — in BeforeAll and before every scenario: loads `dist/kafka/consumer` again for fresh module state and calls `startConsumer()`. With the kafkajs stub in require.cache this sets `consumer` to the stub's consumer model, and returns early since `findDistinctTopics()` has nothing yet.
2. `dispatchKafkaMessage(topic, payload | null, key | null, { partition, offset })` — builds the `EachMessagePayload` KafkaJS would deliver (`offset` is a string) and calls `handleMessage()` directly.
3. The stub's `commitOffsets` captures every `{topic, partition, offset}`; the fake owns them (`takeOwnershipOfCommittedOffsets(scenarioId, topic, partition)`), and the commit auto-default asserts each dispatched message committed **offset + 1 on its own partition**. `fail(scenarioId, 'kafka.commitOffsets', …)` injects a commit failure after the attempt is recorded.

`parity-tests/fake-kafka.parity.ts` compares the payload the driver builds, and the offset the fake captures, with a real KafkaJS consumer and `admin.fetchOffsets` on Apache Kafka.

### fake-fetch

`parity-tests/fake-fetch.parity.ts` runs the real fake and real `fetch` against loopback servers and compares outcomes and the requests that arrive: every standard status, redirects (method/body/header rules, limit, loops), the 421 re-send, and the `TypeError('fetch failed')` network-error shape. Run all parity with `npm run bdd-test:fakes-parity`; the ledger is `parity-tests/README.md`.

---

## 8. Notes

- **`subscriber.headers` spread:** `deliver.ts` spreads `subscriber.headers` onto the fetch headers after Content-Type and X-Delivery-Id. An exact-case name replaces the default; a different-case name is a second key that fetch joins with ", " (`application/json, text/plain`). An invalid header name makes fetch reject before any request, and the attempt is retried like any failure.
- **Fan-out concurrency:** `Promise.allSettled` runs all subscriber deliveries in parallel; ownership is per URL (`takeOwnershipOfDeliveriesForUrl`) and per subscriber (`takeOwnershipOfDeliveryLogsForSubscriber`). Two subscribers on one URL are two deliveries under two delivery ids.
- **Idempotency:** nothing dedupes a redelivered message. `X-Delivery-Id` is minted per `deliver()` call, so it is stable across retries of one delivery but new on every Kafka redelivery — the receiver cannot dedupe on it.
- **Topic matching:** `findByTopic` follows MySQL's `utf8mb4_0900_ai_ci` (case/accent-insensitive) while the flag check is exact-case, so a message on `ORDERS` reaches `orders` subscribers and is not stopped by a block on `orders`.
- **`message_key` VARCHAR(255):** a longer key makes the success INSERT fail after the POST; the offset is never committed (poison message, re-POSTed on every redelivery).
- **No-subscriber short-circuit:** `handleMessage` short-circuits if `findByTopic` returns `[]`. No fetch, no logAttempt, no flag check — just a commitOffset.
- **Rejection propagation:** If `logAttempt()` throws (e.g. DB failure during blocked logging), `Promise.allSettled` catches it as `rejected`, and `handleMessage` rethrows — preventing offset commit so KafkaJS retries the message.
