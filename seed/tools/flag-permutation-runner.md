# Spec: Flag permutation runner

## Part 1 — What and why

### What it does

The runner takes a BDD suite and a manifest that lists, for each feature file, the feature flags its scenarios depend on. It runs every feature file once for every combination of its flags (2^N runs for N flags) and merges all the results into one JUnit report, with each result labeled by its flag combination. The runner exits non-zero if any run fails.

### Why

- **Flags interact.** One flag adds a Kafka write, another reroutes the request. Testing only the defaults, or one flag at a time, misses breakage that only shows up for a particular combination. Exhaustive permutation is affordable because N is small (typically 2–5), scenarios run in milliseconds against in-memory fakes, and the runs are parallel.
- **The manifest is a forcing function.** The harness's flag fake fails any scenario that reads an undeclared flag. Every flag must end up either in the matrix or in `excluded`, where it gets dedicated scenarios instead. The runner closes the loop by refusing to run if a feature file is missing from the manifest or a manifest entry has no feature file. An entry with zero flags still counts: a green baseline run is positive evidence that the flow reads no flags.

### Glossary

- **Combo:** one assignment of on/off to a feature's matrix flags.
- **Run:** one execution of the test framework over a group of feature files with one combo. This is the unit of scheduling.
- **Serial tag** (`@no-parallel`): marks scenarios that can't run concurrently. See Part 2, "Serial pass".

## Part 2 — Building one

### Contract with the harness

The runner only chooses combos. The harness applies them. In its per-scenario `Before` hook, the harness:

1. Declares the baseline flag values (from `defaults`).
2. Declares the feature's manifest flags.
3. Overrides them with the runner's combo.
4. Lets `Given` steps override any of the above for that scenario.

Precedence, last write wins: baseline → manifest → combo → `Given`.

The combo travels as JSON. The Python runner puts it in the `FLAG_PERMUTATION` env var. The Node runner passes it in-process as Cucumber `worldParameters.flagPermutation`, and the harness falls back to `FLAG_PERMUTATION`. Support both so the harness can be driven by hand (`FLAG_PERMUTATION='{"X":true}' npm run bdd-test`).

### Inputs

`flag-manifest.json`, keyed by the feature's path relative to the features dir, `/`-separated:

```json
{ "orders/submit.feature": { "flags": ["A", "B"], "excluded": { "C": "io-only: …" } } }
```

`flags` lists the flags the runner permutes. The runner ignores `excluded`; it exists for humans and the [flag audit](./flag-audit.md).

Config. Every key is optional; defaults shown:

| Key                              | Default                          | Purpose                                |
|----------------------------------|----------------------------------|----------------------------------------|
| `manifestPath`                   | `tests/telem/flag-manifest.json` |                                        |
| `featuresDir`                    | `tests/telem/features`           | Directory scanned for `.feature` files |
| `junitOutputPath`                | `output/bdd-tests-out.xml`       | Merged report                          |
| `maxFlagsPerFeature`             | 10 (rejected if > 20)            | Guard against an exponential blow-up   |
| `serialTag`                      | `@no-parallel`                   |                                        |
| `defaultEnv`                     | `{}`                             | Env vars applied to every run          |
| `cucumberProfile` / `behaveArgs` | `permutation` / `[]`             | How the framework is invoked           |

`PERMUTATION_WORKERS` (env var) overrides the worker count. A glob argument (`*` → `.*`, unanchored) narrows which features run.

### Pipeline

1. **Validate.** Scan the features dir. Report every feature file missing from the manifest, *and* every stale manifest entry, then exit 1. Report both lists before exiting, so one run shows the user everything to fix.
2. **Scan features.** Record which files contain the serial tag, and count each file's `Scenario` / `Scenario Outline` headings. Both are cheap regexes; the heading count only feeds work balancing. Match the serial tag only on lines starting with `@`, and require a word boundary on both sides, so that `@no-parallel-x` doesn't match.
3. **Split into two passes.**
  - A parallel pass with tag expression `not @no-parallel`.
  - A serial pass with `@no-parallel`, restricted to files that contain the tag.
