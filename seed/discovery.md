# Discovery

Signatures and code are pseudocode; tests are Gherkin (Given/When/Then, Scenario Outline, Examples). Examples marked *(platform: …)* illustrate a platform-specific form of a platform-neutral rule; unmarked examples are invented and neutral. Scope: the techniques that find scenarios; sequencing, convergence and exit rules live elsewhere.

**Thesis.** Intuition enumerates scenarios poorly, so every scenario is *derived* by a technique with a stated blind spot, and each technique compensates for another's. Coverage finds **branches** with no scenario. Nothing in coverage finds missing combinations, absent code, unseen fields, wrong values, or weak assertions. Each technique below answers one question; none is optional because it "usually yields nothing" (a verified-empty pass is the value).

| Technique | Finds | Residual blind spot (compensated by) |
| --- | --- | --- |
| Coverage-driven (§1) | Branches no scenario enters | Combinations (§4); absent code (§10); optional fields (§6); table rows (§7); assertion strength (`fakes.md` §12.1) |
| Reachability (§2) | Whether an uncovered branch is truly dead | Is a *judgment*: wrong classification hides a prod bug |
| Error taxonomy (§3) | Failure handling, where most bugs hide | Failure modes outside the checklist (§5, §11) |
| Decision tables (§4) | Untested *combinations* of observable Givens | Completeness of the declared dimensions (re-derivation §4, blind test §11) |
| Protocol / code-path (§5) | Distinct outcomes between two systems | Needs both lists cross-referenced |
| Optional properties (§6) | Shape/serialization/silent-loss of fields that add no branch | none by tool; sweep by inventory |
| Discrete mappings (§7) | Every input value of lookup/switch logic | One lookup = one branch to coverage |
| Config/fixtures (§8) | Behavior that depends on seeded or defaulted config | Unread defaults |
| Flags (§9) | Per-flag and cross-flag behavior | Interactions on excluded flags |
| Documented behaviors (§10) | What the boundary can emit but code has no branch for | Undocumented emissions |
| Blind test (§11) | What the process's accumulated assumptions missed | Survival is unbounded; judged by survivors |

**Governing rules (apply to every technique):**
- **Production code is the source of truth.** A bug found while discovering is **characterized** (scenario pinned to current behavior) and **filed separately** (§12). The test is not the fix.
- **Mutation question**: *what would still pass if this construct were deleted?* A scenario that survives deletion of the thing it claims to test is not coverage of it. It is a reviewer heuristic; no mutation tool exists.
- **Input reachability is code-determined, not producer-determined.** An input is in scope if the code accepts it, whether or not any current producer sends it. Out of scope only if upstream rejection/routing makes it unreceivable.
- **Characterize, never assume semantics.** Assert what the system does, not what it was meant to do (idempotency, injected documented behaviors, double-apply).

## 1. Coverage-driven discovery

Each uncovered branch is a **question**: what input, config, or state reaches it, and what is observable if it fires? Answer it with a scenario that asserts the **observable outcome** with full assertions. Re-run coverage immediately after each scenario: one scenario often covers a block.

- **Coverage drives discovery, not quality.** Entering a branch and asserting only a success status is coverage theater. All behavior-driving branches matter, "infrastructure" ones included.
- **Run unfiltered first.** Run over all of the flow's feature files (glob, so companion files merge), then read the *whole* report: filtering the report by feature or file name hides shared orchestrators/converters whose branches are real and reachable. Filter only to triage.
- **Loaded-file sweep.** Account for every file *loaded* in the run, not the flow's own files. A loaded domain file at 0% is a gap: needs a scenario or is dead code.
- **Cross service boundaries.** If another service runs in-process, instrument both sides.
- **Statement-line gaps are a separate channel.** Branch tools only see arms. A statement uncovered with no branch (the line after a call that always throws) is **presumed coverable**: an always-failing fake looks identical to dead code. An unconditional throw above a line is a defect to file, not a coverage class.
- **A lookup table is one branch.** One covering key reads as 100%; pin rows via §7.
- **Debug the tool, don't skip it.** Without coverage the discovery channel is gone.

