# Health Check — Implementation Notes

## Scope

`src/api/index.ts`: `express.json()`, `GET /health`, `express.static`, the SPA catch-all. The probes it calls:
`ping()` (`src/db/index.ts`, faked at the repository seam as `db.ping`), `isConsumerConnected()`
(`src/kafka/consumer.ts`), `isFlagsReady()` (`src/flags/index.ts`). Startup ordering in `src/index.ts` only as far
as a scenario can observe it (`main()` itself never loads under BDD). `initFlags()` failing at startup belongs to the
flags flow.

## Coverage

| File | Statements | Uncovered |
|---|---|---|
| `src/api/index.ts` | 100 % | none |
| `src/kafka/consumer.ts` | 97.10 % | 81, 85-87 (dead override hook) |
| `src/flags/index.ts` | 88.89 % | 14, 18-20 (dead override hook) |

### Uncovered, classified

- **`__overrideConsumerConnectedForTest` and its `if (_connectedOverride !== null)` arm — dead test hook.** The
  Kafka Givens reach the probe's real arm by shutting the consumer down (`stopConsumer()` → `consumer = null`), so
  nothing calls the override. Proposed for deletion (`FOLLOWUP.md` § Deferred); deleting it changes no scenario.
  Mutation-checked: `consumer !== null` → `true` turns 6 scenarios red.
- **`__overrideFlagsReadyForTest` and its `if (_readyOverride !== null)` arm — dead test hook.** The
  flags-not-ready Givens reach `isFlagsReady()`'s real `return flagsInitialized` false arm by swapping in a
  fresh copy of the flags module whose `initFlags()` has not run, which is production's state between Express
  listening and `initFlags()` resolving (`src/index.ts`). Mutation-checked: `return flagsInitialized` → `return true`
  turns 5 scenarios red. Proposed for deletion (`FOLLOWUP.md` § Deferred).
- **`src/index.ts` — never loaded.** `main()` binds a port and installs signal handlers; the harness builds its own
  server from `createApp()`. The observable consequence of its ordering (Express listening before MySQL, flags and
  Kafka are up) is the all-dependencies-down response, covered by
  "All dependencies failing results in fully degraded report". Not modelled: `ping()` throwing because
  `getPool()` has no pool yet — `dist/db/index` is the fake, so the pool-not-initialised path is parity territory.
- **SPA catch-all success arm (`res.sendFile` finding `index.html`).** Blocked, not unreachable: the harness has no
  `dist/public`, so `sendFile` fails with ENOENT and Express answers 404, where production answers 200 with the React
  app. The decision table carries these cells as `new` (BLOCKED) pending a harness change.

## Production bugs pinned (current behaviour, characterizing comment in the feature)

1. **Kafka probe reports ok when the consumer failed to start.** `startConsumer()` assigns `consumer` before
   `connect()`/`subscribe()`/`run()`, and `main()` swallows the rejection, so `isConsumerConnected()` stays true while
   nothing is consumed. Pinned by "An instance whose Kafka consumer failed to start still reports Kafka as healthy"
   (subscribe failure), "An instance whose Kafka consumer could not connect still reports Kafka as healthy"
   (`fail(…, 'kafka.connect', …)`; parity: a real connect to a closed port rejects connect() itself) and "An instance
   whose Kafka consumer failed to run still reports Kafka as healthy" (`fail(…, 'kafka.run', …)`; injection-only for
   the common case, see the subscribers notes on when KafkaJS's `run()` rejects).
2. **Error pages leak stack traces in production.** Neither the Dockerfile nor docker-compose sets `NODE_ENV`, so
   Express's final handler renders `err.stack` (absolute paths, dependency layout) for any framework error. Pinned by
   "A malformed request body is answered with an error page that exposes a stack trace".

## Findings not pinned

