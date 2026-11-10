# Telem’s Foundational Principles for Tests

## Thesis

Telem is built around one central proposition: a service’s tests for functional requirements should be a durable, executable, black-box specification of every behavior the service promises at its boundaries. Everything else (Gherkin, full-shape assertions, IO ownership, fakes, coverage loops, decision tables, flag permutations, isolation, lint rules, etc.) exists to make that specification readable, comprehensive, reproducible, cheap to execute, and difficult to accidentally weaken.

## The foundational principles

When building out your Telem implementation, you must continuously follow these principles. **The zeroth principle is being pragmatic**, so all of these may be broken, but only when the tradeoff is clearly understood and hedged against.

### 1. Contract-first

Tests verify promises made **at observable boundaries**, not the internal route used to fulfill them. The canonical unit of truth is request in, response out, persisted data, emitted messages, and other externally visible side effects. The tests must be implementation-agnostic, discarding any connection to implementation detail. This allows authors to refactor internally at will and without repercussion.

Examples:

* Scenario and step names use business or effect vocabulary, not function or module names.
* Fakes are placed at external IO boundaries so real middleware, routing, retries, fallbacks, and error handling still execute.
* Scenario identity is determined by observable equivalence: two cases are duplicates _only_ if every observable boundary is identical.

### 2. The suite is the durable specification

Telem treats tests as the artifact expected to outlive PRDs, tickets, Slack discussions, implementation details, and the original authors. The feature file must preserve not only what happens but **why** the behavior matters.

The hierarchy is explicit:

* Scenario names carry the business or product concern.
* Scenario descriptions carry the affected population, impact, and governing rule.
* Comment blocks carry compressed specification context and durable links.
* Given/When/Then steps carry the executable behavior.

Readability therefore means more than "easy prose." A reader should be able to understand the black-box contract without reading the implementation of Gherkin steps or any production code. Defaults that affect behavior must be made explicit, concrete claims in names must be asserted, and comments must preserve code-relative reasoning rather than methodology provenance or fragile line numbers.

### 3. Make the implicit explicit

Telem systematically turns hidden assumptions into reviewable declarations. The whole point is to understand: an assumption that remains implicit cannot be reviewed, permuted, linted, owned, or mechanically checked.

Examples:

- Behaviorally relevant defaults become explicit `Given` steps.
- Feature-flag and configuration reads become manifests with declared baseline values.
- All produced side effects are explicitly owned, and none others may happen behind the scenes.
- Dynamic values receive explicit shape assertions rather than being ignored.
- Business motivation and historical context move from transient discussions into scenario names, descriptions, comments, and durable links.

When something is implicit, failure is silent. Telem strives to make everything explicit so that everything can fail loudly.

Explicitness is also what makes the other principles enforceable. Readability needs visible assumptions. Comprehensiveness needs materialized dimensions. Determinism needs declared sources of time, randomness, and state. Mechanical gates need artifacts to inspect. Epistemic honesty needs residual uncertainty to be named rather than implied.

### 4. Complete observable behavior

Telem’s comprehensiveness standard is defensive: every distinct observable behavior belongs in the suite. Since test authorship and maintenance is much cheaper when compared to human-owned tests, we decide to err on the side of too many tests than to leave behavior uncovered.

Every business-flow scenario must own its full observable outcome or an explicit absence. Status-only checks, key-existence checks, and substring checks are rejected as smoke tests because they do not pin the protocol’s complete shape. Near-duplicates may be merged only after proving equality at every observable boundary; when uncertain, comprehensiveness wins.

Completeness is pursued through multiple complementing mechanisms, including:
* **Top-down** - exploring the protocols of the system's observable interfaces
* **Coverage-based** - what code paths are reachable but have not been explored for their behaviors
* **Bottom-up** - what do the leaves of execution, like calls to IO, provide as an interface and is that interface exhausted

### 5. Account for the negative space

A good Telem scenario proves both what happened and that nothing else happened. Every used Input and Output must be claimed by an assertion or a defined default. Any unclaimed side effect must fail the scenario.

This can catch an accidental newly produced queue message, a write to object store, etc. that ordinary positive assertions never ask about by design. Ownership APIs throw when the expected datum is absent, and concrete identifiers are preferred over permissive predicates so an assertion cannot silently sweep unrelated output.