4. **Plan runs per pass.**
  1. Apply the glob filter, plus the serial-file filter for the serial pass.
  2. Fail if any feature's flag count exceeds the cap.
  3. **Bundle** features that share the same flag set (key: the sorted flag names) so they share runs.
  4. **Split** each bundle into G = min(#features, ⌈workers / 2^N⌉) groups. Assign features round-robin in descending scenario count, so the first wave has about one run per worker. The serial pass uses workers = 1, so G = 1.
  5. Emit one run per (group × combo). Each run gets its own result path.
5. **Execute.** See "Parallelism" below.
6. **Stamp, merge, report.** Stamp each run's report (see below), merge all of them into one suite, print the failures with their captured output, and print a summary that includes the sum of per-run times ("serial-equivalent"), so the speedup is visible.
7. **Telemetry, if any.** Send it only after the exit code is decided, with a time limit, inside a catch-all, so it can never fail, hang, or change the result. Load it lazily, so workers and other subcommands don't pay its import cost.
8. **Exit** 1 if any run failed, otherwise 0. Delete the temp results dir *after* telemetry has read it.

### Parallelism and CPU saturation

- **Worker count:** ⌈0.75 × logical cores⌉, minimum 1, overridable. Leaving 25% headroom keeps the machine usable and stops oversubscription from making timings flaky.
- **One level of parallelism only.** Each worker runs its scenarios single-threaded (Node: `parallel: 0`; behave has no parallel mode by default). If the framework's own parallel mode ran inside each worker, you'd get workers × framework-threads processes and saturate the CPU.
- **Process isolation per worker is required.** Scenario isolation is per-process state (module-scoped scenario IDs, patched modules, fakes), so workers must be separate processes, never threads in one interpreter. Python's thread pool is fine only because each thread just waits on a `behave` subprocess.
- **Process reuse is the biggest design choice.**
  - Spawn per run (Python: `subprocess.run` per run). Simplest and fully isolated, but every run pays the full framework and app boot.
  - Persistent workers (Node). `fork` a pool once. Each worker loads the framework config and support code once, then receives runs over IPC (`run` / `result` / `shutdown`, plus `ready` after boot). This is much faster at scale, but state that leaks across scenarios can now cross runs. A flake that appears only in multi-run workers means cleanup is leaking state, not that the runner is broken.
- **Scheduling.** Feed workers from a queue of pending runs, one run at a time, so the shortest runs fill in around the longest ones. The serial pass's queue is capped at one worker. Node runs both passes in one pool at the same time. Python runs them one after another, which leaves workers idle at the end of the parallel pass.
- **Memory.** Each worker holds a full in-memory app plus its fakes. On big services, memory, not CPU, sets the worker cap.

### Serial pass

The serial tag is for scenarios whose dependency can't be namespaced by scenario: a native extension, or process-global state that no fake can intercept. They get their own single-worker pass, which still covers every combo. This is not a home for flaky tests. A flake caused by a leaked clock, random number, or ordering is a missing fake, not a reason to serialize.

Decide what "serial" guarantees. Each worker already runs its scenarios one at a time, so scenarios inside a single process never collide. What serializing adds is protection for state *shared between processes*: a fixed port, a file, a local daemon. The two implementations guarantee different things:
- **Python** runs the serial pass alone, after the parallel pass.
- **Node** caps the serial queue at one worker, but runs it alongside the parallel workers.

If serial scenarios contend for a host-wide resource, make the serial pass exclusive, i.e. drain the pool before it starts.

### Results (JUnit)

- **Isolate each run's output.** Two concurrent combos of the same feature must not write to the same path. Cucumber accepts a filename per run. behave names its own files (`TESTS-<feature>.xml`), so each run needs its own *directory*, or the reports overwrite each other and the stamping step opens files behave never wrote.
- **Stamp before merging.** Rewrite every `testcase` `classname` to `BDD.<feature>.<scenario>.<combo label>`, where the combo label reads like `A=ON B=off`, or `(baseline)` for no flags. Without this, the same scenario under different combos collapses into one entry in CI.
  - If the XML is regex-parsed, the attribute match must be quote-aware: `>` may appear unescaped inside an attribute value (cucumber-js emits `name="foo &lt;bar>"`).
  - Keep self-closing tags self-closing.
  - A missing report (the framework crashed before writing) is skipped rather than treated as fatal, because the run's own exit code already records the failure.
- **Merge** into one `<testsuite name="BDD">`, summing `tests`, `failures`, `errors`, and `time`. Count errors as failures in the summary.
- **Know the framework differences.** behave includes tag-excluded scenarios as `<skipped/>` and puts a per-case `status` attribute on each testcase. cucumber-js leaves tag-excluded scenarios out entirely and reports every other non-pass outcome as `<failure>`. "Skipped" counts therefore mean different things per framework.
- **behave's `classname` depends on its invocation path.** Pass feature paths the same way every time, or classnames change between runs.

### Failure handling

- A run that fails tests is a result, not an error: record it (features, combo, captured stdout+stderr) and keep going.
- A worker that *crashes* (non-zero exit not caused by our own SIGTERM, or a spawn error) aborts the whole run: kill all children and surface the worker's stderr. Silently retrying would hide real breakage.
- Capture each run's output into a buffer and print it only for failures, so a passing run stays quiet.

### Output

On a terminal (`isatty` and not `CI`), redraw a single progress bar on stderr showing `done/total` and failure counts per pass. Otherwise print one line per run, grouped under a `--- <PASS> done ---` header. Always end with a list of failures and a summary line.

### Acceptance checks

- Unlisted and stale manifest entries are both reported, and the runner exits 1.
- A feature with 0 flags gets exactly one `(baseline)` run. A feature with N flags gets 2^N runs.
- Two combos of the same feature running at the same moment both appear, separately, in the merged report.
- At most one `@no-parallel` run executes at a time. If you chose an exclusive serial pass, nothing else runs during it.
- A worker crash makes the runner exit non-zero and shows the crash's stderr.
- Telemetry failing or hanging doesn't change the exit code.
- Test against the **real** framework, not a faked subprocess. The Python runner's own tests fake `subprocess.run` and write a `TESTS-run{N}.xml` that behave never produces, so they passed while the real JUnit path was broken.
