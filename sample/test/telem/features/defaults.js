// Companion JS stub for telem-bdd audit tool (map-flags-to-features).
// Cucumber uses defaults.ts (loaded via tsx/cjs); this file is for the tool only.
// The tool reads this file as TEXT (fs.readFileSync + regex) — it is never executed.
//
// ONLY arrange.baselineFlags must stay in sync with defaults.ts. The `assert` map is
// intentionally empty here: the tool's regex extracts only `'FLAG': true|false` lines,
// so assert entries (function refs) are ignored. A populated assert in defaults.ts is
// therefore NOT drift — do not copy it here.
//
// Pattern for baseline flags (parsed by the tool via regex):
//   baselineFlags: {
//     'MY_FLAG': false,
//   },

const defaults = {
  arrange: {
    baselineFlags: {
      // No static flags: this app uses a dynamic per-topic flag system.
      // Flag key = Kafka topic name (runtime value); default = false (not blocked).
      // See COLLECTED-WISDOM.md § "Feature Flag Inventory" for rationale.
    },
  },
  assert: {},
};

module.exports = { default: defaults };