This yields a stronger test model:

* Expected output must exist and match completely.
* Unexpected absence must be stated explicitly (e.g. when every other test writes to disk, but this one doesn't).
* Unexpected output is rejected automatically.
* Failed IO attempts are still observable and must be owned, even when they do not alter durable state.

The suite behaves like a closed and comprehensive accounting system for observable effects, not a collection of spot checks.

### 6. Deterministic by construction

One of the most frustrating things about a bad test suite is lack of determinism. It could mean anything from flaky tests to something that's impossible to pin down for a test and is therefore never tested. This directly impact how much you trust a test suite: an irreproducible failure cannot be diagnosed, and an irreproducible fix cannot be verified.

In Telem, a scenario must reproduce under any execution environment, test execution order and parallelism. This is achieved by faking-out the entire set of side effects / IO around the system, in similar fashion to how pure-functional systems are tested.

Note that parallelizability is not merely there as an optimization technique. Successful parallelization is evidence that isolation is correct, and isolation is required to deliver on this principle.

### 7. Speed enables trust

Having tests that run incredibly fast is what allows us to run all tests after every change, locally rather than only in CI. This presents a comprehensive and tight feedback loop, allowing both humans and AI to trust that the changes being made to the system are correct from a functional-requirements-perspective.

Faked-IO scenarios are CPU-bound and are expected to run in single-digit milliseconds. Since the clock is also faked and can therefore be controlled in the test itself (see the determinism principle above), hundreds of milliseconds are treated as a correctness signal: usually an unseeded dependency waiting for data, a real timeout, a sleep, or accidental external IO.

### 8. Fakes must preserve behavior, not wiring

Mocks usually assert how code called another component and therefore couple tests to internal structure. This makes tests brittle, so Telem prefers behavioral Fakes, which implement an external boundary in memory, allowing the real application above that boundary to execute unchanged.

Faithfulness has several implications:

* Fake at the lowest practical point where the process communicates externally.
* Preserve attempt logs and expected failures separately from durable state so retries and failed operations remain observable without creating phantom records.
* Keep all external boundaries injectable rather than collapsing them into convenient but unfaithful construction inputs.
* Fail loudly when a fake reads an undeclared flag or configuration key.

How do we know that behavioral fakes are true to their origin? We can't trust the way the code treats its dependncies to tell us the full story of the behavior domain. This is why Telem introduces a second type of tests altogether - **Fake Parity tests**. Each expected behavior is compared with the real IO, orthogonally to the behavior tests. When run, these tests provide the trust needed to believe that the fakes are true to the realy IO's behavior in the behavior tests that use them.

Telem does acknowledge pragmatic boundaries in this principle. For example, when communicating with databases using SQL, a full fake would have to provide a SQL parser in the specific dialect. Using a Repository pattern and faking that instead of a database driver drops the need for the SQL parser, and parity tests against the real database compensate.

### 9. Mechanical evidence beats intuition

Some agent harnesses drive their agents to be "lazy", deferring work, striving the complete the bare minimum, etc. Used naively, this defeats the principle of completeness. Telem provides agents with a set of tools used as mechanical validation of work, replacing the agent's judgment calls. It replaces that judgment with artifacts and executable checks at every turn.

Here are some of the tools used to replace the agent's judgment:

| Flawed: Judgement                                                                   | Better: Telem's Approach                                                                                            |
|-------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| What code paths remain to cover?                                                    | Coverage tool used to create a gap-closing exploration loop                                                         |
| What input permutations don't have a test?                                          | Decision tables materialize cross-products and set-compare all declared combinations                                |
| Does a test read a certain flag?                                                    | Feature flag runtime accounting, compared to a pre-declared manifest                                                |
| Do we need to change output assertions for a test?                                  | A test that under- or over-declares input/output assertions fails                                                   |
| Are these tests readable and use the same standard as other tests for this service? | A set of deterministic and non-deterministic linters checks the text, implementation, and architecture of the tests |

This principle can be summarized as: (1) Human and agent judgment is fallible, and (2) Do not reason your way out of a tight spot.
