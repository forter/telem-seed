# Fakes

Signatures are pseudocode. Names are camelCase (`takeOwnershipOf*`); snake_case runtimes map 1:1.

**Thesis.** Sociable, black-box, hermetic tests: boot the real app (middleware, handlers, retry, fallback, caching, error handlers) and substitute only the *outbound ports* (IO adapters) with in-memory **fakes** (Meszaros: working implementation, shortcut semantics). Never mocks/spies: interaction verification freezes the call graph; fakes verify *effects*. A fake is both a **test double** and a **sink with an audit log**: whatever the app emits lands in it, and a scenario fails unless every emission is **claimed**.

## 1. Seam selection: what to fake

- Fake the **lowest in-process seam that still talks out of process**. Test: does it cross the process boundary (network, disk, clock, entropy)? Yes → fake. No → run it.
- **Caching layers, retry wrappers, fallback chains, serializers, validators = business logic.** Never fake. Fake the IO source *beneath* them so the real logic executes. A retried method is never faked itself; its client below is.
- **Observability: no-op'd** (§7). **Audit logs that downstream systems treat as source of truth: captured and owned.**
- Seam placement:

| Situation | Fake here | Why | Residual (untested by BDD) |
| --- | --- | --- | --- |
| Package used directly by prod code | The package | It is the lowest IO seam; nothing above it is IO | none |
| Package wrapped by a local client | The wrapper (full fake: seed/fail/ownership). Leave a **deny stub** on the package | The wrapper is the seam production addresses, so seed and ownership keys are domain operations, not driver calls. The stub is defense in depth: any module that imports the package directly (a shadow client) would otherwise open a real connection; a deny stub makes that inert and loud. It captures nothing, so it is a tripwire, not coverage | Wrapper internals: connection config, pooling, in-wrapper retry/mapping |
| Factory yielding N instances | The factory; one fake holds all state, namespaced by instance name | Instances share one code path; a flat namespace conflates them (`sites.get(1)` vs `notifications.get(1)`). A single fake keeps every instance visible to the net | Factory construction logic; fidelity of instance identity |
| Pure re-exporter | Its delegate | The re-exporter holds no behavior; faking it duplicates the delegate's surface and can diverge | none |
| Repository/DAO over SQL | The **repository** | Faking the driver means emulating an RDBMS dialect, itself a drift source | Query logic; parity compensates (§10) |

- **Prefer an in-process fake library, wrap it, never inherit its contract.** The library gives semantics; you add isolation, seed/fail, ownership log, safety net, cleanup, registration. Vet: maintenance recency, adoption, version fit, ≥1.0. **Out-of-process emulators (containers, `*-memory-server`, local cloud emulators) are integration tests, not fakes: rejected.** Archived tools: rejected.
- Library *kind* dictates the wrapper:
  - **Stateful store**: the library holds data; delegate reads/writes to a per-scenario instance; keep your own write log, because the store knows data, not owned-vs-unowned.
  - **Capture-at-boundary** (HTTP interceptors, SDK command stubs): no queryable state; you MUST record each intercepted call into your own ownership log inside the interceptor, or the safety net is blind.
  - **Control** (clock/timers): manipulates ambient state, writes nothing, nothing to own, no ownership API (§8).
  - **Relay** (queue/broker/bus; consumer may live in-repo): no mature in-process library exists for broker-class systems; **hand-roll** per §3 (consumer elsewhere) or §5 (consumer in-repo). Never substitute a containerized broker.
- **Wrapping a mocking library ≠ building a mock.** Key responses by identifying parameter; record what production sent.

## 2. Anatomy: the standard fake API

Every non-stub fake exports exactly:

| Category | Signature | Caller |
| --- | --- | --- |
| Setup | `seed(scenarioId, key, data)`, `seedGlobal(key, data)`, `configure(scenarioId, cfg)` | Given steps (via World), boot |
| Failure | `fail(scenarioId, operation, sequence)`, `isConfiguredToFail(scenarioId, operation)` | Given steps; defaults |
| Production-facing | The surface production calls. Every other export of the real module is present as a **crash stub** (throws a diagnostic naming the method and the fake to extend) | Production code |
| Ownership | `takeOwnershipOf*(scenarioId, destination, key)` | Then steps |
| Safety net | `throwIfUnownedExist(scenarioId)`, `cleanup(scenarioId)` | After hook, via registry |
| Pass-through only | `registerConsumer(destination, handler, {keyExtractor})` | boot |

No-op stubs export only `throwIfUnownedExist` and `cleanup` (both empty) plus the production-used surface as no-ops; every other export is a crash stub.

