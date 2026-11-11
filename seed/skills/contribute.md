# `/telem-{platform}:contribute-*`

The `contribute-*` skills give an agent the methodology for each phase of [Red-Green-Refactor-Whitebox](../red-green-refactor-whitebox.md) in a graduated repo. In this guide, the skill `/telem-{platform}:{skill-name}` will be abbreviated to `/{skill-name}`.

Build them as terse as possible. Each is a sub-skill: not user-invocable, loaded only by the phase in `CONTRIBUTING.md` that names it (progressive disclosure). A skill must not know who called it. It says which cores of methodology apply and why, and links to the seed chapter that holds the *how* instead of restating it.

Rules shared by every skill here:

- The workflow itself (gates, hard rules, commands) lives in `CONTRIBUTING.md`. These skills hold only the how-to for their phase.
- Forward TDD: spec, then failing test, then code. This is the inverse of `/backfill`, which derives tests from existing code.
- Each skill refers to the repo's BDD directory by what the repo established (instruction files or the bootstrap report), never by a hardcoded path.
- Repo guides (`WRITING-TESTS.md`, `WRITING-FAKES.md`, `COLLECTED-WISDOM.md`) carry the repo-specific half of the how-to. Read them; grep `COLLECTED-WISDOM.md` for relevant gotchas instead of reading it end to end.
- Methodology cores are loaded at the sub-step that needs them, not all up front. A core that doesn't apply to the change is skipped.

| Phase | Skill |
| --- | --- |
| 1a / 1b: Spec | `/contribute-spec` |
| 2: Tests (Red) | `/contribute-tests` |
| 3: Implementation (Green) | none; the phase is plain implementation |
| 4: Refactor | `/contribute-refactor` |
| 5: Emerging behavior (Whitebox) | `/contribute-emerging-behavior` |
| After the PR opens | `/review-pr-comments` |

## `/contribute-spec`

Phase 1. Pins down what the change does and why, precisely enough to write failing tests against, and captures context that would otherwise evaporate.

**Inputs:** a feature request (1a) or a bug report (1b).

**1a, PRD (features).** Write a document with: problem statement, proposed behavior, scope (in, and explicitly out), known edge cases. The PRD is a working document and is never committed, because it goes stale and misleads. The tests are the durable artifact.

**1b, Bug triage (bug fixes).** The bug report is the PRD. The agent:

1. Reads the report and identifies expected behavior, actual behavior, and trigger conditions.
2. Asks clarifying questions about anything ambiguous: reproduction, affected configs, edge-case behavior, what is explicitly not being fixed. Genuinely disputed behavior is escalated before going on, and the decision is recorded in the eventual test comments.
3. Summarizes back: what is broken, what "fixed" looks like, what is in and out of scope. This replaces the PRD review.

