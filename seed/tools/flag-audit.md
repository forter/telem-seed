# `flag-audit` spec

## What it does and why

The strict flag interceptor ([Discovery: Feature flags](../discovery.md#9-feature-flags)) only catches reads a scenario actually reaches. A flag read on a path no scenario exercises, a declaration for a flag production stopped reading, and a flag no one decided how to test all pass silently.

`flag-audit` statically extracts the flag names production code reads and compares them to the declared baseline and the per-feature manifest. It reports what is covered, what is unexplained, and what was never categorized. It is an audit, not the source of truth: the interceptor is. A static search can miss reads and can misread code, so every finding has a resolution that doesn't require lying (declare it, delete it, annotate it with a reason, categorize it).

Despite the Telem command name (`map-flags-to-features`), it never maps a flag to a feature. Static extraction has no feature attribution. It only checks that each flag is categorized somewhere in the manifest.

## Building one yourself

### 1. Inputs

- **Audit config** (`.telem/bdd-flags.json`), comments allowed:
  - Search patterns, of two kinds, at least one required (see §2).
  - Container mappings (§2).
  - Baseline file path.
  - Path exclusions.
  - **Dynamic annotations**: flag name → non-empty reason (blank or whitespace-only is rejected at load).
- **Baseline**: the baseline sections of the defaults file (`tests/telem/features/defaults.{ext}`). Every flag it declares counts as declared, whatever its kind (boolean, a function of the user, a percentage rollout, or anything else the repo's flag system supports) and however the repo groups them.
- **Manifest** (optional): `tests/telem/flag-manifest.json`, contract owned by [flag permutation runner](./flag-permutation-runner.md#inputs). The audit reads only each feature's `flags` and `excluded`; it ignores any other property the contract allows.
- **Production source**, minus exclusions.

Validate the config at load and fail loudly, naming the field and file: a pattern missing a required field, a container mapping referenced but not defined, a malformed annotation. Publish a schema for the config; it must accept every key the loader accepts, or editors will flag valid configs.

### 2. Extracting flag reads

Two passes, results merged:

- **Structural pass.** A pattern in the code-search tool's own syntax (`readFlag($NAME)`), the dialect it applies to, and the name of the placeholder that captures the flag. Prefer this: it matches syntax, not text, so formatting and line breaks don't matter. See [the parsing hint](../hints/ast-grep.md) for a tool that does this.
- **Pattern pass.** A regular expression plus the capture-group index holding the name, for chained access a structural pattern can't express. Use one regex engine for both selecting and extracting, and find *every* match, not the first per line. Scan the same set of source files as the structural pass: every dialect the repo uses, not a fixed extension list, or the pass silently misses files.
- **Containers.** Some code reads a container (a table, a namespace) rather than a flag. A pattern may name a dimension, and the config maps each container to the flags inside it; each hit expands to those flags. An unmapped container, including one mapped to an empty list, passes through unexpanded so it surfaces in the report instead of vanishing.
- **Only a string literal names a flag.** A name captured by the pattern pass counts as literal, because a regex can't tell a literal from an expression: write the pattern so it captures only a quoted name that is the whole argument (`readFlag\(\s*"([^"]+)"\s*\)`). A loose one (`readFlag\(([^)]*)\)`) turns `readFlag(variable)` into a flag named `variable`, and one that stops after the closing quote records `foo` for `readFlag("foo" + suffix)`. A call the pattern doesn't match (`readFlag("foo", default)`) isn't seen by this pass: it surfaces only through the structural pass or the non-literal report. Otherwise strip exactly one matching pair of surrounding quotes. A non-literal argument (variable, expression, interpolated string) can't be named statically: list its call site in a separate section for the agent to trace per [Discovery §9](../discovery.md#9-feature-flags) (a finite set of literals is enumerated and declared; an unbounded key is dynamic). Never invent a flag name from the expression text.
- **Exclusions** are matched against the repo-relative path and must at least remove tests, vendored dependencies and generated code: the audit counts production reads only. Report paths repo-root-relative, whatever the search tool's working directory.

Per flag, keep the set of files that read it.

### 3. Parsing the baseline

Parse the baseline declaration structurally. Fail loudly, naming file and expectation, on an unrecognized shape: the declaration missing, in the wrong container, a non-string key, a syntax error. Accept any kind of value; don't validate or evaluate it. Don't scan the file for lines that look like flags: that counts booleans from unrelated sections, silently drops flags with trailing comments or several to a line, and turns a malformed baseline into confident wrong output ("every flag is code-only"). Never execute the file.

Read names only; values are the interceptor's concern. A baseline with zero flags is valid.

### 4. Comparing

Let *found* = flags extracted, *declared* = baseline names, *manifest* = every name in any feature's `flags` or `excluded`.

| Category | Definition | Resolution | Why | Residual |
|---|---|---|---|---|
| covered | in *declared* and *found* | none | The read exists and is declared | Proves a read exists somewhere, not that a scenario reaches it; the interceptor and coverage do that |
| baseline-only | in *declared*, not *found*, not annotated | Delete if dead; annotate if dynamic | A declaration for a removed flag makes the baseline lie and hides that production dropped it | A flag read by a dependency or through a non-literal key looks identical to a dead one; only a human can tell |
| accepted-dynamic | baseline-only and annotated | none; print the reason | Resolved, so it doesn't repeat as noise on every run | The reason is free text; its quality is unchecked |
| stale annotation | annotated, but *found*, or not in *declared* | Remove the annotation | Suppression lists rot silently otherwise | none |
| code-only | in *found*, not in *declared* and not in the manifest's `flags` | Declare it (baseline, or manifest `flags`) | An undeclared read fails at runtime the moment a scenario reaches it | A flag in `excluded` only is categorized, not declared; it still needs a baseline entry or a Given |
| manifest-declared | in *found*, not in *declared*, in some manifest `flags` | Informational | Manifest-only flags default to disabled, a legitimate layer; production-default-enabled flags belong in the baseline | A mistaken default-disabled flag that production enables |
| uncategorized | covered, but in no manifest `flags` or `excluded` | Categorize per the tree in [Discovery §9](../discovery.md#9-feature-flags) | A flag that is neither permuted nor excluded escapes both the matrix and the dedicated scenarios | The check pools all features: it can't tell that the feature actually reading the flag is the one that categorized it |
| non-literal call site | argument isn't a string literal (§2) | Trace the key's source | A variable argument is not proof of a dynamic keyspace | none; it's a work list, not a verdict |

Report counts first, then each category with its flags, and for covered and code-only the reading files. Sort everything so output is diffable. Skip the uncategorized check when there is no manifest or it has no entries.

### 5. Manifest handling

- **Absent by configuration** (no manifest configured or yet created, as in early discovery): skip the cross-check and print one line saying so.
- **Present but unreadable or invalid** (unparseable, wrong shape, or an entry property the runner's contract doesn't define): fail loudly with what and where. Skipping silently disables the only check that finds uncategorized flags, and the clean report that follows is a false green.

### 6. Exit codes: gating, with a report mode

Intended behavior is **gating**, selectable. A strict mode exits non-zero if any of baseline-only (unannotated), stale annotation, code-only or uncategorized is non-empty; the report mode exits zero regardless. Use distinct codes for "findings" and "the audit itself failed" (unreadable config, baseline, manifest or a failed search tool).

Why: during discovery, code-only and baseline-only are the work list, so report mode is right. Once the suite is complete, and on periodic drift checks ([Sync](../skills/sync.md)), those findings are rot, and a requirement to resolve them that lives only in prose is the kind agents skip; the gate is what makes it checkable. Every finding has a non-deceptive resolution, so a gate is satisfiable. Non-literal call sites never gate: they need judgment.

## Challenges and edge cases

- **A static search is an under- and over-approximation.** It misses runtime-built keys and dependency reads; it over-reports reads in unreachable code. The annotation mechanism, not a looser gate, is the answer to that.
- **A search tool's "no match" is not an error.** Some signal it with a non-zero exit and still emit a valid empty result. Distinguish "no match" from "tool missing" from "tool failed" (exit status, stderr, unparseable output), and report each differently. Treat empty output as zero matches. Reporting every failure as "not installed" sends the user to the wrong fix.
- **Substring exclusions over-exclude.** Matching `test/` as a substring also drops `latest/`. Match whole path segments, or document the substring rule.
- **Same flag in many files** is one entry with several files.
- **Quote handling is the same on both passes**, and flag names may contain hyphens, dots (composite keys) and mixed case.
- **A malformed pattern** (bad regex, a capture index out of range, a pattern the search tool rejects) fails the run naming the pattern. It must not return partial results.
- **Whole-line and multi-line reads.** A pattern pass is line-based; a flag read split across lines is invisible to it. Prefer a structural pattern.
- **Containers hide flags.** When code reads a table and the baseline declares its fields, without a mapping the report shows table names as code-only and field names as baseline-only. The mapping must match the key format the baseline uses.
- **Annotations are the only permitted suppression.** Require the reason at load. A dead flag is deleted, not annotated.
- **Multiple implementations** drift on exactly these points (baseline parsing, quote stripping, empty mappings, error reporting). Pin the behavior in shared, language-neutral tests.

## Appendix: worked example

```
audit(config, baselineFile, manifest?):
  found = {}; nonLiteral = []                       # found: flag -> set(files)
  for hit in structuralHits(config) + regexHits(config):   # hit = (file, text, dimension?)
      if isStringLiteral(hit.text):
          for f in expand(unquote(hit.text), hit.dimension, config.containers):
              found[f] += hit.file
      else:
          nonLiteral += (hit.file, hit.text)

  declared = parseBaselineStructurally(baselineFile)       # throws on unrecognized shape
  m = manifest ? validate(manifest) : none                 # throws if present and invalid
  covered       = declared ∩ found
  rawBaseOnly   = declared − found
  accepted      = rawBaseOnly ∩ keys(config.dynamic)
  baseOnly      = rawBaseOnly − accepted
  stale         = keys(config.dynamic) − rawBaseOnly
  manifestDecl  = (found − declared) ∩ flagsOf(m)          # informational
  codeOnly      = found − declared − flagsOf(m)
  uncategorized = m ? covered − (flagsOf(m) ∪ excludedOf(m)) : []
  print(...); exit(strict and any(baseOnly, stale, codeOnly, uncategorized) ? FINDINGS : OK)
```

Baseline declares `{alpha, beta, gamma, delta}`. Production reads `alpha`, `beta`, `epsilon`, and `read(name)` with a variable. Annotations: `{gamma: "read by the billing library", beta: "..."}`. Manifest: `orders.feature → flags [alpha]`.

- covered: `alpha`, `beta`. `alpha` is categorized; `beta` is in no manifest entry, so **uncategorized**.
- `gamma` is baseline-only but annotated: **accepted-dynamic**.
- `delta` is baseline-only, unannotated: **baseline-only** (delete if dead).
- `beta`'s annotation is **stale**: the search finds `beta`, so it was never baseline-only.
- `epsilon` is read and declared nowhere: **code-only**. The next scenario that reaches it would crash the interceptor; the audit says so now.
- `read(name)`: a **non-literal call site**; trace `name`.

In strict mode the run exits with the findings code. Two ways a naive audit lies here: (a) a quiet manifest skip, if the manifest has a typo, hides `beta` as uncategorized and prints a clean report; (b) a line-scanning baseline parser drops a flag declared as `alpha: true, // note` (trailing comment), so `alpha` reads as code-only although it is declared.
