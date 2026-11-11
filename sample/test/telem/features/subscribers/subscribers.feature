Feature: Manage webhook subscribers
  Operators register, list and remove the HTTP endpoints that receive a Kafka topic's messages. A registration
  is persisted first and only then handed to the Kafka consumer, without waiting for it: the consumer can take a
  second to restart, and the subscriber already exists. The API has no authentication by design (sample scope).

  # Design decisions these scenarios pin (fire-and-forget subscribe, no dynamic unsubscription, no ORM, raw SQL
  # behind a repository): see "Architecture decisions that are intentional" and "Known limitations" in CLAUDE.md.

  # ── List subscribers ──────────────────────────────────────────────────────────

  Scenario: Listing returns an empty array when no subscribers are registered
    When I list all subscribers
    Then the response status should be 200
    And the subscriber list should be empty

  # ── Register a subscriber ─────────────────────────────────────────────────────

  Scenario: Register a webhook subscriber for a topic
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: Register a subscriber with custom delivery headers
    When I register subscriber "Signed Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X-Signature-Token | secret-abc123 |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Remove a subscriber ───────────────────────────────────────────────────────

  Scenario: Remove a registered subscriber
    Given a subscriber "Payments Service" with ID 5 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I delete subscriber 5
    Then the response status should be 204
    And subscriber 5 should have been removed [subscriber-delete]

  # ── Validation failures ───────────────────────────────────────────────────────

  Scenario Outline: Registration is rejected when a required field is missing
    When I attempt to register a subscriber without the <field> field
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

    Examples:
      | field |
      | name  |
      | topic |
      | url   |

  # http:// and https:// are both whitelisted — test each protocol explicitly.
  # A change from 'http:' || 'https:' to just 'https:' would only be caught if http:// is tested.
  Scenario: Register a subscriber for a plain HTTP endpoint
    When I register subscriber "Internal Service" for topic "orders" at URL "http://internal.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: Registration is rejected for a non-HTTP or non-HTTPS URL
    When I register subscriber "Payments Service" for topic "orders" at URL "ftp://payments.example.com/hook"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  # express.json() rejects before the route handler runs; the response body is
  # Express's default HTML error page, not our { error: "..." } JSON shape, so the
  # observable outcome we own is the absence of a persisted subscriber (the ownership
  # net enforces it) rather than coupling to Express's default error body.
  Scenario: Registration is rejected for malformed JSON
    When I send a malformed JSON body to register a subscriber
    Then the response status should be 400
    And no subscriber should have been persisted

  Scenario: Deletion is rejected for a non-numeric subscriber ID
    When I attempt to delete subscriber with ID "not-a-number"
    Then the response status should be 400
    And the error response body should be "Invalid id"

  Scenario: API safely handles deletion of a non-existent subscriber
    When I delete subscriber 999
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 999 found no matching subscriber [subscriber-delete]

  # ── Database failures with data present ──────────────────────────────────────
  # A route's database failure is handled the same whether or not rows exist; these pin that a
  # populated table fails the same way, so the axes stay independent.

  Scenario: Database failure when listing returns internal server error even when subscribers exist
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the database is unavailable
    When I list all subscribers
    Then the response status should be 500
    And the error response body should be "Internal server error"

  Scenario: Database failure when removing an existing subscriber returns internal server error
    Given a subscriber "Payments Service" with ID 5 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the database is unavailable
    When I delete subscriber 5
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the delete of subscriber 5 should have been attempted and failed with "Connection refused" [subscriber-delete]

  # ── Infrastructure failures ────────────────────────────────────────────────────

  Scenario: Database failure when listing subscribers returns internal server error
    Given the database is unavailable
    When I list all subscribers
    Then the response status should be 500
    And the error response body should be "Internal server error"

  Scenario: Database failure when registering a subscriber returns internal server error
    Given the database is unavailable
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and failed with "Connection refused" [subscriber-insert]

  Scenario: Database failure when removing a subscriber returns internal server error
    Given the database is unavailable
    When I delete subscriber 1
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the delete of subscriber 1 should have been attempted and failed with "Connection refused" [subscriber-delete]

  # ── Empty-string vs. missing field ───────────────────────────────────────────
  # A missing field and an empty-string field are different code paths.
  # A validator that checks `if (!body.name)` catches both; one that checks
  # `if (body.name === undefined)` only catches missing. Test each explicitly.

  Scenario Outline: Registration is rejected when a required field is an empty string
    When I register subscriber "<name>" for topic "<topic>" at URL "<url>"
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

    Examples:
      | name             | topic  | url                               |
      |                  | orders | https://payments.example.com/hook |
      | Payments Service |        | https://payments.example.com/hook |
      | Payments Service | orders |                                   |

  # Whitespace-only strings are truthy in JS (`!("   ")` is false), so they pass
  # the `if (!name || !topic || !url)` guard and are accepted. This documents the
  # permissive behavior; a future trim-and-recheck change would make these fail.
  Scenario: Registration accepts a whitespace-only name as submitted
    When I register subscriber "   " for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # A whitespace-only topic is not a legal Kafka topic name either: the broker rejects the subscribe, which stops
  # the consumer (see "A failed subscribe leaves the Kafka consumer stopped…"). Not visible here, the 201 is.
  Scenario: Registration accepts a whitespace-only topic as submitted
    When I register subscriber "Payments Service" for topic "   " at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Injection and special characters stored literally ─────────────────────────
  # SQL-special chars, XSS payloads, and path-traversal sequences reach the repository and the response
  # without sanitization. The fake repository never runs SQL, so these do not show SQL-injection safety:
  # binding is checked by fake-db.parity.ts § "Parameter binding: SQL-special characters". Topics with these characters are illegal Kafka topic names, so in production their
  # subscribe fails and stops the consumer (see "A failed subscribe leaves the Kafka consumer stopped…").

  Scenario Outline: Special characters in subscriber fields are stored and returned literally
    When I register subscriber "<name>" for topic "<topic>" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the subscriber should have been stored and returned with name "<name>" and topic "<topic>" [subscriber-insert, post-response]

    Examples:
      | name                          | topic                               |
      | '; DROP TABLE subscribers; -- | orders                              |
      | Payments Service              | orders'; DROP TABLE subscribers; -- |
      | <script>alert('xss')</script> | orders                              |
      | Traversal Service             | ../../etc/passwd                    |

  # ── URL protocol edge cases ───────────────────────────────────────────────────

  Scenario: Registration is rejected for a javascript: URL
    When I register subscriber "Payments Service" for topic "orders" at URL "javascript:alert(1)"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  Scenario: Registration is rejected for a data: URI
    When I register subscriber "Payments Service" for topic "orders" at URL "data:text/html,<h1>hi</h1>"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  Scenario: Registration is accepted for a URL with no path component
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: Registration is accepted for a URL pointing to localhost
    When I register subscriber "Local Service" for topic "orders" at URL "http://localhost:8080/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Duplicate registration ────────────────────────────────────────────────────
  # No unique constraint — a second POST with identical data creates a second independent
  # entry rather than returning a conflict or the existing subscriber.

  Scenario: Registering the same subscriber data twice creates two independent entries
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And both subscribers should appear in the list

  # parseInt('1.5', 10) === 1 (not NaN), so the float passes the isNaN() guard
  # and the handler queries the DB for id=1. No such subscriber exists, so 404.
  Scenario: Deletion with a floating-point subscriber ID returns not found
    When I attempt to delete subscriber with ID "1.5"
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 1 found no matching subscriber [subscriber-delete]

  Scenario: Deleting subscriber with ID zero returns not found
    When I delete subscriber 0
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 0 found no matching subscriber [subscriber-delete]

  # ── Unicode and special characters ───────────────────────────────────────────

  Scenario: Subscriber name with Unicode characters is stored and returned correctly
    When I register subscriber "支払いサービス 🎉" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: Topic name with hyphens and dots is accepted
    When I register subscriber "Payments Service" for topic "order.placed-v2" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Whitespace-only URL ───────────────────────────────────────────────────────
  # Unlike whitespace-only name/topic (which pass the !field guard and are stored),
  # URL has a protocol format check. "   " is truthy so passes !url, but fails
  # the http/https check → 400. Documents this asymmetry explicitly.

  Scenario: Registration is rejected for a whitespace-only URL
    When I register subscriber "Payments Service" for topic "orders" at URL "   "
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  # ── file:// URL ───────────────────────────────────────────────────────────────

  Scenario: Registration is rejected for a file:// URL
    When I register subscriber "Payments Service" for topic "orders" at URL "file:///etc/passwd"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  # ── URL with no host ──────────────────────────────────────────────────────────
  # "https://" is technically scheme-only; new URL() will throw on it.

  Scenario: Registration is rejected for a URL with no host
    When I register subscriber "Payments Service" for topic "orders" at URL "https://"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

  # ── URL with query string ─────────────────────────────────────────────────────

  Scenario: Registration is accepted for a URL with a query string
    When I register subscriber "Analytics Service" for topic "orders" at URL "https://analytics.example.com/hook?source=webhooks&env=prod"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Multiple custom headers ───────────────────────────────────────────────────

  Scenario: Register a subscriber with multiple custom delivery headers
    When I register subscriber "Signed Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X-Signature-Token | secret-abc123    |
      | X-Tenant-ID       | tenant-42        |
      | Authorization     | Bearer sometoken |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Custom header with empty value ────────────────────────────────────────────

  Scenario: Register a subscriber with a custom header that has an empty value
    When I register subscriber "Minimal Endpoint" for topic "orders" at URL "https://minimal.example.com/hook" with headers:
      | X-Empty-Header |  |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Very long name ────────────────────────────────────────────────────────────
  # A 500-character name exceeds the `name` column (VARCHAR(255)). MySQL's strict mode rejects it
  # (ER_DATA_TOO_LONG) and the API has no length validation, so the client gets a 500 (see fake-db.parity.ts).

  Scenario: Subscriber registration with an overlong name fails with internal server error
    When I register subscriber "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'name' at row 1" [subscriber-insert]

  # ── Negative subscriber ID ────────────────────────────────────────────────────
  # parseInt("-1", 10) is -1; isNaN(-1) is false so it passes the guard and hits
  # the DB. No subscriber with id=-1 exists → 404, same path as zero and floats.

  Scenario: Deleting subscriber with a negative ID returns not found
    When I attempt to delete subscriber with ID "-1"
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber -1 found no matching subscriber [subscriber-delete]

  # ── Very large subscriber ID ──────────────────────────────────────────────────

  Scenario: Deleting subscriber with a very large ID returns not found
    When I delete subscriber 9999999
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 9999999 found no matching subscriber [subscriber-delete]

  # ── Delete removes subscriber from subsequent list ────────────────────────────

  Scenario: Deleted subscriber no longer appears in the list
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I delete subscriber 1
    And I list all subscribers
    Then the response status should be 200
    And the subscriber list should be empty
    And subscriber 1 should have been removed [subscriber-delete]

  # ── Null field value ──────────────────────────────────────────────────────────
  # null is falsy; !null is true — the same guard that catches missing fields
  # should also catch explicit nulls.

  Scenario Outline: Registration is rejected when a required field is null
    When I register a subscriber with a null <field>
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

    Examples:
      | field |
      | name  |
      | topic |
      | url   |

  # ── Additional accepted URL formats ──────────────────────────────────────────
  # URL validation checks protocol only. Fragments, embedded credentials, IPv4
  # hosts, non-standard ports, and uppercase protocol (lowercased by new URL())
  # are all accepted and stored as submitted.

  Scenario Outline: Registration is accepted for URLs with varied format components
    When I register subscriber "Test Service" for topic "orders" at URL "<url>"
    Then the response status should be 201
    And the subscriber should have been stored and returned with URL "<url>" [subscriber-insert, post-response]

    Examples:
      | url                                       |
      | https://analytics.example.com/hook#events |
      | https://user:secret@example.com/hook      |
      | http://192.168.1.100/hook                 |
      | https://staging.example.com:8443/hook     |
      | HTTPS://example.com/hook                  |

  # ── Very long topic ───────────────────────────────────────────────────────────
  # A 500-character topic exceeds the `topic` column (VARCHAR(255)). MySQL's strict mode rejects it
  # (ER_DATA_TOO_LONG) and the API has no length validation, so the client gets a 500 (see fake-db.parity.ts).

  Scenario: Subscriber registration with an overlong topic fails with internal server error
    When I register subscriber "Payments Service" for topic "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT" at URL "https://payments.example.com/hook"
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'topic' at row 1" [subscriber-insert]

  # ── Subscriber ID with leading zeros ─────────────────────────────────────────
  # parseInt("007", 10) is 7 — the leading zeros are consumed. No subscriber with
  # id=7 exists, so the DB returns nothing and the handler returns 404.

  Scenario: Deletion with a zero-padded subscriber ID returns not found
    When I attempt to delete subscriber with ID "007"
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 7 found no matching subscriber [subscriber-delete]

  # ── Extra unknown fields in registration body are ignored ─────────────────────
  # The handler destructures known fields; unknown extras should have no effect.

  Scenario: Registration ignores unknown fields in the request body
    When I register a subscriber with extra unknown fields
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── SQL metacharacters in a custom header name ────────────────────────────────
  # Pins only that the key reaches the repository and the response unchanged. The fake never runs SQL;
  # binding of the JSON-encoded headers is checked by fake-db.parity.ts § "Parameter binding: SQL-special characters".

  Scenario: A custom header name containing SQL metacharacters is stored and returned literally
    When I register subscriber "Injection Service" for topic "orders" at URL "https://payments.example.com/hook" with headers:
      | '; DROP TABLE subscribers; -- | safe-value |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Topic with a space ────────────────────────────────────────────────────────
  # A space-containing topic is truthy (passes !topic), passes URL validation
  # (topic is not part of the URL), so it should be accepted as submitted. A space is an illegal Kafka topic
  # name, so in production the subscribe fails and stops the consumer (see "A failed subscribe leaves the Kafka
  # consumer stopped…").

  Scenario: Registration accepts a topic name containing a space
    When I register subscriber "Payments Service" for topic "order placed" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Kafka consumer subscription ───────────────────────────────────────────────
  # A registration persists the subscriber and then, WITHOUT awaiting it, asks the Kafka consumer to take the
  # topic (src/kafka/consumer.ts): KafkaJS cannot subscribe while a consumer is running, so a running consumer is
  # stopped, the topic subscribed, and the consumer run again. Every scenario above is held to the expected
  # lifecycle by the "Kafka consumer subscribes to each newly registered topic" auto-default; the scenarios
  # below pin the cases where it matters what happens, and take over from that default.

  Scenario: Registering a subscriber on a new topic subscribes the Kafka consumer to it
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  # The consumer is already subscribed to "orders" for the whole consumer group, whoever registered it;
  # subscribing again would also fail in KafkaJS, because the consumer is running by then.
  Scenario: A second subscriber on a topic the consumer already has does not subscribe again
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "orders" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "orders" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  Scenario: Registering a subscriber on another topic restarts the Kafka consumer to take it
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "transactions" once
    And the Kafka consumer should have been started and then restarted to consume topics "orders" and "transactions" [kafka-subscribe, kafka-run]

  # subscribeToTopic chains every subscribe onto a lock (subscribeLock). Registrations that arrive together
  # must therefore take the consumer through stop → subscribe → run one after the other; without the lock the
  # second would subscribe while the first was still mid-restart.
  Scenario: Registrations arriving at the same time are subscribed one after the other
    When I register subscribers for topics "orders" and "transactions" at the same time
    Then both registrations should have succeeded
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "transactions" once
    And the Kafka consumer should have been started and then restarted to consume topics "orders" and "transactions" [kafka-subscribe, kafka-run]

  # The subscribe is fire-and-forget (the subscriber is already persisted when it runs); a failure is only logged,
  # so the caller still gets its 201. Any broker error looks like this to production — injected here.
  Scenario: A failing Kafka subscribe does not fail the registration
    Given subscribing the Kafka consumer to a topic fails
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And the Kafka consumer subscription to topic "orders" should have failed

  # Pinned as the observable consequence of the current code, not as an endorsement: when re-subscribing, the
  # running consumer is stopped BEFORE the subscribe, and nothing runs it again if the subscribe fails. Every
  # topic already subscribed stops being consumed until some later registration subscribes successfully.
  # Production can reach this with user input alone: the API only checks that the topic is non-empty, but a
  # broker rejects names outside letters, digits, '.', '_' and '-' (INVALID_TOPIC_EXCEPTION), so registering
  # "order placed" returns 201 and silently stops consumption for every other topic. Fixing it (validate the
  # topic at the API, or run the consumer again after a failed subscribe) is a production change, not made here.
  Scenario: A failed subscribe leaves the Kafka consumer stopped until a later registration succeeds
    Given subscribing the Kafka consumer to a topic fails for the second registration only
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    And I register subscriber "Refund Service" for topic "refunds" at URL "https://refunds.example.com/hook"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the subscriber registered at URL "https://refunds.example.com/hook" should have been stored for topic "refunds" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer subscription to topic "transactions" should have failed
    And the Kafka consumer should have subscribed to topic "refunds" once
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics          | outcome   |
      | start  | orders          | succeeded |
      | stop   |                 | succeeded |
      | start  | orders, refunds | succeeded |

  # Reachability of a rejecting run() (KafkaJS 2.2.4: consumer/index.js run(), consumer/runner.js start()): a failed
  # connect or group join does NOT reject run(). Runner.start() catches it and calls onCrash, which disconnects and
  # restarts later if the error is retriable; run() resolves either way. run() rejects only if that crash-time
  # disconnect throws. These scenarios inject the rejection ("starting the Kafka consumer fails"), so they pin
  # consumer.ts's handling of it, not a common broker failure.
  # The registration is persisted and answered before the consumer is touched, so a consumer that cannot start
  # costs the new topic its consumption (it is subscribed, but nothing runs) and nothing else.
  Scenario: A Kafka consumer that fails to start does not fail the registration
    Given starting the Kafka consumer fails
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have failed to start consuming topic "orders"

  # The consumer is stopped BEFORE the subscribe, so when the stop throws the subscribe is never attempted:
  # the new topic is not subscribed at all, and the consumer is left running on the topics it already had.
  Scenario: A running Kafka consumer that fails to stop is not asked to subscribe the new topic
    Given stopping the Kafka consumer fails
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics | outcome   |
      | start  | orders | succeeded |
      | stop   |        | failed    |

  # ── Framework-owned protocol surface on /api/subscribers ───────────────────────
  # express.json() rejects a malformed or oversized body before the list handler runs;
  # Express auto-derives HEAD from GET /api/subscribers; an unregistered method falls
  # through to a 404. These are app-wide behaviors reachable on this endpoint.

  Scenario: Listing subscribers rejects a malformed JSON body
    When I request the subscribers endpoint with a malformed JSON body
    Then the response status should be 400

  Scenario: Listing subscribers rejects an oversized JSON body
    When I request the subscribers endpoint with an oversized JSON body
    Then the response status should be 413

  Scenario: HEAD request to the subscribers list returns no body
    When I send a HEAD request to the subscribers endpoint
    Then the response status should be 200
    And the response body should be empty

  Scenario: Unsupported method on the subscribers endpoint is rejected
    When I send an unsupported PUT request to the subscribers endpoint
    Then the response status should be 404
    And no subscriber should have been persisted

  # A registration body express.json() rejects as too large never reaches the handler, so nothing is stored.
  Scenario: An oversized registration body is rejected without storing a subscriber
    When I send an oversized JSON body to register a subscriber
    Then the response status should be 413
    And no subscriber should have been persisted

  # express.json() is the only body parser: a form post or a non-object JSON body leaves the handler with no
  # fields, so it is answered as a registration missing all three, not as a parse error.
  Scenario: A form-encoded registration is rejected as missing its required fields
    When I register a subscriber with a form-encoded body
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

  Scenario: A JSON array sent as a registration is rejected as missing its required fields
    When I send a JSON array to register a subscriber
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

  # ── Validation order ──────────────────────────────────────────────────────────
  # The required-field check runs before the URL check, so a request that fails both is told about the
  # missing field.
  Scenario: A registration missing its topic and carrying a non-HTTP URL gets the missing-field error
    When I register subscriber "Payments Service" for topic "" at URL "ftp://payments.example.com/hook"
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

  # ── Field shapes the handler stores as given ─────────────────────────────────
  # A JSON body that names a field twice is parsed by JSON.parse, which keeps the last value.
  Scenario: A registration body that names a field twice stores the last value
    When I register a subscriber whose body gives the name twice, first "Payments Service" and then "Audit Logger"
    Then the response status should be 201
    And the subscriber should have been stored and returned with name "Audit Logger" [subscriber-insert, post-response]

  # The WHATWG URL parser ignores leading and trailing spaces, so a padded URL passes validation; the handler
  # stores the string it was given, spaces included.
  Scenario: A URL with surrounding spaces is accepted and stored with its spaces
    When I register subscriber "Payments Service" for topic "orders" at URL "  https://payments.example.com/hook  "
    Then the response status should be 201
    And the subscriber should have been stored and returned with URL "  https://payments.example.com/hook  " [subscriber-insert, post-response]

  Scenario: A registration with headers set to null is stored with no delivery headers
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook" with headers set to null
    Then the response status should be 201
    And the subscriber should have been stored and returned with no delivery headers [subscriber-insert, post-response]

  Scenario: A registration with an empty headers object is stored with no delivery headers
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook" with an empty headers object
    Then the response status should be 201
    And the subscriber should have been stored and returned with no delivery headers [subscriber-insert, post-response]

  # Header names are stored as JSON object keys, which are case-sensitive, so two names that differ only in
  # case are both kept. (HTTP header names are case-insensitive: what delivery does with the pair is the
  # delivery flow's concern.)
  Scenario: Delivery header names that differ only in case are both stored
    When I register subscriber "Signed Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X-Signature-Token | first-value  |
      | x-signature-token | second-value |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Column limits ─────────────────────────────────────────────────────────────
  # name and topic are VARCHAR(255) and url is VARCHAR(2048), counted in characters. The API does not check
  # lengths, so a value at the limit is stored and one past it is a MySQL error the client sees as a 500.
  Scenario Outline: A <field> at its maximum length is accepted
    When I register a subscriber whose <field> is <limit> characters long
    Then the response status should be 201
    And the subscriber should have been stored and returned with a <limit>-character <field> [subscriber-insert, post-response]

    Examples:
      | field | limit |
      | name  | 255   |
      | url   | 2048  |

  # The column takes 255 characters, but a Kafka topic name stops at 249, so a topic at the column limit is stored
  # and its subscribe is refused: its subscriber never receives a message.
  Scenario: A 255-character topic is stored but never subscribed
    When I register a subscriber whose topic is 255 characters long
    Then the response status should be 201
    And the subscriber should have been stored and returned with a 255-character topic [subscriber-insert, post-response]
    And the Kafka consumer subscription to the 255-character topic should have failed

  Scenario: A URL one character past its maximum length fails with internal server error
    When I register a subscriber whose url is 2049 characters long
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'url' at row 1" [subscriber-insert]

  # ── Repeated requests ─────────────────────────────────────────────────────────
  # Nothing deduplicates a registration: a client that retries a POST it did not see answered gets a second
  # subscriber (and so a second delivery of every message). The consumer subscribes the topic once.
  Scenario: A client retrying the same registration gets a second, separate subscriber
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook" twice
    Then both registrations should have been stored as separate subscribers with IDs 1 and 2 [subscriber-insert, post-response]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  Scenario: Deleting the same subscriber twice removes it once and then reports it not found
    Given a subscriber "Payments Service" with ID 5 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I delete subscriber 5 twice
    Then the first deletion of subscriber 5 should have removed it and the second should have found nothing [subscriber-delete]

  # Kafka topic names are case-sensitive and the consumer tracks the exact spelling it subscribed, so "Orders"
  # is a new topic next to "orders". (MySQL's case-insensitive collation matches them as one topic when the
  # delivery flow looks subscribers up.)
  Scenario: Topics that differ only in letter case are subscribed separately
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "Orders" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "Orders" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "Orders" once
    And the Kafka consumer should have been started and then restarted to consume topics "orders" and "Orders" [kafka-subscribe, kafka-run]

  # No dynamic unsubscription (CLAUDE.md, "Known limitations"): removing a topic's last subscriber leaves the
  # consumer subscribed and running until the service restarts.
  Scenario: Removing a topic's only subscriber leaves the Kafka consumer subscribed to it
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I delete subscriber 1
    Then the response status should be 204
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And subscriber 1 should have been removed [subscriber-delete]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  # ── Subscriber id parsing ─────────────────────────────────────────────────────
  # parseInt(id, 10) reads leading digits (after optional spaces and a sign) and ignores the rest, so ids that
  # merely start with a number address that subscriber.
  Scenario Outline: A subscriber id "<id>" addresses subscriber <subscriber>
    Given a subscriber "Payments Service" with ID <subscriber> listens for topic "orders" at URL "https://payments.example.com/hook"
    When I attempt to delete subscriber with ID "<id>"
    Then the response status should be 204
    And subscriber <subscriber> should have been removed [subscriber-delete]

    Examples:
      | id   | subscriber |
      | 12ab | 12         |
      | 1e3  | 1          |
      | 3.9  | 3          |
      | %205 | 5          |
      | +8   | 8          |

  # "0x1A" is read as 0 (parseInt with radix 10 stops at the x), and no subscriber has id 0.
  Scenario: A hexadecimal-looking subscriber id addresses no subscriber
    Given a subscriber "Payments Service" with ID 26 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I attempt to delete subscriber with ID "0x1A"
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber 0 found no matching subscriber [subscriber-delete]

  # ── Listing shape ─────────────────────────────────────────────────────────────
  Scenario: Listed subscribers are ordered by id, whatever order they were stored in
    Given a subscriber "Audit Logger" with ID 3 listens for topic "transactions" at URL "https://audit.example.com/events"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I list all subscribers
    Then the response status should be 200
    And the subscriber list should contain exactly:
      | id | name             | topic        | url                               | headers | created_at               |
      | 1  | Payments Service | orders       | https://payments.example.com/hook | {}      | 2024-01-01T00:00:00.000Z |
      | 3  | Audit Logger     | transactions | https://audit.example.com/events  | {}      | 2024-01-01T00:00:00.000Z |

  Scenario: Listed subscribers include their delivery headers
    Given a subscriber "Signed Endpoint" with ID 1 listens for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X-Signature-Token | secret-abc123 |
      | X-Tenant-ID       | tenant-42     |
    When I list all subscribers
    Then the response status should be 200
    And the subscriber list should contain exactly:
      | id | name            | topic  | url                             | headers                                                         | created_at               |
      | 1  | Signed Endpoint | orders | https://secure.example.com/hook | {"X-Signature-Token":"secret-abc123","X-Tenant-ID":"tenant-42"} | 2024-01-01T00:00:00.000Z |

  # The production route to "A failed subscribe leaves the Kafka consumer stopped…": no injected failure, only
  # a topic name the API accepts and the broker rejects (letters, digits, '.', '_' and '-' only).
  # Pinned as current behaviour, not endorsed: one unauthenticated POST with a bad topic name stops delivery on
  # every topic until a later registration succeeds.
  Scenario: Registering a topic name the broker rejects stops consumption of every topic already subscribed
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "order placed" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "order placed" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer subscription to topic "order placed" should have failed
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics | outcome   |
      | start  | orders | succeeded |
      | stop   |        | succeeded |

  # ── Kafka consumer recovery after a failed call ───────────────────────────────
  # The consumer keeps its own "running" flag, set before run() is awaited and cleared only after stop()
  # succeeds. These pin what that flag makes the next registration do after a failure.
  # The run() failures below are injection-only (see "A Kafka consumer that fails to start…"). A real
  # failed join leaves the flag set too, but run() resolves, so the same sequence follows without a failed run.

  # run() failed, but the flag already says running, so the next registration stops a consumer that never
  # started before subscribing; the restart then consumes both topics.
  Scenario: A consumer that failed to start is started on both topics by the next registration
    Given starting the Kafka consumer fails the first time only
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "transactions" once
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics               | outcome   |
      | start  | orders               | failed    |
      | stop   |                      | succeeded |
      | start  | orders, transactions | succeeded |

  Scenario: A consumer that fails to restart for a new topic stops consuming every topic, including the ones it already had
    Given starting the Kafka consumer fails the second time only
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "transactions" once
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics               | outcome   |
      | start  | orders               | succeeded |
      | stop   |                      | succeeded |
      | start  | orders, transactions | failed    |

  # Pinned as current behaviour, not endorsed: a failed stop skips the subscribe, and the topic is never
  # recorded as subscribed, but nothing retries it. A later registration on another topic restarts the
  # consumer without it, so the skipped topic's subscribers get no messages until the service restarts (or
  # someone registers on that topic again).
  Scenario: A topic skipped by a failed consumer stop stays unconsumed after the consumer recovers
    Given stopping the Kafka consumer fails the first time only
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Audit Logger" for topic "transactions" at URL "https://audit.example.com/events"
    And I register subscriber "Refund Service" for topic "refunds" at URL "https://refunds.example.com/hook"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "transactions" [subscriber-insert]
    And the subscriber registered at URL "https://refunds.example.com/hook" should have been stored for topic "refunds" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should never have subscribed to topic "transactions"
    And the Kafka consumer should have subscribed to topic "refunds" once
    And the Kafka consumer should have been, in order [kafka-subscribe, kafka-run]:
      | action | topics          | outcome   |
      | start  | orders          | succeeded |
      | stop   |                 | failed    |
      | stop   |                 | succeeded |
      | start  | orders, refunds | succeeded |

  # ── One past the name and topic column limits ─────────────────────────────────
  Scenario: A name one character past its maximum length fails with internal server error
    When I register a subscriber whose name is 256 characters long
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'name' at row 1" [subscriber-insert]

  Scenario: A topic one character past its maximum length fails with internal server error
    When I register a subscriber whose topic is 256 characters long
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'topic' at row 1" [subscriber-insert]

  # ── Other URL shapes ──────────────────────────────────────────────────────────
  Scenario Outline: Only http and https endpoints can be registered
    When I register subscriber "Payments Service" for topic "orders" at URL "<url>"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

    Examples:
      | url                           |
      | mailto:ops@example.com        |
      | ws://payments.example.com/ws  |
      | //payments.example.com/hook   |
      | payments.example.com/hook     |
      | https://pay ments.example.com |
      | http://                       |

  Scenario Outline: An http or https endpoint is stored as submitted whatever its host or path encoding
    When I register subscriber "Test Service" for topic "orders" at URL "<url>"
    Then the response status should be 201
    And the subscriber should have been stored and returned with URL "<url>" [subscriber-insert, post-response]

    Examples:
      | url                                |
      | https://payments.example.com/a%20b |
      | https://münchen.example.com/hook   |

  # ── Non-string field types ────────────────────────────────────────────────────
  # Current behaviour, a production bug: `headers` is passed through unvalidated, so a string is stored as a JSON
  # string, and parseRow JSON.parses it again on every read. The registration succeeds; every later listing
  # fails. Matches MySQL 8: fake-db.parity.ts "subscribers.create — non-object headers are stored as JSON; a
  # non-JSON string makes listAll throw". See subscribers.implementation-notes.md § Production behaviours pinned.
  Scenario: A subscriber registered with headers given as a plain string breaks the subscriber listing
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook" with headers set to the string "abc"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And I list all subscribers
    And the response status should be 500
    And the error response body should be "Internal server error"

  Scenario: A non-string URL cannot create a subscriber
    When I register a subscriber whose url is the number 42
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"
    And no subscriber should have been persisted

  # ── Delete id parsing: injection and non-numbers ──────────────────────────────
  # The id is read with parseInt, so trailing SQL is dropped and only the leading number is bound.
  Scenario: Trailing SQL in a subscriber id is dropped and only the leading id is deleted
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Audit Logger" with ID 2 listens for topic "transactions" at URL "https://audit.example.com/events"
    When I attempt to delete subscriber with ID "1 OR 1=1"
    Then the response status should be 204
    And subscriber 1 should have been removed [subscriber-delete]

  Scenario Outline: A subscriber id that does not start with a number is rejected
    When I attempt to delete subscriber with ID "<id>"
    Then the response status should be 400
    And the error response body should be "Invalid id"

    Examples:
      | id       |
      | abc12    |
      | Infinity |
      | NaN      |
      | -        |
      | %20      |

  # ── URL scheme and authority shapes ───────────────────────────────────────────
  # Validation is the WHATWG URL parser plus a protocol check, so the parser's leniency (single slash, no slashes,
  # IPv6 literals) and strictness (port range, unclosed bracket) decide what a merchant can register.
  Scenario Outline: A URL whose scheme or authority is malformed is rejected
    When I register subscriber "Payments Service" for topic "orders" at URL "<url>"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

    Examples:
      | url                                |
      | JaVaScRiPt:alert(1)                |
      | https://example.com:99999/hook     |
      | https://[::1                       |
      | blob:https://example.com/some-uuid |
      | ftp://user@payments.example.com    |

  Scenario Outline: A lenient but valid http or https URL is accepted and stored as submitted
    When I register subscriber "Test Service" for topic "orders" at URL "<url>"
    Then the response status should be 201
    And the subscriber should have been stored and returned with URL "<url>" [subscriber-insert, post-response]

    Examples:
      | url                             |
      | http:/payments.example.com/hook |
      | https:payments.example.com/hook |
      | https://example.com/hook?q=a b  |

  # ── Names and topics with unusual characters ──────────────────────────────────
  # The Hebrew, template and percent-encoded topics are not legal Kafka topic names: they are stored, and their
  # subscribe fails (the subscription auto-default expects exactly that for an illegal name).
  Scenario Outline: Merchant names and topics in any script or with template-like text are not mangled on registration
    When I register subscriber "<name>" for topic "<topic>" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the subscriber should have been stored and returned with name "<name>" and topic "<topic>" [subscriber-insert, post-response]

    Examples:
      | name               | topic     |
      | שירות תשלומים      | הזמנות    |
      | ${jndi:ldap://x/a} | {{7*7}}   |
      | Payments\Service   | orders%00 |
      | 0                  | 0         |
      | false              | null      |

  # ── Delivery header edge cases ────────────────────────────────────────────────
  # Stored, but not deliverable: fetch's Headers rejects "X-Région" (invalid header name) and "café ☕" (a
  # character above 255 is not a ByteString), so every delivery to this subscriber fails. The API validates neither.
  Scenario: Delivery header names and values outside HTTP's character rules are stored as given
    When I register subscriber "Signed Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X-Région | café ☕ |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: Content-Type and Host delivery headers are stored like any other header
    When I register subscriber "Signed Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | Content-Type | text/plain |
      | Host         | evil.test  |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Delete: scope and id range ────────────────────────────────────────────────
  Scenario: Deleting one subscriber leaves the others listed
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Audit Logger" with ID 2 listens for topic "orders" at URL "https://audit.example.com/events"
    When I delete subscriber 1
    And I list all subscribers
    Then the response status should be 200
    And the subscriber list should contain exactly:
      | id | name         | topic  | url                              | headers | created_at               |
      | 2  | Audit Logger | orders | https://audit.example.com/events | {}      | 2024-01-01T00:00:00.000Z |
    And subscriber 1 should have been removed [subscriber-delete]

  Scenario Outline: A subscriber id beyond any real row is not found
    When I attempt to delete subscriber with ID "<id>"
    Then the response status should be 404
    And the error response body should be "Subscriber not found"
    And the attempt to remove subscriber <id> found no matching subscriber [subscriber-delete]

    Examples:
      | id         |
      | 2147483648 |
      | 4294967296 |

  # ── Whitespace, lenient URL parsing and unusual keys ─────
  Scenario: A name with surrounding spaces is stored with its spaces
    When I register subscriber "  Payments Service  " for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the subscriber should have been stored and returned with name "  Payments Service  " [subscriber-insert, post-response]

  # The WHATWG parser reads an IPv4 host that ends in a number strictly (each part must fit its byte), a
  # percent sign is a forbidden host character, a port must be digits, and an empty host is no host.
  Scenario Outline: A URL whose host or port the parser cannot read is rejected
    When I register subscriber "Payments Service" for topic "orders" at URL "<url>"
    Then the response status should be 400
    And the error response body should be "url must be a valid http or https URL"

    Examples:
      | url                          |
      | http://256.256.256.256/hook  |
      | https://exa%mple.com/hook    |
      | https://example.com:abc/hook |
      | http://:80/hook              |
      | HtTp+x://example.com/hook    |

  # The parser skips extra slashes after a special scheme and expands short IPv4 hosts, so these are valid.
  Scenario Outline: An http or https URL with extra slashes, or a short IPv4 host is accepted and stored as submitted
    When I register subscriber "Test Service" for topic "orders" at URL "<url>"
    Then the response status should be 201
    And the subscriber should have been stored and returned with URL "<url>" [subscriber-insert, post-response]

    Examples:
      | url                                |
      | https:///payments.example.com/hook |
      | http://1.2.3/hook                  |
      | HtTp://payments.example.com/hook   |

  Scenario: A JSON string sent as a registration is rejected as malformed
    When I send a JSON string to register a subscriber
    Then the response status should be 400
    And no subscriber should have been persisted

  # ── Routes that do not exist ──────────────────────────────────────────────────
  Scenario: Deleting the whole collection is rejected
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I send an unsupported DELETE request to the subscribers endpoint
    Then the response status should be 404
    And no subscriber should have been removed

  # "X Bad: Name" can never be sent as an HTTP header (a space and a colon are not token characters).
  Scenario: Unusual delivery header names are stored as submitted
    When I register subscriber "Odd Endpoint" for topic "orders" at URL "https://secure.example.com/hook" with headers:
      | X Bad: Name | v1 |
      | __proto__   | v2 |
      | constructor | v3 |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Same data, different shapes of repetition ─────────────────────────────────
  Scenario: Two registrations for the same endpoint on different topics are both kept
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I register subscriber "Payments Service" for topic "refunds" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "refunds" [subscriber-insert]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have subscribed to topic "refunds" once
    And the Kafka consumer should have been started and then restarted to consume topics "orders" and "refunds" [kafka-subscribe, kafka-run]

  Scenario: Registrations for the same topic arriving at the same time subscribe it once
    When I register subscribers for topics "orders" and "orders" at the same time
    Then both registrations should have succeeded
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  Scenario: Registering on a topic again after its only subscriber was removed does not subscribe it again
    When I register subscriber "Payments Service" for topic "orders" at URL "https://payments.example.com/hook"
    And I delete subscriber 1
    And I register subscriber "Audit Logger" for topic "orders" at URL "https://audit.example.com/events"
    Then the response status should be 201
    And the subscriber registered at URL "https://payments.example.com/hook" should have been stored for topic "orders" [subscriber-insert]
    And the subscriber registered at URL "https://audit.example.com/events" should have been stored for topic "orders" [subscriber-insert]
    And subscriber 1 should have been removed [subscriber-delete]
    And the Kafka consumer should have subscribed to topic "orders" once
    And the Kafka consumer should have been started consuming topic "orders"

  # ── Delete id parsing: digits that are not ASCII ──────────────────────────────
  Scenario Outline: A subscriber id that does not start with an ASCII digit is rejected
    When I attempt to delete subscriber with ID "<id>"
    Then the response status should be 400
    And the error response body should be "Invalid id"

    Examples:
      | id  |
      | １２  |
      | ٣   |
      | one |
      | .5  |

  # ── Delete id: path decoration the router strips or decodes ───────────────────
  # Express matches /:id with or without a trailing slash, leaves the query string out of the param, and
  # percent-decodes the segment, so all of these address subscriber 5.
  Scenario Outline: A subscriber id written as "<id>" in the path addresses subscriber <subscriber>
    Given a subscriber "Payments Service" with ID <subscriber> listens for topic "orders" at URL "https://payments.example.com/hook"
    When I attempt to delete subscriber with ID "<id>"
    Then the response status should be 204
    And subscriber <subscriber> should have been removed [subscriber-delete]

    Examples:
      | id           | subscriber |
      | 5/           | 5          |
      | 5?force=true | 5          |
      | %35          | 5          |

  # ── Request body shapes ───────────────────────────────────────────────────────
  # The handler destructures only name, topic, url and headers, so a client cannot choose its own id.
  Scenario: A client cannot choose the id of the subscriber it registers
    When I register a subscriber that tries to choose its own id
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]
    And the registered subscriber should have an id other than the one the client asked for

  # `headers` is not validated, so values that are not strings are stored as given; what fetch makes of them is
  # the delivery flow's concern.
  Scenario: Delivery header values that are not strings are stored as given
    When I register a subscriber with delivery header values that are a number and a nested object
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Listing ignores query parameters ──────────────────────────────────────────
  # The list handler reads no query string, so a client that expects a topic filter gets every subscriber.
  Scenario: Listing with a topic query parameter still returns subscribers of every topic
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Audit Logger" with ID 2 listens for topic "transactions" at URL "https://audit.example.com/events"
    When I list all subscribers with the query string "?topic=orders"
    Then the response status should be 200
    And the subscriber list should contain exactly:
      | id | name             | topic        | url                               | headers | created_at               |
      | 1  | Payments Service | orders       | https://payments.example.com/hook | {}      | 2024-01-01T00:00:00.000Z |
      | 2  | Audit Logger     | transactions | https://audit.example.com/events  | {}      | 2024-01-01T00:00:00.000Z |

  # ── Astral characters ─────────────────────────────────────────────────────────
  # The columns count characters, not UTF-16 units: 255 emoji (510 units) fit, 256 do not.
  Scenario: A name of 255 emoji is accepted
    When I register a subscriber whose name is 255 emoji long
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  Scenario: A name of 256 emoji fails with internal server error
    When I register a subscriber whose name is 256 emoji long
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the subscriber insert should have been attempted and rejected by MySQL with ER_DATA_TOO_LONG "Data too long for column 'name' at row 1" [subscriber-insert]

  # ── Concurrent deletion ───────────────────────────────────────────────────────
  # The handler answers from the DELETE's own affected-row count, not a lookup before it, so of two racing
  # deletions only the one that removed the row reports success.
  Scenario: Two simultaneous deletions of the same subscriber remove it once
    Given a subscriber "Payments Service" with ID 5 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I delete subscriber 5 twice at the same time
    Then exactly one of the two deletions of subscriber 5 should have removed it [subscriber-delete]

  # ── Falsy non-strings ─────────────────────────────────────────────────────────
  # The required-field guard is truthiness, so the number 0 is "missing" while any other number is "present".
  Scenario Outline: Registration is rejected when a required field is the number zero
    When I register a subscriber whose <field> is the number 0
    Then the response status should be 400
    And the error response body should be "name, topic, and url are required"

    Examples:
      | field |
      | name  |
      | topic |
      | url   |