**Context capture.** While writing the spec, mark what must outlive it: the business motivation, the rule being pinned down, and every external link (ticket, chat thread, design doc). Plan where each lands in the feature file, per [Scenario Design: Context preservation](../scenario-design.md#6-context-preservation).

**Output:** the PRD or triage summary, submitted for review. No files are committed. Gate: the reviewer approves before Phase 2.

## `/contribute-tests`

Phase 2. From the approved spec, writes the full suite before any production code. At the end every new scenario is red (failing or with undefined steps), none passing.

**Steps:**

1. **Regression triage.** Run the suite first. Existing failures go to the user as action items; a red baseline is resolved before adding to it.
2. **Read the repo guides** (see the shared rules above).
3. **Apply the cores** below, each loaded when reached.
4. Run the repo's `llm-lint` on the changed files ([spec](../tools/llm-lint.md)), then the Gherkin and platform linters, before submitting.

| Core | Applies | Seed |
| --- | --- | --- |
| Scenario design: name by concern, Given says why, honest steps | Always | [Scenario Design](../scenario-design.md) |
| IO ownership: every IO the new behavior produces is owned by a Then or a default; full shape; absence via negative assertions | Always | [Fakes §12](../fakes.md) |
| Error taxonomy: the spec's happy path is a fraction of the surface; work the failure modes systematically | Always | [Discovery §3](../discovery.md#3-error-taxonomy) |
| Context preservation: embed the spec's motivation and links into names, descriptions and comment blocks now, while the PRD is open | Always | [Scenario Design §6](../scenario-design.md#6-context-preservation) |
| Feature flags: both flag states from the start; categorize the flag and declare it in the right layer | The change adds a flag | [Discovery §9](../discovery.md#9-feature-flags) |
| Fixtures and config dimensions: select fixtures by complete predicates; cover every behavior-changing config value the change reads, including the default | Change reads config or seeded data | [Discovery §8](../discovery.md#8-config-dimensions-and-fixtures) |
| Environment profiles: cover both sides of a region/environment branch and tag honestly | The behavior is profile-specific | none yet |
| Determinism: per-scenario isolation, every non-deterministic source faked, no retries or flaky tags | Always | [Fakes §8](../fakes.md) |

**New IO boundary or operation.** A scenario that touches a boundary with no fake either hits the network block or, for a non-network boundary, leaks silently and passes vacuously. So the fake comes first:

- *Brand-new boundary:* classify it ([Fakes §1](../fakes.md)), build the fake with the builder for its class (datastore, pass-through, service; same builders as `/create-fakes`), wire and register it following the repo's "adding a new fake" guide (which also checks for a second fake registry), record the boundary's documented behaviors ([Fakes §11](../fakes.md), [Discovery §10](../discovery.md#10-documented-behaviors-of-faked-boundaries)), then write its parity test ([Fakes §10](../fakes.md)).
- *New operation on an existing fake:* record its documented behaviors and extend the fake's parity tests if the operation changes what the boundary emits.

**Output:** the new feature files, steps and fakes, all red. Gate: the reviewer approves before Phase 3. If review shows significant spec gaps, go back to Phase 1 after asking the reviewer.

## `/contribute-refactor`

Phase 4. Simplifies the implementation with the green suite as the safety net. No test-design core applies. This is not the same as `/backfill-tests`'s `/refactor`, which dedups test code.

Rules:

- Run the suite after every change. If a step turns it red, that step changed behavior: revert or fix it before moving on.
- Never modify approved tests to fit the implementation. A refactor that needs them changed is a behavior change. A test with an incorrect expectation, confirmed by re-reading the approved spec (not by what the new code does), is fixed and the correction noted. The default is that tests don't move.
- Aim for the simplest correct implementation. No abstraction the change doesn't need.
- Stop if thrashing (fixing one test breaks another, repeatedly). It can signal a feature-level conflict; ask for guidance.

Before declaring done: run the repo's full validation (unit tests, lint, BDD), and the full flag-permutation matrix ([runner spec](../tools/flag-permutation-runner.md)) before pushing, since the fast loop misses permutation and profile regressions that CI gates on. Both commands are in `CONTRIBUTING.md`.

## `/contribute-emerging-behavior`

Phase 5. Captures behavior the implementation introduced beyond the spec (defaults, error paths, fallbacks, implicit ordering) in tests. These tests describe behavior that already exists, so they pass immediately. It is the one day-to-day phase where tests derive from code, like `/backfill`.

A diff review catches the obvious additions and misses the implicit ones (a default a getter returns when unseeded, a branch a refactor introduced, a flag interaction). So the skill walks the discovery techniques in order, loading each at its sub-step, and executes every one even when it yields no new scenario. Feeling that a step is redundant is the signal that something is about to be missed.

**Walk, in order:**

1. Coverage on the changed feature: find branches the new code added that no scenario hits ([Discovery §1](../discovery.md#1-coverage-driven-discovery)). Classify what stays uncovered: unreachable, telemetry-only, or a bug ([Discovery §2](../discovery.md#2-reachability)).
2. Reasoning lenses, each in turn: decision tables ([Discovery §4](../discovery.md#4-decision-tables); the table is materialized and must pass [`check-decision-table`](../tools/check-decision-table.md) plus the advisory reason-quality `llm-lint` rule before the lens is done), discrete mappings ([§7](../discovery.md#7-discrete-mappings)), optional properties ([§6](../discovery.md#6-optional-properties)), protocol and code-path thinking ([§5](../discovery.md#5-protocol-thinking-and-code-path-thinking)).
3. Blind test ([Discovery §11](../discovery.md#11-blind-test)), only when the feature changed substantially.

**Alongside the walk:**

- IO ownership is unconditional. New code paths produce new IO; own all of it.
- A new IO boundary introduced during Green must be faked before its IO can be owned. Build it the same way as in `/contribute-tests` (classify, build, wire, record behaviors, parity). A new operation on an existing fake needs only behavior recording and a parity extension.
- Feature flags, environment profiles and fixtures load only if the change touches one. New code under an existing flag is the common case; a brand-new flag was handled in Phase 2.
- Determinism: emerging behavior often involves ordering, clocks or async timing. Fake the source. `@no-parallel` is only for genuinely un-fakeable runtime dependencies ([Fakes §8](../fakes.md)).

A new test that fails means one of two things: a bug (write the test to match current behavior and file the bug) or a misreading of the code. Resolve it before submitting.

**Output:** new scenarios, all green on arrival, submitted for review. Gate: the reviewer approves.

## `/review-pr-comments`

After the PR opens. Unlike the skills above, this one is not tied to a numbered phase and is invoked on its own. For each unresolved reviewer comment on a BDD PR it gives a verdict, a bucket, a methodology explanation and a drafted reply. It is advisory: it recommends and drafts, and the human decides what to apply and post. It composes with a generic PR-comment workflow, which triages and applies, while this one supplies the methodology judgment.

**Why it exists:** the reviewer sees the diff, not the suite, and usually knows BDD in general but not this methodology's specifics. Much of what they flag is about conventions the whole suite should follow, not the one flagged line.

**Steps:**

1. **Gather.** Find the PR for the current branch and read every unresolved review thread with its file and line (a comment and its replies are one thread). Skip threads resolved by agreement. If there is no PR or no comments, say so and stop.
2. **Judge each thread with a fresh subagent**, in parallel. The author is biased toward defending the code, so the author does not judge. Give each subagent: the thread verbatim; the flagged file read in full (surrounding scenario and comment block included); the methodology cores matching the topic (it cannot tell a correct choice from slop without them); and the bucket taxonomy below. It returns:
   - **Verdict:** valid or a misunderstanding. Valid means the reviewer found a real problem, even if their proposed fix is wrong or incomplete (the problem is judged, then the correct fix is recommended).
   - **Bucket**, **explanation** (in terms a reviewer who doesn't know the methodology will accept), and for a valid finding the **widen result** (the search it ran and the other instances found, with references).
3. **Present** every thread (valid or not): the point in one line, verdict and bucket, explanation, the recommended action with widen count, and a drafted reply. A valid reply acknowledges the finding and says what was done and how wide it goes. A `reviewer-wrong` reply explains the methodology courteously and says nothing will change.
4. **Apply nothing until the user decides**, per comment. Approved actions are then carried out, including widening, routing to the guide, and filing a retro.

**Buckets and the rule behind them: route the finding, don't just fix the site.**

| Bucket | Meaning | Action |
| --- | --- | --- |
| `local` | A real problem specific to this flow. Also used when the rule generalizes but the methodology or a lint rule already carries it. | Fix here (and widen); nothing to route. |
| `convention` | A real problem that is a rule the whole suite should follow and isn't captured yet. | Fix here, widen across the suite, move the rule into the repo guide and leave a one-line pointer at the site. |
| `methodology-defect` | The methodology itself produced it. Test: would following the methodology faithfully still have produced this? If the methodology already forbids it, it's `convention` or `local`. | Fix and widen locally, and route to a retrospective. |
| `reviewer-wrong` | The reviewer misunderstood a correct choice (for example, challenging an input the code genuinely accepts). | Change nothing in the code. Optionally add a one-line provenance comment to head off re-litigation ([Scenario Design §6](../scenario-design.md#6-context-preservation)). |

**Widen every comment.** For any `convention`, and often `local`, count the other occurrences across all feature files and fakes before replying, so the reply says "fixed here and the N other places". Some shapes are structural or ratio patterns (for example, a negative step on every scenario of a file), so count by shape, not just by searching the flagged text.

**Commit hygiene.** Fixes made in response to review are a separate concern from other work in flight. Widening, guide routing and the retro each go in their own small commit.

**Done when:** every unresolved thread has verdict, bucket, explanation and a drafted reply; valid `convention` findings carry a widen count and a routing recommendation; `methodology-defect` findings are flagged for a retro; and the user has decided per comment. Nothing was rewritten without the user's approval.
