# Lint rules

Static rules that catch a methodology violation at lint time, before any scenario runs. They cover what an AST or a feature-file parse can prove; judgment rules (llm-lint) are listed in [Fakes §13](../fakes.md#13-deterministic-validation-tooling) and are out of scope here.

Each rule's paragraph is its spec. The residual is what the rule still lets through. Examples are invented; the appendix pins the boundary of the rules where prose is ambiguous.

## Conventions shared by every platform

- **Scope by file category.** Three categories: step definitions, support (the World, hooks, helpers) and fakes. Each rule names the categories it runs on. Scope is part of the spec: the same call is correct in one category and a defect in another (the per-scenario temp root is created from the OS temp dir in a hook; the same call in a step body leaks).
- **Blocking unless marked advisory.** Advisory rules have a known false-positive class and must not fail CI. Where the linter has no warning tier, run advisory rules as a separate non-blocking pass.
- **Step registration.** A call that registers a step definition, recognized by the called function's own name however it is reached; the step body is its function argument and the pattern its first argument, when that is a string or regex literal. A rule that matches only one call form silently covers nothing in a repo that uses another.
  - *(platform: JS)* `Given`, `When`, `Then`, `defineStep`, called bare, as a member (`ns.Given`), or in the transpiled sequence form `(0, ns.Given)(…)`.
  - *(platform: Python)* a `def` or `async def` decorated with `given`, `when`, `then` or `step` (case-insensitive; bare or attribute; called or not).
- **Ownership call.** A call whose own name starts with the ownership prefix, bare or as a method. *(platform: JS)* `takeOwnershipOf`. *(platform: Python)* `take_ownership_of_`.
- **Fake-named receiver.** A bare identifier following the harness's fake naming convention. *(platform: JS)* `fake*` or `*Fake`. *(platform: Python)* starts or ends with `fake`.
- **The names are the contract** between harness and linter: rename the harness API (ownership prefix, fake names, seeding methods, scenario-ID accessors) without the rules and they silently cover nothing.
- **Feature corpus.** Rules that cross-reference feature files walk a root directory, skipping dependency, VCS, build and coverage directories, parse every `.feature` file and compile it to pickles (so Outline placeholders are substituted), and collect the step texts; build once per root per lint process and cache. They are biased to false negatives: no feature files, one that can't be read or parsed, a missing Gherkin parser, or a pattern the rule can't compile means flag nothing. A partial corpus makes a live step look dead; a false positive blocks a real change, a false negative leaves one orphan.
- **Messages state what is wrong, why it fails, and the fix.**
- **Twin rules stay behaviorally identical** across step-definition languages, pinned by shared tests. Every difference below is marked *(forced: reason)*; anything unmarked is the intended behavior for both.

## eslint (Node)

One plugin exporting three flat configs (`stepDefinitions`, `support`, `fakes`) that the consumer spreads with its own file globs.

### `expect-custom-message`
*Step definitions, support.* Every `expect(...)` assertion chain must carry a custom message: as `expect`'s second argument, or on any call in the chain that takes one, i.e. has at least the listed argument count: `equal`, `eql`, `eqls`, `lengthOf`, `include`, `includes`, `contain`, `contains`, `match`, `matches`, `oneOf`, `greaterThan`, `lessThan`, `above`, `below`, `least`, `most` at 2; `property`, `within`, `closeTo` at 3. Inspect only the terminal link of each chain (a call or member that is not itself the object or callee of a further link) and walk back to the root `expect`. A chain ending in an argument-less property assertion (`ok`, `true`, `false`, `null`, `undefined`, `NaN`, `exist`, `empty`, `arguments`, `Arguments`) needs the message on `expect`. Why: a bare failure in parallel CI output ("expected false to be true") doesn't say which claim broke. Residual: a chain ending in a property outside that list (a plugin's `.called`) is unchecked; presence only, message quality is a judgment rule.

### `seed-via-world`
*Step definitions, support.* Flag `X.seed(scenarioId, …)`, `X.configure(scenarioId, …)` and `X.fail(scenarioId, …)` where `X` is a fake-named receiver and the first argument is `scenarioId` or `this.scenarioId`. Also flag any `=` assignment to a non-computed property of a fake-named receiver (`fakeOrders.items = …`); assigning the identifier itself is wiring and is fine. Why: the World helpers (`this.seedFake`, `configureFake`, `failFake`) inject the scenario ID and register teardown. A direct call skips teardown; a direct state write skips per-scenario namespacing, so the data leaks into later scenarios ([Fakes §12.7](../fakes.md#127-scenario-id-isolation-seeding)). Residual: a receiver reached through a member (`this.fakeOrders.seed(…)`), a fake not following the naming convention, or a scenario ID under another name escapes.

### `fail-sequence-array`
*Step definitions, support.* For a call named `fail` or `failFake` (bare or as a method), the third positional argument is the outcome sequence the fake replays call by call ([Fakes §9](../fakes.md#9-failure-injection-failscenarioid-operation-sequence)) and must be an array. Flag a `new` expression, or an identifier or non-computed member whose name ends in `Error`, in that slot (forgot the brackets). Inside an array literal, flag an element that is a bare `…Error` class: a class isn't callable without `new`, so the fake's outcome resolution throws a confusing type error. Never flag an array, an instance, a factory, `null` or any other variable (it may be a prebuilt sequence). Residual: an error class not named `…Error`, and a variable holding a bare error, escape.

### `no-get-unowned`
*Step definitions, support.* Flag any method call whose name starts with `getUnowned` or `listUnowned`. A migration guard: these inspection methods were replaced by the throwing registry check (`throwIfUnownedExist`). Reading a list and asserting it empty is the inspect-and-count shape a mock has, and it hides leaks the throwing check reports. Residual: a reference that is passed or stored but not called escapes; it hides nothing until called.

### `discarded-ownership-return`
*Step definitions.* Flag an expression statement whose expression, after unwrapping `await` and optional chaining, is an ownership call. Why: the claim satisfies the No-Unowned-IO net but asserts nothing, so a regression in the claimed data still passes ([Fakes §12.1](../fakes.md#121-claims-must-be-able-to-fail)). Any use of the return (bound, returned, passed to an assertion, chained) is fine. Residual: binding the return and never asserting on it passes.

### `no-unused-step-params`
*Step definitions.* For a step registration's body, each parameter, including identifiers inside destructuring patterns, must have at least one read reference in the function's scope (the initializing write doesn't count). Why: a captured value the step ignores is copy-paste drift; the scenario says something the test never checks. The one exception, an absence step whose empty body is the point, takes an inline disable ([Scenario design §4](../scenario-design.md#4-step-definitions)). Residual: default-valued and rest parameters are skipped; presence of use, not quality.

### `orphaned-step-definition`
*Step definitions.* Flag a step registration whose literal pattern matches no step text in the feature corpus: a string compiles as a Cucumber Expression with the built-in parameter types, a regex literal as a regex. The corpus root is option `featureDir`, default the lint working directory. Skip a non-literal pattern, a custom parameter type, or a matcher error. Why: dead step vocabulary misleads readers and rots, and blind-test subagents leave it behind. Residual: non-literal patterns and custom parameter types are never checked; a step used only by features outside the root is a false positive until `featureDir` points at them.

### `no-production-require`
*Step definitions, support.* Flag `require('<literal>')` and static `import … from '<literal>'` of a production path. Options: `productionPathPattern` (default: a relative path climbing three levels, `^../../../`, i.e. out of the test tree), `allowedPrefixes` (default `@cucumber`, `chai`, `sinon`, `lodash`), `infrastructurePattern` (default a `/fakes/`, `/support/`, `/seeds/` or `/fixtures/` path segment). Allowed: a listed prefix, an infrastructure path, a relative path not matching the production pattern, a `node:` builtin, a bare package name. Why: a test that imports production constants adapts silently when production changes, so a contract break (a value renamed on the wire) passes. Hardcode expected values. The production pattern is a depth heuristic; a repo with another layout must configure it. Residual: a non-literal argument, and a production module reached through a path alias that doesn't match the pattern, escape.

### `no-top-level-production-require`
*Step definitions.* Same path classification and options as `no-production-require` (default allowed prefixes `@cucumber`, `chai`, `sinon`), but flags only module scope: a `require` with no enclosing function, and every static `import` (always module scope). A lazy `require` or dynamic `import()` inside a step body is fine. Why: a module-scope reference is bound before the harness seeds fakes, so steps keep a stale reference to the real, unfaked module. It matters where a repo relaxes `no-production-require`, e.g. to load the app under test. Residual: a require inside a function run at load time (an immediately-invoked function) escapes.

### `scenario-scoped-tempdir`
*Step definitions.* Inside a step registration's body, at any nesting depth (track with a depth counter, not a flag), flag `mkdtemp`/`mkdtempSync` (bare or as a method) whose first argument derives from the OS temp dir: a `tmpdir()` call (bare or as a method) anywhere in the expression, through call arguments, `+` concatenation or template-literal parts. Hooks and plain helpers are deliberately unchecked: that's where the one per-scenario root legitimately comes from the OS temp dir. Why: teardown removes only the scenario root, so a sibling leaks one directory per scenario. Residual: derivation through a variable (`const base = os.tmpdir()`) and other directory-creating calls under the OS temp dir escape.

### `multi-output-not-split-helpers`
*Step definitions; advisory.* For a step registration whose literal pattern contains a bracket list of two or more names (`[store-receipt, emit-invoice]`; only the first `[…]` group is read), count ownership calls made directly in its body; nested functions get their own frame, so a delegated helper's claims don't count. Report at the first call when the count is two or more. Why: go-to-definition should land on one effect's assertion; one single-effect helper per effect keeps each reusable ([Fakes §12.2](../fakes.md#122-step-shape)). Advisory because it's readability, not a false green. Residual: a non-literal pattern, and a second bracket group, are ignored.

### `unfaked-nondeterminism`
*Step definitions, support, fakes.* Flag real time and entropy reads by literal receiver: `Date.now()`, zero-argument `new Date()`, `Date()` called without `new`, `Math.random()`, `crypto.randomUUID()` and bare `randomUUID()`, `performance.now()`, `process.hrtime()` and `process.hrtime.bigint()`. `new Date(fixed)` is allowed. Why: values change every run, so full-shape assertions and ownership keys drift; use the faked clock and RNG from the World ([Fakes §8](../fakes.md#8-control-fakes-non-determinism)). Residual: an aliased reference (a destructured `now`) and third-party clock or ID libraries escape.

### `no-get-scenario-id-in-fakes`
*Fakes.* Flag every identifier `getScenarioId` (call, import, reference). Fakes must use the throwing accessor (`requireScenarioId`): the non-throwing one returns undefined outside a scenario (module load, un-awaited async after cleanup), and the fake silently writes under a shared undefined key. A legitimate boot-time read guards with an explicit init check before calling the throwing accessor ([Fakes §12.7](../fakes.md#127-scenario-id-isolation-seeding)). Residual: a re-export under another name escapes.

## flake8 (Python)

One checker registered under the `BDD` code prefix; it receives each file's AST and filename and yields every rule's violations. flake8 has no per-category configs and no warning tier, so the consumer scopes codes per directory (per-file ignores) and runs advisory codes as a separate non-blocking pass. A "twin" shares the eslint rule's spec, scope and why; only differences are stated.

### `BDD100 assert-custom-message`
*Step definitions, support.* Twin of `expect-custom-message`. Every `assert` statement must have a message (`assert ok, "why"`) *(forced: the language's assertion statement has one message slot, so no chain analysis)*. Residual: assertion-library calls (`assert_that(…)`) are unchecked; presence only.

### `BDD200 no-get-scenario-id-in-fakes`
*Fakes.* Twin. Flag a name, attribute or imported name `get_scenario_id`; use `current_scenario_id()`, which raises outside a scenario instead of returning `None`. Residual: a re-export under another name escapes.

### `BDD201 unfaked-nondeterminism`
*Step definitions, support, fakes.* Twin. Flag an attribute call whose leftmost name (so `datetime.datetime.now()` resolves to `datetime`) and attribute match: `datetime` → `now`, `utcnow`, `today`; `date` → `today`; `time` → `time`, `monotonic`, `perf_counter`; `uuid` → `uuid1`, `uuid4`; `os` → `urandom`; any attribute of `random` or `secrets` *(forced: the stdlib's sources differ from Node's)*. Residual: a bare call after `from time import time` escapes; a seeded `random.Random(n)` is over-flagged.

### `BDD300 no-get-unowned`
*Step definitions, support.* Twin. Flag a call to an attribute starting with `get_unowned` or `list_unowned`; use `throw_if_unowned_exist`.

### `BDD301 discarded-ownership-return`
*Step definitions.* Twin. Flag an expression statement whose value, after an optional `await`, is an ownership call.

### `BDD400 no-production-import`
*Step definitions, support.* Twin of `no-production-require`, inverted to an allowlist *(forced: an absolute import name carries no path depth and doesn't say whether it is the repo's own package or an installed one)*. Flag every absolute `import`/`from … import` whose module is not stdlib (top segment in the interpreter's stdlib module list), doesn't equal an allowed root or a dotted child of one (`behave`, `hamcrest`, `assertpy`, `unittest`, `pytest`), and has no dotted segment naming test infrastructure (`fakes`, `support`, `seeds`, `fixtures`). Relative imports are skipped. Both lists are configurable: any third-party package not on the allowlist is flagged. Residual: a relative import that climbs into production escapes.

### `BDD401 no-top-level-production-import`
*Step definitions.* Twin of `no-top-level-production-require`. Same classification as `BDD400`, flagging only an import with no enclosing function; an import inside a step body is lazy and fine. Why: `from app import x` at module scope binds `x` before fakes are installed, exactly as in Node. Residual: same as `BDD400`.

### `BDD500 no-unused-step-params`
*Step definitions.* Twin. Each positional parameter other than `context` must appear as a name somewhere in the body *(forced: no scope manager is available to a flake8 plugin; a shadowing reassignment counts as use)*. Residual: `*args`, `**kwargs` and keyword-only parameters are skipped.

### `BDD501 orphaned-step-definition`
*Step definitions.* Twin. The corpus root is the working directory. Matching follows behave's default `parse` matcher: if `parse` can't compile the pattern (custom type), skip. Otherwise the step is referenced if `parse` matches any corpus text, or the pattern compiled as a regex finds a match *(forced: behave's opt-in regex matcher is selected at runtime and can't be detected statically)*. The regex check only adds positives, so it can't introduce a false positive.

### `BDD502 multi-output-not-split-helpers`
*Step definitions; advisory.* Twin. Nested `def` and `lambda` bodies are their own frames.

### `BDD503 greedy-terminal-placeholder`
*Step definitions.* No Node twin. `parse` matches a terminal untyped field greedily, so for a pattern ending in `{amount}` a feature step with a trailing ownership list captures `"12.50 [store-receipt, emit-invoice]"` and the conversion fails. Flag a decorator whose pattern ends in an untyped named field (not an escaped `{{…}}`), compiles under `parse`, and matches some corpus text whose captured value for that field ends in a bracket list; report once per decorator. Fix: keep the literal bracket tail in the pattern and type the value (`{amount:g}`). Residual: a greedy field that isn't terminal, and a swallow no corpus step demonstrates, pass.

### `BDD504 scenario-scoped-tempdir`
*Step definitions.* Twin, different heuristic *(forced: the stdlib temp factories default to the OS temp dir when no parent is given, so absence is the signal)*. Inside a step body, flag `mkdtemp`, `mkstemp`, `TemporaryDirectory` or `NamedTemporaryFile` (as `tempfile.X` or a bare imported name; other receivers are ignored) called without a `dir=` keyword. Residual: `dir=` set to the OS temp dir passes; a positional `dir` and a `**` splat are over-flagged.

### `BDD600`/`BDD601 seed-via-context`
*Step definitions, support.* Twin of `seed-via-world`; use the context helpers (`context.seed_fake`, `configure_fake`, `fail_fake`). `BDD600`: `X.seed(…)` or `X.fail(…)`; `BDD601`: `X.configure(…)`, where `X` is a fake-named receiver and the first argument is `scenario_id`, `context.scenario_id` or a `current_scenario_id()` call. `BDD600` also covers plain and annotated assignment (with a value) to an attribute of a fake-named receiver.

### `BDD700 fail-sequence-list`
*Step definitions, support.* Twin of `fail-sequence-array`, for a call named `fail` or `fail_fake`. Flag a third positional argument that is a call, name or attribute whose name ends in `Error` or is `Exception`/`BaseException`. A bare class inside the list is fine *(forced: classes are callable, so the fake can instantiate it)*. Residual: an exception class not named `…Error`, and a variable holding a bare exception, escape.

## gplint (Gherkin)

Custom rules loaded from a rules directory and enabled in `.gplintrc`. Each rule module exports `name`, its default config, `run({ feature, pickles, file }, config)` returning `{ message, rule, line, column }[]`, and optionally `fix(error, file)`, which mutates `file.lines` in place; since `fix` receives only the error and the file, the fix plan travels on the error object. Shared mechanics: English primary keywords; `And`/`But`/`*` inherit the previous primary, so a **Then block** is a maximal contiguous run of steps whose resolved keyword is `Then`. Scan Backgrounds, Scenarios and scenarios nested under `Rule`.

### `then-step-ordering`
A Then block reads outcome → input → output ([Scenario design §1.4](../scenario-design.md#14-then-order-and-shape)). Classify each step by case-insensitive substring against three phrase lists, tried in that order (first match wins); an unmatched step is a wildcard, never flagged and never moved. Report the first classified step whose tier is below the highest tier already seen, once per block. Defaults: outcome `response status`; input `should have been fetched`, `should have been read`, `should have been loaded`, `should have been retrieved`, `should have been looked up`, `should have been queried`; output `should have been emitted`, `should have been published`, `should have been sent`, `should have been stored`, `should have been persisted`, `should have been written`, `should have been produced`, `should have been delivered`, `should have been recorded`. A configured list replaces its tier's default, it doesn't merge. Autofix: stable-sort the classified slots by tier, leave wildcards in place, rewrite the leading keywords (first `Then`, rest `And`); skip the fix but still report when a step has a doc string or data table, or the block's lines aren't contiguous (comments, blank lines). Residual: classification is phrase-based, so a read phrased as an output passes.

### `well-known-io-names`
Every name in a Then-block bracket list (`[store-receipt, emit-invoice]`) must be in the configured `names` allowlist, matched exactly and case-sensitively. Check the compiled pickles, so an Outline's `[<sink>]` is checked per Examples row, mapping each pickle step back to its source step and keeping only Then-block steps. Split every `[…]` group in the step text on commas and trim; skip a token still containing `<` or `>`; an empty token (`[]`, `[a,]`, `[a,,b]`) makes the list malformed, reported once per step and regardless of the allowlist, since it's structural. Deduplicate by source step and token signature (Background steps recur in every pickle, Outline steps per row) and report at the source line. With an empty allowlist (the default: there is no universal IO vocabulary), unknown names don't fail; warn once per lint run asking for the list. Why: the bracket vocabulary is the flow's closed IO map; a typo or undeclared destination would otherwise read as accounted for. No autofix: the intended name can't be guessed. Residual: brackets in doc strings, data tables and non-Then steps are not checked.

### `unasserted-example-column`
*Advisory.* For each Scenario Outline with at least one Examples column (the union of header cells across its Examples blocks), report on the Outline line if no Then-block step's text, doc string or data-table cells contain any `<column>` (the angle brackets make the match exact: `<in>` never matches inside `<input>`). Why: rows that vary only setup run identical assertions, so the table reads as many cases and proves one. Advisory: it can't tell a mapping whose output goes unasserted from inputs that legitimately all behave the same (every valid value → 200); the message walks the reader to that decision. Residual: any one column in any Then satisfies it.

### `example-column-whole-step`
In a Scenario Outline, flag a step of any keyword whose trimmed text is exactly `<x>` where `x` is an Examples column (a lone `<x>` that isn't a column is a stray literal and is left alone). Blocking: there's no legitimate case. Why: the row's meaning moves into the table and the step definitions, and rows that need different setup steps are different scenarios. Residual: a placeholder inside other text passes.

## Appendix: boundary examples

One flagged and one allowed line per rule where the prose leaves room. JS and Python snippets are inside a step body unless noted.

| Rule | Flagged | Allowed |
|---|---|---|
| `expect-custom-message` *(platform: JS)* | `expect(total).to.equal(3)` | `expect(total).to.equal(3, 'order total')` |
| `expect-custom-message` *(platform: JS)* | `expect(done).to.be.true` | `expect(done, 'job finished').to.be.true` |
| `fail-sequence-array` *(platform: JS)* | `this.failFake(fakeMail, 'send', new TimeoutError())` | `this.failFake(fakeMail, 'send', [new TimeoutError(), null])` |
| `fail-sequence-array` *(platform: JS)* | `this.failFake(fakeMail, 'send', [TimeoutError])` | `this.failFake(fakeMail, 'send', [() => new TimeoutError()])` |
| `BDD700` *(platform: Python)* | `fail(sid, "send", TimeoutError)` | `fail(sid, "send", [TimeoutError, None])` |
| `seed-via-world` *(platform: JS)* | `fakeOrders.seed(this.scenarioId, order)` | `this.seedFake(fakeOrders, order)` |
| `seed-via-world` *(platform: JS, support)* | `fakeOrders.items = [order]` | `this.fakeOrders = new OrdersFake()` |
| `discarded-ownership-return` *(platform: JS)* | `await fakeMail.takeOwnershipOfMessages(1)` | `const sent = await fakeMail.takeOwnershipOfMessages(1)` followed by an assertion on `sent` |
| `scenario-scoped-tempdir` *(platform: JS)* | `fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))` | `fs.mkdtempSync(path.join(this.tmpDir, 'x-'))` |
| `BDD504` *(platform: Python)* | `tempfile.mkdtemp()` | `tempfile.mkdtemp(dir=context.tmp_dir)` |
| `BDD503` *(platform: Python)* | `@then("the invoice total is {amount}")` with feature step `the invoice total is 12.50 [store-receipt, emit-invoice]` | `@then("the invoice total is {amount:g} [store-receipt, emit-invoice]")` |

`then-step-ordering` autofix *(platform: Gherkin)*, before and after:

```gherkin
Then the invoice should have been emitted [emit-invoice]
And the invoice total should be 12.50
And the response status should be 201
And the customer should have been fetched
```

```gherkin
Then the response status should be 201
And the invoice total should be 12.50
And the customer should have been fetched
And the invoice should have been emitted [emit-invoice]
```

The wildcard (`invoice total`) keeps slot 2; the three classified steps fill slots 1, 3 and 4 in tier order.