**`takeOwnershipOf*` contract: five clauses, all MUST:**
1. Require a **concrete identifying key beyond `scenarioId`**. If items nest under a destination (`(scenarioId, destination, key)`), the key must come *beyond* the destination. Destination-only = destination-level sweep. Key accepted but not used to narrow = sweep in a key costume.
2. **Exact match** (strict equality / map lookup). No substring, regex, prefix: overlapping names (`l3c` / `l3c-batch`) silently over-claim.
3. **Throw on zero unowned matches** (diagnostic message). Never return `[]`; a test always knows what IO to expect. No `…IfPresent` variants.
4. **Mark claimed** (index set or `owned` flag) so the net sees what was accounted for. A method that returns without marking is a read disguised as a claim.
5. **Return deep clones**, so tests can't mutate fake state.

Why no predicates: `() => true` is a degenerate sweep. A string is either the right key or it isn't. Why key must be *uniquely* identifying: a categorical attribute (message type, status) shared across items claims all of them, which is a partial sweep.

**Invariants, enforced by lint or meta-tests (§13):**
- **Per-scenario state only**, keyed by scenario ID, including guard sets, counters, and tracking flags added later. Module-level mutable state leaks in run order and shows up only under permutation or parallelism. Dual-context fakes (touched at module load *and* at request time) must read scenario state *inside* each method body, never close over it at init.
- **Copy-on-read and copy-on-write.** Wrap clone in a helper that throws a diagnostic on non-cloneable values (functions, handles, request objects). Modules that cache fake output must clone at cache time.
- **No test-only inspection methods** (`getMessages`, `listCaptured`, `getUnownedCount`, call counters). Sole inspection path = `takeOwnershipOf*`. Production-facing reads the real module exports are fine. Call *logging* for ownership is fine; call *counts as the assertion API* is a mock.
- **Seed by identifying parameter, not by scenario alone.** A fake returning the same payload whichever key was queried is a mock. Seed domain data (token, siteId, orderId), never response-shaped data (`status`, `body`, `headers`), except fakes whose domain *is* the transport (capture sinks testing 5xx/non-JSON).
- **Key-not-found mirrors the real boundary** (null/throw/404). A fake that defaults to a success payload hides wrong-key bugs. Unseeded lookup = diagnostic throw naming the missing Given.
- **Diagnostic errors:** what happened (with scenario ID, method, key), probable cause, what to do. Truncate samples (~200 chars; PII). Exception: simulated real-service errors must match the real service verbatim (`NoSuchKey`, typed codes).
- **Export-surface discipline.** Implement only what production calls (grep). Diff against the real module's exports; every unused export is a **crash stub** (throws a diagnostic) rather than absent or silently defaulted. A missing export is an opaque crash deep in middleware, and a silent default is a hidden mock; a diagnostic crash makes the first test that starts using the method fail loudly and name what to build. Match class vs plain object and constructor semantics.
- **Calling-convention audit** before implementing each method: callback-style vs promise (a promisified caller hangs forever on an async fake), `this`-binding via `call/apply` (no arrow functions), event-emitter/stream return values.
- **Self-register** with the fake registry. An unregistered fake is invisible to the net: its IO leaks silently. Then grep for a second, independent enumeration (verify scripts, CI lists) that won't fail loudly on omission.
- **Typed errors carry the real discriminator** (`code`/`name`/structured fields such as `graphQLErrors`) that production catch blocks branch on. A bare generic error takes the wrong catch arm.

## 3. Datastores (DB, KV, object store, broker-as-sink)

State splits into **two structures**, event-log vs materialized-view:
- **Call log** (ownership surface + attempt counter): append **every call, including failed ones, before failure injection**.
- **Durable store** (read model): only successful writes and seeds.

Write order: **log → maybeFail → persist-on-success.** Consequences: a failed write is *owned IO* (proves "the code tried to write X", not "X survived") yet leaves no phantom record (`get` after failed write returns nothing; "primary is empty" fallback-exclusivity stays true). Seeds are *pre-existing state*, not flow emissions: durable store only, never the call log (else flagged unowned).

Keying: `(scenarioId, destination, key)` via a `keyExtractor(destination, payload)` fixed at build time (`orderId`; `destination` alone for single-item stores; `bucket+objectKey`; primary key). Determine the key by reading how production addresses individual items.

`seedGlobal`: boot-time, read-only reference data satisfying *all* of: needed at boot, identical for every scenario, truly static. Everything else is per-scenario, even if repetitive: an explicit Given beats implicit presence that can green-wash a missing arrangement. Seed interchangeable fields (name vs displayName) to **distinct** values so assertions pin which field production reads.

