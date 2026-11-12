# Scenario Design

Signatures and code are pseudocode; tests are Gherkin. Examples marked *(platform: …)* illustrate a platform-specific form of a platform-neutral rule; unmarked examples are invented and neutral. Scope: the feature-file side of authoring (scenario anatomy, naming, assertion strength, step-definition hygiene, scenario economy, context preservation). What the ownership safety net does at runtime, fake internals and failure injection live in `fakes.md`; techniques that find scenarios live in `discovery.md`.

**Thesis.** The feature file is a black-box behavioral spec readable by someone who has never seen the code, and the only durable artifact (specs, tickets and threads decay). Every rule below exists so a scenario can fail for the right reason and a cold reader can tell what it protects.

Examples below use an invented service: a *reminder service* that sends overdue-invoice reminders over email and SMS and records each send.

## 1. Scenario anatomy

Fixed order: **Background** (setup shared by most scenarios) → **Given** (inputs and relied-on defaults) → one **When** (the trigger) → **Then** (outcome → reads → outputs → absences).

### 1.1 Background: only what most scenarios share
- `Background` carries setup shared by most scenarios, and no more specificity than they all need (`Given an authenticated customer`, not `a premium customer`, unless every scenario depends on premium). Over-specifying forces every scenario into assumptions most don't hold.
- A scenario needing different setup overrides it with its own Given.

### 1.2 Given: why, not what
- Use **descriptive predicates**, not raw ids or opaque values. The reader must never open a seed file to learn why a fixture was chosen.
- **Exception: a value the scenario refers back to is stated literally.** If a later step asserts it, reuses it or compares against it, the Given carries the value (`And the customer has the email "ada@example.com"` → `Then the reminder should have been sent to "ada@example.com"`). A predicate there would hide the link between input and expected value (§4).
- Distinguish **direct properties** (adjectives: `a premium customer`) from **configuration** (state: `the customer has SMS reminders enabled`).
- **Relied-on defaults are explicit.** If behavior depends on something *not* being configured, add a Given naming it, even if the step is a no-op. An implicit default is a hidden input: it can change without any scenario noticing.

```gherkin
# Good: predicates say why this customer was chosen
Given a premium customer
And the customer has SMS reminders enabled
And no quiet hours are configured        # relied-on default, made explicit

# Bad: needs a fixture lookup
Given customer "c-4471"
```

