# Telem's Runtime Artifacts

While running Telem, the skills generate both the tests and other artifacts.
The tests, their runtime, utilities, etc. - for the purpose of this document - are placed in `tests/telem`. Platforms may vary where that root should be.

## Tests

Note: `{ext}` is used here to denote platform-specific source file (e.g. `.py`, `.js`, `.ts`).

```
- tests/
  - telem/ 
    - features            # Gherkin feature files, executed by the platform's version of Cucumber
      - defaults.{ext}    # Test defaults: feature flag baselines, always-on Then steps, etc.
    - step-definitions    # Gherkin steps implementation in your language of choice
    - support             # Runtime supporting files
      - fakes             # Fake implementations
        - parity-tests    # Fake parity test suite
    - flag-manifest.json  # Flags decleared per feature file
```

## Supporting documentation

There are multiple pieces of context that the agents create and maintain:

1. In `tests/telem`:
   - `WRITING-TESTS.md`: System-specific information about how to write tests and their implementation.
   - `WRITING-FAKES.md`: System-specific information about how to write fakes and their parity tests.
   - `COLLECTED-WISDOM.md`: Anything the agent has come across that was not easily inferred from the code. It greps through this file when it comes across anything that confuses it.
2. Next to each feature file:
   - `{feature}.analysis.md`
   - `{feature}.implementation-notes.md`

## Work product

There are also files that accompany the skills as they work, keeping track:

1. In `tests/telem`:
   - `FLOW-CHECKLIST.md`: The list of flows and sub-flows that the backfill process is working through. This file is removed once the repo graduates.
2. In `./telem`:
   - `bdd-onboarding-progress.json`: A file containing `{phase, flowsCompleted, pluginVersion}`, allowing the agent to keep track of what has already been backfilled.
   - `bdd-freshness.json`: A file containing `{pluginVersion, lastCheckedAt, lastCheckedCommit}`, created post-graduation, which helps `/sync` keep track of where to start work.

## Configuration files

### `tests/telem/features/defaults.{ext}`

This file contains anything that runs by default during a test run. It is split by `arrange`, `act`, and `assert` sections, corresponding to the part of the lifecycle where they run.

Example:

```javascript
module.exports = {
   // Preconditions applied to every scenario (arrange phase).
   arrange: { 
      // The baseline of flags for all scenario runs.
      baselineFlags: {
         'example-flag': true,
         'another-traffic-flag': function(user) {
             return user.hasTrafficFlag;
         }
      },
   },

   assert: {
      // Must be last — runs after all other defaults have taken ownership of their data.
      // To opt out: "Then we might have unowned IO changes"
      'No unowned IO changes should remain': assertNoUnownedChanges,
   },
};
```

Below the top-level properties, there is no prescribed format. Fit the structure of the data to your use case. Evolve it as you see fit.

Read more about `No unowned IO changes should remain` in [Fakes](./fakes.md) and about the feature flag baseline in [Discovery](./discovery.md). 

### `tests/telem/flag-manifest.json`

This file contains explicit declarations of feature flags used by each `feature` file. It's used by the test runner to figure out which flag permutations to run.

```json
{
   "{business-flow-name}.feature": {
      "_comment": "An explanation for why we chose to declare the flags",
      "flags": [
         "FLAG_1",
         "FLAG_2"
      ]
   }
}
```
