# `check-decision-table` spec

## What it does and why

When testing a flow, you cross the conditions that change its behavior (auth state, config, a dependency
being down) into a grid. Agents skip cells: they write the obvious ones and wave at the rest.

`check-decision-table` is a pass/fail gate that proves every cell has a row and every row says what was
done about it. The methodology step doesn't move on until it passes.

## Building one yourself

### 1. The table format

In order:

- **A declaration** of the dimensions and their values. Everything else is checked against it.
- **A header**: the dimensions in declared order, then disposition, then reason.
- **One row per combination**: dimension values, a disposition, a free-text reason.

Use a plain line-oriented format that can be hand-written and diffed. Put the reason last so it can
contain anything, including the separator.

The file is regenerated whenever the flow is touched and never committed. Lasting knowledge goes in
durable docs.

### 2. Dispositions

| Disposition | Meaning | Reason required? |
|---|---|---|
| covered | An existing scenario tests this cell | No, but should name the scenario |
| new | A distinct path; a full scenario was written | No |
| belt | Shares a code path with another scenario; a short outline suffices | Yes |
| cannot-occur | This input can't reach this path | Yes |

`belt` and `cannot-occur` skip a full scenario, so they're the ones agents reach for to dodge the gate.

### 3. The completeness check

Expand the declaration into every combination and compare against the rows:

- **Missing**: a combination with no row.
- **Unknown**: a row with an undeclared value (usually a typo). It doesn't count toward the combination
  it was meant to cover.
- **Duplicate**: a combination on more than one row.
- **Bad disposition**: not an allowed value, or a required reason that is empty or whitespace.

Report every problem, not just the first, naming each combination by all its dimension values, with a
fix. On success, print the total so the run shows how big the grid was.

### 4. The cross-check against the feature file (optional)

The table can only prove the *declared* grid is filled. The feature file closes two gaps:

- **Claims with nothing behind them.** A `covered` or `belt` row must name a scenario that exists. This
  mainly catches a well-argued `belt` row with no outline written.
- **Under-declared dimensions.** If a parameter column shares a dimension's name, every value in it must
  be declared.

Scan for scenario titles and parameter columns only; don't build a full parser. Skip dimensions with no
matching column; guessing produces false positives.

## Challenges and edge cases

- **The declaration is trusted.** Leave out a value and everything passes. Say so in the help text.
  Reason quality is out of reach too; telem leaves it to an advisory LLM lint rule.
- **Grids explode.** Conditions that short-circuit (auth fails, validation never runs) multiply into
  walls of `cannot-occur` rows. The guidance should push toward narrowing the declaration or modeling the
  stages as one dimension.
- **`cannot-occur` gets abused.** The test is "can this input reach this path?", not "is the result the
  same?". Same result is `belt`. The tool can only require a reason.
- **Malformed input fails loudly, saying what and where**: missing or empty declaration, a dimension with
  no values or an empty value, a dimension declared twice, a wrong or misspelled header, a row with too
  few fields.
- **Whitespace and line endings.** Trim names and values, parse Windows line endings like Unix ones,
  ignore blank lines.
- **Stray comment lines** before the header: pick a behavior. telem rejects them as a malformed
  declaration.
- **Reasons are messy free text.** Match scenario names as a plain substring, not by parsing quotes.
- **Shared outlines.** Several `belt` rows may name one scenario; allow it.
- **Exit codes.** telem exits non-zero for both an incomplete table and unreadable input, distinguished
  only by message. Use separate codes if callers need to tell them apart. Help should work anywhere in
  the arguments.
- **Multiple implementations** drift. Pin the behavior in shared, language-neutral tests.
