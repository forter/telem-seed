# `/telem-{platform}:sync`

Once a repo has graduated, its Telem suite is the source of truth for how the code behaves. Two things pull the suite out of date: the plugin's guidance changes, and production code changes. `sync` is a periodic check that is safe to rerun. It closes both gaps, and never edits an approved test without the user's approval.

## State

`.telem/bdd-freshness.json` is written by `/graduate`. If the file is missing, stop. It holds two anchors:

- `pluginVersion` is the last plugin release whose guidance the repo has applied.
- `lastCheckedCommit` is the last production commit the suite has been reconciled with.

An anchor moves forward only when its check is clean or the user accepts what's left. That way any outstanding drift shows up again on the next run.

## Checks

1. **Guidance**:
  - Upgrade telem's own packages to latest, and leave third-party packages alone.
  - Collect every changelog entry newer than `pluginVersion`. Each entry carries an `ON SYNC:` instruction. See [Plugin Versioning](../plugin-versioning.md) for more info about versions.
  - Write the entries to an on-disk checklist, with one item per target ("each fake", "each flow"). This keeps diffuse items from being dropped.
  - Apply what the user approves. Every item must end up applied or skipped with a reason.
2. **Production**:
  - Diff the code from `lastCheckedCommit` to the remote default branch. Keep only changes to observable behavior.
  - Attribute each changed hunk to *every* flow that runs it and add scenarios to each, per [Discovery: Shared-code drift fan-out](../discovery.md#shared-code-drift-fan-out), using [`affected-flows`](../tools/affected-flows.md) with per-feature coverage rebuilt fresh at the reconcile baseline.
  - If no flow runs the code, it's a moved file (rule out a rename first), dead code, or a new flow; queue a new flow for backfill.
  - If a scenario asserts behavior that production no longer has, ask the user whether the change was intended or is a bug.
  - Also reconcile fake parity and remove dead flags.
3. **CI**: Make sure CI still runs the full flag-permutation matrix, and rewire it if not.
4. **Gate hygiene**: Every standing warning gets fixed, or suppressed with a written reason. A gate that is always yellow will get ignored, so this is the time to fix it.

Then advance the production anchor if all four checks are clean, and report each check as clean or outstanding.