### 1.3 When: one trigger
- One `When` per scenario by convention (Gherkin's grammar allows several): the single stimulus whose outcome the scenario owns, so a failure points at one cause. Multi-stimulus scenarios (several requests) are permitted only when the interaction is the subject, and each stimulus's IO is then owned (`fakes.md` §12.5).
- When the system under test is the **receiver** of an inbound event, use passive voice (`When the payment notification is received`): Givens describe what the external party sent, the When says it arrived. A deliberately malformed inbound payload keeps the active form with an explicit body.

### 1.4 Then: order and shape
Order inside a `Then` block: **outcome → reads → outputs**. Outcome is the synchronous result (status, returned body); reads are inputs the flow fetched (lookups, queries); outputs are the effects it produced (writes, emits, sends). Reads are inputs, not outputs: separate steps placed before the output steps, never bundled into an ownership step. The static rule (`then-step-ordering`) enforces tier order among the steps it can classify; a read phrased as an output, or bundled into an ownership step, is not caught. The phrasing that classifies a step into a tier is configurable per repo and must be overridden to match the repo's step wording.

**Bracketed IO.** Owning more than one output in a single Then step is an **optimization for the reader**: one cohesive action (`the reminder should have been sent and recorded`) reads more easily than a column of Then steps spelling out its parts. The bracketed list keeps that detail visible. A Then step that owns more than one output ends with a bracketed list of every output it owns:

```gherkin
Then the reminder should have been sent and recorded [send-email, write-send-log, emit-audit-event]
```

- **Why:** the list is the reader-facing ledger of what the step accounts for. It is **positive** (what is owned, not what is negated), so a reader sees the step's whole claim without opening its definition. Pair with the safety net (`fakes.md` §12): anything the flow emits that no list or default names fails the scenario.
- **Delimiter:** square brackets because the step matcher must not interpret them. *(platform: Cucumber expressions treat `( )` as optional-text markers, so `(a, b)` silently swallows the list and breaks matching.)*
- **Closed allowlist.** Every bracketed name, including a single-output one, must be registered in the linter's allowlist (`well-known-io-names`) the first time it is used, kept in step with the repo's ownership and default destination keys. Until the list is populated the linter only warns it is empty; once populated an unknown name (typo, undeclared destination) fails the build. The linter is deferred to CI, so run it while authoring or an unregistered name stays silent until then.
- **Name the exact destination** (`the "digest" queue`), not "the queue". Naming it forces the author to learn which destination a given config or flag routes to, which surfaces permutation scenarios. A bracketed list already names its outputs, and a single-destination boundary where the step text makes the destination obvious needs no quoted name.
- **Implementation:** one single-effect helper per bracketed name; the step calls them in turn (an advisory static rule flags the obvious inline case of a multi-output step whose body doesn't split). Go-to-definition from a list entry lands on exactly one effect.
- **Own each IO set once per scenario** (claims consume; mechanics in `fakes.md` §12.2). When two assertions need the same set, fold them into one Then driven by a data table, not a second step.

**Absence** is an owned outcome: a step with an empty body that claims nothing (`fakes.md` §12.4). A negative earns its place only where it counters an expectation the flow sets; stamped on every scenario it counters nothing.

**Scenario Outline.** At least one `Examples` column should be asserted in a Then (`unasserted-example-column`, advisory; ignorable when every row behaves identically): a column used only in Givens varies an input whose effect nothing checks. A step whose whole text is a single placeholder is banned (`example-column-whole-step`, blocking): it hides the step wording from the reader and the linter.

## 2. Naming

### 2.1 Scenario names carry the concern, not the steps
- Name by **business-level** behavior (what the customer sees) or **effect-level** behavior (which system receives what). Never by implementation detail: internal variable, flag or key names, function names, boolean conditions. Test: *would someone who hasn't read the code understand what this protects?*
- The name must **carry information the steps don't**: the business or product concern (why it matters, who is affected, which rule it pins). A name that reads the inputs and outputs back as a sentence adds nothing.

```gherkin
# Good: the concern
Scenario: Customers in quiet hours are not woken by reminders
# Bad: restates the steps
Scenario: Customer with quiet hours returns SKIPPED for reminder
# Bad: leaks implementation
Scenario: Returns 200 when suppressUntil is set
```

### 2.2 Every checkable claim in a name is asserted
A concern ("not woken") needs no step; a **behavioral claim** (`…but only the first reminder is sent`, `…under its original subject`) is a promise that nothing can fail unless a Then verifies it. Add the assertion or strike the claim. Never pad a name to look richer.

### 2.3 Then steps name the effect, not the fake
`the reminder should have been sent to the "sms" channel`, not `the SMS fake should have 1 message`. A step named after the fake or storage method describes how the test verifies, not what happened.

## 3. Assert an observable outcome

**Invariant:** every business-flow scenario owns an observable outcome: the **full shape** of a produced output, or an **explicit absence**. Asserting that the flow *reached* a state is a **smoke test**, and business flows have no smoke tier.

- Smoke tests: a status code alone; a key's presence without its value; a substring or `contains` over a serialized payload (proves the value appears *somewhere*, not that it landed at the right path in the right shape; a regression that moved or duplicated it still passes).
- A reusable `… payload field should contain <substring>` step is an anti-pattern generator: every scenario reusing it inherits a non-comprehensive assertion. Own the field structurally; remove such steps when found.
- Not a smoke test: a rejection scenario (4xx plus empty-body absence steps). Absence is owned.
- Full-shape mechanics (pinning controlled values, shape checks only for uncontrolled fields, `deep.equal` of the remainder) and the ban on loose matchers are `fakes.md` §12.1.

## 4. Step definitions

- **Use every captured parameter.** An unused capture is a value the step ignores (copy-paste drift). Remove it from the pattern if the step is meant to be a no-op. *Exception:* an absence step is intentionally empty because the safety net enforces it; its parameter exists for readability, with an inline lint-disable.
- **Assert values, not presence.** A check that a key exists cannot fail on a wrong value.
- **Expected values derive from scenario inputs, never from captured output.** The inputs are the Given-seeded data and what the When sent. Comparing an output to another read of the same system is a tautology: a wrong value everywhere still passes (`fakes.md` §12.1). Every clock, id generator and random source is controlled (`fakes.md` §8), so an output is predictable from the scenario's inputs and the scenario can supply the literal. The response is never the only available source, unless the value comes from code the harness can't control (a salt or nonce generated inside a third-party library): that is a gap in `fakes.md` §8 to record, and only then is a shape check acceptable (`fakes.md` §12.1).
- **Failure messages answer three questions** for a reader with no project context: what failed (with interpolated actual values), the probable cause in a test context, and what to check (which seed, fake, config). `expect(x, 'mismatch')` costs a debugging session in parallel CI output.
- **Reuse a step only when the observable behavior is identical** (same IO pattern, same shape). Create a new step when fields, destinations or shapes differ, even if the customer-facing response is the same.
- **Narrowest scope.** Feature-specific steps live in feature-specific files; shared files hold only steps reused across features.
- **Step names are business-level** (§2.3): never named by the fake method they call.

## 5. Scenario economy

- **Combine assertions for one setup.** When the same Givens exercise distinct behavior in several outputs, assert them all in one scenario rather than duplicating Given/When. One scenario with several Thens beats two with identical setup.
- **Duplicates.** Two scenarios are duplicates only if they match at **every** observable boundary (response, status, IO side effects, persisted data) **and** the shared result is intended for both inputs. One differing boolean makes them distinct. A collapse that hides a quirk (a junk path segment silently parsing as a valid id) is a characterization: keep both and file the quirk. Dedup is a narrow exception, not a pruning pass: a surviving near-duplicate is cheap, a lost boundary case is not. When unsure, keep both.

## 6. Context preservation

The feature file is read cold for years by people who never saw how it was made. It carries context at three levels, plus a constraint on how it refers to anything.

| Carrier | Holds | Source it replaces |
| --- | --- | --- |
| Scenario name | The business concern (§2.1) | The "why now" |
| Scenario description (free text before the first Given) | Affected population, impact, the governing rule | The spec's rule statement |
| Comment block over a group of scenarios | Compressed originating spec **and** at least one external link (ticket, thread, design doc) | The ticket, PRD, thread |

- **Links are literal.** A rotted link is still a search term; never paraphrase it away.
- **Comments explain why, never what or how.** Rationale unrecoverable from the steps (why a group exists, why a config property matters, a constraint) is always worth keeping and overrides "sparingly". A comment restating a step or the scenario name rots when the step changes.
- **Record the why against the production code, never the process that produced the test.** *"Pins the old naming because a fix is in flight"* is code-relative; *"from the third review round"* or a section named for the wave that wrote it means nothing to a cold reader. Name a section for the subject its scenarios cover. Production-code history ("workaround dates from a vendor migration") is code-relative and stays.
- **Durable references only.** Symbol names instead of line numbers (a cited line goes stale on any unrelated edit and a reader can't tell fresh from rotten). Properties ("every caller", or the predicate selecting a subset) instead of counts ("six callers" is a promise to re-audit nobody keeps).
- **Check:** if the PRD and thread were deleted tomorrow, does the file still say why these scenarios exist and where to dig? Working notes may carry exact lines and counts; the feature file may not.
- **A behavior-changing contribution** must leave its file carrying a why and an external link for the added scenarios (one covering both is enough). Trivial changes (doc-only, test-only refactors, confirmed dead code) have no spec to embed.

## 7. Enforcement

| Rule | Enforced by | Tier | Residual |
| --- | --- | --- | --- |
| Bracketed names registered | [`well-known-io-names`](tools/linters.md#well-known-io-names) (gplint) | static | Allowlist can be left empty (warn only) until populated |
| Multi-output step carries a list | `multi-output-bracket-list` | advisory | Judges whether outputs are "distinct"; a transformation plus its destination counts as one |
| Then order outcome → reads → outputs | [`then-step-ordering`](tools/linters.md#then-step-ordering) (gplint) | static | Tier classification is phrase-based; unmatched wording is unclassified; a read phrased as an output, or bundled into an ownership step, passes |
| Outline has an asserted column | [`unasserted-example-column`](tools/linters.md#unasserted-example-column) (gplint) | advisory | Any one column in any Then satisfies it, even a Then that doesn't really depend on it |
| Outline step is not a bare placeholder | [`example-column-whole-step`](tools/linters.md#example-column-whole-step) (gplint) | static | Only a step that is exactly a lone `<col>` is caught; a placeholder inside other text passes |
| Multi-output step split into single-effect helpers | [`multi-output-not-split-helpers`](tools/linters.md#multi-output-not-split-helpers) (eslint) | advisory | Only fires on a literal step pattern with a bracketed list; delegated or computed patterns pass |
| Unused captures | [`no-unused-step-params`](tools/linters.md#no-unused-step-params) | static | Presence of use, not quality of use |
| Assertion messages carry what/cause/check | `diagnostic-assertion-messages`; [`expect-custom-message`](tools/linters.md#expect-custom-message) | advisory; static | Message quality is a judgment; the static rule checks presence |
| Full-shape assertions | `full-shape-assertions` | advisory | Judgment on helper delegation |
| Names: concern, no leaks, claims asserted | `scenario-naming`, `then-step-naming` | advisory | Unasserted-claim detection depends on the judge reading the Thens |
| Given clarity, relied-on defaults | `given-step-clarity` | advisory | An unstated default is only visible if the judge knows the config |
| Observable outcome | `assert-observable-outcome` | advisory | The only detector for smoke tests |
| Destination named | `destination-in-assertions` | advisory | Whether a boundary is multi-destination is a judgment |
| Why-comments, link present | `feature-file-comments`, `new-scenario-missing-context` | advisory | Cannot verify a link resolves or that the why is true |
| Duplicates, step reuse | none | none | Reviewer judgment |
| Tautological expected values | `hardcoded-expected-values` | advisory | Only the judge sees it. A value derived from the output through a helper may escape |

"Advisory" means the judge decides whether the code violates the rule, not that the rule is optional.

## Appendix A: worked example

```gherkin
# Quiet hours: customers complained of SMS reminders overnight. Reminders inside a
# customer's quiet window are deferred to its end, not dropped.
# See: TICKET-2210, https://chat.example.com/archives/C0123/p1700000000
Feature: Reminder delivery

  Background:
    Given an authenticated customer
    And the clock is "2025-03-01T03:00:00Z"

  Scenario: Customers in quiet hours are not woken by reminders
    Customers set a quiet window; a reminder due inside it must wait for the
    window to end rather than be sent or dropped.

    Given a premium customer
    And the customer has SMS reminders enabled
    And the customer has quiet hours from "22:00" to "07:00" UTC
    And an invoice overdue by 5 days
    When the overdue reminder job runs
    Then the job result should be "deferred"
    And the overdue lookup should have been read [read-overdue-invoices]
    And the reminder should have been scheduled for "2025-03-01T07:00:00Z" [write-schedule]
    And no reminder should have been sent
```

Why it bites: `the clock is …` is a Given because the scheduled time is an expected value derived from inputs (§4). If the code ignored quiet hours and sent immediately, `no reminder should have been sent` fails and the safety net also fails the unowned send. If the claim *"are not woken"* were in the name with no absence step, nothing could fail (§2.2). A substring check on the schedule payload would still pass if the time landed in the wrong field (§3).
