# Plugin versioning

Each skills plugin has its own version and its own changelog. Target repos record which plugin version they have applied, so later releases can be retrofitted into them.

## Pieces

- The plugin's version is bumped by hand on every change to the plugin. Patch is the default. Minor is for an interface break. Major bumps are a decision by the user.
- A `CHANGELOG.md` file is maintained. Newest entry first. Each entry has this shape:

  ```
  ## <version>
  - `<owning skill>` — what changed.
    ON SYNC: what an existing repo must do, or `none`.
    SUPERSEDES: <version>   (optional; cancels that entry's action)
  ```

- `pluginVersion` in the target repo's configuration files. The last version whose `ON SYNC` actions the repo has worked through. It lives in one of two files, depending on whether the repo has finished onboarding.

## Who writes what

| Writer | Writes |
| --- | --- |
| A plugin change (by a human or an agent) | Bumps `plugin.json` and adds a new changelog entry at the top |
| `backfill` (first run) | Creates `.telem/bdd-onboarding-progress.json` with `pluginVersion` set to the current version |
| `backfill` | Advances `pluginVersion` in the progress file |
| `graduate` | Writes `pluginVersion` into `.telem/bdd-freshness.json`, which takes over from the progress file |
| `sync` | Advances `pluginVersion` in the freshness file |

## Who reads it

### `check-plugin-version.sh` - validation of changes

Target repos use the changelog to catch up on plugin changes (`backfill`, `sync`). Two things break that:

- **A change ships without a version bump.** Repos that have already synced past the old version never see the change.
- **A shipped entry is edited or dropped.** Repos that already walked past that entry never see the edit.

The check blocks both before merge.

#### Interface

- **Inputs:** a plugin directory and a base branch. The base is the PR's target in CI and `main` locally. Compare like with like: the branch's own changes, from where it diverged, including whatever the author is about to ship, committed or not.
- **Reads:** the plugin's manifest version and `CHANGELOG.md` as they are on the branch side (the working tree, so uncommitted edits count), and the same two files on the remote base branch.
- **Exit codes:** 0 means pass, 1 means a rule was broken, 2 means a usage error. Each failure prints one message that names the file and tells the author how to fix it. In CI the message is emitted as an annotation.
- **Runs in:**
  - CI, one job per plugin, triggered only by PRs that touch that plugin;
  - the local pre-stop static checks, once per plugin against `main`.

#### Rules, in order

The order matters: the changelog rules apply even when no bump is due.

1. **The changelog exists.**
2. **The top heading matches the version.** A heading's version is its first word after `## `, and anything after that is ignored. If there is nothing to say for an existing repo, the author still adds an entry, with `ON SYNC: none`.
3. **Every heading is unique and in strictly descending semver order.** Compare the numbers field by field, not as strings, so that `0.10.0` sorts above `0.9.9`.
4. **A plugin that doesn't exist on the base passes here.** This is allowed only if the base branch itself resolves. Without that condition, a typo'd base would let every change through as "new".
5. **The changelog is append-only.** Find the base's top heading on the branch side. That heading and everything below it must be byte-identical to the base. So the only allowed edit is inserting new entries above the old top.
6. **An untouched plugin passes here.** If nothing in the plugin directory differs from the base, no bump is required. This keeps a branch that's even with the base from failing.
7. **The version changed.** The branch's version must differ from the base's version.

Rule 7 checks only that the version is *different*. It doesn't need to check that it's *higher*, because rules 2, 3 and 5 together force the new top heading to sit above the base's top heading in descending order.

### Retrofit walk - applying changes

**The retrofit walk**, run by `backfill` during onboarding and by `sync` after graduation, works like this:

1. Take the entries newer than the repo's `pluginVersion`, up to the installed version. Compare as semver, not as strings.
2. Drop entries that a later entry supersedes, and entries marked `ON SYNC: none`.
3. Record every remaining item before working any of them. `sync` writes them to `.sync-plan.md`; `backfill` creates one Task each. Split an item that targets "each fake" or "each flow" into one item per target.
4. Apply what the user approves. Every item ends up applied or skipped with a reason.
5. Advance `pluginVersion` only once every item has reached one of those states. Until then, a rerun recomputes the same set of items.

`backfill` also drops entries for phases that haven't run yet, because those phases will read the current guidance anyway. When it isn't clear which phase an entry belongs to, it keeps the entry.
