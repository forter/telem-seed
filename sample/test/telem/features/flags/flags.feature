Feature: Manage topic delivery flags

  # GET /api/flags reads the topic_flags MySQL table and returns { [topic]: blocked } for every row.
  # PATCH /api/flags/:topic upserts into topic_flags — delivery_blocked:true writes blocked=1,
  # delivery_blocked:false writes blocked=0.
  #
  # Three states for a topic:
  #   (1) no row in topic_flags   → unmanaged, absent from the GET response
  #   (2) row with blocked=false  → explicitly unblocked, appears in GET as { topic: false }
  #   (3) row with blocked=true   → blocked,              appears in GET as { topic: true }
  #
  # Replaced flagd+flags.json: the HTTP server writing a local JSON file is a design smell.
  # Flag state now lives in the same MySQL instance as the rest of the platform state.
  # Architecture decision: CLAUDE.md § "Architecture decisions that are intentional" — the
  # OpenFeature SDK is preserved (provider swapped from FlagdProvider to MySqlFlagsProvider)
  # so the flags IO boundary remains distinct and testable. No external ticket; decision made
  # in the design session documented in git log (the commit introducing this feature file).

  # ── GET /api/flags ──────────────────────────────────────────────────────────

  Scenario: No topics have been explicitly managed
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should be empty

  Scenario: A blocked topic appears in the delivery flag listing
    Given the topic "orders" has delivery blocked in the flags database
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  # Three-state semantics: a row with blocked=false exists when a topic was explicitly unblocked
  # via PATCH. It is distinct from "never managed" — the topic still appears in GET.
  Scenario: Explicitly unblocked topics remain visible in the flag listing
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | false   |

  Scenario: All managed topics appear in the delivery flag listing
    Given the topics "orders" and "payments" have delivery blocked in the flags database
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should contain exactly:
      | topic    | blocked |
      | orders   | true    |
      | payments | true    |

  # ── PATCH /api/flags/:topic — validation ───────────────────────────────────

  # Validation runs before any DB IO — a 400 produces no topic_flags upsert.
  Scenario Outline: PATCH rejects non-boolean delivery_blocked values
    When I attempt to PATCH delivery blocked for topic "orders" with delivery_blocked as <type>
    Then the response status should be 400
    And the error response body should be "delivery_blocked must be a boolean"

    Examples:
      | type    |
      | missing |
      | null    |
      | number  |
      | object  |
      | array   |
      | string  |

  # ── Infrastructure failures ──────────────────────────────────────────────────

  Scenario: GET returns 500 when the database is unavailable
    Given the database is unavailable
    When I list all delivery flags
    Then the response status should be 500
    And the error response body should be "Internal server error"

  Scenario: PATCH returns 500 when the database is unavailable
    Given the database is unavailable
    When I block delivery for topic "orders"
    Then the response status should be 500
    And the error response body should be "Internal server error"

  # ── PATCH /api/flags/:topic ─────────────────────────────────────────────────

  Scenario: Blocking a topic creates its delivery flag row
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: blocking an already-blocked topic upserts identically — no guard in handler.
  Scenario: Blocking an already-blocked topic is idempotent
    Given the topic "orders" has delivery blocked in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be blocked in the flags database [topic-flags-upsert, patch-response]

  Scenario: Unblocking a topic sets its row to unblocked
    Given the topic "orders" has delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be unblocked in the flags database [topic-flags-upsert, patch-response]

  # Three-state: unblocking a never-blocked topic upserts blocked=0 — the topic was "unmanaged"
  # before and is now "explicitly unblocked". It will appear in GET as { orders: false }.
  Scenario: Unblocking a never-blocked topic creates an explicit unblocked row
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be unblocked in the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: blocking a topic whose row already has blocked=0 (explicitly unblocked).
  # ON DUPLICATE KEY UPDATE sets blocked=1 regardless of the prior value — same code path as
  # blocking with no prior row (the upsert's INSERT vs UPDATE arm is MySQL-internal).
  Scenario: Blocking a topic that was explicitly unblocked re-blocks it
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: unblocking a topic whose row already has blocked=0.
  # ON DUPLICATE KEY UPDATE sets blocked=0 on an already-0 row — same code path as unblocking a
  # blocked row (the upsert executes regardless; only the value changes).
  Scenario: Unblocking an already-unblocked topic is idempotent
    Already-unblocked means a row with blocked=0 exists. Upserting blocked=0 again succeeds
    silently — the UPSERT does not distinguish INSERT from UPDATE at the API level.
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be unblocked in the flags database [topic-flags-upsert, patch-response]

  # ── State consistency round-trips ───────────────────────────────────────────

  Scenario: GET reflects a topic that was just blocked
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be blocked in the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  # After unblocking, the row stays with blocked=false — the topic appears in GET as false, not absent.
  # This differs from the previous file-based implementation where unblocking deleted the row.
  Scenario: Unblocking preserves a topic in the listing as explicitly unblocked instead of removing it
    Given the topic "orders" has delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be unblocked in the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | false   |

  Scenario: Unblocking one topic does not affect other blocked topics
    Given the topics "orders" and "payments" have delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should be unblocked in the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic    | blocked |
      | orders   | false   |
      | payments | true    |

  # ── Valid Kafka topic-name variants ─────────────────────────────────────────

  # Kafka topic names allow hyphens; the flag key is the topic name verbatim.
  Scenario: Blocking a topic name containing hyphens is accepted
    When I block delivery for topic "order-events"
    Then the response status should be 200
    And delivery for topic "order-events" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # Kafka topic names allow dots and underscores.
  Scenario: Blocking a topic name with dots and underscores is accepted
    When I block delivery for topic "order.events_v2"
    Then the response status should be 200
    And delivery for topic "order.events_v2" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # ── Extra fields in PATCH body ───────────────────────────────────────────────

  Scenario: PATCH with extra unknown fields in the body ignores them and succeeds
    When I block delivery for topic "orders" with extra fields in the body
    Then the response status should be 200
    And delivery for topic "orders" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # ── Former prototype-pollution bug — now fixed ────────────────────────────────

  # Previously: config.flags['__proto__'] = {...} invoked the Object.prototype.__proto__ setter
  # rather than creating an own key; JSON.stringify omitted the result → write was silently empty.
  # The parameterized SQL query stores the topic name as a plain VARCHAR — no prototype access,
  # no silent data loss. See COLLECTED-WISDOM.md § "Prototype pollution via __proto__ topic name".
  Scenario: Blocking a topic named "__proto__" correctly creates a blocked row
    When I block delivery for topic "__proto__"
    Then the response status should be 200
    And delivery for topic "__proto__" should be blocked in the flags database [topic-flags-upsert, patch-response]

  # ── Framework-owned protocol surface on /api/flags ─────────────────────────────
  # express.json() rejects a malformed or oversized body before the flags listing
  # handler runs; Express auto-derives HEAD from GET /api/flags; an unregistered
  # method falls through to a 404. These are app-wide behaviors reachable here.

  Scenario: Listing delivery flags rejects a malformed JSON body
    When I request the flags endpoint with a malformed JSON body
    Then the response status should be 400

  Scenario: Listing delivery flags rejects an oversized JSON body
    When I request the flags endpoint with an oversized JSON body
    Then the response status should be 413

  Scenario: HEAD request to the flags listing returns no body
    When I send a HEAD request to the flags endpoint
    Then the response status should be 200
    And the response body should be empty

  Scenario: Unsupported method on the flags endpoint is rejected
    When I send an unsupported PUT request to the flags endpoint
    Then the response status should be 404
    And no delivery flag should have been modified
