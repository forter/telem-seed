# Parity Test Ledger

Tracks parity coverage for every fake. Each fake is one of: **Covered**, **Not Covered** (with reason), or **Blocked** (with a REQUIREMENTS.md detailing what the owner team must supply).

| Fake | Status | Notes |
|---|---|---|
| `fake-mysql.ts` | **Blocked** | Needs a running MySQL 8 instance with the webhooks schema from `init.sql` and `PARITY_MYSQL=true` env var. See `REQUIREMENTS.md`. |
| `fake-fetch.ts` | **Covered** | Live-HTTP parity test against a loopback Node.js server: `npm run bdd-test:fakes-parity`. Verified: header normalisation (lowercase via `new Headers()`), method and body passthrough, `response.ok`/`response.status`/`response.statusText` for all 13 standard codes. Known divergence: a server sending a custom reason phrase (e.g. `503 Connection Limit Exceeded`) produces a different `statusText` than the HTTP_REASON table entry. This is acceptable — BDD scenarios pin the expected `error_message` value so the divergence is scoped and documented. See `fake-fetch.parity.ts` for the full analysis. Local run: `ran — 3 tests` (run.sh fails the whole suite if this drops to zero). |
| `fake-openfeature.ts` | **Not Covered** (delegated to MySQL) | `fake-openfeature.ts` no longer has its own storage — `blockTopic()` seeds the MySQL fake's `topic_flags` state; `getBooleanValue` reads from it via `peekTopicFlagBlocked`. The OpenFeature layer is a thin pass-through; real parity lives in `fake-mysql` parity (Blocked — see above). |
| `non-determinism.ts` | **Not Covered** | No external real service to compare against. `crypto.randomUUID` and `setTimeout` are patched at the Node.js layer — their "real" behavior is Node.js built-in and well-specified. No fake storage semantics or external shape is hardcoded. |

## Safety-net meta-tests

The ownership safety net itself (not a fake, but the harness's core mechanism) is verified by always-run scenarios in `test/telem/features/meta-tests.feature`. These are NOT parity tests — they don't compare a fake against a real service. They verify that unowned IO is caught and that cleanup isolates scenarios.
