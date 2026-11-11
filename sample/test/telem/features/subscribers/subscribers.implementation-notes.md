# Coverage Accounting — Manage Webhook Subscribers

Flow under test: `src/api/subscribers.ts` (GET/POST/DELETE) and the POST's fire-and-forget
`subscribeToTopic()` in `src/kafka/consumer.ts`.

Coverage (whole suite, `npm run bdd-test:coverage`):

| File | Statements | Branches | Uncovered |
|---|---|---|---|
| `src/api/subscribers.ts` | 100 % | 100 % | none |
| `src/api/index.ts` | 100 % | 100 % | none |
| `src/kafka/consumer.ts` | 97.10 % | 92.31 % | 81, 85-87 (dead `__overrideConsumerConnectedForTest`, health-check flow) |
| `src/db/subscribers.ts` | not loaded | not loaded | — |

Coverage proves reach, not behaviour: most scenarios here pin behaviour on lines already covered (idempotency, keyed
collisions, failure sequences, optional-field shapes, parse mappings).

## Not loaded under BDD

**`src/db/subscribers.ts`** — the repository is the fake boundary (`fake-db.ts` replaces
`dist/db/subscribers` in `require.cache`), so none of its SQL or `parseRow` runs under BDD.
`fake-db.parity.ts` (real repository on MySQL 8) covers it.

## Unreachable or out of scope for this flow

- **Boot with existing subscribers.** `startConsumer()`'s `topics.length > 0` arm runs at boot, and
  `reseatKafkaConsumer()` calls `startConsumer()` before any Given has seeded subscribers, so scenarios reach it only
  through the health-check flow's startup step ("the instance has run its Kafka consumer startup"). A step that
  re-runs `startConsumer()` after seeding ("the service starts with these subscribers registered") is proposed
  (`FOLLOWUP.md` § Deferred); it would also pin that a POST for a topic the consumer took at boot doesn't resubscribe.
- **Other-flow:** `api/index.ts` SPA catch-all `res.sendFile(index.html)`. `GET /api/subscribers/:id` falls through to
  it; production answers the SPA's `index.html` with 200, the harness (no built frontend) a 404. Not pinned: the
  harness would need a `public/index.html` fixture first.

No instrumentation artifacts; no telemetry-only branches.

## Access control — no auth by design

The subscriber API has no authentication (sample scope, stated in the feature description). Auth-failure
cells are not applicable.

## Production behaviours pinned (current behaviour, not endorsed)

- A failed subscribe leaves the consumer stopped (stop happens before subscribe; run only after success).
  Reachable from user input alone: "Registering a topic name the broker rejects stops consumption of every
  topic already subscribed".
- A failed **stop** skips the subscribe and nothing retries it: "A topic skipped by a failed consumer stop
  stays unconsumed after the consumer recovers" — the subscriber is persisted and silently never consumed
  until a restart.
- `isRunning` is set before `run()` resolves and is not cleared on failure, so after a failed start the next
  registration stops a consumer that never ran ("A consumer that failed to start is started on both topics
  by the next registration"). Harmless against KafkaJS (stop on a stopped consumer is accepted).
  **Reachability of a rejecting `run()` (checked in `node_modules/kafkajs` 2.2.4):** a failed connect or group join
  never rejects `run()`: `Runner.start()` catches it and calls `onCrash`, which disconnects and restarts later for
  a retriable error, and `run()` resolves. `run()` rejects only when that crash-time `disconnect()` throws. The three
  `fail('kafka.run')` scenarios are therefore **injection-only** for the common case, kept to pin consumer.ts's
  reject arm. The real crash path leaves `isRunning` true as well, so the same "next registration stops a consumer
  that never ran" sequence follows from it without a failed `run()`.
- No length validation: name/topic over 255 or url over 2048 characters is a 500 from MySQL.
- `parseInt(id, 10)` accepts any id that starts with digits: `DELETE /api/subscribers/12ab` deletes
  subscriber 12, `1e3` deletes 1.
- No deduplication: a retried POST creates a second subscriber (and so double delivery).
- `headers` is not validated: `"headers": "abc"` answers 201, the column holds the JSON string `"abc"`, and
  `parseRow` JSON.parses it again, so every later `GET /api/subscribers` is a 500 ("A subscriber registered with
  headers given as a plain string breaks the subscriber listing"). The same row poisons its topic in
  webhook-delivery. Matches MySQL 8 (`fake-db.parity.ts`, non-object headers case).

Non-string `name`/`topic`/`url` (`{"name":123}`), array fields and non-object `headers` follow mysql2's binding and
JSON-column behaviour; `fake-db` reproduces it and `fake-db.parity.ts` pins it (see `WRITING-FAKES.md`).

## Blind test

| Round | Kept | Categories | Removed and why |
|---|---|---|---|
| 1 | 7 blocks | one-past-limit, URL schemes, IDN/percent URLs, non-string url, SQL in id, non-numeric ids | "Deleting one subscriber leaves the others listed" (exercised the seed helper, not DELETE); IPv6 row (gplint reads `[::1]` as an IO tag) |
| 2 | 6 blocks | URL authority shapes, other scripts / template text, header overrides, delete isolation, INT-range ids | literal-`\r\n` header (tested backslash text, not CRLF); combining-character and emoji rows (table-align miscounts them); duplicate IPv4 and IPv6 rows |
| 3 | 10 blocks | URL parser strict/lenient edges, JSON string body, DELETE on the collection, prototype-named header keys, repetition shapes, non-ASCII digit ids | `GET /api/subscribers/:id` (pins the harness's missing frontend, not production); numeric name/topic (pins the fake's `assertFits` TypeError) |
| 4 | 7 of 13 blocks | path decoration on the id, client-chosen id, non-string header values, list query string, astral-character length, concurrent delete | duplicates of existing classes: comma id, URL reject and accept shapes, text/plain and empty bodies, trailing-space topic, register-then-list round trip |
| 5 | 1 of 11 blocks | number 0 as a required field | rejected registrations not subscribing (the ownership net already fails any unclaimed subscription); duplicates of existing classes: trailing-dot topic, invisible characters in names, URL leniency shapes, empty header name, JSON null and text/plain bodies; 249-character topic (no production branch); `GET /api/subscribers/:id` (harness-only 404) |

Blind test (Step 15): complete — 5 rounds, stopped on cap

## Decision tables

`test/telem/.decision-tables/subscribers-*.tsv` (gitignored), each green on `telem-bdd check-decision-table --feature`.
Nested short-circuits are folded into one ordered dimension (request outcome; parsed id; list rows), value classes and
headers are single dimensions (they reach `db.create()` as opaque parameters), and the id-text parse mapping is its
own table so the Outline's `id` column is cross-checked.
