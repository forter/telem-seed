Feature: Harness safety-net meta-tests

  These scenarios verify the core harness invariants. They must always pass.
  If they fail, the ownership safety net is broken and the entire suite's integrity is at risk.

  Scenario: Harness detects orphaned database operations
    Given a subscriber is created via the API without claiming ownership
    Then the unowned IO check catches the unclaimed subscriber write

  Scenario: Subscribers don't persist between scenarios
    Given no subscribers are seeded
    When I GET the subscribers list
    Then the response status is 200
    And the response body is an empty array

  Scenario: MySQL failure injection propagates to the API response
    Given the MySQL fake is configured to fail
    When I GET the subscribers list
    Then the response status is 500

  Scenario: Harness detects an orphaned Kafka offset commit
    Given a Kafka message is dispatched without claiming its offset commit
    Then the unowned IO check catches the unclaimed offset commit

  Scenario: Kafka failure injection fails one commit and then recovers
    Given committing the Kafka offset fails once and then recovers
    When I attempt to dispatch a Kafka message on topic "meta-topic" partition 4 at offset 10 with key "k1" and payload "first"
    And I attempt to dispatch a Kafka message on topic "meta-topic" partition 4 at offset 11 with key "k2" and payload "second"
    Then the first commit attempt failed and the second succeeded for topic "meta-topic" partition 4

  Scenario: Kafka failure injection rejects an undeclared operation
    Then configuring failure for an undeclared Kafka operation is rejected

  # isConfiguredToFail is what a Then step asks to tell "the provider is still failing" from "it has
  # recovered" without spending an evaluation; these pin that it peeks rather than advances.
  Scenario: OpenFeature failure injection reports the failure until it is consumed and then recovers
    Given the feature flag provider fails on its first evaluation and then recovers
    And the topic "meta-flags" is delivery-blocked
    Then the flag evaluation for topic "meta-flags" reports its injected failure until it is consumed

  Scenario: OpenFeature failure injection keeps failing on every repeated flag evaluation
    Given the feature flag provider is failing on every evaluation
    And the topic "meta-flags" is delivery-blocked
    Then the flag evaluation for topic "meta-flags" keeps failing across repeated evaluations

  Scenario: OpenFeature failure injection reports nothing for a scenario that configured none
    Then no flag evaluation failure is reported for a scenario that configured none

  Scenario: OpenFeature failure injection is isolated to the scenario that configured it
    Given the feature flag provider is failing on every evaluation
    Then no flag evaluation failure is reported for another scenario

  Scenario: OpenFeature failure injection rejects an undeclared operation
    Then configuring or querying failure for an undeclared flag operation is rejected

  Scenario: OpenFeature failure injection rejects an empty sequence
    Then configuring a flag failure with an empty sequence is rejected

  # A configured failure that nothing triggers means the scenario never exercised the failure path it
  # names (typically a typo'd URL); the net must flag it rather than let the scenario pass vacuously.
  Scenario: Harness detects a network failure that was configured but never fired
    Given a network failure is configured for a URL the app never requests
    Then the unowned IO check catches the network failure that never fired

  Scenario: Network failure injection rejects an operation that is not a request URL
    Then configuring a network failure for something that is not a request URL is rejected

  Scenario: Response seeding rejects answers real fetch would never hand back
    Then seeding a response that real fetch would never hand back is rejected
