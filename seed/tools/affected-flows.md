# `affected-flows` spec

## What it does and why

Shared code (a converter, a dispatcher, a validator) is run by many flows, and each flow's feature file is the only record of what that flow promises. When the shared code changes, coverage goes green as soon as one flow covers the new branch. The other flows are left under-asserted and nothing goes red.

`affected-flows` answers, for each changed line range, which flows run it. The tool takes the changed ranges and one coverage report per feature file, and labels every (hunk, flow) pair `covered`, `candidate` or unattributed. It never runs the suite. Used by `sync` ([Discovery: Shared-code drift fan-out](../discovery.md#shared-code-drift-fan-out)).

## Building one yourself

### 1. Inputs

- **Changed hunks**: new-side line ranges, 1-based, inclusive, each with a file path relative to the source root. Two sources:
  - A **changes file**: one `path:start-end` (or `path:line`) per line. Blank lines and `#` comments are ignored.
  - A **VCS diff** against a baseline, with zero context lines, optionally restricted to production source paths.
- **One coverage report per feature file**, in one directory. The report's file stem is the feature id.
- **A source root**: relative paths in hunks and in coverage reports resolve against it, never against the process's working directory.

The tool reads coverage that already exists. The caller builds the per-feature reports, each from its own isolated output directory and from the code at the same revision as the hunks' new side. Reports from another revision shift every line number and attribute silently wrong. Rebuild them on every run and never persist them: any later edit makes a stored line-level index stale.

### 2. Verdicts

| Verdict | Meaning | Action for the agent | Residual |
|---|---|---|---|
| `covered` | The flow executed a line in the hunk | Write the scenario in this flow | Line evidence is not proof the changed part ran when the line carries more than one behavior (§4) |
| `candidate` via enclosing function | The flow ran the body of the innermost function containing the hunk, but not the hunk | Near-miss: confirm reachability with a debugger or temporary logging, then write | The flow may be unable to construct an input that reaches the hunk |
| `candidate` via file only | The flow loaded the file, but ran neither the hunk nor the function body | Weakest lead: same confirmation | Most such flows can't reach it. Also what every hunk outside any function degrades to (module-level code) |
| unattributed | No flow executed any line of the file | Rule out a rename or move, then it's a new flow or dead code | Can't tell which of those |

A pair is always exactly one of these, so a hunk in a loaded file never has an empty flow list.

Output is sorted covered, then enclosing-function, then file-only, with ties broken by feature id in code-point order. Locale-aware comparison reorders the same input across machines, and the output is diffed and compared in tests.

### 3. Turning coverage into per-line evidence

Reduce each report to the set of lines the flow executed, per file. The rule: **a line's evidence is the hit count of the innermost statement containing it.** Counting every enclosing statement is wrong. A compound statement (a conditional spanning all its arms) counts as hit when any arm runs, so unioning its range marks the untaken arms as covered. This was a real over-claim: a flow that took a different branch read `covered`.

What a coverage source gives you decides how to apply the rule:

| Source gives | Choice | Rationale | Residual |
|---|---|---|---|
| Statement spans and hit counts | Paint spans widest-first, so the innermost statement wins each line | Directly the rule | None |
| Statement start lines only | Use the parser to find the innermost statement containing each hunk line, and test that statement's start line | A continuation line of a multi-line statement is never in the set, so a hunk touching only it can never intersect and reads as not run | Needs a parser for the dialect (§5) |
| Branch arms with hit counts, in addition | A hit arm proves its start line. An untaken arm of a ternary or short-circuit loses its line, unless another taken arm or a single-line hit statement independently shows the line ran | The container statement is hit whichever arm ran, so multi-line expression arms over-claim without this | Same-line arms can't be split this way (§4) |
| No arm data | Skip the arm step | The source can't see expression arms | Multi-line ternary and short-circuit arms may read as covered |

A report entry with zero executed lines does not count as the flow loading the file. Coverage tools list never-loaded files with all counters at zero. Counting them would make every flow a file-only candidate, so a hunk would never be unattributed and the drift would fan out to the whole suite.

### 4. Granularity caveat

Line coverage can't tell which part of a line ran. For a **single-line hunk** that is `covered`, mark the verdict line-granular when the line carries more than one behavior:

- More than one real statement starts on the line. Do not count a block as a statement: a conditional header that opens a block is one statement plus its block, and flagging every such line makes the caveat noise that agents learn to ignore.
- A function or class definition that ends on the same line.
- A ternary or short-circuit that starts and ends on the line.
- A definition header line, or an annotation line attached to a definition: in dialects where definition headers execute at load, it runs when the file is loaded, so a flow that merely imports the file reads `covered` without having run the change.

The message tells the agent to confirm with a debugger or temporary logging, as for a candidate. Multi-line hunks aren't flagged, even though a multi-line range can include a line that line coverage doesn't resolve. That is a known gap, not a guarantee.

### 5. Enclosing function

Parse the changed file and find the **innermost function** whose span contains the whole hunk. Methods and anonymous functions count. The reach test is whether the flow executed a line in the function's **body statements**, from the first body statement to the last. Exclude the declaration line and the closing delimiter. In dialects where definition headers execute at load, a declaration assigned to a name (a function expression, an anonymous function, a definition at module level) is itself a statement that runs at load time, so any flow that imports the file executes it. Testing the whole span would turn every file-only candidate into a false near-miss.

Use a parser (see [the parsing hint](../hints/ast-grep.md)) for **every dialect the repo contains** (including module-style sources, typed supersets and mixed-dialect repos). Coverage must report positions in the original source, not generated code, so the file the parser reads has the same line numbers as the report. A file that can't be parsed or read has no enclosing-function lookup, and a silent fallback to file-only looks exactly like a flow that never entered the function. Never fall back silently: still produce the report, mark every affected hunk ("enclosing-function lookup unavailable: file unparseable", naming the file), list those files in the summary, and exit with the distinct code in §7. Prove each dialect with a captured fixture where the near-miss resolves to enclosing-function, not file-only.

### 6. Hunks from a VCS diff

- Take new-side ranges only. A hunk with a new-side count of zero (pure deletion) and a deleted file produce nothing.
- Path form: the diff's path prefixes depend on user configuration (some setups omit them, some use other markers). Either run the VCS with the options that force the plain prefixes, or read paths from a format that carries none. Don't strip a hard-coded prefix.
- Diff paths are relative to the repository root. Require the source root to be the repository root, and reject anything else instead of resolving against it. Otherwise a root one directory down prefixes every path twice, nothing matches a coverage key, and every hunk reads unattributed.
- A pure rename has no hunks, and a rename with edits appears under its new path with no coverage key. Either shows as unattributed. Detecting a rename is the caller's job.

### 7. Failure handling

| Condition | Result |
|---|---|
| No hunks (empty change set, or the diff and path filter matched nothing) | Exit 2. A no-op is not "nothing drifted" |
| Malformed changes line, line number 0, or reversed range | Fail naming the line. A reversed range never intersects anything and would silently turn every loading flow into a file-only candidate |
| Missing or empty coverage directory, unparseable report | Fail naming the path |
| Neither input given, unknown or misspelled option | Fail, usage hint. A misspelled source-root option would otherwise attribute everything against the working directory |
| Source file unparseable or unreadable | Report is still produced. Each affected hunk is marked "enclosing-function lookup unavailable" with the file named, the files are listed in the summary, and the exit code is 3. A deleted file has no coverage key to match, so it is usually unattributed instead |

Exit 0 on a clean report, 1 on usage or runtime error, 2 on no hunks, 3 when a report was produced but some files couldn't be parsed or read (its candidates are unreliable). Machine output (JSON) and a human table carry the same fields: per hunk, the file, the range and the flows (feature, reach, via, enclosing-function range, line-granular flag), plus the unattributed hunks.

### 8. Enforcement

The `sync` skill requires the tool's output for every changed hunk, and the fan-out covers every flow in the result, not a chosen one. Test the tool against **real captured coverage**, not hand-built reports. Hand-built reports tend to contain only flat, single-line statements with no enclosing containers. That shape hid the container over-claim, the function-declaration-line over-claim and the module-style parse failure. Fixtures need one report per flow, a zeroed never-loaded report, and one case per row of §3 and §4.

## Challenges and edge cases

- **Hunks that can't exist.** The tool sees new-side lines only. A removed branch has none, and its absence says nothing about drift. Old-side inspection is manual and stays with the agent ([Discovery](../discovery.md#shared-code-drift-fan-out)).
- **Candidates are absence evidence.** A new arm has not run in any flow, so the best the tool can say is "this flow ran the function". Confirmation is manual.
- **Report quality.** A coverage source that merges across parallel workers can mis-merge and drop lines, which turns `covered` into a false candidate. Read reports from isolated, single-feature runs.
- **Symlinks and relative keys.** The same file can appear under different path spellings in the hunk and in the report. Resolve both to canonical absolute paths. A deleted file can't be resolved, so it matches nothing.
- **Large hunks against large coverage sets.** The intersection test scans whichever set is smaller.
- **Unattributed isn't new.** Rename, moved file, dead code, or a genuinely new entry point all look the same here.
- **A hunk in a flow-split family.** Combinations resolved as their own file are separate flows in the result. Combinations resolved as extra example rows share the base flow's file and have no file of their own, so the agent routes those to the base flow ([audit-flow-split](./audit-flow-split.md)).
- **Multiple implementations** drift, on tie-break order, counting rules and path handling. Pin the behavior in shared, language-neutral tests.

## Appendix A: worked example

Pseudocode of the core, per hunk:

```
attribute(hunk, flows):
  loading = [f for f in flows if len(executed[f][hunk.file]) > 0]     # zero-hit entries don't load
  if loading is empty: return unattributed(hunk)
  granular = hunk.start == hunk.end and line_is_granular(hunk.file, hunk.start)
  fn = innermost_function(hunk.file, hunk.start, hunk.end)            # null if module-level
  lookup_failed = parse_or_read_failed(hunk.file)                     # recorded: marks hunk, listed in summary, exit 3
  for f in loading:
    if any line in [hunk.start..hunk.end] is in executed[f][hunk.file]:
      verdict(f) = covered, granular
    else:
      if fn and executed[f] intersects fn.body_first_stmt .. fn.body_last_stmt:
        verdict(f) = candidate(enclosing-function, fn.span)
      else:
        verdict(f) = candidate(file-only)
  sort by (reach rank, feature id by code point)
```

Source `fees.src` (new side), changed lines marked:

```
1  fn surcharge(order):
2    if order.region == "remote":
3      return order.base * 1.2        # changed (was 1.1)
4    return order.base
5  fn label(n): return n > 0 ? "pos" : "neg"    # changed
6  FEE_CAP = load_cap()               # module level
```

Hunks: `fees.src:3-3`, `fees.src:5-5`. Executed lines per flow:

| Flow | Executed lines in `fees.src` |
|---|---|
| `quote_remote` | 2, 3, 6 |
| `quote_local` | 2, 4, 6 |
| `quote_label` | 5, 6 |
| `report_only` | 6 |

Result for `fees.src:3-3`: `quote_remote` covered. `quote_local` candidate via enclosing function 1-4 (ran 2 and 4, not 3). `quote_label` and `report_only` candidate via file only. For `fees.src:5-5`: `quote_label` is covered but line-granular, since the ternary has two arms on one line and the flow may have taken only `"pos"`. The others are file-only candidates.

The rule biting: coverage after the edit is green once `quote_remote` has a scenario asserting the new 1.2. Writing it there alone leaves `quote_local`, which reaches `surcharge` on the other arm, without any scenario about a change in the same function. The tool lists it, and the agent must confirm (debugger, logging) whether `quote_local` can construct a remote order before adding one or deciding it can't.
