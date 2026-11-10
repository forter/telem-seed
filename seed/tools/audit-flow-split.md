# `audit-flow-split` spec

## What it does and why

Some flows have too many behavior-changing combinations to backfill in one pass. A *flow split* lifts
axes out of the flow into the flow checklist, so each combination becomes a sub-flow worked on its own
(methodology: [`backfill`](../skills/backfill.md#backfill-tests)). The cross-product is typed into the
checklist by hand or by an agent, which is exactly where a combination goes missing, gets listed twice, or
gets waved through as "done" with nothing behind it.

`audit-flow-split` is the pass/fail gate for that: every declared combination has exactly one row, every
completed row says what was done about it, and what it points at still exists. It is the split-level
sibling of [`check-decision-table`](./check-decision-table.md) and shares its stance (trusted declaration,
report every problem, fail loudly on malformed input); those ideas are not restated here.

## Building one yourself

### 1. The declaration

A small block in the flow checklist, invisible when the checklist is rendered, heading the flow's
sub-flows section. A human reviews this, never the expanded rows.

- A **flow id**: one token.
- One **axis** per line: a name, a **rule**, and a value list.

| Rule | Expands to | Rationale | Residual |
|---|---|---|---|
| `one-of` | each value | A mutually exclusive choice; exactly one is always selected | none |
| `powerset` | every subset of the values, **including the empty set**, written `∅` | Independent present/absent toggles. "None present" is a reachable sub-flow (rejected input, degenerate run); dropping it silently is the failure this tool exists to stop | The size: 2^n |

The checklist may hold several declarations, one per flow. The combinations of a flow are the **cross
product of every axis's expansion** (expand each axis first, then cross; crossing raw values would never
produce a subset).

There is deliberately **no constraint syntax** ("A excludes B"). Every combination is generated; a
combination leaves the set only by a per-row `meaningless` disposition (§3). A bulk rule would let a
whole swath be dropped unexamined.

Reject, naming the flow and axis:

- An empty block; a flow id that is empty, contains whitespace, or contains row-key syntax characters
  (`;`, `=`); a flow declared twice; a flow with no axes.
- An axis line that doesn't parse, including an unknown rule; an axis declared twice.
- An axis name that collides with a reserved row field (`flow`, `disposition`, `file`, `reason`).
- A value list that is empty, contains an **empty value** (`{a, , b}`), repeats a value, or has a value
  containing row-key syntax (`;`, `=`, `,`, `+`, braces) or the empty-set marker `∅`.
- A powerset or a total cross product above a cap (see Challenges).

### 2. The row key

A combination row is any checklist line carrying a **key token**: a machine-readable, non-rendered
annotation. The display name is for readers; the gate reads only the token, never the prose.

Fields, `;`-separated, in any order: `flow`, one `axis=value` per declared axis, and for completed rows
`disposition`, `file`, `reason`. `reason` comes last and runs to the end of the token, so it may contain
`;` and `=`. A repeated field is an error (last-wins hides a typo).

A powerset value is its members joined with `+`. `∅` stands alone: `∅+x` is never valid.

The row's **status** is a checkbox on the same line, completed when checked (either case). Read it only
from the part of the line *before* the token. The token's own text (a reason containing `[x]`) must
never be searched, or a row with no status checkbox parses as completed.

Rows are found line by line, independent of table layout, so a Sub-flows table anywhere in the file works.
A token on a line without a checkbox, or with no `flow` field, is an error naming the line.

### 3. The check

Per declaration: expand, canonicalize every row, set-compare.

- **Canonicalize** a powerset value: split on `+`, trim, reorder members to declared order. `wrap+insure`
  and `insure+wrap` are one combination. A repeated member (`a+a`) or a `∅` mixed with members does not
  canonicalize to anything declared.
- **Missing**: a declared combination with no row.
- **Unknown**: a row whose flow has no declaration; that lacks a declared axis or has an extra one; or
  whose value (or a powerset member) isn't declared, including non-canonical ones above. It counts
  toward nothing.
- **Duplicate**: a combination on more than one row, after canonicalization.
- **Bad disposition** and **missing artifact**: completed rows only (below).

Report **every** problem, not the first. Name each combination by all its axis values. Order is part of
the contract, so reports diff cleanly and agree across implementations:

- Combinations: cross product with the first declared axis outermost; within a powerset, by subset size
  then declared order (`∅, a, b, c, a+b, a+c, b+c, a+b+c`), which matches the working order in the
  flow-splitting methodology.
- Rows: by line number, one list per problem kind. Never iterate an unordered set into the report.

On success print rows, declared combinations, and how many are completed (see Challenges: a pass is not
done).

**Completed rows** carry a disposition:

| Disposition | Meaning | Gate verifies | Residual |
|---|---|---|---|
| `own-file` | Structure diverges; full scenarios in a file of its own | `file` present, resolves (relative to the checklist's directory) to an existing regular file | File contents: that it pins the combination in its Givens, or that two rows don't share one file |
| `examples-in-base` | Only values differ; extra example rows in an existing file (the split-level `belt` of [check-decision-table §2](./check-decision-table.md#2-dispositions)) | As above, plus the file has an example-table block and every value of the combination appears as a **whole token** inside example tables (never titles, steps, or prose) | Assertion strength (a liveness-only assertion is a false tripwire; judgment); that the values share a row. The empty member has no name, so its marker `∅` must appear literally in an example cell (open choice; chosen: louder; alternative: the empty member contributes no tokens) |
| `meaningless` | A *reachable* combination a human deliberately excluded after reading the code | `reason` non-blank | Reason quality; whether the exclusion is true. Not `cannot-occur`: that folds away an impossible input cross inside one flow |

Incomplete rows are checked for presence only, so a plan (`disposition`, `file`) can be recorded before the
work is done.

### 4. The dimensions cross-check

A split lifts its axes *out* of the sub-flow, so the sub-flow's own decision table must not declare one
again as a dimension: it is fixed for that sub-flow. With the path to a sub-flow's decision-table file
(ephemeral and uncommitted, so it can only be checked while the sub-flow is being worked), and `--flow
<id>` when the checklist declares more than one split (required then, an error if unknown), fail if any
declared dimension name equals a lifted axis name. List every offender.

Read the names with the **same parser** [`check-decision-table`](./check-decision-table.md) uses for its
declaration. A second, lenient reader will pass files that tool rejects. **No dimension declaration found
is an error, not a pass**; otherwise a misspelled preamble line makes the check vacuous.

### 5. Interface and enforcement

Arguments: the checklist path; `--check-dimensions <file>`; `--flow <id>`; help anywhere. An option missing
its value, or an unknown option, is an error. Silently ignoring `--check-dimensions` with no value runs the
full audit, which can pass, so the agent believes the dimensions were checked. Exit 0 only when clean;
non-zero otherwise, with unreadable input distinguishable from an incomplete checklist if callers need it.
Success goes to stdout, problems to stderr.

The run points are set by the backfill orchestration; they are listed here only because each constrains
the tool's behavior. It must be correct at each:

| Run point | Mode | Checkable then | Residual |
|---|---|---|---|
| Expansion (declaration to rows), before the declaration's human review concludes | audit | Rows match the declaration. All rows open, which must pass | The declaration itself |
| During each sub-flow's decision-table step | dimensions | No lifted axis re-declared | A renamed axis (`plan` for `tier`) |
| At each sub-flow's completion | audit | Disposition valid, files exist, example rows present | Contents of the files |
| Final whole-flow sweep | audit | Artifacts deleted after a row was checked off | Gaps *between* combinations, which per-sub-flow coverage cannot see; the whole-suite coverage sweep owns those |

## Challenges and edge cases

- **The declaration is trusted.** A forgotten value passes. Values come from code discovery and the
  human's review of the (short) declaration; say so in the help text.
- **Completeness is not completion.** A checklist with every row open passes the audit, as it must at
  expansion. At the final sweep, "all rows completed" is a separate assertion; offer a strict mode, or the
  sweep proves less than it appears to. A success line saying "present and disposed" over open rows
  overclaims; report the completed count separately.
- **Grids explode.** A powerset is 2^n, and axes multiply. Cap each powerset and the cross-product total
  at a size a human can review, not at an integer width, and refuse before expanding. Never print millions
  of missing combinations; print the count and a bounded sample. The remedy is methodological: group values
  into behavior families first ([`backfill`](../skills/backfill.md#backfill-tests)).
- **Matching example values.** Whole-token, not substring: `pro` must not match `professional`.
  Delimit tokens by cell boundaries and separators (whitespace, `,`, `+`, `|`). A stronger variant
  requires all values of a combination in one row; adopt it where the base file's tables use the axis
  names as columns.
- **Parsing example tables.** Comment lines and blank lines inside a table don't end the block. Accept every
  keyword the scenario language uses for example blocks. Text inside a multi-line string argument is not a block.
- **Reserved characters.** `+`, `∅`, `;`, `=` carry meaning in keys. Reject them in declared values rather
  than let a value like `a;b` surface later as one missing and one unknown combination.
- **Illustrative tokens count.** Any line with a token is a row, including one in a fenced explanation. Keep
  examples out of the checklist.
- **Line endings.** Treat `\n` and `\r\n` as the only separators, in every file read, or line numbers and
  row boundaries differ between implementations. Trim names and values; ignore blank lines.
- **Directory as `file`.** Reject it with a message, not a crash.
- **Exclusion is per row.** The tool can require a reason, not a true one. Reason quality is left to human
  review of each `meaningless` row.
- **Multiple implementations** drift. Pin the behavior, including report order, in shared language-neutral
  tests.

## Appendix: worked example

```
audit(checklist):
  decls = parse_declarations(checklist)          # §1; throws on malformed
  rows  = parse_rows(checklist)                  # §2; checkbox read left of token
  for d in decls:
    expected = cross(d.axes.map(expand))         # first axis outermost
    seen = {}
    for r in rows where r.flow == d.id:
      key = canonicalize(d, r) or record_unknown(r) and continue
      if key not in expected: record_unknown(r); continue
      seen[key] += 1
      if r.completed: validate(r)                # disposition, file, example tokens
    missing   += expected - seen.keys
    duplicate += seen where count > 1
  report every list; ok iff all empty

expand(axis): one-of -> values
              powerset -> [∅] + subsets by size, each in declared order, joined by "+"
```

Declaration, then rows, one omitted:

```
<!-- flow-split: parcel-quote
     axis extras = powerset { insure, wrap }
     axis speed  = one-of   { standard, express } -->

| 1 | [ ] | none · standard           | <!--key: flow=parcel-quote; extras=∅; speed=standard--> |
| 2 | [ ] | none · express            | <!--key: flow=parcel-quote; extras=∅; speed=express--> |
| 3 | [ ] | insure · standard         | <!--key: flow=parcel-quote; extras=insure; speed=standard--> |
| 4 | [ ] | insure · express          | <!--key: flow=parcel-quote; extras=insure; speed=express--> |
| 5 | [ ] | wrap · standard           | <!--key: flow=parcel-quote; extras=wrap; speed=standard--> |
| 6 | [ ] | wrap · express            | <!--key: flow=parcel-quote; extras=wrap; speed=express--> |
| 7 | [ ] | both · standard           | <!--key: flow=parcel-quote; extras=wrap+insure; speed=standard--> |
```

The declaration expands to 4 x 2 = 8 combinations. Row 7 is written out of order and canonicalizes to
`insure+wrap`. The eighth row was never written, so the run fails:

```
1 declared combination(s) have no row:
  parcel-quote: extras=insure+wrap  speed=express
```

A hand-typed table with a human eyeballing it would have passed; the `∅` rows (1, 2) are the ones a
person most often forgets.

The same rule on a completed row. Row 5 is checked off as `examples-in-base`, but a later cleanup rewrote
the base file's example table down to the columns `| extras | speed |` with the single row `| insure | standard |`:

```
1 completed row(s) have a missing artifact:
  line 9: base file features/quote.feature no longer mentions this combo's value(s): wrap
```

Had the check been a substring test, a surviving `| wrapped |` cell would have kept it green.
