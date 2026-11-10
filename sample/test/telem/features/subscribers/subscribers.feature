Feature: Manage webhook subscribers

  # ── List subscribers ──────────────────────────────────────────────────────────

  Scenario: Registered subscribers appear in registration order
    Given a subscriber "Payments Service" with ID 1 listens for topic "orders" at URL "https://payments.example.com/hook"
    And a subscriber "Audit Logger" with ID 2 listens for topic "transactions" at URL "https://audit.example.com/events"
    When I list all subscribers
    Then the response status should be 200
    And the subscriber list should contain exactly:
      | id | name             | topic        | url                               | headers | created_at               |
      | 1  | Payments Service | orders       | https://payments.example.com/hook | {}      | 2024-01-01T00:00:00.000Z |
      | 2  | Audit Logger     | transactions | https://audit.example.com/events  | {}      | 2024-01-01T00:00:00.000Z |

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

  # ── Belt-and-suspenders ──────────────────────────────────────────────────────
  # Covers decision-table cells confirmed by code inspection to share the same catch
  # block as an existing scenario. Guards against future refactors coupling axes.

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

  Scenario: Database failure when removing a subscriber returns internal server error
    Given the database is unavailable
    When I delete subscriber 1
    Then the response status should be 500
    And the error response body should be "Internal server error"

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

  Scenario: Registration accepts a whitespace-only topic as submitted
    When I register subscriber "Payments Service" for topic "   " at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Injection and special characters stored literally ─────────────────────────
  # SQL-special chars, XSS payloads, and path-traversal sequences are stored and
  # returned verbatim without sanitization. Real SQL-injection safety belongs to
  # the MySQL parity test; the fake receives already-bound params and never
  # evaluates them as SQL.

  Scenario Outline: Special characters in subscriber fields are stored and returned literally
    When I register subscriber "<name>" for topic "<topic>" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

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
  # 500-character name exercises VARCHAR column limits and JSON serialization.

  Scenario: Subscriber registration with a very long name is stored and returned correctly
    When I register subscriber "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" for topic "orders" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

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
    And subscriber 1 has been deleted
    When I list all subscribers
    Then the response status should be 200
    And the subscriber list should be empty

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
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

    Examples:
      | url                                       |
      | https://analytics.example.com/hook#events |
      | https://user:secret@example.com/hook      |
      | http://192.168.1.100/hook                 |
      | https://staging.example.com:8443/hook     |
      | HTTPS://example.com/hook                  |

  # ── Very long topic ───────────────────────────────────────────────────────────
  # 500-character topic exercises VARCHAR column limits.

  Scenario: Subscriber registration with a very long topic is stored and returned correctly
    When I register subscriber "Payments Service" for topic "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

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

  # ── SQL injection in custom header name ───────────────────────────────────────
  # Headers are stored in a JSON column, not in a SQL column name, so injection
  # in the key has no SQL effect. Verify the key is stored and returned literally.

  Scenario: Custom header with SQL injection in the key name is stored and returned literally
    When I register subscriber "Injection Service" for topic "orders" at URL "https://payments.example.com/hook" with headers:
      | '; DROP TABLE subscribers; -- | safe-value |
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

  # ── Topic with a space ────────────────────────────────────────────────────────
  # A space-containing topic is truthy (passes !topic), passes URL validation
  # (topic is not part of the URL), so it should be accepted as submitted.

  Scenario: Registration accepts a topic name containing a space
    When I register subscriber "Payments Service" for topic "order placed" at URL "https://payments.example.com/hook"
    Then the response status should be 201
    And the registered subscriber should match the submitted data [subscriber-insert, post-response]

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
