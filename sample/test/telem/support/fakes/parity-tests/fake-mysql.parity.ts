/**
 * Parity test stub: fake-mysql vs real MySQL 8
 *
 * STATUS: Blocked — see REQUIREMENTS.md for what's needed to unblock.
 *
 * This file intentionally contains no runnable code. Cucumber loads all files
 * under test/telem/support/, so parity tests must not define top-level describe()
 * or it() blocks (those belong to Mocha, not Cucumber).
 *
 * To implement: run `/telem-bdd-node:unblock-parity` once REQUIREMENTS.md is satisfied.
 * That skill will add a dedicated Mocha suite in a separate test runner config.
 *
 * ---- What will be tested once unblocked --------------------------------
 *
 * For each query shape, the parity suite will:
 *   1. Run it against a real mysql2/promise pool (env from REQUIREMENTS.md).
 *   2. Run the equivalent seedSubscribers() + pool.query() against the fake.
 *   3. Assert structural equality: same field names, same JS types, same row count.
 *
 * Query shapes to cover:
 *
 *   READ — listAll()
 *     SELECT id, name, topic, url, headers, created_at FROM subscribers ORDER BY id
 *     → headers must arrive as a JSON string from both real DB and fake
 *
 *   READ — findByTopic(topic)
 *     SELECT id, name, topic, url, headers, created_at FROM subscribers WHERE topic = ?
 *     → only rows matching the topic param are returned
 *
 *   READ — findDistinctTopics()
 *     SELECT DISTINCT topic FROM subscribers
 *     → one { topic } row per unique topic value
 *
 *   WRITE — create(...)
 *     INSERT INTO subscribers (name, topic, url, headers) VALUES (?, ?, ?, ?)
 *     → result[0].insertId is a positive integer
 *
 *   WRITE — remove(id) — existing row
 *     DELETE FROM subscribers WHERE id = ?
 *     → result[0].affectedRows === 1
 *
 *   WRITE — remove(id) — missing row
 *     DELETE FROM subscribers WHERE id = ?
 *     → result[0].affectedRows === 0
 *
 *   WRITE — logAttempt(...)
 *     INSERT INTO delivery_log (...) VALUES (?, ?, ?, ?, ?, ?, ?)
 *     → no error; result[0] is an object (OkPacket)
 */

export {};
