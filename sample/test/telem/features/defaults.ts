// Declares which assertions run automatically after every scenario.
// Loaded by defaults.steps.ts — NOT a feature file, not auto-loaded by Cucumber.
//
// Ordering rule: the unowned-IO check MUST be last, after all other auto-defaults have
// taken ownership of their expected IO. Add new auto-ownership entries above it.

import { assertNoUnownedChanges, assertKafkaOffsetCommitted, assertKafkaSubscriptions } from '../step-definitions/defaults.steps';

const defaults = {
  // Baseline flags applied to every scenario before Given steps run. Also read (as text) by
  // `npm run bdd-test:audit-flags` via defaultsPath in .telem/bdd-flags.json.
  // Dynamic per-topic flag system — no static flags needed.
  // See COLLECTED-WISDOM.md § "Feature Flag Inventory" for rationale.
  arrange: {
    baselineFlags: {} as Record<string, boolean>,
  },

  assert: {
    // Claims + asserts, per dispatched message, the commit of offset + 1 on its own topic/partition.
    // Scenarios that pin offsets explicitly, or whose handler is expected to throw, opt out
    // (steps: "the committed offset ...", "the Kafka offset should not have been committed").
    'Kafka offset is committed after a dispatched message': assertKafkaOffsetCommitted,

    // Claims + asserts, per distinct topic of the subscribers a scenario registered, the one subscribe attempt and
    // the consumer's run / stop / run sequence. Scenarios that pin the lifecycle themselves (a failing subscribe,
    // restarts, concurrent registrations) opt out via the "Kafka consumer ..." steps in subscribers.steps.ts.
    'Kafka consumer subscribes to each newly registered topic': assertKafkaSubscriptions,

    // MUST BE LAST.
    'No unowned IO changes should remain': assertNoUnownedChanges,
  },
};

export default defaults;
