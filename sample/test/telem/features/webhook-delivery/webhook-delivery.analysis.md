# Flow Analysis: Deliver webhooks to subscribers

**Flow:** Kafka message → flag check → HTTP fan-out → delivery log

---

## 1. Flow Entry Point

- **File:** `src/kafka/consumer.ts`
- **Function:** `handleMessage` (exported, line 15)
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
| `logAttempt(..., 'success', ...)` on 2xx | MySQL write (fake-mysql) |
| `logAttempt(..., 'failed'/'exhausted', ...)` on non-2xx / network error | MySQL write (fake-mysql) |
| `sleep(RETRY_DELAYS[attempt-1])` | setTimeout (faked to 0ms) |

Retry loop runs up to `WEBHOOK_MAX_ATTEMPTS` times (env var, default 6, captured at module scope).

---

## 3. IO Dependencies

| IO Dependency | Type | Used In | Fake Status |
|---|---|---|---|
| MySQL — `subscribers` table (`findByTopic`) | Data store | `src/db/subscribers.ts:46` | ✅ Faked + wired (`fake-mysql.ts` → `seedSubscribers`, `routeQuery`) |
| MySQL — `delivery_log` table (`logAttempt`) | Data store | `src/db/deliveryLog.ts:13` | ✅ Faked + wired (`fake-mysql.ts` → `delivery_log INSERT` branch) |
| OpenFeature SDK (`isTopicBlocked`) | Feature flag | `src/flags/index.ts:11` | ✅ Faked + wired (`fake-openfeature.ts` → `blockTopic`) |
| HTTP outbound (`fetch`) | External service | `src/delivery/deliver.ts:30` | ✅ Faked + wired (`fake-fetch.ts` → `seedResponse`, `takeOwnershipOfDeliveries`) |
| `crypto.randomUUID` | Non-determinism | `src/delivery/deliver.ts:6` | ✅ Faked (non-determinism.ts — deterministic counter) |
| `setTimeout` | Non-determinism | `src/delivery/deliver.ts:11` | ✅ Faked (non-determinism.ts — 0ms in scenario) |
| `kafkajs` Consumer (`consumer.commitOffsets`) | Infrastructure | `src/kafka/consumer.ts:35` | ⚠️ **PARTIAL** — no-op stub exists, but `consumer` is null at test time (see §7) |

---

## 4. Configuration Dimensions

| Config | Type | Where Read | Default | Effect |
|---|---|---|---|---|
| `WEBHOOK_MAX_ATTEMPTS` | Env var (int, ≥1) | `src/delivery/deliver.ts:5` — **module scope** | `6` | Total delivery attempts. Captured once at module load; cannot be changed per-scenario |
| `<topic>` OpenFeature flag | Binary (dynamic key = topic string) | `src/flags/index.ts:12` via `src/kafka/consumer.ts:21` | `false` (not blocked) | Path-diverting: `true` → all subscribers get `logAttempt(blocked)`, no HTTP delivery |

**`WEBHOOK_MAX_ATTEMPTS` module-scope capture:** `deliver.ts` evaluates `parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10)` at module load. Per-scenario `process.env` changes have no effect — the value is frozen at `6` for all scenarios.

---

## 5. Domain Sweep Results

Grepped for `handleMessage`, `deliver`, `delivery_log`, `logAttempt`, `isTopicBlocked`, `commitOffset` across `src/`:

- `src/kafka/consumer.ts` — entry point (expected)
- `src/delivery/deliver.ts` — delivery fan-out (expected)
- `src/db/deliveryLog.ts` — delivery log persistence (expected)
- `src/flags/index.ts` — OpenFeature client (expected)
- `src/api/flags.ts` — flag GET/PATCH (flags flow, separate)
- `src/index.ts` — startup entry (not tested directly; known)

No unaccounted-for code found outside the traced call graph.

---

## 6. COLLECTED-WISDOM Entries

Relevant entries already recorded:

- **"`handleMessage` is now exported"** — can be called directly from step definitions without starting a KafkaJS consumer.
- **"kafka no-op stub"** — `world.ts` stubs kafkajs into require.cache; HTTP API tests bypass the consumer. Consumer stays null unless `startConsumer()` is called.
- **"randomUUID / setTimeout patched"** — non-determinism.ts already handles these; retry scenarios are fast.
- **"Module-scope env capture"** — `WEBHOOK_MAX_ATTEMPTS` is captured at module load; scenario-level env changes have no effect.

---

## 7. Missing / Partial Fakes

### Inbound Kafka fake (MISSING — blocks all scenarios)

**Problem:** `consumer` in `src/kafka/consumer.ts` is a module-level variable, initialized to `null`. `startConsumer()` is only called from `src/index.ts`, which is never loaded in tests. After BeforeAll runs `createApp()`, `consumer` is still `null`. Line 35 of `handleMessage`:

```typescript
await consumer!.commitOffsets([{ topic, partition, offset: ... }]);
```

...will throw `TypeError: Cannot read properties of null` on every direct `handleMessage()` call.

**Fix:** Create `test/telem/support/fakes/fake-kafka.ts` that:
1. Exposes `initKafkaFake()` — calls `startConsumer()` from `dist/kafka/consumer` once in BeforeAll. With the kafkajs stub already in require.cache, this sets `consumer` to the stub object (has `commitOffsets: async () => {}`), and returns early since `findDistinctTopics()` returns [] on the INIT_SENTINEL state.
2. Exposes `dispatchKafkaMessage(topic: string, key: string | null, payload: string, partition?: number)` — constructs a synthetic `EachMessagePayload` and calls `handleMessage()` directly.
3. Registers with the fake registry (no owned IO — just a test driver into the real handler).

Wire `initKafkaFake()` in `world.ts` BeforeAll after `createApp()`.

### fake-fetch parity (deferred)

Still Not Covered (pre-existing; recorded in WRITING-FAKES.md). Graduates to a real HTTP parity test once the Kafka fake is in place. No action needed now.

---

## 8. Notes

- **`subscriber.headers` spread:** `deliver.ts` spreads `subscriber.headers` onto the fetch headers after Content-Type and X-Delivery-Id. Scenarios with custom headers need `seedSubscribers(..., { headers: {...} })` to exercise the spread.
- **Fan-out concurrency:** `Promise.allSettled` runs all subscriber deliveries in parallel. With multiple subscribers, `takeOwnershipOfDeliveries()` returns all calls; order is non-deterministic. Scenarios must assert by content, not position.
- **`takeOwnershipOfDeliveryLog()` is claim-all:** claims ALL unowned delivery log rows at once. For a single subscriber with retries, this returns all attempt rows (attempt 1..N). For multiple subscribers, it returns all subscribers' rows interleaved (order non-deterministic).
- **Multi-subscriber ownership gap:** `takeOwnershipOfDeliveries()` and `takeOwnershipOfDeliveryLog()` are claim-all. For multi-subscriber scenarios, you can verify counts and sort, but you can't match a specific HTTP call to a specific subscriber log row. Noted in WRITING-FAKES.md as a known limitation.
- **No-subscriber short-circuit:** `handleMessage` short-circuits if `findByTopic` returns `[]`. No fetch, no logAttempt, no flag check — just a commitOffset. Important edge case.
- **Rejection propagation:** If `logAttempt()` throws (e.g. DB failure during blocked logging), `Promise.allSettled` catches it as `rejected`, and `handleMessage` rethrows — preventing offset commit so KafkaJS retries the message.
