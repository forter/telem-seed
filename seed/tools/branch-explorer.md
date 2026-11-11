# `explore-branches` spec

## What it does and why

A coverage percentage doesn't say what to construct to cover the rest. A raw coverage report lists thousands of
arms, most of them interior to code the flow never enters, and coverage formats don't report error handlers as
arms at all.

`explore-branches` reads a coverage report and lists the **reachable-but-never-taken** arms (the construct ran,
some sibling arm hit, this one didn't) plus the error handlers whose protected block ran but whose handler
didn't. Each row has a position, a construct kind, an arm description and a source snippet. It writes a
machine-readable report, a human-readable one, and a console triage summary.

It is a worklist generator, not a gate: it exits 0 when it finds gaps. The coverage-tool step turns each row
into a scenario, and coverage-accounting classifies what's left (see [Discovery §1](../discovery.md#1-coverage-driven-discovery)
and [§2](../discovery.md#2-reachability)).

## Building one yourself

### 1. What it consumes

A coverage report with one entry per source file, keyed by path as the coverage run wrote it. What the tool can
say depends on the granularity of the coverage source:

| Source granularity | Choice | Rationale | Residual |
|---|---|---|---|
| **Per-arm hit counts**: each branch lists its arms with a hit count each, plus per-statement hit counts | Read arms directly; the arm index and sibling hits come from the report | Nothing to infer, so no parser is needed for arms | Phantom arms the producer invents (classify as instrumentation artifact, [Discovery §2](../discovery.md#2-reachability)) |
| **Arc-level**: the report lists transitions between lines that never happened | Map each missing transition to an arm by parsing the source and matching the target line to a construct's body, else-part or loop exit. Fall back to a generic "branch to line N" when no construct matches | Reached-ness is implicit: a transition can only be missing from a line that ran | Expression-level arms (conditional expressions, short-circuit operands, default values, comprehension filters) and two arms on one line are invisible. Say so in the help text; compensation is code reading and decision tables ([Discovery §4](../discovery.md#4-decision-tables)) |
| **Line/statement-only**: no branch data at all | Refuse with an error naming the report and what was missing | Zero findings would read as "no gaps" | Only the handler pass would work; not worth a half-working tool |
| **Producer omits never-loaded files** (some coverage producers list only loaded files, others list them at 0%) | Report only what's in the file; state it in the help text | The tool can't know what it wasn't told | Never-loaded modules are invisible; the whole-suite sweep (full-tree diff of source files against the report) covers it |

Contract with the coverage run, owned by [Discovery §1](../discovery.md#1-coverage-driven-discovery) ("What the coverage run must provide"), not by this tool:
original-source paths and positions (never generated code), single-process runs for branch analysis, per-run
isolated output. If the report points at generated code the tool will faithfully list the wrong lines.

Conventions to pin down once:

- Lines are 1-based, columns 0-based, counted in characters. Producers differ (bytes, UTF-16 units); convert,
  or the caret lands in the wrong place on non-ASCII lines.
- Relative paths in the report resolve against the **project root** (the directory the coverage run started
  in), an explicit option that defaults to the working directory. Not against the report's own directory: the
  report usually sits in a subdirectory, and the lookup silently misses every file.
- Split source into lines on exactly the terminators the producer counted (`\n`, `\r\n`). Unicode-aware line
  splitters also split on form feeds and similar and shift every later line number.

### 2. The sibling-hit filter

An arm is a finding only if **some sibling arm hit** (arc-level sources: the originating line ran). A branch
whose arms all have zero hits was never reached; its interior is classified once, at the *entry arm* the flow
did reach, and everything behind it inherits that class. Hand-listing the interior is noise. The consumer rule
that makes this sound ("the entry arm must truly be unreachable, else the subtree is coverable") belongs to
[Discovery §2](../discovery.md#2-reachability); the tool just states that unreached subtrees are absent by
design in its help text and summary footer.

A branch kind with a single arm has no sibling to prove reachability. Choose deliberately: use the enclosing
function or statement having run as the parent evidence, or skip the kind and say so in the help text. Don't
let it fall out of the filter by accident.

### 3. Error handlers

Coverage formats don't report an error handler as an arm, so parse the source.

- Find every protected block and its handlers (typed, untyped, grouped, multi-type: every handler syntax the
  language has).
- Emit **one row per handler** when the protected block has an executed statement, the handler has at least
  one statement, and no handler statement executed. Label it with the caught type when there is one, so a
  multi-handler block gives distinct rows.
- Evidence is statement hit data, by line. No evidence, no row: a protected block that never ran (its
  enclosing code is classified at its entry arm, §2), a handler with no executable statements, and cleanup-only
  blocks with no handler are all silent by design.
- **Parse every source dialect the repo uses** (see [the parsing hint](../hints/ast-grep.md); including ones that parse differently depending on mode, supersets that need a transpiler, and newer syntax). Try the
  configured dialects in turn; a file that parses under none is an error naming the file, never an empty
  result. See Challenges.

### 4. Rows and arm descriptions

Row: file (project-root-relative), line, column, construct kind, arm index and sibling hit count (when the
source has them), arm description, snippet. Optionally the target line for arc-level sources. Pick one field
set and use it in every implementation. Kinds and descriptions form a closed vocabulary independent of the
coverage producer; unknown kinds get a generic description ("arm N"), never a crash.

- two-way conditional statement: then / else (an else-if chain names the chain link)
- conditional expression: truthy / falsy
- short-circuit expression: "operand N not evaluated"
- multi-way select: "case N not taken" (default arm included)
- default value: "default value path"
- loop: "body not entered" / "exit not taken" (never completed normally)
- pattern-match case: "case N not taken"
- arc to function exit: "exit branch"
- error handler: "<caught type> handler" (or "catch-all handler")

Snippet: the arm's line with one line of context each side, a gutter of line numbers, and a caret under the
column. If the source can't be read the snippet is empty and the file is named in the summary (see
Challenges).

### 5. Outputs

Always write both files, even with zero rows, so a stale report from an earlier run can't be mistaken for this
one. They're regenerated and never committed.

- **Machine report**: the rows, sorted by (path, line, column) with an ordinal, locale-independent comparison.
- **Human report**: a heading per file, a table of position / kind / arm / snippet. Escape the cell separator
  and backticks in snippets and turn newlines into line breaks, or one snippet breaks the table.
- **Console summary**: the row and file counts; the number of **files and branches examined** (zero findings
  from zero branches must read differently from zero findings from thousands); counts by kind, descending;
  the top N files by row count, descending, ties broken by path; the path of the human report. With zero rows,
  stop after the first line.

### 6. Command line

`explore-branches [options] [report-path]`

- `--filter <substring>`: only files whose report key contains it. Filtering hides shared orchestrators; the
  methodology runs unfiltered first, so use it only to triage.
- `--top <n>`: file ranking length, default 15. A positive integer, else a usage error.
- `--out-dir <dir>`: where both reports go. `--root <dir>`: see §1.
- Help works anywhere in the arguments. An unknown option, or an option missing its value, is a usage error;
  silently ignoring one turns a typo into a different run (the value of a skipped option becomes the report
  path).
- Exit 0 on success, whatever it found. Non-zero for: missing or unparseable report, a report with no branch
  data, a source file that exists but can't be parsed, usage errors. Use a different code for usage errors if
  callers need to tell them apart.

## Challenges and edge cases

- **Parse failure is the silent killer.** An unsupported dialect makes the handler pass return nothing, which
  looks exactly like "every handler was exercised". Collect parse failures, still write the reports, list
  every failing file in the summary, and exit non-zero.
- **Source missing on disk.** Usually a path-resolution mistake (§1), sometimes a virtual or bundled module.
  Both leave empty snippets and no handler pass. Count and name these in the summary; don't fail on one, since
  virtual modules are real, but if *every* file is unreadable the root is wrong, so fail.
- **Same-line evidence.** Hit data is by line. A protected block and its handler on one line can't be told
  apart, so the handler is never reported. Know it, don't paper over it.
- **A handler with no statements** (an empty swallow) gives no hit evidence, so it can never be listed, though
  swallowed errors are exactly where production hides bugs. Read for them while sweeping loaded files.
- **Single-arm kinds**: see §2.
- **Report validation.** A report that says branch tracking was off is a failure, not a warning: the result
  would be a clean-looking nothing. A report that merely has no branches (a source file with none) is legal.
- **Column units and tabs.** The caret line is made of spaces, so a source line indented with tabs misaligns
  it. Expand tabs in the snippet or document it.
- **Determinism.** Sorting, tie-breaks and path separators must not depend on locale or OS, so reports diff
  cleanly between runs.
- **Multiple implementations drift**, and this tool is the one most likely to: they read different report
  formats. Pin the row set, vocabulary and CLI in shared, language-neutral tests with a coverage fixture per
  granularity tier.

## Enforcement

The tool gates nothing; the methodology does. The coverage-tool step reruns it after each scenario, and the
accounting step requires every file in the report to be classified. What the tool itself must satisfy:

- Acceptance checks: an arm with a hit sibling is listed and one whose whole branch is unreached is not; a
  handler whose protected block ran and whose body didn't is listed, one with both hit or neither hit is not;
  a file in every source dialect the repo uses yields handler rows; relative report keys resolve against the
  root; a bad `--top` or an unknown option exits non-zero with a message; both reports are rewritten on a
  zero-row run.
- Test against a **real** coverage report from the real producer for each supported platform, not only
  hand-written fixtures; hand-written ones encode your assumptions about key shapes and positions.

## Appendix: worked example

```
explore(report, root, opts):
  fail unless report.hasBranchData
  rows = [], problems = []
  for file in sorted(report.files) where opts.filter in file.key:
    path = resolve(file.key, root)
    src  = read(path)  or note(warnings, "unreadable", path)
    for br in file.branches:
      if max(br.hits) == 0: continue              # entry never reached; classified upstream
      for (i, h) in br.hits where h == 0:
        rows += Row(file, br.arms[i].pos, br.kind, i, describe(br.kind, i), max(br.hits), snippet(src, pos))
    tree = parse(src, dialects) if src
    if src and not tree: note(problems, "unparseable", path)
    for t in tryBlocks(tree):
      if anyExecuted(t.body):
        for h in t.handlers where h.statements and none executed(h): rows += handlerRow(h)
  write(machine(sort(rows)), human(rows)); print(summary(rows, examined))
  exit(1 if problems or fatal or all files unreadable else 0)   # warnings alone don't fail
```

Source:

```
10 fn total(cart, coupon):
11   try:
12     rate = lookup_rate(cart.region)
13   catch NotFound:
14     rate = fallback_rate
15   off = coupon ? coupon.pct : 0
16   if cart.empty: return 0
...
40 fn legacy_total(cart):          # never called by this flow
41   if cart.vip: ...              # both arms: 0 hits
```

Hits from the run: line 12 ran 4x, line 14 never; the conditional at 15: truthy 0, falsy 4; the `if` at 16:
then 0, else 4; line 41: 0, 0.

Output:

```
total.src:14:5  handler                 NotFound handler   rate = fallback_rate
total.src:15:9  conditional-expression  truthy branch      off = coupon ? coupon.pct : 0
total.src:16:3  if                      then branch        if cart.empty: return 0
3 rows in 1 file; examined 3 branches
```

Line 41 is absent because no sibling arm hit, so the branch was never reached. The uncalled function
surfaces through the statement-line channel and the loaded-file sweep ([Discovery §1](../discovery.md#1-coverage-driven-discovery)),
not through this tool. The rule biting: if the source were written in a dialect the parser didn't accept, the handler row
disappears and the output reads `2 rows in 1 file; examined 3 branches`, a plausible "fewer gaps" report. With the parse-failure rule the same
run prints `1 file unparseable: total.src (handler pass skipped)` and exits 1, and the missing scenario (make
`lookup_rate` fail for a region) gets written.
