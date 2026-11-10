Feature: Harness smoke test — GET /api/subscribers

  These two scenarios together verify end-to-end harness correctness:
  - Scenario 1: MySQL fake seeds and returns data; fake-fetch handles no outbound calls.
  - Scenario 2: Cleanup isolated Scenario 1's data — this scenario sees a fresh empty state.

  Scenario: API maintains subscriber insertion order
    Given the following subscribers are seeded:
      | id | name      | topic  | url                         | headers |
      | 1  | Acme Corp | orders | https://acme.example.com/wh | {}      |
      | 2  | Beta Inc  | orders | https://beta.example.com/wh | {}      |
    When I GET the subscribers list
    Then the response status is 200
    And the response body contains 2 subscribers
    And the first subscriber has name "Acme Corp"
    And the second subscriber has name "Beta Inc"

  Scenario: Cleanup prevents data leakage between scenarios
    When I GET the subscribers list
    Then the response status is 200
    And the response body is an empty array