Serialization (Avro/Protobuf/custom): **never an identity fake.** Run the real serializer, capture **wire bytes**. Copy the schema into the test tree (a contract: production drift breaks deserialization, which is the point). Deserialize in Then and assert the **full wire shape** (catches silent default-filling under backward-compatible evolution). Client-level and transport-level layers get **separate ownership namespaces**; claiming one doesn't consume the other.

## 4. Replacing a module / repository / factory

Mechanism is runtime-specific; the invariants aren't:
- **Install before the app loads.** Nothing in the app's import graph may load before substitution; the harness should throw if a boundary is already resolved. Substitute by resolved identity (absolute path/specifier), not string alias: one key covers every requirer, direct or transitive (for module-registry substitution; patch-based substitution is per lookup site).
- A seeded fake **fully replaces** the module: no call-through. Call-through would route unfaked methods to real IO. Surface discipline therefore matters (see export-surface discipline).
- **Runtime builtins (fs, crypto, http, os)** are shared singletons with multiple specifier spellings: patch methods on the one object; don't substitute a spelling.
- **Boot-time audit** after load: (a) the installed object is the fake (identity), (b) every inventoried IO boundary has a fake, (c) ≥1 fake, (d) category-required methods present (data store/service: seed, configure, ownership, net, cleanup; pass-through: + `registerConsumer`, messages+deliveries ownership; stub: net+cleanup only).
- **Shadow clients:** a module that builds its own pool/SDK client instead of using the shared wrapper bypasses the fake. Caught only by the network block (§13).
- **Test-mode guards** (`if (TEST_MODE) return canned`) make fakes invisible: fake captures nothing, scenarios pass vacuously. Scan IO-adjacent code first; choose: run prod mode / disable per scenario / use another entry.
- **Module-scope init:** resource modules with `init()/connect()` called by the service bootstrap but not by the loaded entry point need that call replicated in boot, in bootstrap order, *after* wiring fakes. Driver fakes (feeding input into the app) may need the consumer module's own init for module-level state.
- **Load order is bottom-up:** dependency fakes before dependents. A suite-wide red naming a subsystem you didn't touch = load-order symptom, not a bug in the new fake.
- Secrets in seeds: synthetic, prefixed (`test-only-`), shaped to fail production validation.

## 5. Pass-through IO (same-codebase queues)

Boundary where producer and consumer live in the same service: fire-and-forget relay between internal stages. Test: grep the topic/queue name for a consumer registration in-repo. In-repo consumer = pass-through; external-only consumer = datastore; both = pass-through (handles both modes).

- `registerConsumer(destination, handler, {keyExtractor})` at boot; **one consumer per destination** (wrap fan-out in one function); keyExtractor mandatory.
- `publish` **invokes the consumer synchronously**: determinism over async fidelity. Bimodal: no consumer registered ⇒ degrades to plain datastore.
- **Separate failure domains:** consumer errors are written to a **delivery log**, never thrown at the producer (production semantics: DLQ/retry, not backpressure on the producer).
- **Two ownership surfaces,** each keyed by `keyExtractor` output (not the raw message): `takeOwnershipOfMessages` (what was published) and `takeOwnershipOfDeliveries` (`{message, key, result?, error?}`). Both feed the net; a consumer that threw leaves an unowned delivery with an `error`.
- Failable ops: the real publish method **and** pseudo-op `consume`. `consume` outcomes are *returned and recorded*, not thrown.
- Real serializer runs; wire bytes captured (§3).
- Fire-and-forget producers (un-awaited sends) must be flushed before the After hook; otherwise they run post-scenario against a cleared scenario context.

## 6. External services

Capture-at-boundary or hand-rolled. Seed responses **by identifying parameter** (URL+path, GraphQL query *and* variables, bucket+key, command input), capture every outbound request into the ownership log, and look up by identifier so wrong-key production bugs surface. If a dedicated service fake exists, never seed the transport layer for that service.

On failure paths **do not rely on the net alone**: configurations with seeded error responses record interactions the net doesn't flag as unowned. Always add explicit outbound-request assertions (bidirectional protocols: assert request shape even when the response is an error).

## 7. Instrumentation is no-op'd, not faked

Telemetry, metrics, tracing, service discovery, server listeners: **no-op stubs, permanently.** Rationale:
1. **No contract consumer.** No downstream business process depends on it; ownership would verify nothing a product promise depends on.
2. **Ownership noise.** Capturing it means every scenario claims metric emissions on every path; the safety-net signal drowns in non-behavior.
3. **Coupling to internals.** Asserting on emissions pins implementation structure: the exact fragility that motivated fakes over mocks.
4. **Nothing to drift-check.** A no-op reimplements no external behavior ⇒ parity classification **Not Covered**.
5. **Failure must not leak.** The stub implements the production-used surface as no-ops; every other export is a crash stub (diagnostic throw), so a newly used method fails loudly instead of as an opaque crash in middleware. It **never throws or swallows** what production would surface from the used surface. Latency handles return a no-op `end()`, etc.

