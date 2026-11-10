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
