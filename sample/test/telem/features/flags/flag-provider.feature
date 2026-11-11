Feature: Delivery flags reach the message consumer through a 5-second flag cache

  # The consumer asks OpenFeature whether a topic is blocked for every message. The provider behind it,
  # MySqlFlagsProvider, does not read topic_flags per message: it loads the whole table into memory when
  # the platform starts and reloads it every 5 seconds. So a flag change made through PATCH /api/flags
  # takes effect on the first reload after the change, up to 5 seconds later, and a reload that cannot
  # reach MySQL keeps serving the last state it loaded. Startup itself is different: if the first load
  # fails, initFlags() rejects and the platform refuses to start, because running without flag state
  # could deliver to topics an operator has blocked.
  # Design rationale: CLAUDE.md § "Architecture decisions that are intentional" (OpenFeature + MySQL-backed
  # provider, permissive flag default, initFlags() is fatal on startup failure) and
  # docs/discussions/project-review-01.md.
  #
  # These scenarios run the real provider; every other feature answers flags straight from the topic_flags
  # rows, so the cache is invisible there. Time is a virtual clock the scenarios move forward.

  Background:
    Given the platform evaluates delivery flags through its MySQL flag cache
    And a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"

  # ── What the flag state loaded at startup means for delivery ──────────────────
  # Three states (CLAUDE.md § "Permissive flag default"): no row = unmanaged, blocked=0 = explicitly
  # unblocked, blocked=1 = blocked. Only blocked=1 stops delivery.

  Scenario: Messages on a topic nobody has managed are delivered
    Given the platform has started
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: Messages on an explicitly unblocked topic are delivered
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    And the platform has started
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: Messages on a topic blocked before startup are suppressed from the first message
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    When a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  # The cache is keyed by the stored topic string, so its lookup is exact-case, while topic_flags' primary
  # key and the subscriber lookup both use MySQL's case-insensitive collation. A message on "Orders"
  # reaches the "orders" subscriber, but the "orders" block does not apply to it.
  # Characterizes current behaviour, not an endorsement: see flags.implementation-notes.md
  # § "Known Production Bugs" (case-variant topic blocks).
  Scenario: A block on a topic does not apply to messages on a differently-cased spelling of it
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    When a Kafka message arrives on topic "Orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  # PATCH "Orders" updates the existing "orders" row in place (same primary key under the collation, and
  # ON DUPLICATE KEY UPDATE keeps the first spelling), so the API answers 200 "Orders blocked" while the
  # cache only ever holds "orders". Messages on "Orders" keep being delivered.
  # Characterizes current behaviour, not an endorsement: see flags.implementation-notes.md
  # § "Known Production Bugs" (case-variant topic blocks).
  Scenario: Blocking a differently-cased spelling of a managed topic blocks the stored spelling instead
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    And the platform has started
    When I block delivery for topic "Orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "Orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    # This step checks the upsert the API was asked for ("Orders") and its response; the stored row keeps
    # the spelling "orders" (flags.feature pins the listing).
    Then delivery for topic "Orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as successful with key "msg-1" and then blocked with key "msg-2" [delivery-log]

  # The listing drops a "__proto__" row (flags.feature), but the cache is a Map, so the block itself holds.
  Scenario: A block on the topic "__proto__" suppresses its messages
    Given a subscriber "Proto Service" with ID 2 listens for topic "__proto__" at URL "https://proto.example.com/hook"
    And the topic "__proto__" has delivery blocked in the flags database
    And the platform has started
    When a Kafka message arrives on topic "__proto__" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 2 [delivery-log]

  # ── A flag change takes effect at the next 5-second reload ────────────────────

  # The virtual clock settles the reload's (fake, microtask) MySQL query before the next step runs, so here the new
  # cache is in place at t=5000. In production the reload is a real query: a message arriving at t≈5000 can still
  # see the old cache until it returns. This pins the 5 s period, not the instant of the switch.
  Scenario: A block made through the API starts suppressing messages from the first 5-second reload after startup
    The reload runs on a fixed 5-second period from startup, not 5 seconds after the change. A change
    made right after startup is invisible for the rest of that period, and applies once that period's reload has run.
    Given the platform has started
    When I block delivery for topic "orders"
    And 4999 milliseconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 1 millisecond passes
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as successful with key "msg-1" and then blocked with key "msg-2" [delivery-log]

  Scenario: An unblock made through the API lets messages through only after the next reload
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    When I unblock delivery for topic "orders"
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as blocked with key "msg-1" and then successful with key "msg-2" [delivery-log]

  # A one-shot reload would pass the scenario above; this one fails unless the reload repeats.
  Scenario: The flag cache keeps reloading every 5 seconds, not only once after startup
    Given the platform has started
    When 6 seconds pass
    And I block delivery for topic "orders"
    And 3999 milliseconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 1 millisecond passes
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as successful with key "msg-1" and then blocked with key "msg-2" [delivery-log]

  # Each reload replaces the cache with what the table holds now. Nothing in the API deletes a row, but an
  # operator can, and a merge-style reload would keep the deleted block forever.
  Scenario: Deleting a topic's flag row directly in MySQL returns it to the permissive default after the next reload
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    When the flag row for topic "orders" is deleted directly in the database
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as blocked with key "msg-1" and then successful with key "msg-2" [delivery-log]

  # ── A reload that cannot reach MySQL ──────────────────────────────────────────
  # The reload's failure is logged and swallowed; the cache keeps its last loaded state. That is "serve
  # stale", not "fail open": a blocked topic stays blocked through a MySQL outage.

  Scenario: A blocked topic stays blocked while the flag cache cannot reload from MySQL
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    And the flag cache cannot reach MySQL from now on
    When I unblock delivery for topic "orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]
    And no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  Scenario: An unblocked topic keeps being delivered while the flag cache cannot reload from MySQL
    Given the platform has started
    And the flag cache cannot reach MySQL from now on
    When I block delivery for topic "orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]

  Scenario: An unblock missed by a failed reload is picked up by the next successful one
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    And the flag cache cannot reach MySQL on its next reload only
    When I unblock delivery for topic "orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as blocked with key "msg-1" and then successful with key "msg-2" [delivery-log]

  Scenario: A block missed by a failed reload is picked up by the next successful one
    Given the platform has started
    And the flag cache cannot reach MySQL on its next reload only
    When I block delivery for topic "orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-2" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the deliveries for subscriber 1 should have been logged as successful with key "msg-1" and then blocked with key "msg-2" [delivery-log]

  # Belt-and-suspenders: whatever happens to the row (nothing, or an out-of-band delete), a reload that
  # fails takes the same swallow-and-keep-the-old-cache path as the scenarios above, so the message right
  # after it still sees the state loaded at startup. The rows are the full row-edit × outage table.
  Scenario Outline: A failed reload keeps the startup flag state in force — row <row_edit>, MySQL unreachable <outage>
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    And the flag cache cannot reach MySQL <outage>
    When the flag row for topic "orders" is <row_edit>
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

    Examples:
      | row_edit                         | outage                  |
      | left as it is                    | from now on             |
      | left as it is                    | on its next reload only |
      | deleted directly in the database | from now on             |
      | deleted directly in the database | on its next reload only |

  # ── Startup ──────────────────────────────────────────────────────────────────
  # initFlags() rejecting is what makes src/index.ts main() exit the process; the exit itself (and a fresh
  # process's not-ready health) is outside what an in-process BDD harness can observe.

  Scenario: Flag initialization at startup fails when it cannot load the flag state
    Given the flag cache cannot reach MySQL from now on
    When the platform starts
    Then flag initialization should have failed with the MySQL error

  # ── Isolation between topics, repeated blocks and long outages ──────────────
  # A flag cache that served stale or mis-keyed state would deliver to topics an operator blocked
  # (CLAUDE.md § "initFlags() is fatal on startup failure"). A block stays scoped to its own topic and a
  # reloaded block survives any number of failed reloads after it.

  Scenario: A block on one topic does not suppress messages on another topic after the reload
    Given a subscriber "Billing Service" with ID 2 listens for topic "invoices" at URL "https://billing.example.com/hook"
    And the platform has started
    When I block delivery for topic "invoices"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then the webhook should have been posted to "https://payments.example.com/hook" [delivery-call]
    And the delivery should have been logged as successful for subscriber 1 with key "msg-1" [delivery-log]
    And delivery for topic "invoices" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: Blocking an already blocked topic again leaves it blocked
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    When I block delivery for topic "orders"
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  Scenario: A blocked topic stays blocked through a long MySQL outage
    Given the topic "orders" has delivery blocked in the flags database
    And the platform has started
    And the flag cache cannot reach MySQL from now on
    When 60 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]

  Scenario: A block applied while the platform is up survives a later MySQL outage
    Given the platform has started
    When I block delivery for topic "orders"
    And 5 seconds pass
    And the flag cache cannot reach MySQL from now on
    And 5 seconds pass
    And a Kafka message arrives on topic "orders" with key "msg-1" and payload '{"orderId":"abc"}'
    Then delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And no webhook should have been delivered
    And the delivery should have been logged as blocked for subscriber 1 [delivery-log]