- **No probe timeout.** `ping()` is awaited without a deadline; a MySQL that accepts the connection but never answers
  holds `/health` until mysql2 gives up. Kubernetes' probe `timeoutSeconds` turns that into a failed probe, so the
  verdict is right but late. The fake has no "hang" outcome, so it can't be driven.
- **Unknown `GET /api/*` paths get the React app's HTML with 200 in production** (the catch-all is not limited to
  non-API paths). Not observable in the harness (see the catch-all entry above).

## Harness artifacts worth knowing

- **supertest drops a HEAD request's body** but keeps `Content-Length`, so body-parser 400s on the short read. The
  method-by-body outlines send with plain `node:http` so a HEAD row fails or passes for the right reason.
- **A 404 for any unknown GET path is a harness artifact** (no `dist/public`). The traversal scenario therefore asserts
  only what holds in both environments: nothing outside the public directory is served.
- The flags-not-ready Givens swap in an uninitialised copy of `dist/flags/index`; the After hook in
  `health-check.steps.ts` puts the original exports back.

## Decision tables

Gitignored TSVs under `test/telem/.decision-tables/`, each passing `telem-bdd check-decision-table --feature`:

- `health-check-dependencies.tsv`: mysql × kafka × flags on GET. No short-circuit, every probe always runs, so the full
  cross stands.
- `health-check-kafka-startup.tsv`: how the consumer got to its state (connected, connect / subscribe / run failed, shut
  down). The probe reads only `consumer !== null`, so these collapse onto kafka ok/absent and aren't crossed again.
- `health-check-head.tsv`: HEAD with no dependency down, or one down.
- `health-check-protocol.tsv`: method (7) × body state (absent, well-formed, malformed, oversized, gzip bomb, bad gzip,
  unsupported encoding).
- `health-check-body-shapes.tsv`: body shapes the JSON parser skips, refuses or passes (GET; the parser runs before
  routing, so the method doesn't change the result).
- `health-check-paths.tsv`: path variants and the static/SPA fallthrough. Unknown GET is `new` (BLOCKED, see above).

## Blind test (3 rounds, stopped on budget, not on the skill's rule: round 3 still kept survivors)

| Round | Proposed (runnable) | Kept | Removed and why |
|---|---|---|---|
| 1 | 8 blocks (22) | 5 blocks (10): qs-parsed query shapes, a query can't mask a failure, Accept header, concurrent probes | 6 injection/unicode query rows, long query, degraded-is-JSON, degraded-no-leak, repeated flags probe: already pinned by a full-shape assertion or the freshness scenarios |
| 2 | 11 blocks (24) | 3 outline rows: malformed `%` escape, null byte, nested keys beyond qs's depth | 404 path-variant outline (a harness artifact: production answers those with 200); the rest duplicated round 1 |
| 3 | 9 blocks (18) | 6 blocks (15): ignored credential/Host/proxy headers, JSON-parser body shapes (strict 400, non-UTF charset 415, text/plain and empty skipped), `__proto__` body, query length past Node's 16 KiB header limit (431), OPTIONS answering 200 while degraded, ETag revalidation (304, and 503 once degraded) | degraded-is-JSON, degraded-no-leak: pinned by the full-shape degraded assertions; consumer shut down twice: no new outcome on /health |

## Peer review (Step 17): complete

Five personas. 17 agreed items: 14 applied here (4 of them in part: their shared reload helper, `FOLLOWUP.md` lines
and the same encoded-body rows for subscribers and flags lie outside this flow's files), 2 wholly outside them
(`LINT-DEFERRALS.md` wording, a fake-db "hang" outcome), 1 retro (scenario descriptions vs `#` comments, repo-wide). By category: harness safety (exception-safe flags swap narrowed to
`isFlagsReady`, startup Given rethrows anything it didn't inject), coverage (Content-Encoding 413/400/415, `run()` as a
third start failure), naming (two Givens, one title), comments.

## Refactor queue (deferred)

- "Health check response contains no undocumented fields" is implied by every full-shape `the health check response
  should be:` assertion. Kept because it names the contract.