**Demarcation line:** if a downstream system or business process reads it, it's *output* (capture + own). If only operators watch it, it's *instrumentation* (no-op). An "audit log" feeding downstream = output. Process-global module-scope side effects (default-metrics collectors) belong to load-order handling, not ownership.

## 8. Control fakes: non-determinism

Not ownable boundaries (writes nothing). No ownership API, not registered as ownership-bearing; per-scenario reset only. **Every ambient entropy/time source must be fakeable per scenario:** wall clock, monotonic/hrtime, PRNG, UUID/random bytes, timers, shuffle/iteration-order sources, hostname/platform if branched on, runtime env reads post-boot, event-loop ordering primitives.

- **Non-determinism is always a bug.** Remedies: fake the source or fix the timing. Never retry loops, quarantine, or flaky tags. Validating a fix of a probabilistic failure needs statistical confidence (13% fail rate ⇒ ~17 runs for 90%).
- Preserve type identity: subclass the clock type; never replace it with a function/proxy (breaks `instanceof`, early-bound references, libraries that capture `now` at load).
- Libraries that capture RNG at load, with sealed exports and internal entropy pools, can't be patched via their callers; replace the RNG module itself *before any importer loads*.
- Global time override also affects dependencies (token expiry, nonce, rate limit): stub those independently if wall-clock matters.
- Timers + retry backoff: advance the fake clock with the **async-aware** tick, or the awaited continuation starves.
- `@no-parallel` serial lane exists *only* for genuinely un-fakeable process-global state (native extensions). It's not a license to skip a fake.
- Lint: real clock/RNG calls in fakes/support are blocked statically.

## 9. Failure injection: `fail(scenarioId, operation, sequence)`

Sole failure surface. No whole-fake "fail everything" default (name the operation so a reader sees what fails).
- `operation` ∈ the fake's declared **failable set**; unknown name throws at setup (typo-proof).
- `sequence`: per-call outcomes consumed **by call arrival**; each entry is an `Error` (instance or zero-arg factory) or `null` = success; **last entry repeats** past the end. Re-calling `fail` resets position.
  - `[E]` always fails; `[E, null]` fail-then-recover; `[E, E, E]` exhaustion.
- **Record-then-fail** (§3). A failed attempt is still owned IO. Recovery scenario owns the boundary called >1 time; non-retryable owns exactly 1.
- **Retries need two scenarios; recovery is the load-bearing one.** Exhaustion is observationally identical to *no retry at all*; only recovery dies when the wrapper is deleted (the mutation question: what still passes if I delete this construct?). Retryable-predicate tested by failing once with a non-retryable error and owning exactly one call.
- Sequence advances by arrival, not call identity: don't use it to bind outcomes to concurrent *distinct* calls.
- Every IO method must participate once any sibling does (failable + guard), or the failure path for that code is untestable.
- Retry-wrapped dependencies expose `fail` from creation. Typed entries must carry the real code callers branch on (§11).
- `isConfiguredToFail` lets **defaults/ownership branch deterministically** in fallback chains and fire-and-forget IO.
- Fallback chains: one Given per layer; assert **exclusively** (expected destination has data, all others empty) from *persisted* state (durable store), not call-log emptiness.
- Static: sequence must be a list; bare error classes aren't callable without `new`.

## 10. Parity tests

