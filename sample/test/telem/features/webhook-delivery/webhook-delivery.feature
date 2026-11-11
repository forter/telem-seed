Feature: Webhook delivery

  # Each Kafka message arriving on a subscribed topic triggers HTTP POST delivery to all
  # matching subscribers and records every attempt in the delivery log.

  Scenario: Message with a matching subscriber is delivered successfully
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the Kafka offset should have been committed

  Scenario: Message without a key is delivered and logged with a null message key
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" without a key and with payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 without a key [delivery-log]

  Scenario: A message on a topic nobody subscribes to is skipped and committed so the consumer moves on
    When a Kafka message arrives on topic "unknown-topic" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should have been committed

  # ── Feature flag: topic blocked ────────────────────────────────────────────

  Scenario: Blocked topic suppresses HTTP delivery and logs the subscriber as blocked
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  Scenario: All subscribers for a blocked topic are each logged as blocked
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the deliveries for subscribers 1 and 2 should have been logged as blocked [delivery-log]

  # ── Feature flag evaluation failures ───────────────────────────────────────

  # The OpenFeature SDK never rejects: when the provider throws while evaluating a flag it answers with the
  # caller's default, and isTopicBlocked() passes false (CLAUDE.md: "Permissive flag default"). So a failing
  # flag provider fails OPEN — delivery proceeds even for a topic whose topic_flags row says blocked=1.
  # Pinned as the observable consequence of that documented decision, not as an endorsement of it.
  Scenario: A failing flag provider lets a message on a blocked topic through to its subscribers
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    And the feature flag provider is failing on every evaluation
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # Each message evaluates the flag once, so a flag outage is per message: the first message is let through,
  # the next one — evaluated after the provider recovered — is suppressed again.
  Scenario: Blocking resumes on the next message once the flag provider recovers
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    And the feature flag provider fails on its first evaluation and then recovers
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as successful with key "msg-1" and then blocked with key "msg-2" [delivery-log]

  # ── Infrastructure failures ────────────────────────────────────────────────

  Scenario: DB failure during message processing prevents delivery and causes message retry
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the database is unavailable
    When I attempt to dispatch a Kafka message on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should not have been committed

  Scenario: DB write failure during delivery log recording prevents delivery and causes message retry
    # Covers the rejection-propagation path: subscriber SELECT succeeds, but the INSERT INTO
    # delivery_log fails mid-flight. Promise.allSettled captures the rejection; handleMessage
    # rethrows it to prevent offset commit so KafkaJS retries the message.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    And the database fails on delivery log writes
    When I attempt to dispatch a Kafka message on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And no webhook should have been delivered
    And no delivery should have been logged
    And the blocked delivery log write for subscriber 1 should have been attempted and failed with "MySQL: connection lost during delivery log write" [delivery-log]
    And the Kafka offset should not have been committed

  # Current behaviour, a production bug: a subscriber registered with `"headers": "abc"` has the JSON string "abc"
  # stored, and findByTopic's parseRow JSON.parses it again, so the lookup throws before any delivery. The handler
  # rejects, the offset is never committed, and KafkaJS redelivers forever: a poison message for the whole topic.
  # Matches MySQL 8: fake-db.parity.ts "subscribers.create — non-object headers are stored as JSON; a non-JSON
  # string makes listAll throw" (findByTopic included). See webhook-delivery.implementation-notes.md.
  Scenario: A subscriber whose headers were stored as a plain string blocks every message on its topic
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with its headers stored as the string "abc"
    When I attempt to dispatch a Kafka message on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown the JSON parse error "Unexpected token 'a', \"abc\" is not valid JSON"
    And no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should not have been committed

  Scenario: Persistent network errors exhaust all delivery retry attempts
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  Scenario Outline: HTTP error response from the subscriber endpoint exhausts all delivery retries
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status <status>
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 HTTP <status> delivery attempts should have been logged for subscriber 1 with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

    Examples:
      | status |
      | 503    |
      | 429    |
      | 500    |
      | 504    |

  # ── Multiple subscribers ───────────────────────────────────────────────────

  Scenario: Multiple subscribers for the same topic each receive an independent webhook delivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to both subscriber URLs [delivery-call]
    And each subscriber's delivery should have been logged as successful [delivery-log]

  # ── Optional input shapes ─────────────────────────────────────────────────

  Scenario: Message with a null value is delivered with an empty body and logged with an empty payload
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message with key "msg-1" and no value arrives on topic "orders"
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: Subscriber custom headers are merged into the delivery call on top of the defaults
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | Authorization | Bearer token123 |
      | X-Custom-Id   | merchant-001    |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with the subscriber's custom headers [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── Protocol edge cases ───────────────────────────────────────────────────

  Scenario: Empty-byte message key is delivered and logged with an empty-string key distinct from null
    # Protocol outcome: Kafka producer sends empty byte array as key.
    # message.key = Buffer.from('') is truthy → messageKey = '' (not null).
    # Observable difference from no-key scenario: message_key = '' instead of null.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message with an empty key arrives on topic "orders" with payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "" [delivery-log]

  # ── Non-200 2xx responses ─────────────────────────────────────────────────

  Scenario: Endpoint returning HTTP 201 is treated as a successful delivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 201
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" and http status 201 [delivery-log]

  Scenario: Endpoint returning HTTP 204 is treated as a successful delivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 204
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" and http status 204 [delivery-log]

  # ── Topic isolation ───────────────────────────────────────────────────────

  Scenario: Message on one topic does not trigger delivery to subscribers of a different topic
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Inventory Service" with ID 2 listens for topic "inventory" at URL "https://inventory.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the webhook should not have been posted to "https://inventory.example.com/hook" [delivery-call]
    And no delivery should have been logged for subscriber 2

  # ── Partial fan-out failure ───────────────────────────────────────────────

  Scenario: One subscriber succeeds while another is unreachable in the same fan-out
    # Promise.allSettled fan-out: the successful delivery and the 6-attempt exhaustion run concurrently.
    # Both URLs are recorded in delivery calls: fake-fetch records each request before the injected network error.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the subscriber endpoint at "https://analytics.example.com/hook" is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery for subscriber 1 should have been logged as successful with key "msg-1" [delivery-log]
    And all 6 delivery attempts to "https://analytics.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts should have been logged for subscriber 2 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  Scenario: One subscriber exhausts HTTP error retries while another is delivered successfully in the same fan-out
    # Distinct from the network-error fan-out: here the endpoint answers, so each failed attempt is logged with
    # http_status 503 and the reason phrase rather than a null status and 'fetch failed'.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the subscriber endpoint at "https://analytics.example.com/hook" responds with status 503
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And all 6 delivery attempts to "https://analytics.example.com/hook" should have been made [delivery-call]
    And the delivery for subscriber 1 should have been logged as successful with key "msg-1" [delivery-log]
    And all 6 HTTP 503 delivery attempts should have been logged for subscriber 2 with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  # ── Redirecting subscriber endpoints ──────────────────────────────────────

  # Real fetch follows redirects on its own (up to 20) and deliver.ts only sees the FINAL response. For a
  # POST, a 301/302/303 makes fetch re-request the new location with GET and no body, so the receiving
  # endpoint answers 200, the delivery is logged as successful, and the payload never arrived. Pinned as
  # the observable behavior of today's code (verified against Node's real fetch in the fake-fetch parity
  # suite), not as an endorsement of it. A registered http:// URL that redirects to https:// hits this.
  Scenario: A subscriber endpoint that redirects with 301 is logged as delivered although the payload never reaches its new location
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "http://payments.example.com/hook"
    And the subscriber endpoint at "http://payments.example.com/hook" answers with status 301 redirecting to "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "http://payments.example.com/hook" [delivery-call]
    And the redirected request to "https://payments.example.com/hook" should have been downgraded to a GET without a body [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # 307/308 are the redirects that keep the method and body, so the payload does reach the new location.
  Scenario: A subscriber endpoint that redirects with 307 receives the payload at its new location
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "http://payments.example.com/hook"
    And the subscriber endpoint at "http://payments.example.com/hook" answers with status 307 redirecting to "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "http://payments.example.com/hook" [delivery-call]
    And the redirected request to "https://payments.example.com/hook" should have replayed the original POST with its payload [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # Real fetch re-sends a request once when the server answers 421 (Misdirected Request) before it reports
  # the answer, so every retry attempt reaches the subscriber as two identical POSTs. Pinned as real-fetch
  # behavior, not as an endorsement: a receiver that dedupes on X-Delivery-Id sees the same id both times.
  # Depends on undici, not the app: the fetch spec re-sends after a 421 only when the connection was not new, and
  # undici (Node's fetch) never marks the first fetch as a new connection, so it always re-sends once. fake-fetch
  # hard-codes that; fake-fetch.parity.ts re-checks it against the running Node.
  # https://fetch.spec.whatwg.org/#http-network-or-cache-fetch
  Scenario: A subscriber endpoint answering 421 receives every delivery attempt twice
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 421
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then every one of the 6 delivery attempts to "https://payments.example.com/hook" should have been received twice by the subscriber [delivery-call]
    And all 6 HTTP 421 delivery attempts should have been logged for subscriber 1 with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  # ── Transient failure then recovery ───────────────────────────────────────

  Scenario: Delivery succeeds after a transient network failure on the first attempt
    # Transient failure: attempt 1's POST throws a network error, attempt 2's succeeds.
    # Delivery log: 1 "failed" entry + 1 "success" entry; delivery calls: 2 (both POSTs were sent).
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 1 time then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 2 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And the delivery should have recovered for subscriber 1 after 1 failed attempt with key "msg-1" [delivery-log]
    And the retries should have waited "1s" between attempts

  # ── Retry backoff schedule ────────────────────────────────────────────────

  # deliver.ts waits min(1000 * 2^i, 30000) ms after failed attempt i + 1. The harness runs those waits at
  # 0 ms but records the delay production asked for, and a scenario that retries must claim its schedule
  # (an unclaimed wait fails it — which is also why a first-try success needs no "did not wait" step).
  # The attempt limit is frozen in deliver.ts at 6, so the two scenarios below set their own limit.
  Scenario: Retry waits double after each failed attempt and stop growing at 30 seconds
    Given deliveries are limited to 10 attempts
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 10 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 10 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s" between attempts

  Scenario: A single-attempt limit exhausts the delivery without waiting to retry
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 1 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 1 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

  # ── Retry limit boundaries ────────────────────────────────────────────────

  # The default limit is six attempts: these guard both sides of it, so an off-by-one in the loop bound shows.
  Scenario: A delivery that recovers on the last allowed attempt is logged as a success, not exhausted
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 5 times then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And the delivery should have recovered for subscriber 1 after 5 failed attempts with key "msg-1" [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  Scenario: A delivery that fails on all six attempts is exhausted and never gets a seventh
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 6 times then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  # ── Payload edge cases ────────────────────────────────────────────────────

  Scenario: Message with a Unicode payload is delivered and logged correctly
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"name":"こんにちは","emoji":"🎉"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── URL preservation ──────────────────────────────────────────────────────

  Scenario: Subscriber URL with query parameters is called with the full URL intact
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook?env=prod&version=2"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook?env=prod&version=2" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── Payload passthrough (no transformation) ───────────────────────────────

  Scenario: SQL-special characters in the message payload are forwarded and logged without transformation
    # Asserts literal storage in the fake; binding is checked by fake-db.parity.ts § "Parameter binding: SQL-special characters".
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"id":"1; DROP TABLE subscribers; --"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── Message with neither key nor value ────────────────────────────────────

  Scenario: Message with neither key nor value is delivered and logged with null key and empty body
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with no key and no value
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 without a key [delivery-log]

  # ── Flag isolation across topics ──────────────────────────────────────────

  Scenario: Blocking one topic does not suppress delivery on a different unblocked topic
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Inventory Service" with ID 2 listens for topic "inventory" at URL "https://inventory.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "inventory" with key "msg-1" and payload '{"item":"widget"}'
    Then the webhook should have been posted to "https://inventory.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 2 with key "msg-1" [delivery-log]
    And the webhook should not have been posted to "https://payments.example.com/hook" [delivery-call]
    And no delivery should have been logged for subscriber 1

  # ── Offset commit position (at-least-once) ────────────────────────────────

  Scenario: The offset committed after a delivered message is the next offset after its own
    # Kafka's rule: a consumer commits the NEXT offset to read, so a message at offset 41 commits 42.
    # A wrong offset would silently redeliver (too low) or skip (too high) messages after a restart.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" partition 2 at offset 41 with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the committed offset for topic "orders" partition 2 should be 42

  Scenario: Each message commits the offset after its own, on its own partition
    # Offsets are per partition: partition 2 advances 41 → 42 → 43 while partition 5 is committed independently.
    # No subscriber, so the commit is the only effect and a mix-up between partitions cannot hide behind a delivery.
    When a Kafka message arrives on topic "orders" partition 2 at offset 41 with key "msg-1" and payload '{"orderId":"a"}'
    And a Kafka message arrives on topic "orders" partition 5 at offset 7 with key "msg-2" and payload '{"orderId":"b"}'
    And a Kafka message arrives on topic "orders" partition 2 at offset 42 with key "msg-3" and payload '{"orderId":"c"}'
    Then no webhook should have been delivered
    And no delivery should have been logged
    And the offsets committed for topic "orders" partition 2 should be:
      | 42 |
      | 43 |
    And the committed offset for topic "orders" partition 5 should be 8

  Scenario: A failed offset commit fails the message handling
    # The commit is the last step, so the webhook was already delivered and logged when it fails.
    # The handler rejects, KafkaJS keeps the old offset and redelivers: the subscriber may see the message twice.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And committing the Kafka offset fails
    When I attempt to dispatch a Kafka message on topic "orders" partition 3 at offset 99 with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And a failed offset commit should have been attempted for topic "orders" partition 3 at offset 100

  # ── Redelivery of the same message ────────────────────────────────────────

  # Kafka delivers at least once: when handleMessage() threw before committing, when the process died between the
  # POST and the commit, or when an operator resets the group's offsets, the same record (same partition and
  # offset) is handed over again. Nothing in handleMessage() or deliver() remembers a
  # message, and deliver() mints X-Delivery-Id with randomUUID() on every call — so the id is stable across the
  # retries of ONE delivery but a redelivered message reaches the receiver as a brand-new delivery with a new id.
  # The comment in deliver.ts calls the id "an idempotency key for the receiver"; across a Kafka redelivery it
  # is not one. Pinned as current behaviour: each scenario below fails once redelivery is deduplicated.
  # The record was committed, so only an offset reset (or a crash before the commit landed) replays it.
  Scenario: A redelivered message is posted and logged again under a new delivery id
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" partition 2 at offset 41 with key "msg-1" and payload '{"orderId":"abc"}'
    And Kafka redelivers the same message
    Then the redelivered message should have been handled without an error
    And the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And the delivery should have been logged as successful 2 times for subscriber 1 with key "msg-1" [delivery-log]
    And the offsets committed for topic "orders" partition 2 should be:
      | 42 |
      | 42 |

  # The commit is the last step, so a failed commit leaves the subscriber with the message already delivered
  # and Kafka with the old offset: the redelivery posts it a second time.
  Scenario: After a failed offset commit the subscriber receives the redelivered message a second time
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the broker rejects the first offset commit and accepts the next
    When I attempt to dispatch a Kafka message on topic "orders" partition 3 at offset 99 with key "msg-1" and payload '{"orderId":"abc"}'
    And Kafka redelivers the same message
    Then the first handling of the message should have failed
    And the redelivered message should have been handled without an error
    And the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And the delivery should have been logged as successful 2 times for subscriber 1 with key "msg-1" [delivery-log]
    And the commit attempts for topic "orders" partition 3 should have been:
      | offset | outcome   |
      | 100    | failed    |
      | 100    | committed |

  # deliver() POSTs first and records the outcome second. If that record fails the delivery rejects, the
  # handler rethrows and the offset stays put, although the subscriber already accepted the webhook.
  Scenario: A delivery whose success could not be recorded is posted again when Kafka redelivers the message
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the delivery log rejects its first write and then recovers
    When I attempt to dispatch a Kafka message on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And Kafka redelivers the same message
    Then the first handling of the message should have failed
    And the redelivered message should have been handled without an error
    And the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And these delivery log writes for subscriber 1 should have been attempted and failed with "MySQL: connection lost during delivery log write" [delivery-log]:
      | attempt_number | status  | http_status | error_message |
      | 1              | success | 200         |               |
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the offsets committed for topic "orders" partition 0 should be:
      | 1 |

  # ── Delivery-log failures inside the retry loop ───────────────────────────

  # A failed attempt is logged before the backoff sleep. When that INSERT throws, deliver() rejects on the spot:
  # no wait, no further attempts, and the handler rethrows so the message is redelivered later.
  Scenario: A delivery log outage after a failed attempt stops the delivery from being retried
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 503
    And the database fails on delivery log writes
    When I attempt to dispatch a Kafka message on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And these delivery log writes for subscriber 1 should have been attempted and failed with "MySQL: connection lost during delivery log write" [delivery-log]:
      | attempt_number | status | http_status | error_message                |
      | 1              | failed | 503         | HTTP 503 Service Unavailable |
    And the Kafka offset should not have been committed

  # delivery_log.message_key is VARCHAR(255) and MySQL runs in strict mode, so a longer key makes the success
  # INSERT fail after the POST went out. The handler rethrows, the offset is never committed, and every
  # redelivery POSTs again and fails the same way: a poison message that re-sends the webhook forever.
  Scenario: A message key longer than the delivery log allows is delivered but never committed
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When I attempt to dispatch a Kafka message on topic "orders" with a 256-character key and payload '{"orderId":"abc"}'
    Then the message handler should have thrown because the key does not fit the delivery log
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And these delivery log writes for subscriber 1 should have been attempted and failed with "Data too long for column 'message_key' at row 1" [delivery-log]:
      | attempt_number | status  | http_status | error_message |
      | 1              | success | 200         |               |
    And the Kafka offset should not have been committed

  Scenario: A message key exactly as long as the delivery log allows is delivered and committed
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with a 255-character key and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with that key [delivery-log]
    And the Kafka offset should have been committed

  # ── Subscribers that collide ──────────────────────────────────────────────

  # Subscribers are keyed by id, not URL, so two registrations of one endpoint are two deliveries: the endpoint
  # gets the webhook twice, under two delivery ids, and each subscriber has its own log row.
  Scenario: Two subscribers registered with the same URL each deliver to it
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Payments Service (duplicate)" with ID 2 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And the delivery should have been logged as successful once for each of subscribers 1 and 2 with key "msg-1" [delivery-log]

  # deliver() builds the headers as an object literal — defaults first, then `...subscriber.headers` — and fetch
  # turns it into HTTP headers, whose names are case-insensitive. A subscriber header spelled exactly like a default
  # replaces it in the object; one spelled in another case is a second key, and fetch joins the two values with ", ".
  Scenario: A subscriber header spelled exactly like a default one replaces it
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | Content-Type | text/plain |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with exactly these headers [delivery-call]:
      | content-type  | text/plain              |
      | x-delivery-id | <generated delivery id> |
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: A subscriber header differing from a default one only in case is merged into it
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | content-type  | text/plain   |
      | x-delivery-id | receiver-key |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with exactly these headers [delivery-call]:
      | content-type  | application/json, text/plain          |
      | x-delivery-id | <generated delivery id>, receiver-key |
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # fetch validates header names before it opens a connection, so a subscriber stored with a header name HTTP
  # does not allow never gets a request at all. Every attempt fails with the same TypeError and is retried
  # anyway, because deliver() retries every failure alike. The rest of the message is undici's wording (it changes
  # between Node releases); fake-fetch.parity.ts pins the full text against the running Node.
  Scenario: A subscriber with an invalid header name is never contacted and exhausts its retries
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | X Bad Header | value |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And all 6 delivery attempts should have been logged for subscriber 1 with an error starting "Headers.append:" and the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  Scenario: A subscriber header value outside the Latin-1 range is never sent and exhausts its retries
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | X-Note | 日本 |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And all 1 delivery attempts should have been logged for subscriber 1 with an error starting "Cannot convert argument to a ByteString" and the last marked as exhausted [delivery-log]

  # ── Topic names under MySQL's collation ───────────────────────────────────

  # Kafka topic names are case-sensitive, but subscribers.topic uses MySQL's default utf8mb4_0900_ai_ci collation,
  # so findByTopic() matches case- and accent-insensitively. A message on any spelling reaches the subscribers of
  # every other spelling. Pinned as current behaviour.
  Scenario Outline: A message on topic "<message_topic>" reaches the subscribers of topic "orders"
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "<message_topic>" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

    Examples:
      | message_topic |
      | ORDERS        |
      | Orders        |
      | ördérs        |

  # The flag check is exact-case (the provider caches topic_flags rows in a Map keyed by the stored spelling)
  # while the subscriber match is not, so a block on "orders" does not stop a message on "ORDERS" that still
  # reaches the "orders" subscribers.
  Scenario: Blocking a topic does not block a message on a differently-cased spelling of it
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "ORDERS" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # The collation match is case- and accent-insensitive only: a longer or shorter name is a different topic, and
  # the message is committed with nothing delivered.
  Scenario Outline: A message on topic "<message_topic>" does not reach the subscribers of topic "orders"
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "<message_topic>" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should have been committed

    Examples:
      | message_topic |
      | orders-v2     |
      | order         |

  # utf8mb4_0900_ai_ci is a NO PAD collation, so unlike older MySQL collations a trailing space is significant.
  Scenario: A message on a topic with a trailing space does not reach the subscribers of the trimmed topic
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders " with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should have been committed

  # ── Topic flag states ─────────────────────────────────────────────────────

  # A topic_flags row with blocked = 0 is the "explicitly unblocked" state; it delivers exactly like a topic with no row.
  Scenario: A topic explicitly unblocked in the flags database is delivered normally
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" has delivery explicitly unblocked in the flags database
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario Outline: Every subscriber of a topic whose flag is <flag> receives its own delivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the delivery flag of topic "orders" is "<flag>"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to both subscriber URLs [delivery-call]
    And each subscriber's delivery should have been logged as successful [delivery-log]

    Examples:
      | flag           |
      | unblocked-row  |
      | provider-fails |

  Scenario Outline: Two subscribers sharing a URL on a topic whose flag is <flag> are each delivered
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Payments Service (duplicate)" with ID 2 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the delivery flag of topic "orders" is "<flag>"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And the delivery should have been logged as successful once for each of subscribers 1 and 2 with key "msg-1" [delivery-log]

    Examples:
      | flag           |
      | unblocked-row  |
      | provider-fails |

  Scenario: Two subscribers sharing a URL on a blocked topic are each logged as blocked
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Payments Service (duplicate)" with ID 2 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the deliveries for subscribers 1 and 2 should have been logged as blocked [delivery-log]

  # ── Commit failures and redelivery on the routes that deliver nothing ─────

  # The commit runs on every route, so it can fail even when there was nothing to deliver.
  Scenario: A failed offset commit for a topic without subscribers fails the message handling
    Given committing the Kafka offset fails
    When I attempt to dispatch a Kafka message on topic "orders" partition 3 at offset 99 with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And no webhook should have been delivered
    And no delivery should have been logged
    And a failed offset commit should have been attempted for topic "orders" partition 3 at offset 100

  Scenario: A message for a topic without subscribers whose commit failed is committed on redelivery
    Given the broker rejects the first offset commit and accepts the next
    When I attempt to dispatch a Kafka message on topic "orders" partition 2 at offset 41 with key "msg-1" and payload '{"orderId":"abc"}'
    And Kafka redelivers the same message
    Then the first handling of the message should have failed
    And the redelivered message should have been handled without an error
    And no webhook should have been delivered
    And no delivery should have been logged
    And the commit attempts for topic "orders" partition 2 should have been:
      | offset | outcome   |
      | 42     | failed    |
      | 42     | committed |

  Scenario: A failed offset commit on a blocked topic fails the message handling
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    And committing the Kafka offset fails
    When I attempt to dispatch a Kafka message on topic "orders" partition 3 at offset 99 with key "msg-1" and payload '{"orderId":"abc"}'
    Then the message handler should have thrown due to an infrastructure failure
    And no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]
    And a failed offset commit should have been attempted for topic "orders" partition 3 at offset 100

  # Nothing remembers a blocked message either: its redelivery is logged as blocked a second time.
  Scenario: A message on a blocked topic whose commit failed is logged as blocked again on redelivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    And the broker rejects the first offset commit and accepts the next
    When I attempt to dispatch a Kafka message on topic "orders" partition 2 at offset 41 with key "msg-1" and payload '{"orderId":"abc"}'
    And Kafka redelivers the same message
    Then the first handling of the message should have failed
    And the redelivered message should have been handled without an error
    And no webhook should have been delivered
    And the delivery should have been logged as blocked 2 times for subscriber 1 [delivery-log]
    And the commit attempts for topic "orders" partition 2 should have been:
      | offset | outcome   |
      | 42     | failed    |
      | 42     | committed |

  # ── HTTP status classes ───────────────────────────────────────────────────

  # deliver() decides on response.ok alone: every 2xx is a success, everything else is a failed attempt — including
  # a 3xx fetch could not follow (no Location) and every 4xx, which are retried like a 5xx. One attempt keeps
  # these rows to the classification.
  Scenario Outline: An endpoint answering <status> is a successful delivery
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status <status>
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" and http status <status> [delivery-log]

    Examples:
      | status |
      | 202    |
      | 299    |

  Scenario Outline: An endpoint answering <status> is a failed delivery attempt
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status <status>
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 1 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 1 HTTP <status> delivery attempts should have been logged for subscriber 1 with the last marked as exhausted [delivery-log]

    Examples:
      | status |
      | 300    |
      | 302    |
      | 304    |
      | 400    |
      | 401    |
      | 404    |
      | 410    |
      | 502    |

  # fetch reports a 407 (proxy authentication) as a network error even though the endpoint answered, so the attempt
  # is logged with no HTTP status and the generic 'fetch failed', like an unreachable endpoint.
  Scenario: An endpoint answering 407 is logged as a network error
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 407
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 1 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 1 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

  # ── More redirects ────────────────────────────────────────────────────────

  Scenario Outline: A subscriber endpoint that redirects with <status> gets an empty GET at its new location
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "http://payments.example.com/hook"
    And the subscriber endpoint at "http://payments.example.com/hook" answers with status <status> redirecting to "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "http://payments.example.com/hook" [delivery-call]
    And the redirected request to "https://payments.example.com/hook" should have been downgraded to a GET without a body [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

    Examples:
      | status |
      | 302    |
      | 303    |

  Scenario: A subscriber endpoint that redirects with 308 receives the payload at its new location
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "http://payments.example.com/hook"
    And the subscriber endpoint at "http://payments.example.com/hook" answers with status 308 redirecting to "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "http://payments.example.com/hook" [delivery-call]
    And the redirected request to "https://payments.example.com/hook" should have replayed the original POST with its payload [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # deliver() only sees fetch's final answer, so the outcome is decided where the redirect lands.
  Scenario: A redirect that lands on a failing endpoint is a failed delivery attempt
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "http://payments.example.com/hook"
    And the subscriber endpoint at "http://payments.example.com/hook" answers with status 301 redirecting to "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status 503
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "http://payments.example.com/hook" [delivery-call]
    And the redirected request to "https://payments.example.com/hook" should have been downgraded to a GET without a body [delivery-call]
    And all 1 HTTP 503 delivery attempts should have been logged for subscriber 1 with the last marked as exhausted [delivery-log]

  # fetch follows at most 20 redirects; the 21st redirect response is a network error. An endpoint that redirects
  # to itself is therefore hit 21 times inside one delivery attempt before the attempt is logged as failed.
  Scenario: An endpoint that redirects to itself is hit 21 times before the attempt is logged as a network error
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" answers with status 307 redirecting to "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then 21 identical POSTs to "https://payments.example.com/hook" should have been made within a single delivery attempt [delivery-call]
    And all 1 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

  # ── How WEBHOOK_MAX_ATTEMPTS is read ──────────────────────────────────────

  # Operators set WEBHOOK_MAX_ATTEMPTS by hand, and deliver.ts never validates it: it reads Math.max(1, parseInt(value || '6', 10))
  # once at module load. These scenarios pin how each kind of value is interpreted.
  Scenario Outline: A WEBHOOK_MAX_ATTEMPTS of "<setting>" is raised to a single attempt
    Given the WEBHOOK_MAX_ATTEMPTS setting is "<setting>"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 1 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 1 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

    # 0 and -3 are clamped by Math.max; parseInt reads 0x10 as 0 (then clamped) and 1e3 as 1, not 1000.
    Examples:
      | setting |
      | 0       |
      | -3      |
      | 0x10    |
      | 1e3     |

  Scenario: A fractional WEBHOOK_MAX_ATTEMPTS is truncated to a whole number of attempts
    Given the WEBHOOK_MAX_ATTEMPTS setting is "2.5"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 2 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 2 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s" between attempts

  Scenario: An empty WEBHOOK_MAX_ATTEMPTS falls back to the default of six attempts
    Given the WEBHOOK_MAX_ATTEMPTS setting is ""
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  # The limit is only consulted when an attempt fails, so a first-try success looks the same under every setting.
  Scenario Outline: A delivery that succeeds first time is unaffected by a WEBHOOK_MAX_ATTEMPTS of "<setting>"
    Given the WEBHOOK_MAX_ATTEMPTS setting is "<setting>"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

    Examples:
      | setting |
      | 1       |
      | 10      |
      | 0       |
      | 2.5     |
      |         |
      | 3abc    |

  # Any limit of two or more lets a single transient failure recover on the second attempt.
  Scenario Outline: A transient failure recovers on the second attempt under a WEBHOOK_MAX_ATTEMPTS of "<setting>"
    Given the WEBHOOK_MAX_ATTEMPTS setting is "<setting>"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 1 time then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 2 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And the delivery should have recovered for subscriber 1 after 1 failed attempt with key "msg-1" [delivery-log]
    And the retries should have waited "1s" between attempts

    Examples:
      | setting |
      | 10      |
      | 2.5     |
      |         |
      | 3abc    |

  # With a single attempt there is no second try, so a failure that would have been transient is final.
  Scenario Outline: A transient failure is final under a WEBHOOK_MAX_ATTEMPTS of "<setting>"
    Given the WEBHOOK_MAX_ATTEMPTS setting is "<setting>"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 1 time then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 1 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 1 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

    Examples:
      | setting |
      | 1       |
      | 0       |

  # parseInt('six') is NaN and Math.max(1, NaN) is NaN, not 1, so the retry loop `attempt <= NaN` never runs:
  # no POST, no delivery_log row, and the offset is committed as if the message had been handled. A typo in the
  # setting silently drops every webhook. Pinned as current behaviour; it fails once the setting is validated.
  Scenario: A non-numeric WEBHOOK_MAX_ATTEMPTS silently drops every delivery
    Given the WEBHOOK_MAX_ATTEMPTS setting is "six"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And no delivery should have been logged
    And the Kafka offset should have been committed

  # parseInt(value, 10) reads a leading integer and ignores the rest, so these settings are not rejected: they
  # are read as the number their prefix spells.
  Scenario Outline: A WEBHOOK_MAX_ATTEMPTS of "<setting>" is accepted by its leading integer as <attempt_count> attempts, never rejected
    Given the WEBHOOK_MAX_ATTEMPTS setting is "<setting>"
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all <attempt_count> delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all <attempt_count> delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And the retries should have waited "<waits>" between attempts

    Examples:
      | setting | attempt_count | waits  |
      | 3abc    | 3             | 1s, 2s |
      | +2      | 2             | 1s     |

  # ── Payloads that are not JSON ────────────────────────────────────────────

  # The payload is forwarded byte for byte; nothing checks it parses, yet it is always labelled application/json.
  Scenario: A message that is not JSON is forwarded verbatim under a JSON content type
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload 'order abc shipped'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── Offsets beyond 2^53 ───────────────────────────────────────────────────

  # handleMessage() adds one with BigInt, so an int64 offset that a JavaScript number cannot represent is still exact.
  Scenario: An offset beyond JavaScript's safe-integer range is committed exactly
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" partition 0 at offset "9007199254740993" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the committed offset for topic "orders" partition 0 should be "9007199254740994"

  # ── Message key shapes ───────────────────────────────────────────────

  # Keys reach delivery_log.message_key unchanged: non-ASCII, SQL-special and whitespace-only keys must survive.
  # The fake never runs SQL; binding is checked by fake-db.parity.ts § "Parameter binding: SQL-special characters".
  Scenario: A Unicode message key is delivered and logged intact
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "ключ-🔑-鍵" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "ключ-🔑-鍵" [delivery-log]

  Scenario: A message key containing SQL-special characters is logged literally
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "k'; DROP TABLE delivery_log; --" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "k'; DROP TABLE delivery_log; --" [delivery-log]

  Scenario: A whitespace-only message key is kept as a key and not treated as missing
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key " " and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key " " [delivery-log]

  # ── Fan-out isolation ─────────────────────────────────────────────────

  Scenario: Three subscribers on one topic where one is down still deliver to the other two
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And a subscriber "Audit Service" with ID 3 listens for topic "orders" at URL "https://audit.example.com/hook"
    And the subscriber endpoint at "https://analytics.example.com/hook" responds with status 500
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the webhook should have been posted to "https://audit.example.com/hook" [delivery-call]
    And all 6 delivery attempts to "https://analytics.example.com/hook" should have been made [delivery-call]
    And the delivery for subscriber 1 should have been logged as successful with key "msg-1" [delivery-log]
    And the delivery for subscriber 3 should have been logged as successful with key "msg-1" [delivery-log]
    And all 6 HTTP 500 delivery attempts should have been logged for subscriber 2 with the last marked as exhausted [delivery-log]
    And the retries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  Scenario: Two subscribers that are both unreachable are each retried to exhaustion independently
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" is unreachable
    And the subscriber endpoint at "https://analytics.example.com/hook" is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts to "https://analytics.example.com/hook" should have been made [delivery-call]
    And all 6 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]
    And all 6 delivery attempts should have been logged for subscriber 2 due to a network error with the last marked as exhausted [delivery-log]
    And each of the 2 deliveries should have waited "1s, 2s, 4s, 8s, 16s" between attempts

  # ── Repeated and special messages ────────────────────

  Scenario: Two different messages sharing a key are delivered and logged independently
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" partition 0 at offset 1 with key "same" and payload '{"orderId":"abc"}'
    And a Kafka message arrives on topic "orders" partition 0 at offset 2 with key "same" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" 2 times, each under a different delivery id [delivery-call]
    And the delivery should have been logged as successful 2 times for subscriber 1 with key "same" [delivery-log]
    And the offsets committed for topic "orders" partition 0 should be:
      | 2 |
      | 3 |

  Scenario: The first message of a partition commits offset one
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" partition 0 at offset 0 with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And the committed offset for topic "orders" partition 0 should be 1

  Scenario: A message without a key on a blocked topic is logged as blocked
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    When a Kafka message arrives on topic "orders" without a key and with payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  # ── Degenerate payloads and header values ─────────────────────────────────

  # The payload is untrusted bytes from the broker and is forwarded and stored as-is, never trimmed.
  # Storage is checked by fake-db.parity.ts § "a whitespace-only or whitespace-edged payload is stored untrimmed".
  Scenario: A whitespace-only payload is forwarded and logged without trimming
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '   '
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # Header injection: fetch refuses a value with a line break before anything reaches the wire
  # (fake-fetch.parity.ts § "header value with CR LF").
  Scenario: A subscriber header value containing a line break is never sent and exhausts its retries
    Given deliveries are limited to 1 attempt
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | X-Note | a\nX-Evil: 1 |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And all 1 delivery attempts should have been logged for subscriber 1 with an error starting "Headers.append:" and the last marked as exhausted [delivery-log]

  # An empty value is a valid header, so it is sent rather than dropped
  # (fake-fetch.parity.ts § "subscriber custom header with an empty value").
  Scenario: A subscriber header with an empty value is sent rather than dropped
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | X-Empty |  |
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with the subscriber's custom headers [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # ── Over-long key on a blocked topic ──────────────────────────────────────

  # The blocked route writes its log row before anything is sent, so a key over VARCHAR(255) fails that write, the
  # handler rethrows and the offset is never committed: the message blocks its partition for as long as the topic
  # stays blocked. Rejection is checked by fake-db.parity.ts (256-character key).
  Scenario: A message key longer than the delivery log allows on a blocked topic is never committed
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the topic "orders" is delivery-blocked
    When I attempt to dispatch a Kafka message on topic "orders" with a 256-character key and payload '{"orderId":"abc"}'
    Then the message handler should have thrown because the key does not fit the delivery log
    And no webhook should have been delivered
    And these delivery log writes for subscriber 1 should have been attempted and failed with "Data too long for column 'message_key' at row 1" [delivery-log]:
      | attempt_number | status  | http_status | error_message |
      | 1              | blocked |             |               |
    And the Kafka offset should not have been committed

  # ── Credentials across redirects ──────────────────────────────────────────

  # fetch drops Authorization when a redirect leaves the origin, so a subscriber's bearer token is not handed to
  # the host it redirects to; within the origin it is kept (https://fetch.spec.whatwg.org/#http-redirect-fetch).
  # fake-fetch.parity.ts § "cross-origin 307 drops credentials only" / "same-origin 307 keeps everything".
  # The replay step asserts the redirected request's headers exactly, so a leaked Authorization fails it.
  Scenario: A redirect to another origin does not forward the subscriber's Authorization header
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | Authorization | Bearer token123 |
    And the subscriber endpoint at "https://payments.example.com/hook" answers with status 307 redirecting to "https://elsewhere.example.org/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with the subscriber's custom headers [delivery-call]
    And the redirected request to "https://elsewhere.example.org/hook" should have replayed the original POST with its payload [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: A redirect within the same origin keeps the subscriber's Authorization header
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook" with custom headers:
      | Authorization | Bearer token123 |
    And the subscriber endpoint at "https://payments.example.com/hook" answers with status 307 redirecting to "https://payments.example.com/v2/hook"
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" with the subscriber's custom headers [delivery-call]
    And the redirected request to "https://payments.example.com/v2/hook" should have replayed the original POST with its payload and the subscriber's custom headers [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
