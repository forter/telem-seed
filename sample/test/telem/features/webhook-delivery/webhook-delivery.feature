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

  Scenario: Message for a topic with no subscribers produces no side effects
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
    And the Kafka offset should not have been committed

  Scenario: Persistent network errors exhaust all delivery retry attempts
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber webhook endpoint is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts should have been logged for subscriber 1 due to a network error with the last marked as exhausted [delivery-log]

  Scenario Outline: HTTP error response from the subscriber endpoint exhausts all delivery retries
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" responds with status <status>
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then all 6 delivery attempts to "https://payments.example.com/hook" should have been made [delivery-call]
    And all 6 HTTP <status> delivery attempts should have been logged for subscriber 1 with the last marked as exhausted [delivery-log]

    Examples:
      | status |
      | 503    |
      | 429    |
      | 500    |

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
    # The successful URL is recorded in delivery calls; the unreachable URL throws before recording.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the subscriber endpoint at "https://analytics.example.com/hook" is unreachable
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery for subscriber 1 should have been logged as successful with key "msg-1" [delivery-log]
    And all 6 delivery attempts should have been logged for subscriber 2 due to a network error with the last marked as exhausted [delivery-log]

  Scenario: One subscriber exhausts HTTP error retries while another is delivered successfully in the same fan-out
    # Distinct from the network-error fan-out: HTTP 503 errors DO record delivery calls (unlike
    # network errors which throw before recording). Both subscribers' call sets can be asserted.
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Analytics Service" with ID 2 listens for topic "orders" at URL "https://analytics.example.com/hook"
    And the subscriber endpoint at "https://analytics.example.com/hook" responds with status 503
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And all 6 delivery attempts to "https://analytics.example.com/hook" should have been made [delivery-call]
    And the delivery for subscriber 1 should have been logged as successful with key "msg-1" [delivery-log]
    And all 6 HTTP 503 delivery attempts should have been logged for subscriber 2 with the last marked as exhausted [delivery-log]

  # ── Transient failure then recovery ───────────────────────────────────────

  Scenario: Delivery succeeds after a transient network failure on the first attempt
    # Transient failure: attempt 1 throws (not recorded in delivery calls), attempt 2 succeeds.
    # Delivery log: 1 "failed" entry + 1 "success" entry; delivery calls: 1 (the recovered POST).
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And the subscriber endpoint at "https://payments.example.com/hook" fails 1 time then succeeds
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have recovered for subscriber 1 after 1 failed attempt with key "msg-1" [delivery-log]

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
    # Verifies the payload is not sanitized between Kafka and the HTTP delivery call or delivery log.
    # Asserts literal storage in the fake — SQL injection safety is the parity test's job (WRITING-TESTS.md).
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
