Feature: Health check

  # GET /health probes all three runtime dependencies before declaring the service healthy:
  #   - MySQL: runs SELECT 1 against the pool
  #   - Kafka: checks that the consumer has connected
  #   - OpenFeature: checks that the flags provider is READY
  # A single failure triggers 503 with a per-dependency status map so orchestrators
  # (Kubernetes readiness probes, load balancers) can detect and route around degraded instances
  # without silently routing traffic to an instance that cannot process messages.

  Scenario: System is ready to accept requests after startup
    When I request the health check
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  Scenario: Health check response is machine-parseable
    When I request the health check
    Then the response content type should be JSON

  # Guards against /health accidentally absorbing mutation traffic
  Scenario: Health check endpoint is read-only
    When I send a POST request to the health check endpoint
    Then the response status should be 404

  # ── Dependency failures ──────────────────────────────────────────────────────

  # Each dependency failure is detected independently and surfaces in the status map.
  # The caller can tell exactly which dep is the problem — useful for runbooks and alerts.
  # No external ticket; driven by a direct request to make /health useful to orchestrators.
  # All combinations of the three binary dependency states are covered.

  Scenario: MySQL unavailability is detected and reported
    Given the database is unavailable
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | ok       |

  Scenario: Kafka consumer disconnection is detected and reported
    Given the Kafka consumer is not connected
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | error    |
      | flags  | ok       |

  Scenario: Flags provider failure is detected and reported
    Given the flags provider is not ready
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | ok       |
      | flags  | error    |

  Scenario: MySQL and flags failures are reported together
    Given the database is unavailable
    And the flags provider is not ready
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | error    |

  Scenario: MySQL and Kafka failures are reported together
    Given the database is unavailable
    And the Kafka consumer is not connected
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | error    |
      | flags  | ok       |

  Scenario: Kafka and flags failures are reported together
    Given the Kafka consumer is not connected
    And the flags provider is not ready
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | error    |
      | flags  | error    |

  Scenario: All dependencies failing results in fully degraded report
    Given the database is unavailable
    And the Kafka consumer is not connected
    And the flags provider is not ready
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | error    |
      | flags  | error    |

  # ── HTTP method guard ──────────────────────────────────────────────────────
  # /health must reject all mutation methods so misconfigured clients cannot
  # accidentally treat the probe endpoint as an API resource.

  Scenario: PUT to health check endpoint is rejected
    When I send a PUT request to the health check endpoint
    Then the response status should be 404

  Scenario: DELETE to health check endpoint is rejected
    When I send a DELETE request to the health check endpoint
    Then the response status should be 404

  Scenario: PATCH to health check endpoint is rejected
    When I send a PATCH request to the health check endpoint
    Then the response status should be 404

  # ── Request body rejections (express.json middleware, app-wide) ────────────
  # express.json() runs in front of every route. A malformed or oversized JSON body
  # is rejected by the middleware before the /health handler runs, so orchestrator
  # probes that send a junk body get a clean 4xx rather than a handler crash.

  Scenario: Health check rejects a malformed JSON body
    When I request the health endpoint with a malformed JSON body
    Then the response status should be 400

  Scenario: Health check rejects an oversized JSON body
    When I request the health endpoint with an oversized JSON body
    Then the response status should be 413

  # ── HEAD probe ─────────────────────────────────────────────────────────────
  # Express auto-derives HEAD from the GET /health route; load balancers that probe
  # with HEAD must receive the status line with no body.

  Scenario: HEAD request to the health check returns no body
    When I send a HEAD request to the health endpoint
    Then the response status should be 200
    And the response body should be empty

  # ── Response shape contract ────────────────────────────────────────────────
  # The response must contain exactly the four documented keys. Extra keys could
  # leak internal state (stack traces, internal service names, credentials).

  Scenario: Health check response contains no undocumented fields
    When I request the health check
    Then the health check response should only contain documented fields

  # ── Query parameters are ignored ───────────────────────────────────────────
  # Orchestrators and load balancers sometimes append query params (e.g. cache
  # busting). The probe must return the same result regardless.

  Scenario: Health check ignores unknown query parameters
    When I request the health check with query parameter "debug=true"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  # ── No authentication required ─────────────────────────────────────────────
  # Kubernetes readiness probes and external load balancers call /health without
  # any credentials. If the endpoint requires auth the probe fails and the pod
  # never enters rotation — a silent availability regression.

  Scenario: Health check is accessible without authentication headers
    When I request the health check without any authentication headers
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |
