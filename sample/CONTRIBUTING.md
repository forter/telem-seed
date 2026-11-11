# Contributing

This document is the source of truth for the **workflow**: the phases, the gates, and the hard rules. It applies to **both human and AI contributors**, but each uses it differently:

- **AI contributors** load the deep *how-to* for each phase by invoking the matching `contribute-*` skill via the Skill tool (named per phase below).
- **Human contributors** read that same methodology in the plugin's skill files and in this repo's guides (`test/telem/WRITING-TESTS.md`, `test/telem/WRITING-FAKES.md`, `test/telem/COLLECTED-WISDOM.md`). The `contribute-*` skills are internal — they don't appear in the `/` menu and can't be slash-invoked. A human's role in this workflow is the **approver at each phase gate**.

This file **routes; it does not replicate** the methodology — the per-phase pointers below send you to the single source of truth for the *how*.

## Development Workflow

This repo follows a **red-green-refactor** cycle where tests are written upfront, before the implementation. Every feature or change goes through the phases below, each gated on explicit approval before proceeding.

### Pre-Flight: before every change

Before starting any change — whether you enter at Phase 1 or, for a trivial change, jump straight to Phase 2 — **run `/telem-bdd-node:preflight`** and resolve anything it flags before continuing.

There are two entry points into this workflow:

- **Features** start at Phase 1a (PRD).
- **Bug fixes** start at Phase 1b (Bug Triage).

#### Trivial Changes

Changes that don't affect runtime behavior — documentation, test-only changes, dead code removal confirmed by coverage — can skip Phase 1a and go straight to Phase 2 (run the Pre-Flight first) with a one-line spec describing the change.

Changes that add, remove, or modify code paths — including site lists, flag values, and config that routes behavior — are **not** trivial and require the full workflow.

### Phase 1: Spec — PRD (1a, features) / Bug Triage (1b, bug fixes)

> **Methodology:** follow `/telem-bdd-node:contribute-spec`.

**1a — PRD (features).** Write a Product Requirements Document describing what the change does, why it's needed, and its boundaries: problem statement, proposed behavior, scope (in *and* explicitly out), and known edge cases. PRDs are working documents — **do not commit them** (they go stale and mislead). The tests are the durable artifact; Phase 2 embeds the PRD's context into them.

**1b — Bug Triage (bug fixes).** The bug's description serves as the PRD. Understand the bug (expected vs actual behavior, trigger conditions), ask clarifying questions for anything ambiguous (reproduction, affected sites/configs, scope boundaries; escalate genuinely disputed behavior and record the decision in the test comments), then summarize the spec back: what's broken, what "fixed" looks like, what's in/out of scope.

Submit the PRD (1a) or the triage summary (1b) for review. **Do not proceed to Phase 2 until the reviewer is satisfied.**

### Phase 2: Tests (Red)

> **Methodology:** follow `/telem-bdd-node:contribute-tests`.

**Regression triage.** Before writing any tests, run `npm run bdd-test` to find existing failures. Raise them as action items — a red baseline is something the reviewer will want resolved before proceeding.

From the approved spec, write the full BDD suite **before any production code**. Read the repo's guides for the repo-specific part (`test/telem/WRITING-TESTS.md`, `test/telem/WRITING-FAKES.md`, and grep `test/telem/COLLECTED-WISDOM.md` for relevant gotchas). Run `npm run bdd-test:llm-lint:unstaged` to catch naming/structure/style issues before submitting.

At the end of this phase the suite is **red** — every new scenario is failing or has undefined steps, none passing — because it describes behavior that doesn't exist yet.

Submit the tests for review. **Do not proceed to Phase 3 until the reviewer is satisfied.** If review reveals significant spec gaps (missing requirements, wrong scope), go back to Phase 1 — ask the reviewer before reverting.

### Phase 3: Implementation (Green)

Using the spec and tests as the specification, write the production code. Validate continuously against the BDD suite until it is green:

```bash
npm run bdd-test
```

Then run the full validation (Gherkin lint + BDD, which includes a `tsc` step) to catch anything else:

```bash
npm run lint:features && npm run bdd-test
```

Make the tests pass with the simplest correct implementation — don't optimize or restructure prematurely (that's Phase 4). **Never modify approved tests to accommodate the implementation** (add new tests instead; if a test has an incorrect expectation confirmed by re-reading the approved spec, fix it and note the correction in the PR). **Stop if you start thrashing** between test failures — that can signal a feature-level conflict; ask for guidance.

### Phase 4: Refactor

> **Methodology:** follow `/telem-bdd-node:contribute-refactor`.

With a fully green suite as a safety net, refactor and simplify the **implementation**. After every change, confirm the BDD suite stays green:

```bash
npm run bdd-test
```

Before declaring the refactor done, run `npm run lint:features && npm run bdd-test` to verify lint and BDD still pass.

### Phase 5: Implicit Behavior Tests (Whitebox)

> **Methodology:** follow `/telem-bdd-node:contribute-emerging-behavior`.

Implementation often introduces behavior the spec didn't anticipate — default values, error paths, fallback logic, implicit ordering, edge cases visible only while writing the code. Now that the implementation has settled after the refactor, capture this behavior in tests. These describe behavior that **already exists**, so they should pass immediately.

Run the full suite to confirm nothing regressed:

```bash
npm run bdd-test
```

Submit the new tests for review. **Do not proceed until the reviewer is satisfied.**

### Before Pushing: Run the Full Matrix

The inner loop above runs `npm run bdd-test` — the suite once, under default flags. That's fast, but it doesn't exercise the flag permutations where most regressions hide. CI gates on the **full matrix** (every feature under all flag combinations), so run it locally before pushing:

```bash
npm run bdd-test:permutations
```

### After the PR opens: responding to review

> **Methodology:** follow `/telem-bdd-node:review-pr-comments`.

Once a BDD PR is under review, invoke `/telem-bdd-node:review-pr-comments`. Per reviewer comment it gives a **right/wrong + bucket** verdict (local / convention / methodology-defect / reviewer-wrong), a **methodology explanation** the reviewer will accept, and a **drafted reply**. Like the phases above, this file routes; the skill holds the *how*.

The core rule is **route the finding, don't just fix the site**: a reviewer sees the diff, not the whole suite, so fixing only the one line they flagged is the least valuable response. A **convention** belongs in the repo guide (`test/telem/WRITING-TESTS.md` / `test/telem/WRITING-FAKES.md`) with a pointer left at the site, **widened** across every other place it occurs; a **methodology defect** goes to a retro. It's advisory — the human approves each action and reply.

### Hard Rules

- **Stop between phases.** Do not proceed to the next phase without approval — the human is the approver at each gate.
- **Tests are the spec.** They carry the context — scenario names describe business concerns, descriptions explain product context, comment blocks link to external resources.
- **Never modify approved tests to accommodate implementation.** Add new tests if needed; don't change existing ones. If a test has an incorrect expectation (confirmed by re-reading the approved spec), fix it and note the correction in the PR.
- **Stop if thrashing.** If fixing one test breaks another repeatedly, stop and ask for guidance.
- **Run the full matrix before pushing.** The fast inner loop runs under default flags; `npm run bdd-test:permutations` runs every flag combination — what CI gates on. Run it locally before pushing.
