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
  # Flag state lives in the same MySQL instance as the rest of the platform state, behind the OpenFeature SDK
  # (MySqlFlagsProvider) so the flags IO boundary stays distinct and testable.
  # Design rationale: CLAUDE.md § "Architecture decisions that are intentional". No external ticket.

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

  # The listing is a JSON object keyed by topic, built in the order the GET query returns rows (ORDER BY
  # topic), so the order a client sees is alphabetical, not insertion order.
  Scenario: The delivery flag listing is sorted by topic name
    Given the topics "payments" and "orders" have delivery blocked in the flags database
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should contain, in this order:
      | topic    | blocked |
      | orders   | true    |
      | payments | true    |

  # The listing is built by assigning each row to a plain object (result[topic] = blocked). For the topic
  # "__proto__" that assignment hits Object.prototype's __proto__ setter, which ignores a boolean, so the
  # row is stored and enforced but missing from the listing (and from the UI built on it).
  # Characterizes current behaviour, not an endorsement: see flags.implementation-notes.md
  # § "Known Production Bugs" and COLLECTED-WISDOM.md § "JS prototype pollution via bracket-notation
  # assignment on plain objects".
  Scenario: A topic named "__proto__" is silently missing from the delivery flag listing
    Given the topics "__proto__" and "orders" have delivery blocked in the flags database
    When I list all delivery flags
    Then the response status should be 200
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  # ── PATCH /api/flags/:topic — validation ───────────────────────────────────

  # Validation runs before any DB IO — a 400 produces no topic_flags upsert. The guard is typeof, so the
  # falsy and truthy look-alikes of a boolean (0, 1, "", "true") are rejected like any other non-boolean.
  # Every row is meant to behave the same way.
  Scenario Outline: PATCH rejects non-boolean delivery_blocked values
    When I attempt to PATCH delivery blocked for topic "orders" with delivery_blocked as <type>
    Then the response status should be 400
    And the error response body should be "delivery_blocked must be a boolean"
    And no delivery flag should have been modified

    Examples:
      | type         |
      | missing      |
      | null         |
      | number       |
      | zero         |
      | object       |
      | array        |
      | string       |
      | empty-string |

  # express.json() answers these before the PATCH handler runs, so they never reach the upsert.
  Scenario: A flag update with a malformed JSON body is rejected without touching the flags
    When I send a flag update for topic "orders" with a malformed JSON body
    Then the response status should be 400
    And no delivery flag should have been modified

  Scenario: A flag update with an oversized JSON body is rejected without touching the flags
    When I send a flag update for topic "orders" with an oversized JSON body
    Then the response status should be 413
    And no delivery flag should have been modified

  # A body that is not declared as JSON is left unparsed: the handler sees no delivery_blocked field and
  # rejects it like a missing one.
  Scenario: A flag update sent as plain text is rejected as a missing delivery_blocked value
    When I send a flag update for topic "orders" as plain text instead of JSON
    Then the response status should be 400
    And the error response body should be "delivery_blocked must be a boolean"
    And no delivery flag should have been modified

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
    And the delivery flag write blocking topic "orders" should have been attempted and failed with "Connection refused" [topic-flags-upsert]

  Scenario: Unblocking fails with a server error when the database is unavailable
    Given the database is unavailable
    When I unblock delivery for topic "orders"
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the delivery flag write unblocking topic "orders" should have been attempted and failed with "Connection refused" [topic-flags-upsert]

  # Belt-and-suspenders: a body the route rejects is answered by express.json() or the typeof guard,
  # neither of which touches the database, so an outage cannot turn the rejection into a 500.
  Scenario Outline: A rejected flag update is rejected the same way while the database is unavailable — <body> body
    Given the database is unavailable
    When I send a flag update for topic "orders" whose body is <body>
    Then the response status should be <status>
    And no delivery flag should have been modified

    Examples:
      | body           | status |
      | malformed-json | 400    |
      | oversized      | 413    |
      | plain-text     | 400    |
      | non-boolean    | 400    |

  # Unknown fields are dropped before the upsert, so a failing database sees the same write either way.
  Scenario: A block request with extra fields fails with a server error when the database is unavailable
    Given the database is unavailable
    When I block delivery for topic "orders" with extra fields in the body
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the delivery flag write blocking topic "orders" should have been attempted and failed with "Connection refused" [topic-flags-upsert]

  # Belt-and-suspenders: getAll() rejects before any row is read, so what the table holds cannot change
  # the 500 the listing answers with.
  Scenario Outline: The delivery flag listing fails with a server error whatever the table holds — a topic <state>
    Given the topic "orders" has delivery <state> in the flags database
    And the database is unavailable
    When I list all delivery flags
    Then the response status should be 500
    And the error response body should be "Internal server error"

    Examples:
      | state                |
      | blocked              |
      | explicitly unblocked |

  # ── PATCH /api/flags/:topic ─────────────────────────────────────────────────
  # These own the write the handler sends (topicFlags.upsert's arguments) and the response, not the row it leaves:
  # insert-vs-update-in-place is MySQL's ON DUPLICATE KEY, pinned by fake-db.parity.ts "topicFlags.upsert — inserts,
  # then updates in place". Scenarios that list the flags afterwards show the resulting row.

  Scenario: An operator's block of a topic is recorded in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: blocking an already-blocked topic upserts identically — no guard in handler.
  Scenario: Re-blocking an already-blocked topic is accepted and recorded again
    Given the topic "orders" has delivery blocked in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: An operator's unblock of a blocked topic is recorded in the flags database
    Given the topic "orders" has delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]

  # Three-state: unblocking a never-blocked topic upserts blocked=0 — the topic was "unmanaged"
  # before and is now "explicitly unblocked". It will appear in GET as { orders: false }.
  Scenario: Unblocking a never-blocked topic records an explicit unblocked flag
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: blocking a topic whose row already has blocked=0 (explicitly unblocked).
  # ON DUPLICATE KEY UPDATE sets blocked=1 regardless of the prior value — same code path as
  # blocking with no prior row (the upsert's INSERT vs UPDATE arm is MySQL-internal).
  Scenario: An operator can re-block a topic that was explicitly unblocked
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # Belt-and-suspenders: unblocking a topic whose row already has blocked=0.
  # ON DUPLICATE KEY UPDATE sets blocked=0 on an already-0 row — same code path as unblocking a
  # blocked row (the upsert executes regardless; only the value changes).
  Scenario: Unblocking an already-unblocked topic is accepted and recorded again
    Already-unblocked means a row with blocked=0 exists. Upserting blocked=0 again succeeds
    silently — the UPSERT does not distinguish INSERT from UPDATE at the API level.
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]

  # A client retry or double click sends the same request twice. Nothing dedupes it: each request upserts,
  # and the second leaves the row exactly as the first did.
  Scenario: Sending the same block request twice writes the flag twice and leaves one blocked row
    When I block delivery for topic "orders" twice
    Then both requests should have written topic "orders" as blocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  # topic_flags' primary key uses MySQL's case-insensitive collation and ON DUPLICATE KEY UPDATE only
  # touches `blocked`, so "Orders" lands on the existing "orders" row and the stored spelling stays
  # "orders" — while the response echoes "Orders". The flag cache is exact-case, so the block never applies
  # to messages on "Orders" (flag-provider.feature).
  # Characterizes current behaviour, not an endorsement: see flags.implementation-notes.md
  # § "Known Production Bugs" (case-variant topic blocks).
  Scenario: Blocking a differently-cased spelling of a managed topic updates the existing row under its old spelling
    Given the topic "orders" has delivery explicitly unblocked in the flags database
    When I block delivery for topic "Orders"
    Then the response status should be 200
    And delivery for topic "Orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  # ── State consistency round-trips ───────────────────────────────────────────

  Scenario: GET reflects a topic that was just blocked
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | true    |

  Scenario: Unblocking preserves a topic in the listing as explicitly unblocked instead of removing it
    Given the topic "orders" has delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic  | blocked |
      | orders | false   |

  Scenario: Unblocking one topic does not affect other blocked topics
    Given the topics "orders" and "payments" have delivery blocked in the flags database
    When I unblock delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as unblocked to the flags database [topic-flags-upsert, patch-response]
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
    And delivery for topic "order-events" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # Kafka topic names allow dots and underscores.
  Scenario: Blocking a topic name with dots and underscores is accepted
    When I block delivery for topic "order.events_v2"
    Then the response status should be 200
    And delivery for topic "order.events_v2" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # topic_flags.topic is VARCHAR(255) and the handler does not check length, so MySQL is the only guard.
  Scenario: Blocking a topic name of exactly 255 characters is accepted
    When I block delivery for a topic name of 255 characters
    Then the response status should be 200
    And delivery for the 255-character topic should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: Blocking a topic name longer than 255 characters fails with a server error
    When I block delivery for a topic name of 256 characters
    Then the response status should be 500
    And the error response body should be "Internal server error"
    And the delivery flag write for the 256-character topic should have been rejected by MySQL as too long [topic-flags-upsert]

  # The topic is the path segment after Express decodes it: a percent-encoded slash becomes part of the
  # topic, while a literal slash makes a different path that no flags route matches.
  Scenario: A percent-encoded slash in the topic segment is decoded into the stored topic name
    When I block delivery for the raw URL path segment "orders%2Fv2"
    Then the response status should be 200
    And delivery for topic "orders/v2" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: A topic path containing a literal slash matches no flags route
    When I block delivery for the raw URL path segment "orders/v2"
    Then the response status should be 404
    And no delivery flag should have been modified

  Scenario: A flag update that names no topic matches no flags route
    When I block delivery without naming a topic
    Then the response status should be 404
    And no delivery flag should have been modified

  # ── Extra fields in PATCH body ───────────────────────────────────────────────

  Scenario: PATCH with extra unknown fields in the body ignores them and succeeds
    When I block delivery for topic "orders" with extra fields in the body
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # ── "__proto__" on the write side ─────────────────────────────────────────────
  # The write is safe: the topic reaches the repository as a plain string. The read side drops it: see
  # "A topic named "__proto__" is silently missing from the delivery flag listing".
  # COLLECTED-WISDOM.md § "JS prototype pollution via bracket-notation assignment on plain objects".
  Scenario: A block of a topic named "__proto__" is recorded, not lost on the write
    When I block delivery for topic "__proto__"
    Then the response status should be 200
    And delivery for topic "__proto__" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

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

  # ── Hostile and unusual topic names ─────────────────────────────────────────

  # Pins only that the handler passes the topic to the repository unchanged and lists it back. The fake repository
  # never runs SQL, so binding (no interpolation) is checked by fake-db.parity.ts § "Parameter binding: SQL-special characters".
  Scenario: A topic name containing SQL metacharacters reaches the flags store unchanged and is listed back literally
    When I block delivery for topic "orders'; DROP TABLE topic_flags; --"
    Then the response status should be 200
    And delivery for topic "orders'; DROP TABLE topic_flags; --" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic                               | blocked |
      | orders'; DROP TABLE topic_flags; -- | true    |

  Scenario: Blocking a topic name containing HTML markup stores it verbatim
    When I block delivery for the raw URL path segment "%3Cscript%3Ealert(1)%3C%2Fscript%3E"
    Then the response status should be 200
    And delivery for topic "<script>alert(1)</script>" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: Blocking a topic name containing non-ASCII characters stores it verbatim
    When I block delivery for topic "заказы-注文"
    Then the response status should be 200
    And delivery for topic "заказы-注文" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  Scenario: A percent-encoded path traversal in the topic segment is stored as a plain topic name
    When I block delivery for the raw URL path segment "..%2F..%2Fetc%2Fpasswd"
    Then the response status should be 200
    And delivery for topic "../../etc/passwd" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]

  # ── Interactions between managed topics ─────────────────────────────────────

  # The upsert is keyed by topic, so writing one row must leave every other row's state as it was.
  Scenario: Blocking one topic does not affect an explicitly unblocked topic
    Given the topic "payments" has delivery explicitly unblocked in the flags database
    When I block delivery for topic "orders"
    Then the response status should be 200
    And delivery for topic "orders" should have been written as blocked to the flags database [topic-flags-upsert, patch-response]
    And I list all delivery flags
    And the delivery flag listing should contain exactly:
      | topic    | blocked |
      | orders   | true    |
      | payments | false   |

  # ── Unsupported methods on a topic path ─────────────────────────────────────

  # Only PATCH is routed on /api/flags/:topic, so there is no way to delete a flag row through the API.
  # (A GET there falls through to the SPA catch-all, which serves index.html in the built image; the BDD
  # harness has no frontend build, so that case is not pinned here.)
  Scenario: A DELETE request to a single topic's flag path matches no route
    Given the topic "orders" has delivery blocked in the flags database
    When I request the flag path for topic "orders" with method "DELETE"
    Then the response status should be 404
    And no delivery flag should have been modified