**Fakes drift.** Real service changes an error shape; fake keeps the old one; every BDD scenario is green; production breaks. BDD tests run *the app against the fake*: they are blind to fake-vs-real divergence. A parity test runs **identical operations against fake and real side** and asserts equal **behavior**: return values, error name/code callers branch on, ordering, round-trip invariants, edge/boundary (missing key null-vs-throw, dup writes, coercion), persisted side effects read back.
- **Never shape-only.** Key-presence comparison proves nothing; not acceptable even as fallback. If behavior can't be exercised: **Blocked** (file `REQUIREMENTS.md` for the owning team: minimum active service, operations table, behaviors to verify, behavior-shaping prod config) or genuinely no behavior (**Not Covered**).
- Drift risk ∝ externally-defined data shapes, not LOC. "It's short" is not a reason to skip.
- **Needs parity:** reimplemented storage semantics; callers branch on error codes; wraps non-trivial library; hardcodes external shape; **captures what production sends to an external system** (broker/queue/event: verify the serialized payload the real service would accept: capture-only is *not* an exemption). Predicate-evaluating fakes (WHERE/LIKE/NULL three-valued logic/collation) pass vacuously in BDD because scenario and fake share the same wrong rule: only the real engine catches it.
- **Not Covered (recorded with reason):** no-op stubs; non-determinism controls; routing layers (feature-flag interceptor delegating to real code); trivial runtime-API echoes with explicitly justified negligible drift. Most pass-through fakes: relay, not reimplementation (exception: ordering/dedup/delivery/DLQ semantics production branches on).
- **Scope:** every operation production calls (grep), across every behavior dimension. Not the real API surface.
- **Real-side ladder (take highest applicable, don't prompt):**
  1. **Containerized prod-config replica** (same major version, server config, SQL mode, engine, broker `acks`/topic, schema/DDL). A differently-configured container is a test that lies. Read the repo's existing compose/CI first; behavior-affecting config not derivable from code ⇒ **ask the human**. Use team mirror registry if the repo does.
  2. **Reachable dev endpoint** (VPN): graceful skip when unreachable (connection-class errors) *and* when auth env var unset. Never commit credentials; read secrets from env at runtime. Can't exercise (auth/write safety) ⇒ rung 3, not a shape test.
  3. **Blocked-on-owner-team** → `REQUIREMENTS.md`. Don't contact anyone; the human shares the doc. When delivered, `unblock-parity` takes the real side and reconciles: **real service is ground truth; fix the fake**, except *intentional divergences* (faked clock/UUID, forced-deterministic ordering, documented design choice such as ignoring TTL), which are documented exclusions asserted as the fake behaves, never "corrected".
- Divergence is a bug **in both directions** (fake drifted → fix fake, rerun BDD; or real changed → update fake + scenarios). Never loosen the assertion.
- **Gate hygiene:** the BDD command doesn't run parity (separate runner, outside harness), so a green BDD suite says nothing about parity. One entry point (`run.sh`; one script), never per-fake scripts. **Module-load error or zero tests executed = failed run**, never a pass (a stale import silently disables parity). Ledger records `ran — N tests` so a drop to 0 reads as drift. Never `.skip`/`.only`-narrow/grep-exclude to go green.
- Parity runs outside the BDD World ⇒ nothing sets the scenario ID the fakes key on: bootstrap it **once** in a shared setup module; verify each suite **in isolation** (else a sibling spec's side effect masks a break).
- Ledger (single README): **Covered** (flavor: client/repository/library; real side + version; ran N / skipped locally), **Not Covered** (reason), **Blocked** (link). CI: container-backed ⇒ blocking on every change; live-endpoint ⇒ separate non-blocking stage with retry (upstream flake alerts the owner, doesn't block). Scaffold + document; CI wiring is separate.
- Complement, not substitute: parity checks fake↔your test infra. It does **not** detect upstream API change; that's **consumer-driven contracts**.

**Why parity happens at fake-build time, not later:**
1. **Lead time on the real side.** The oracle may not exist (nothing containerizable, no exercisable endpoint). Discovering that requires another team to *build* something. That latency is the critical path, so surface it before scenarios pile onto an unverified fake. Until verified, behaviors on a Blocked fake are `provisional` and every scenario built on them carries that caveat.
2. **Context freshness.** The builder holds why the fake is shaped as it is: which operations production calls, which codes callers branch on, which divergences are deliberate, which config was guessed. A later author reading only the fake can't distinguish deliberate divergence from bug, so either asserts a divergence (fails forever) or "fixes" the fake toward real.

Order per fake: **build fake → discover documented behaviors (§11) → parity gauntlet**, interleaved, not batched at the end. Rerun parity whenever a Covered fake changes (backfill's fill-fakes is the only in-flow re-verification point).

## 11. Discover faked behaviors

Coverage and code reading are **structurally blind** to behaviors the code has no branch for: a throttle (`SlowDown`) when only `NoSuchKey` is caught, `nil` where a string was assumed, an auto-followed redirect. No branch ⇒ no uncovered branch ⇒ green coverage with an untested real-world case. The **dependency's documentation is the oracle** for its emission range, so on build, for each *called* operation record (not the library's whole surface):
- **Success-shape variants:** empty 2xx body; `nil` vs `""` vs missing; truncated/paginated; stale eventually-consistent read; type coercion (`incr` returns number).
- **Library-specific failure modes:** exact codes/names/classes (`NoSuchKey`, `AccessDenied`, `ConditionalCheckFailed`, `ProvisionedThroughputExceeded`). Generic transport faults are protocol-thinking's job.
- **Edge/round-trip semantics:** dup write return, overwrite, type change, ordering.

Record as a **docstring on the fake method modelling the operation** (capability and documentation are one edit). Lead with a caveat header: *documented behaviors, not exhaustive: the boundary may emit more*. Each entry: **what**, **how to inject** (typed `fail(...)` carrying the real code, or seeded/configured state), **provenance** (installed type definitions/JSDoc first, version-accurate but incomplete; online docs enrich gaps; URL per behavior), **status**:
- `doc-asserted-only`: read, not reproduced.
- `parity-verified`: gauntlet reproduced it against the real side.
- `provisional`: fake is Blocked; guess from docs.

Plus package version derived against, **once** in the file header (baseline for dependency-bump sync). **Documented non-modeled behaviors** (e.g. rate-limit `SlowDown` far below threshold) get recorded with reason. Distinct from a parity *intentional divergence* (modelled differently). **Every injectable behavior must be emittable**: a docstring naming something the fake can't produce is a dead menu entry; extend `fail` to carry the typed error.

**Stimulus, never assertion.** The docstring is a menu of inputs. Injecting one *characterizes what the code does* (crash, propagate, silent drop); an unhandled documented behavior is a **finding**, not a spec. Don't assert semantics the code doesn't implement. Docs are a floor; parity verifies the docstrings; protocol thinking catches what docs omit. **Skipped with recorded reason:** no-op stubs, routing layers, undocumented in-house boundaries; ambient controls *unless* production observes a documented behavior through them.

## 12. IO ownership & the safety net

**Invariant (No Unowned IO):** every datum any fake records during a scenario must be **claimed** by a Then step (`takeOwnershipOf*`) or a **named auto-default**, else the After hook fails the scenario. Forces **routing discovery**: a scenario cannot pass by asserting the response while ignoring the three messages it also emitted. Negative assertions are free (§12.4).

### 12.1 Claims must be able to fail
- **Full-shape assertion:** pin the literal for every controlled source (§8: clock, elapsed time, ids, randomness). Extract into a type/existence check only a field whose source is genuinely uncontrolled (e.g. a salt generated inside a third-party library) and record it as a §8 gap; `deep.equal` the remainder against a **complete expected value declared up front**. Spot-checking misses fields appearing/disappearing.
- **Never derive expected from the captured actual** (tautology: compares a value to itself, unfailable). Especially on error paths: pin the literal (network error ⇒ null status; HTTP error ⇒ the specific status). Expected derives only from scenario *inputs*.
- **No loose matchers:** substring over a serialized blob (`"count":1` ⊂ `100`); `||` whose permissive arm subsumes the strict one (strict arm unfalsifiable). Parse, compare equality.
- **Discarded return = vacuous:** a bare `takeOwnershipOf*(...)` claims (satisfies the net) but asserts nothing; bind and assert. Static rule blocks.
- Failed operations are still recorded and still claimed. Reads are **inputs**, not outputs: separate Then steps placed *before* output steps, never bundled.

### 12.2 Step shape
- Multi-output Then steps **name every claimed output in the step text** (`[store-response, write-redis, emit-task]`): the feature file reader sees what's accounted for without opening code. Implementation: one single-effect helper per effect. Bracketed names are a **closed allowlist** (linter) registered on first use.
- Name the **exact destination** (`the "batch" queue`), not "the queue": forces the author to learn which destination a given config/flag routes to, which surfaces permutation scenarios.
- **Own each IO set once per scenario.** Claims consume; a second claim over the same set errors. Fold repeated facets into one Then with a data table.

### 12.3 Keyed sinks collapse silently
Keyed outputs (upsert by id, map by type) keep only the last entry on key collision. Distinct-key scenarios never reveal it. Write a **collision scenario** (two entries differing in data, sharing the key) and assert what **each destination the datum reaches** actually persists, characterizing as-is (silent data loss ⇒ finding). Distinct from idempotency (the *same* entry twice).

### 12.4 Absence
Assert absence with an **empty-body step**: claims nothing, so any leak stays unowned and the net fails. Never count-and-assert-zero (needs inspection methods; and claiming to count *masks* the leak by marking it owned). Soundness requires a fake that actually captures that boundary (a negative over an unfaked boundary is vacuous). **A negative earns its place only where it counters an expectation the flow sets** (suppressed write on an error/flag path where happy path writes). Stamped on every scenario it counters nothing: drop it.

### 12.5 Surprise IO = routing discovery, not noise
- Middleware IO (request log, webhook persistence, metrics-as-output) fires on **error paths** too.
- Multi-request scenarios emit one set of middleware IO **per request**: skip the default *and* own every request's IO.
- Fire-and-forget: ownership is **conditional on setup**, branching on `isConfiguredToFail` (always-claim errors when it didn't fire; never-claim leaks when it did). Harness flushes pending async work before the After hook.

### 12.6 Defaults, After hook, opt-out
- **Defaults** (`No unowned IO changes should remain` etc.): auto-claim IO that every scenario produces (request metadata, response storage). IO common to only one flow is claimed in its Background. Each default is a **separate named entry** (never bundle destinations), each independently opt-outable.
- **One After hook**, sequence guaranteed inside a single function body: (1) auto-default claims, in declared order; (2) **`No unowned IO changes should remain` MUST be last** (runs registry-wide `throwIfAnyUnownedExist`, aggregating every fake's leak so all surface at once); (3) cleanup, last of all, resilient (one fake's failed cleanup mustn't skip the rest). Earlier = false positives on IO other defaults would have claimed. Hook-ordering is unreliable in some runners (Cucumber.js: LIFO registration order, `order` option silently ignored); hence one hook.
- **Opt-out step** `we might have unowned IO changes` adds the safety-net default to a skip set ⇒ disables the net for that scenario. **Temporary** by design: a ratchet for incremental adoption; track usage, drive to zero. A scenario that opts out can silently regress.
- Opt-out use is itself linted (advisory `unowned-io-opt-out`).

### 12.7 Scenario ID, isolation, seeding
- Each scenario gets a unique ID (generated pre-scenario), **all fake state namespaced by it**, cleaned post-scenario. Result: order-independence, free parallelism (process-per-worker ⇒ no shared mutable state), reproducibility.
- **Ambient scenario-context accessor in a leaf module** (imported by both harness and fakes) to break the import cycle (fakes need the ID; harness needs fakes). Choose the carrier your runner's execution model supports (module variable under sequential/process-per-worker; async-local/contextvar as the default carrier when scenarios can overlap in-process, where a plain set in the before-scenario hook suffices if steps and hooks run synchronously in one context; beware runners that re-enter fresh async contexts per step, which defeats async-local, and raw threads that don't propagate contextvars).
- Accessor **throws** if context is absent (catches code running outside a scenario: module load, un-awaited async after cleanup). A silent-`undefined` accessor is banned in fakes. Boot window uses a **sentinel** ID (truthy, non-UUID) so fakes read-through safely during app load (feature-flag interceptor passes to real module).
- **Seed/configure/fail through the World** (the scenario-scoped context object; e.g. `this.seedFake(fake, …)`, `configureFake`, `failFake`), which inject the ID. Direct `fake.seed(scenarioId,…)` and direct state assignment (`fakeX.prop = …`) bypass isolation and leak. Static rule blocks.
- Temp dirs: rooted under a scenario-owned dir so existing teardown covers them.
- **Reload-from-dirty trap:** a Given that seeds dirty data and triggers a cache reload leaves the dirty cache after cleanup unless the After hook also cleans+reloads (parallel-only flake).
- Seeding by copying a whole collection re-reads other scenarios' dirt: seed one entry.

## 13. Deterministic validation tooling

A trust hierarchy, from always-on/blocking to judgment:

**Runtime meta-tests (always run, no real side, never skip, not in the parity ledger).** Static lint verifies fakes are *shaped* right; only runtime proves the **assembled** net works. If wiring silently breaks (fake never registered, After hook swallows the throw, cleanup leaks), every scenario passes vacuously: the net is the load-bearing wall.
1. **Unowned-IO detection:** under a scenario ID, record via a registered fake, invoke the same registry-wide check the After hook runs without claiming; assert it throws naming the data. Also catches unregistered fakes and swallowing hooks.
2. **Cleanup isolation:** record under both scenario A and B, run registry cleanup for A, assert A is clean and B's data is intact in every fake. A B that was never dirtied passes a no-op cleanup.
3. **Network block active:** after boot, attempt an outbound call and assert failure with **the block's own error signature**. Target a resolvable host (not a closed port: `ECONNREFUSED` fires even with no block ⇒ false green). The always-on backstop for an unfaked *network* boundary in CI. (Non-network boundaries still leak silently: build every fake.)
   Ownership-on-empty is static, so no runtime duplicate.

**Network block** (installed at boot): deny at the transport (HTTP interceptor `disableNetConnect`, agent `createConnection` throw, or DNS override) so a missing fake fails loudly.

**Boot-time audit** (§4). **Parity gate** (§10). **Static lint** (deterministic, blocking except the rules marked advisory): Gherkin rules on feature files and analyzer rules on harness code, specified in [Lint rules](tools/linters.md).

**LLM lint (advisory by invocation; *a confirmed violation is not waivable* where it's the MUST's only detector):**
- Fakes: `ownership-method-completeness`, `ownership-claim-integrity` (sweep/predicate/partial/substring: only detector), `fakes-not-mocks` (seed ignores identifier, hardcoded responses, call-count API, missing key-not-found, transport seed beside a dedicated fake, response-shaped seed, schema mismatch, plain error where structured expected), `delayed-binding-in-dual-context-fakes`, `failure-injection-completeness`, `diagnostic-error-messages`, `documented-behavior-docstrings`.
- Steps: `ownership-over-inspection` (no inspection, no `IfPresent`), `emptiness-validation-via-ownership`, `hardcoded-expected-values` (hardcode *and* tautology), `seeded-data-shape-mismatch`, `diagnostic-assertion-messages`.
- Features: `destination-in-assertions`, `then-step-naming` (business effects, not fake method names), `unowned-io-opt-out`, `multi-output-bracket-list`, `exclusive-fallback-destination`, `assert-observable-outcome` (status-only smoke test that owns no output).

**Performance budget as diagnostic:** a faked-IO scenario should run in single-digit ms. Hundreds of ms ⇒ a missing seed (real timeout) or an escaped real-IO call; the budget is a fake-wiring detector.

## 14. Build order (per boundary)

1. Inventory IO boundaries (category, real module, methods used). Create the scenario-context leaf module.
2. Scan for test-mode guards; decide strategy.
3. Classify: **category** (datastore+factory / pass-through / service+stub) and **library-fit** (wrap X | hand-roll; Kind = stateful store | capture-at-boundary | control).
4. Build one per category first; wire; smoke-test; **peer review the patterns** before building the rest (fixing a pattern in 3 fakes ≪ fixing it in 18).
5. Per fake: build → discover documented behaviors → parity.
6. Wire: non-determinism → app loading → network block → boot audit → seed → defaults/After hook/opt-out.
7. Verify: two-scenario smoke (seed→act→own; then clean-state check), failure-injection propagation, meta-tests, guard handling.
8. Maintain the team guide (WRITING-FAKES): categories, standard API, pitfalls, add-a-fake procedure; update on new boundaries. New post-graduation boundary ⇒ classify and invoke the single leaf builder.

## Appendix A: worked example (datastore fake, pseudocode)

```
// State: all keyed by scenarioId. No module-level mutable state beyond these maps.
callLog[sid][dest][key]  = [item...]      // ownership surface; includes FAILED calls
durable[sid][dest][key]  = [item...]      // read model; successful writes + seeds only
owned[sid][dest][key]    = Set(index)
failSeq[sid][op] = [outcome...]; failIdx[sid][op] = n
failable = {"write"}                       // must equal methods that call maybeFail

write(dest, data):                         // production-facing
  sid  = currentScenarioId()               // throws if no scenario context
  item = clone(data); key = keyExtractor(dest, item)
  callLog[sid][dest][key].push(item)       // 1. log
  maybeFail(sid, "write")                  // 2. inject (throws if sequence says so)
  durable[sid][dest][key].push(item)       // 3. persist on success

read(dest, key): last(durable[currentScenarioId()][dest][key]) cloned, else null

seed(sid, dest, key, data): durable[sid][dest][key].push(clone(data))   // never callLog
fail(sid, op, seq): assert op in failable; failSeq[sid][op] = copy(seq); failIdx[sid][op] = 0

maybeFail(sid, op):
  seq = failSeq[sid][op]; if empty return
  outcome = seq[min(failIdx[sid][op], len-1)]; failIdx[sid][op]++
  if outcome != null: throw (outcome is Error ? outcome : outcome())

takeOwnershipOfWrites(sid, dest, key):     // exact keys, throws on empty, marks, clones
  unowned = callLog[sid][dest][key] minus owned indices
  if unowned empty: throw diagnostic(what, probable cause, fix)
  mark all; return clones

throwIfUnownedExist(sid): collect every (dest,key) with unowned items -> one aggregated throw
cleanup(sid): delete sid from every map
registerFake(self)                         // else the net can't see it
```

Scenario and its claims:

```gherkin
Given the "orders" store is configured to fail once with a timeout   # World: failFake(store, "write", [timeout, null])
When an order "o-1" is submitted
Then the order should have been persisted [store-order]              # one claim returns both attempts for "o-1"
```

The step claims `takeOwnershipOfWrites(sid, "orders", "o-1")`, binds the return, and `deep.equal`s the **pinned** expected shape (controlled values pinned as literals). The retry is proved by two items under that key, since the failed attempt was logged before `maybeFail` threw. After hook order: auto-default claims, then `No unowned IO changes should remain`, then cleanup.