### What the coverage run must provide

The worklist itself (arm kinds and descriptions, the sibling-hit filter, positions and snippets, error-handler detection, outputs) comes from the branch explorer: spec `tools/branch-explorer.md`, not restated here. Changed-hunk attribution and its granularity flags: `tools/affected-flows.md`. What the coverage *run* must deliver to them:

| Requirement | Why | If absent |
| --- | --- | --- |
| Per-arm hit counts (arms + hits per branch, statements + hits; *platform: JS, Istanbul-shaped JSON*) | Percentages can't say which condition to construct | No worklist; agent interprets raw data |
| Expression-level arms: ternary arms, short-circuit operands, default-arg, switch cases | `a ? b : c` and `f() \|\| g()` are branches; line/statement granularity marks them covered after one arm | Convergence stalls on false "covered". **Language limits:** a line/arc-level tool (*platform: Python's coverage.py*) cannot see these; compensate by reading code and decision tables, and say so |
| Statement-line data as a second readable channel | Branch tools are blind to uncovered statements | Dead-looking lines hide untested success paths |
| Original-source paths and positions (*platform: JS/TS: enable source maps in the coverage producer*) | TS must report `.ts` lines | Every hunk degrades to file-level; compiled lines mislead |
| **Loaded-vs-unloaded accounting.** Some tools (*platform: JS V8-native coverage*) omit never-loaded files rather than reporting 0%; others (*platform: instrumenting tools, Python `source=`*) report them at 0% | Unloaded modules are missed flows or dead code, invisible to a per-flow run | Full-tree diff (tracked source files vs report) required for tools that omit them |
| Per-run attribution: one report per feature, **isolated output directory** per run, scoped to that feature only. Verify the scope took effect, e.g. assert the run's scenario count | Feeds shared-code drift attribution (below) | Concurrent runs clobber one dir; unscoped runs make everything read covered (a runner can silently merge your path with its configured defaults and run every feature) |
| Correct merging. Merging coverage from parallel workers can mis-merge (*platform: V8*) | Branch analysis needs trustworthy arms | False uncovered branches. **Use a single-process run for branch analysis** |
| Wrapper must propagate args to the tested process | A missing separator silently emits no coverage and exits 0 | False "no gaps" |

Coverage does **not** see: assertion strength, computation correctness, combinations, absent code, fields/lookup entries, flag interactions, fake drift. Those need §3-§11 and parity.

### Shared-code drift fan-out

A change to shared code (converter, dispatcher, validator) is *observed by every flow that reaches it*, and each flow's feature file is the sole truth for its promises. Coverage goes green when one flow covers the changed branch, leaving others under-asserted with no gate. So attribute a changed hunk to **all** flows reaching it, deterministically (per-feature coverage reports + changed hunks), and assert in each what *that* flow observes.
- Run the affected-flows attributor (spec: `tools/affected-flows.md`: inputs, verdicts, the line-granular caveat, failure modes; not restated here). `covered` is a fact unless flagged line-granular; `candidate` and line-granular `covered` are leads: confirm reachability with a debugger or temporary logging before writing the scenario. Unattributed: rule out a rename or move first, then it's a new flow or dead code (§2).
- Fan-out is bounded by **reachability**, not output-observability: a distinct input yielding the same output is still a valid false-positive guard. Genuine redundancy is pruned later by dedup (§5).
- Pure deletions produce no new-side hunks (the tool exits 2 on an empty change set): inspect the old side manually; "no hunks" ≠ "no drift".

## 2. Reachability

After coverage discovery, **every** remaining uncovered branch and statement line in every loaded file gets a class. Nothing stays uncovered silently. These four classes apply per flow; a whole-suite sweep over files no flow has touched adds two outcomes: a **new flow** (queue it for its own pass) or **dead code** (nothing the suite loads references it).

| Class | Meaning | Action |
| --- | --- | --- |
| Coverable | Reachable from this flow | Write a scenario, or a deferred TODO with a reason |
| Unreachable | No input/config/state the flow can construct reaches it | One-line structural reason, grouped by root cause |
| Instrumentation artifact | Phantom branch the tool invents (ternary counted as two arms, impossible `default`, short-circuit) | Note, no action |
| Telemetry-only | Only emits logs/metrics, no other observable effect | Note; a scenario adds no behavioral coverage |

- **Presume coverable.** "Unreachable" means the flow cannot construct *any* input/config/state that reaches it, **not** that current scenarios miss it. If you can describe the scenario that reaches it (feed the missing enum, supply the optional field, fail the dependency once so the retry arm runs, seed the record, configure the other region), it is coverable. `default`/`else`/`catch` arms are presumed coverable. No "non-functional / not worth it" bucket.
- **Structural-reason requirement.** Unreachable only with a nameable structural reason: runs at init time, belongs to another flow's path, or its guard is provably always taken.
- **Group unreachable branches by root cause**; the grouped notes become the hit-list for later flows:
  - *init-time* (module load, boot, periodic refresh: no scenario context)
  - *other-flow* (shared module only another flow reaches)
  - *defensive fallback* (*platform: JS* `x || {}` on an already-initialized value)
  - *environment-gated* (production-only conditions the harness genuinely can't reproduce; a region or disaster-recovery path the harness can configure is coverable)
  - *entity-specific* (gated on identifiers outside the test fixture pool; coverable if the entity can join the pool)
- Notes key each entry to **module + reason**, not an exact arc (arcs go stale or mis-transcribe and can never match a later report).
- **Not worth testing ≠ unreachable.** Don't dismiss a guard like `if (!caller.isVerified)` on intuition: a wrapping layer that runs earlier (*platform: web middleware, decorators, interceptors*) or an alternate entry point may reach it. Settle it empirically: write the scenario you believe reaches it and run it; to see the path, step through it with a breakpoint.
- **Traps where tracing "unreachable" reveals a production bug** (pin as current behavior, file separately):
  1. *Destructured-param mismatch*: callee destructures `{accountId}`, caller passes the value elsewhere; field always `undefined`, downstream arms dead.
  2. *Field-mapping gap across call paths*: two flows call the same function with different field mappings; arms depending on the unmapped field are dead in one.
  3. *Inner catch makes the outer catch dead*: B swallows internally and returns null.
  4. *Init-time limits*: classify and move on.
  5. *Harness-only config default fakes unreachability*: the test env/World sets a default production sets differently; no error, the branch just never runs. Check harness config before classifying.
  6. *Always-failing fake masks a live statement*: the line below a call that throws in every scenario is an untested success path, not dead code.
  7. *(platform: async/await runtimes such as JS/TS)* `return promise` vs `return await promise` inside try/catch makes the catch dead for async errors: the rejection escapes the frame uncaught.

## 3. Error taxonomy

Most bugs hide in failure handling; intuition enumerates failure modes poorly. Work a **fixed checklist** while reading every branch of the pipeline (every handler; every branch with distinct behavior). Governing check: *what would still pass if the handling were deleted?*

| Category | Scenarios | Assertion rule |
| --- | --- | --- |
| Auth & validation | Unauthenticated, wrong credentials, expired/malformed, insufficient scope; each required field absent one at a time; invalid types/ranges/formats; schema rejection | Status/body **and** no downstream IO |
| Infrastructure failures | Downstream down, timeout, non-2xx, partial failure, secret-store failure (distinct from auth) | Inject **per operation** by name; no whole-dependency "down" switch |
| Retry / resilience wrappers | **Exhausted** (every attempt fails) and **recovers mid-sequence** (`[Err, null]`) | Recovery is the load-bearing scenario: exhaustion is observationally identical to no retry. Prove retry fired by owning the boundary called >1; prove the predicate by failing once with a non-retryable error and owning exactly 1 call. Assert exhaustion at the business observable, not the internal error type. Fake the IO *below* the wrapper |
| Fallback chains | Every stage: primary ok; primary fails/first fallback ok; … ; all fail | **Exclusive**: expected destination has data **and** every other is empty, from *persisted* state, collected without short-circuit. One Given per layer, else the chain succeeds at layer 2 and the final catch never fires |
| Access control / tenant isolation | Wrong tenant, nonexistent resource, valid auth with wrong role | Seed both tenants; complete invisibility both directions |
| Silent drops | collection filters that remove items, early returns without error, `if (shouldDrop)`, conditional writes | Assert **absence** of the side effect, not just the 200 |
| Fire-and-forget | Response unaffected by downstream async failure | IO deterministically either happens or doesn't, per setup |
| Malicious / oversized input | Injection payloads (SQL/NoSQL/command), path traversal, oversized bodies, deeply nested JSON, wrong field types | Two levels: error response **and** input never reaches datastore/broker/object store |
| Boundary values | Every threshold, both sides (`> 50`: 51 passes, 50 fails), string lengths, date cutoffs, array sizes, percentages | A value far from the threshold leaves the boundary unguarded; don't seed an exact time threshold (elapsed wall-clock) |

- **Error paths are confirmed reachable, not assumed.** Constructs that make a path dead or a failure invisible: an un-awaited async call escaping its catch; (*platform: JS/TS async*) `return promise` vs `return await promise` in try/catch; a wrapping layer (*platform: web middleware, decorators, interceptors*) that catches, reports and continues, swallowing the error (three scenarios: the boundary it calls fails → the main operation still succeeds → that boundary's IO is absent; downstream throws → the failure surfaces to the caller; its flag disabled → the layer is skipped); an eager strict-flag read inside a catch that throws and falls back, so the scenario passes with the wrong decision (declare every flag the path evaluates).
- **Retry pitfalls**: backoff needs the clock advanced past each delay (*platform: JS fake-timer libraries: use the async-aware tick; a synchronous tick leaves awaited continuations stuck and `[Err, null]` hangs*); whole-handler retry over several ops: count the *specific* op's calls exactly (a bare `>1` can't say which op retried); the failure sequence advances by call arrival, so use it only for sequential attempts of the **same** call.
- Library-specific failure codes come from documented behaviors (§10).

## 4. Decision tables

Gate: **`check-decision-table`** (spec: `tools/check-decision-table.md`). It owns the table format, the four dispositions, the completeness and feature-file cross-checks, and its edge cases; none of that is restated here. This section is the agent's side: building the grid and triaging honestly.

Coverage can hit 100% with each dimension tested individually; the **cross-product** reveals combinations no scenario covers. Built from observable Givens only (implementation-agnostic); code is consulted at triage.

1. **Identify dimensions.** Every Given that changes behavior: auth state, config, infra health, protocol outcome, request shape, headers, environment. Also: conditionals in the pipeline no Given names (silent drops, guards, event-type early returns); framework-owned protocol behaviors (route, method, body validity, body size) as dimensions of the endpoint's *contract* (a synthetic `request=[any]` means discovery stopped at the handler body); documented behaviors of faked boundaries with no `src/` branch (§10).
2. **Cross them into the tool's table file, not in your head.** Regenerate whenever the flow is touched; durable "why impossible" goes to the repo's wisdom file.
3. **Triage** every row.
4. **Fill** the scenarios the dispositions require.

Judgment the tool cannot check (it only requires a disposition and, for some, a reason):
- **`covered`**: quote the scenario title in the reason.
- **`belt`**: shares a code path with an existing scenario, **confirmed by reading it**. Fill as a compact Scenario Outline under a marked section, with assertions that hit the interaction-bearing output (a liveness-only assertion is a false tripwire); quote the filling title.
- **`cannot-occur`**: the one mechanical test is *can this input arrive here?* If yes, the cell is covered/new/belt, never `cannot-occur`, however identical its outcome. A missing validation is a behavior, not an absence. Same outcome ⇒ `belt` (name the shared path).
- **Sequential short-circuit collapse**: auth → validation → logic makes "auth fails + validation fails" impossible, but still write **one scenario per failure point**; short-circuit order may change in a refactor.
- **Fold a nested pipeline** into one ordered outcome dimension (`render_path=[no-items,no-template,outside-window,sent]`) crossed only against genuinely independent axes. **Fold same-facet flat options** into a derived combo-dimension (`visibility_filter=[published-only,archived-only,both-set,neither]`); the tell you skipped it: a row per flag and none where two same-facet flags are both set. Prefer narrowing a dimension's values over a wall of `cannot-occur`.
- **Re-derive the declaration on every entry**: map every scenario back to the dimension value it exercises; a scenario with no home is a missing value. Crossing new scenarios is not re-deriving.
- **Pitfalls**: skipping code inspection at triage; `belt` without reading the code; marking cells `cannot-occur` to dodge the gate; dismissing a framework-owned cell (400/404/405/413 are reachable, observable behaviors; "the framework implements it once" is white-box, and only a documented *business* cross-cutting contract collapses a cell across endpoints); collapsing a resilience wrapper's recovery cell as a happy-path duplicate; seeded Givens that never reach consumption.
- **Residual**: the tool trusts the declaration. Re-derivation, the blind test (§11), and the advisory reason-quality lint (restated verdicts, deferrals, platitudes, framework-owned justifications) cover what it cannot.

## 5. Protocol thinking and code-path thinking

Two lists, cross-referenced:
- **Protocol**: *what distinct things can happen between these two systems?* HTTP-like: valid, timeout, connection refused, malformed, partial, unexpected status, empty body with success, valid with unexpected content. Messaging: valid, malformed, duplicate, out-of-order, unknown type. Fire-and-forget: succeeds, fails, times out, partial.
- **Code-path**: *what branches exist?* Every `if`/`switch`/`try-catch` in the response handler; silent error swallowing; response-dependent branching.
- For each unique case: is there a scenario, and does its observable output differ?
- **Both directions.** Outbound: assert shape (identifiers, payload, headers, routing), not "a message was sent". Inbound: assert every protocol outcome. **An outbound request has its own inbound half** owned by the transport client: some clients auto-follow redirects (*platform: JS `fetch`*); a connection reset or TLS failure surfaces as a throw, not a status. A fake returning the 3xx verbatim doesn't reproduce this.
- **Idempotency: test the second application.** Deliver the same operation twice (at-least-once delivery, client retry, internal retry). Assert what the system does (one effect or doubled), never the intended semantics; double-apply ⇒ characterize and file. Distinct from two *different* inputs colliding on a shared sink key.
- **Dedup rule**: two outcomes indistinguishable at **every** observable boundary are one scenario; differing in any field (even a boolean) means distinct. Dedup is a narrow exception, not a pruning pass; when unsure keep both.

## 6. Optional properties

If the API accepts an optional field that changes request shape, add a scenario including it **even when the handler's branch is identical**: the aim is the full pipeline (validation → serialization → intermediate processing layers → downstream IO). Coverage can't see it: a field that creates no branch has 100% branch coverage either way.
- **Three failure modes**: schema rejection (wrong type, unexpected property, bad format); serialization error (wire schema lacks the field); **silent loss** (an allowlist of known fields, a mapper that doesn't forward, a constructor that omits).
- Assert the full IO shape with the field present, confirm absence when omitted, **at the final destination, across serialization boundaries**.
- Look beyond the body: path params, query strings, headers. **Nested optionals** get three cases: outer with all subfields, outer with only required, absent.
- Write rejection scenarios for invalid values (at minimum wrong type, bad format, null for non-nullable).
- Inventory: `field | covered? | changes IO shape? | changes response?`. Find optional fields in schemas, destructuring defaults, optional chaining, and conditional forwarding. Fields silently ignored and never forwarded aren't worth testing.
- These are **not duplicates** of the base scenario (different request shape); never consolidate them away.

## 7. Discrete mappings

Test **every** distinct input of switch/case/lookup logic, even when several map to the same output: each input is a separate signal the external system can send.
- Scenario Outline, one row per input, asserting the mapped output (not just status).
- **False-positive guards** for filter/transform mappings (placeholder removal, skip lists, allowlists): one non-matching value per field, asserting it was *not* affected (catches greedy regex, wrong case-sensitivity, list expansion, substring-vs-exact).
- **Defaults**: unknown-input fallthrough and empty/null/undefined are distinct outcomes (default, throw, pass-through).
- Whitespace-sensitive values can't be Examples cells (Gherkin trims): standalone scenarios with a quoted literal.
- **Examples table = parametrization**: every column holds a *value*, never a whole step; assert the value the outline varies over. An outline whose Then references none of its columns is suspect unless rows are genuinely inert; split inert rows, shared-code rows, and rows whose value is copied to output. Rows differing in both Given and Then were never one scenario.
- **Embedded data tables** (lookup data with thousands of entries): a generator reads production data and emits a dedicated feature file with one Outline whose Examples is the whole mapping, committed as a pinned clone. The clone **is the drift detector** between production and test: expected values come from the committed row and are never read from production at runtime (a test that reads production's table at runtime can never disagree with it). Each row runs end-to-end and asserts the full shape. Modified/removed entries break their row; **added entries are invisible at runtime**, so CI regenerates the file from production and fails on a diff. Non-entry branches (default, structural-absence guards) get their own scenarios. Never a structural byte-compare of the two tables.

## 8. Config dimensions and fixtures

- **If a value changes observable output, write a scenario per distinct value**: account/tenant properties, service tiers, regional overrides, per-tenant config.
- **Read the default, not whether config exists.** A non-empty default means the dimension is **always active**, even when nothing is seeded. Read what the getter returns when the key is missing (dict default, config-object field, hardcoded constant): that default is itself a behavior-changing value to cover.
- Inventory: `configuration | type | values that change behavior | handlers affected`. Descriptive Givens ("the account has bulk export enabled"), not storage-level ones.
- **Fixtures** (shared pools, randomized) are domain objects that are cross-cutting identities appearing in most scenarios, whose attributes production branches on outside the scenario's control, with multiple real instances. Given-phase only; the stimulus is always explicit.
  - **Predicate-based, never position-based** selection; **exhaustive predication** on every routing-relevant attribute the flow branches on (a partial predicate passes or fails on shuffle luck); **mirror scenarios** (tighten "has B" to "has A and B" ⇒ add "lacks A, has B"); **pool diversity** (≥1 fixture per distinct value of each routing attribute); **randomize non-predicated attributes** so unstated dependencies surface as flakes; a new routing property updates existing scenarios.
  - **Seed interchangeable fields to distinct values** (name vs displayName); equal values blind every scenario to which field production reads.
  - Per-scenario config seeds need teardown, or they contaminate other features. A truthy header that isn't meaningfully parsed gives false coverage.

## 9. Feature flags

Every flag the production path evaluates during a scenario must be accounted for.
- **Strict interceptor**: the flag module is replaced by a fake that throws on an **undeclared** read during a scenario (message lists declared flags and where to declare). During app boot it passes through to the real module; detect boot by comparing to the **boot sentinel**, never by "no scenario id" (a falsy check silently disables strictness on a broken async context). Unbounded dynamic keyspaces (`isEnabled(userSuppliedKey)`) return the uniform production default; the Then carries the guard. A key that traces to a finite set of literals (a ternary, a region list, a lookup table) is **not** dynamic: enumerate and declare every key and test each. Table-cached fallback: when production spreads, clones or iterates the whole flag table, per-field strictness can't be enforced, so an undeclared read returns the production default and the Then carries the guard; document the divergence. Unsure → stay strict. A static audit (spec: `tools/flag-audit.md`) is an *audit*; the runtime strict fake is the source of truth.
- **Four declaration layers**, last write wins: *baseline* (global, production defaults, applied to every scenario; values from the real config source; security flags (authN/authZ/rate-limit) manually verified, never trusted from a query) → *per-feature manifest* (`tests/telem/flag-manifest.json`: `feature → {flags, excluded: {FLAG: "category: reason"}}`; manifest-only flags default to `false`; production-default-true flags belong in baseline) → *permutation override* (the runner's value for this combination) → *per-scenario Given* (`flag "X" is enabled|disabled`). A Given beats the permuted value because a path-diverting flag is excluded from the matrix and pinned by a Given. Pin a flag's state with a Given, **never a tag**.
- **Categorization tree**:

| Category | Treatment | Why |
| --- | --- | --- |
| Response-affecting | Keep in the permutation matrix | Changes output or interacts with other flags |
| IO-only | Dedicated enabled+disabled scenarios, exclude from matrix | Controls a persistence destination / streaming / logging |
| Entity-gated | Dedicated scenarios with the gated entities in the pool | Fires only for specific entities |
| Path-diverting | Dedicated scenarios per path, exclude from matrix | Enabling skips a whole code path |

Never pull a flag out of the matrix without understanding its interactions; when in doubt, keep it in.
- **Test both states.** Enabled proves the feature; **disabled guards against the `if (flag)` guard being removed**. Skip disabled only for a pure widening override (off falls back to already-tested default).
- **Exhaustive 2^N permutations** per feature over matrix flags, run by the **flag permutation runner** (spec: `tools/flag-permutation-runner.md`: manifest contract, precedence, caps, parallelism; not restated here). Every permutation failure is a real interaction bug, never noise: fix the scenario or production, never weaken assertions. Re-run after adding non-matrix scenarios (they may interact). The matrix doubles per flag: exhaustive is feasible to about 5 matrix flags (32 runs). Beyond that, re-categorize flags out of the matrix (above) or split the feature. The runner hard-fails above its cap (default 10, ceiling 20); do not raise the cap without the user's say-so.
- **Verify the handler is in the pipeline**: a flag scenario whose handler isn't reached passes regardless of value (false coverage); don't copy flag scenarios between flows. IO-only flag scenarios own the *specific* IO the flag affects.
- **Don't assume two flags are inverses.** `DISABLE_FEATURE` and `ENABLE_FEATURE_FOR_ALL` often form a multi-state system (kill-switch / force-all / conditional default): read the `if` chain for priority, fallthrough, per-entity overrides.

## 10. Documented behaviors of faked boundaries

Coverage is blind to behaviors a dependency can emit that the code has no branch for (throttling error, `nil` where a value was assumed, an auto-followed redirect). The dependency's documentation is the oracle; fakes carry those behaviors as docstrings (see `fakes.md` §11). In discovery they are **stimulus**: each documented behavior with no `src/` branch becomes a decision-table dimension value (§4) and is injected; the scenario characterizes what the code does, and an unhandled one is a **finding**, never a spec.

## 11. Blind test

A fresh subagent that does **not** know what the process already considered and dismissed proposes scenarios the systematic process missed through accumulated assumptions.
- **Mandatory real subagent.** Run as a mental scan it found zero gaps; as a subagent it immediately found genuine ones.
- **Context restriction**: give it **only the feature-file path**, one file at a time. Not the flow analysis, coverage notes, decision table, wisdom file, or any summary; even "this is a user-signup handler" biases it.
- **Two phases, prompt used verbatim** (only repo-command lines adapt). **Phase 1, no source** (the "never read any source" constraint must appear word-for-word): read the feature file; guess extra defensive scenarios: empty/null/missing fields, max-length strings/huge numbers/Unicode, concurrent/duplicate/replay, partial degradation, boundary values (off-by-one, zero, negative), auth states (expired, revoked, wrong scope), injection (SQL/XSS/traversal), cross-tenant leaks, optional fields present but empty/wrong type, **two options that filter/scope the same thing combined** (exclusive vs widen/narrow), timing under load; append to the file in existing style. **Phase 2, source allowed**: run permutations and tests; fix failing scenarios (adjust Givens, fix Thens, add steps). **Remove** a scenario only when the code *rejects or can't route* that input **and** it asserts a downstream effect that then never happens; keep one asserting the rejection itself; keep one whose input the code accepts even if no producer emits it. Report added/survived/categories/removed.
- **After**: dedupe true duplicates (keep same-condition-different-angle), reword to the existing step vocabulary, delete orphaned steps. A scenario judged "impossible" due to a **missing validation** is a production bug: document it. The value is in the survivors, not the survival rate.
- It is a **generator**, not a checker: don't expect survival to decline. (Stopping rules are an orchestration concern.)

## 12. Findings

Discovery will find production bugs. Handle them uniformly:
- **Characterize, don't fix**: write the scenario to current (buggy) behavior; when the bug is fixed the test fails, which is the signal to update it.
- **Record in three places**: the per-flow notes' "production bugs discovered" section; the repo's wisdom file with the full explanation; a separate bug report. Code proven dead (e.g. behind an unconditional throw) is a defect: record and flag for deletion. Unreachable-but-live classes (init-time, other-flow, defensive fallback, environment-gated, entity-specific) are not defects.
- Sources: reachability traps (§2), a documented behavior your code doesn't handle (§10), double-apply on redelivery (§5), a "impossible due to missing validation" blind-test result (§11), fake-vs-production divergence.
- Not findings: assessments *about* a scenario (re-grade and keep the scenario) and gaps in the skills themselves (those are methodology feedback).

## Appendix A: worked example

A flow persists an order and, on persistence failure, falls back to a secondary store with a retry wrapper around the primary write. Paths and syntax are JS-flavored illustration; the layout is schematic, not the tool's real row shape, and the parenthesized glosses are the agent's own reading, not tool output.

```
# 1. Coverage reports (arm type + description; arm hit 0, parentHits>0):
src/order.js:42:9   if       else  (retry wrapper recovered branch)    snippet: "if (attempt > 1) metrics.inc(...)"
src/order.js:57:3   catch    catch block                               snippet: "} catch (e) { return fallback(order) }"
src/fallback.js:12:5 cond-expr falsy (secondary also failed)

# 2. Each is a QUESTION:
42 -> fail primary write once then succeed        => fail(store, "write", [timeout, null])   [recovery scenario]
57 -> primary always fails                        => fail(store, "write", [timeout, timeout, timeout]) [exhaustion]
12 -> primary AND secondary fail                  => one Given per layer

# 3. Reachability triage of a remaining line (statement channel):
src/order.js:61  "audit.log(order)"  uncovered, follows `await queue.send(...)` that throws in every scenario
  -> presumed COVERABLE (always-failing fake masks a live statement), not dead: add a success scenario.

# 4. Decision-table cell the coverage tool cannot produce:
# dimensions: primary=[ok,fail-once,fail-always]; secondary=[ok,fail]; flag_audit=[on,off]
primary	secondary	flag_audit	disposition	reason
fail-once	ok	on	covered	'Recovered write is persisted and audited'
fail-always	ok	off	new	(write: fallback without audit)
fail-always	fail	on	new	(write: both stores fail, error response, nothing persisted; stores fail independently, so the input can arrive)
```

The coverage rows prompt three scenarios; the decision table forces a fourth (flag-off fallback) that no branch demanded; the mutation question confirms the exhaustion scenario alone would pass with the retry deleted, so recovery is the one that proves the wrapper.
