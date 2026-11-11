# How to parse source for the tools

`ast-grep` fits [`flag-audit`](../tools/flag-audit.md), [`affected-flows`](../tools/affected-flows.md) and [`explore-branches`](../tools/branch-explorer.md). A hint, not a requirement.

- **Standalone binary, not the repo's compiler API.** A peer-dependency major can't break it. TypeScript 7 shipped without the JS compiler API.
- **`flag-audit`:** `$NAME` metavariable. It captures the literal with its quotes; a non-literal capture is a dynamic call site.
- **`affected-flows`:** `kind` rule on function nodes (`function_declaration`, `arrow_function`, `method_definition`; Python `function_definition`). Innermost range containing the hunk. Ranges are **0-based**; coverage and diffs are 1-based.
- **`explore-branches`:** `kind` rule on handler nodes (`catch_clause`; Python `except_clause`).
- **Node kinds:** `--debug-query=ast`.
- **Error recovery is the trap.** A broken file still yields matches. Run `kind: ERROR` per dialect; any hit is a parse failure naming the file, never a partial result.
- **Dialects:** language id per file (`ts`, `tsx`, `js`, `py`), on the original source, not build output.
