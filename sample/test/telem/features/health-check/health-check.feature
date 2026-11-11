Feature: Health check

  # GET /health probes all three runtime dependencies before declaring the service healthy:
  #   - MySQL: runs SELECT 1 against the pool, on every request (nothing is cached)
  #   - Kafka: checks that a consumer object exists (isConsumerConnected) - not that the broker
  #     connection is live or that the consumer is running
  #   - OpenFeature: checks that initFlags() completed (isFlagsReady)
  # Every probe runs and is reported, whichever fail. A single failure triggers 503 with a
  # per-dependency status map so orchestrators (Kubernetes readiness probes, load balancers, the
  # docker-compose healthcheck's wget) can detect and route around degraded instances without
  # silently routing traffic to an instance that cannot process messages.
  # Readiness probe semantics: https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/

  # The request carries no credentials, as Kubernetes readiness probes and load balancers send it: if /health ever
  # required auth, the probe would fail and the pod never enter rotation, a silent availability regression.
  Scenario: A fully started instance reports every dependency healthy
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
  # Every combination of dependency states is covered.

  Scenario: MySQL unavailability is detected and reported
    Given the database is unavailable
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | ok       |

  # Shut down means stopConsumer() ran, as on SIGTERM. A broker that drops a live consumer is NOT detected: see "What the Kafka probe actually checks" below.
  Scenario: A Kafka consumer that has been shut down is reported as an error
    Given the Kafka consumer has been shut down
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | error    |
      | flags  | ok       |

  # "Not ready" is the startup window: Express answers /health before initFlags() resolves (src/index.ts), and a
  # failed initFlags() aborts the process, so no instance serves with a failed provider.
  Scenario: A flags provider that has not finished initialising is reported as an error
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
    And the Kafka consumer has been shut down
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | error    |
      | flags  | ok       |

  Scenario: Kafka and flags failures are reported together
    Given the Kafka consumer has been shut down
    And the flags provider is not ready
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | error    |
      | flags  | error    |

  # This is also what an instance answers in its startup window: Express listens before MySQL, flags and Kafka are up
  # (src/index.ts), so an orchestrator keeps it out of rotation until all three are.
  Scenario: All dependencies failing results in fully degraded report
    Given the database is unavailable
    And the Kafka consumer has been shut down
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
  # The response carries only the documented keys. Extra keys could
  # leak undocumented internal state (stack traces, hostnames, credentials).

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

  # ── Probe freshness ────────────────────────────────────────────────────────
  # Each request pings MySQL again. An orchestrator must see an instance leave rotation as soon as
  # the database goes away, and come back as soon as it returns - a cached or latched result would
  # keep a dead instance in rotation, or a recovered one out of it.

  Scenario: A healthy result is not reused once the database goes away
    Given the database answers the first health probe and fails the next one
    When I request the health check
    Then the response status should be 200
    And a second health check should answer 503 with:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | ok       |

  Scenario: The instance reports healthy again as soon as the database recovers
    Given the database fails the first health probe and answers the next one
    When I request the health check
    Then the response status should be 503
    And a second health check should answer 200 with:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  # ── What the Kafka probe actually checks ───────────────────────────────────
  # isConsumerConnected() is `consumer !== null`. startConsumer() assigns the consumer before it
  # connects or subscribes, and main() in src/index.ts logs and swallows a failed start, so an
  # instance whose consumer never started still reports Kafka as ok and stays in rotation.
  # This scenario pins that current behaviour: it is a production bug (the instance consumes
  # nothing while /health answers 200), not the intended contract. A fix fails this scenario.

  Scenario: An instance whose Kafka consumer failed to start still reports Kafka as healthy
    Given a subscriber "Order Service" with ID 1 listens for topic "orders" at URL "https://orders.example.com/hook"
    And subscribing the Kafka consumer to a topic fails
    And the instance has run its Kafka consumer startup
    When I request the health check
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |
    And the startup subscription to topic "orders" should have been attempted and failed [kafka-subscribe]

  # Same bug one step earlier: the consumer is assigned before connect(), so a broker it never reached
  # still reads as connected, and startup stops before subscribing to anything.
  Scenario: An instance whose Kafka consumer could not connect still reports Kafka as healthy
    Given a subscriber "Order Service" with ID 1 listens for topic "orders" at URL "https://orders.example.com/hook"
    And the Kafka consumer cannot connect to the broker
    And the instance has run its Kafka consumer startup
    When I request the health check
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |
    And the Kafka consumer should never have subscribed to topic "orders"

  # Same bug one step later: the subscription succeeds and run() rejects. KafkaJS's run() resolves on a failed group
  # join (its runner restarts in the background) and rejects only when the crash-time disconnect throws, so this
  # is the rare arm; it still leaves an instance consuming nothing while /health answers 200.
  Scenario: An instance whose Kafka consumer failed to run still reports Kafka as healthy
    Given a subscriber "Order Service" with ID 1 listens for topic "orders" at URL "https://orders.example.com/hook"
    And starting the Kafka consumer fails
    And the instance has run its Kafka consumer startup
    When I request the health check
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |
    And the startup run of the Kafka consumer on topic "orders" should have been attempted and failed [kafka-subscribe, kafka-run]

  # The shutdown path (stopConsumer) leaves the group before disconnecting and drops the consumer,
  # which is the one production state in which the Kafka probe reports an error.
  Scenario: Kafka is reported down once a consuming instance has shut its consumer down
    Given a subscriber "Order Service" with ID 1 listens for topic "orders" at URL "https://orders.example.com/hook"
    And the instance has run its Kafka consumer startup
    And the Kafka consumer has been shut down
    When I request the health check
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | ok       |
      | kafka  | error    |
      | flags  | ok       |
    And the consumer should have subscribed to topic "orders", run, and then stopped [kafka-subscribe, kafka-run]

  # ── HEAD probe on a degraded instance ──────────────────────────────────────
  # HEAD runs the same handler as GET (Express derives it), so every probe runs and the status
  # line alone carries the verdict. A HEAD-probing load balancer must see 503.

  Scenario Outline: A HEAD probe sees a degraded instance through the status line alone (<dependency> down)
    Given the <dependency> health dependency is down
    When I send a HEAD request to the health endpoint
    Then the response status should be 503
    And the response body should be empty

    Examples:
      | dependency |
      | mysql      |
      | kafka      |
      | flags      |

  # ── Protocol surface ───────────────────────────────────────────────────────

  # Express answers OPTIONS itself from the routes registered on the path.
  Scenario: OPTIONS on the health check advertises only GET and HEAD
    When I send an OPTIONS request to the health check endpoint
    Then the response status should be 200
    And the allowed methods should be advertised as "GET,HEAD"

  # Express routing is case-insensitive and ignores a trailing slash by default, so probe paths
  # configured either way reach the same handler.
  Scenario Outline: Health check path variants reach the probe (<path>)
    When I request the health check at path "<path>"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

    Examples:
      | path     |
      | /health/ |
      | /HEALTH  |

  Scenario: Health check ignores a well-formed JSON body
    When I request the health check with a well-formed JSON body
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  # express.json() is mounted before every route, so a bad body is refused before /health runs
  # its probes: the answer is 400, not the 503 a down database would otherwise produce.
  Scenario: A malformed body is refused with 400 even while the database is down
    Given the database is unavailable
    When I request the health endpoint with a malformed JSON body
    Then the response status should be 400

  # The body parser also runs before routing, so a mutation method with a bad body is refused
  # with the parser's 4xx, not the 404 the same method gets with no body.
  Scenario Outline: A <method> with a <body> JSON body is refused with <status> instead of the usual answer for that method
    When I send a <method> request with a <body> JSON body to the health check endpoint
    Then the response status should be <status>

    Examples:
      | method  | body      | status |
      | POST    | malformed | 400    |
      | PUT     | malformed | 400    |
      | PATCH   | malformed | 400    |
      | DELETE  | malformed | 400    |
      | POST    | oversized | 413    |
      | PUT     | oversized | 413    |
      | PATCH   | oversized | 413    |
      | DELETE  | oversized | 413    |
      | HEAD    | malformed | 400    |
      | OPTIONS | malformed | 400    |
      | HEAD    | oversized | 413    |
      | OPTIONS | oversized | 413    |

  # body-parser also decodes Content-Encoding before routing: it inflates gzip and applies the 100kb limit to the
  # inflated size, refuses gzip it can't inflate, and refuses an encoding it doesn't support with 415.
  Scenario Outline: A <method> whose JSON body is <body> is refused with <status> instead of the probe's answer
    When I send a <method> request to the health check endpoint whose JSON body is "<body>"
    Then the response status should be <status>

    Examples:
      | method  | body                       | status |
      | GET     | a gzip bomb                | 413    |
      | GET     | not really gzip            | 400    |
      | GET     | in an unsupported encoding | 415    |
      | HEAD    | a gzip bomb                | 413    |
      | HEAD    | not really gzip            | 400    |
      | HEAD    | in an unsupported encoding | 415    |
      | POST    | a gzip bomb                | 413    |
      | POST    | not really gzip            | 400    |
      | POST    | in an unsupported encoding | 415    |
      | PUT     | a gzip bomb                | 413    |
      | PUT     | not really gzip            | 400    |
      | PUT     | in an unsupported encoding | 415    |
      | PATCH   | a gzip bomb                | 413    |
      | PATCH   | not really gzip            | 400    |
      | PATCH   | in an unsupported encoding | 415    |
      | DELETE  | a gzip bomb                | 413    |
      | DELETE  | not really gzip            | 400    |
      | DELETE  | in an unsupported encoding | 415    |
      | OPTIONS | a gzip bomb                | 413    |
      | OPTIONS | not really gzip            | 400    |
      | OPTIONS | in an unsupported encoding | 415    |

  Scenario Outline: A <method> with a well-formed JSON body gets the same <status> as it does without one
    When I send a <method> request with a well-formed JSON body to the health check endpoint
    Then the response status should be <status>

    Examples:
      | method  | status |
      | HEAD    | 200    |
      | OPTIONS | 200    |
      | POST    | 404    |
      | PUT     | 404    |
      | PATCH   | 404    |
      | DELETE  | 404    |

  # Neither the Dockerfile nor docker-compose.yml sets NODE_ENV, so Express's final handler runs in
  # development mode in production and renders the error's stack trace, with absolute file paths.
  # This pins that current behaviour: it is an information leak, not the intended contract.
  # https://expressjs.com/en/advanced/best-practice-performance.html#set-node_env-to-production
  Scenario: A malformed request body is answered with an error page that exposes a stack trace
    When I request the health endpoint with a malformed JSON body
    Then the response status should be 400
    And the error page should expose the JSON parser stack trace

  # ── Static files and the SPA catch-all ─────────────────────────────────────
  # They live here because no other feature owns them and /health shares their middleware chain.
  # The response status differs between the harness (no dist/public, so the catch-all 404s) and
  # production (the catch-all serves index.html with 200), so the traversal scenario asserts only
  # what must hold in both: nothing outside the public directory is served.

  Scenario: An encoded path traversal does not serve files from outside the public directory
    When I request the repository manifest through an encoded path traversal
    Then the repository manifest should not have been served

  # The SPA catch-all is GET-only, so an unknown API path gets Express's own 404 for any other
  # method - an API client sees a refusal rather than the React app's HTML.
  Scenario: A POST to an unknown API path is refused with 404
    When I send a POST request to an API path that does not exist
    Then the response status should be 404
    And the request should be refused with Express's own 404 page

  # ── Query strings the handler never reads ──────────────────────────────────
  # Express parses the query string (qs) before the handler runs, including arrays, nested keys and
  # __proto__. None of it may change or mask the verdict.

  Scenario Outline: Health check ignores a query string shaped like a verdict or a parser attack (<kind>)
    When I request the health check with query parameter "<query>"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

    Examples:
      | kind                | query                       |
      | repeated key        | debug=1&debug=2&debug[]=3   |
      | forged status       | status=degraded&mysql=error |
      | prototype pollution | __proto__[status]=degraded  |
      | malformed escape    | debug=%E0%A4%A              |
      | null byte           | debug=%00                   |
      | deeply nested keys  | a[b][c][d][e][f][g]=1       |

  Scenario: A query string cannot mask a failing dependency
    Given the database is unavailable
    When I request the health check with query parameter "status=ok&mysql=ok"
    Then the response status should be 503
    And the health check response should be:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | ok       |

  # res.json() does no content negotiation: a probe that asks for HTML or XML still gets JSON.
  Scenario Outline: The Accept header does not change the answer (<accept>)
    When I request the health check accepting only "<accept>"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

    Examples:
      | accept          |
      | text/html       |
      | application/xml |
      | */*             |

  # ── Concurrent probes ──────────────────────────────────────────────────────
  # Several orchestrators and load balancers probe at once; every one gets the same verdict. These pin agreement
  # only, not that each request pings on its own: fake-db records no reads, and a shared in-flight ping would
  # still answer every caller correctly. That a later probe pings again is pinned under "Probe freshness".

  Scenario: Concurrent probes on a healthy instance all answer healthy
    When I request the health check 20 times concurrently
    Then every concurrent health check should answer 200 with:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  Scenario: Concurrent probes on a degraded instance all answer degraded
    Given the database is unavailable
    When I request the health check 20 times concurrently
    Then every concurrent health check should answer 503 with:
      | status | degraded |
      | mysql  | error    |
      | kafka  | ok       |
      | flags  | ok       |

  # ── Credentials and headers the probe never reads ──────────────────────────
  # /health is unauthenticated, so a stale or revoked credential, a hostile Host or a proxy chain must not
  # turn the probe into a refusal that takes a healthy instance out of rotation.

  Scenario Outline: Health check ignores the <header> header (<kind>)
    When I request the health check with the header "<header>" set to "<value>"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

    Examples:
      | kind                | header          | value                |
      | expired credentials | Authorization   | Bearer expired.token |
      | revoked session     | Cookie          | session=revoked      |
      | spoofed host        | Host            | evil.example.com     |
      | proxy chain         | X-Forwarded-For | 10.0.0.1, 10.0.0.2   |

  # ── Request bodies the JSON parser accepts, refuses or skips ───────────────
  # express.json() runs in strict mode and only for JSON content types, so what the probe sees depends on the label.

  Scenario Outline: A probe's body shape decides whether the parser lets it through (<body>: <status>)
    When I send a GET request to the health check endpoint whose body is "<body>"
    Then the response status should be <status>

    Examples:
      | body                            | status |
      | empty                           | 200    |
      | a bare number                   | 400    |
      | a bare string                   | 400    |
      | plain text labelled text/plain  | 200    |
      | labelled with a Latin-1 charset | 415    |

  Scenario: A __proto__ key in the JSON body cannot rewrite the verdict
    When I send a GET request to the health check endpoint whose body is "a __proto__ key"
    Then the response status should be 200
    And the health check response should be:
      | status | ok |
      | mysql  | ok |
      | kafka  | ok |
      | flags  | ok |

  # ── Query string length ────────────────────────────────────────────────────
  # Node's HTTP server answers 431 once the request line and headers pass its 16 KiB default (neither the harness nor
  # production raises it), before Express sees the request. A probe URL with a long cache-buster has that much room.
  # https://nodejs.org/api/http.html#httpmaxheadersize

  Scenario Outline: A probe with a <length>-character query string answers <status>
    When I request the health check with a query string of <length> characters
    Then the response status should be <status>

    Examples:
      | length | status |
      | 10000  | 200    |
      | 20000  | 431    |

  # ── OPTIONS is no health signal ────────────────────────────────────────────
  # Express answers OPTIONS from the route table without running the probes, so a load balancer configured to probe
  # with OPTIONS keeps a degraded instance in rotation.

  Scenario: An OPTIONS probe answers 200 even while the database is down
    Given the database is unavailable
    When I send an OPTIONS request to the health check endpoint
    Then the response status should be 200
    And the allowed methods should be advertised as "GET,HEAD"

  # ── Conditional probes ─────────────────────────────────────────────────────
  # res.json() sets an ETag, so a client that replays it with If-None-Match is revalidated. A cached
  # "healthy" must never mask a dependency that has since failed.

  Scenario: A conditional probe on an unchanged healthy instance is revalidated
    When I request the health check
    Then a conditional health check using the first answer's ETag should answer 304

  Scenario: A conditional probe cannot reuse a healthy answer once the database goes away
    Given the database answers the first health probe and fails the next one
    When I request the health check
    Then the response status should be 200
    And a conditional health check using the first answer's ETag should answer 503
