// Declares which assertions run automatically after every scenario.
// Loaded by defaults.steps.ts — NOT a feature file, not auto-loaded by Cucumber.
//
// Ordering rule: the unowned-IO check MUST be last, after all other auto-defaults have
// taken ownership of their expected IO. Add new auto-ownership entries above it.

import { assertNoUnownedChanges, assertKafkaOffsetCommitted } from '../step-definitions/defaults.steps';

const defaults = {
  // Baseline flags applied to every scenario before Given steps run.
  // Dynamic per-topic flag system — no static flags needed.
  // See COLLECTED-WISDOM.md § "Feature Flag Inventory" for rationale.
  arrange: {
    baselineFlags: {} as Record<string, boolean>,
  },

  assert: {
    // Add auto-ownership entries here as common IO patterns emerge from written scenarios.
    // Example: 'Request metadata is persisted': assertMetadataPersisted,

    // Claims + asserts the single offset commit for any scenario that dispatched a Kafka message.
    // Failure-path scenarios opt out with "the Kafka offset should not have been committed".
    'Kafka offset is committed after a dispatched message': assertKafkaOffsetCommitted,

    // MUST BE LAST.
    'No unowned IO changes should remain': assertNoUnownedChanges,
  },
};

export default defaults;
