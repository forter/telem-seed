# Parity Test Requirements: fake-mysql

## Status: Blocked

The `fake-mysql` parity test requires a running MySQL instance loaded with the webhooks schema.
No such instance is available in the standard CI environment without Docker.

## What the owner team must supply

1. **A running MySQL 8 instance** reachable at `MYSQL_HOST`/`MYSQL_PORT` (defaults: `localhost:3306`).
2. **The webhooks schema** applied from `init.sql` at the repo root:
   ```bash
   mysql -u webhooks -pwebhooks webhooks < init.sql
   ```
3. **Env vars** set before running the parity suite:
   | Var | Expected value |
   |-----|----------------|
   | `MYSQL_HOST` | host of the MySQL instance |
   | `MYSQL_PORT` | port (default 3306) |
   | `MYSQL_USER` | `webhooks` |
   | `MYSQL_PASSWORD` | `webhooks` |
   | `MYSQL_DATABASE` | `webhooks` |
   | `PARITY_MYSQL` | `true` (gate flag; parity test skips unless set) |

## What will be tested

Once unblocked, `fake-mysql.parity.ts` will:

- Run every SQL query shape used by production code against the real DB and the fake side-by-side.
- Assert that SELECT results have the same shape, row count, and field types.
- Assert that INSERT returns an auto-incremented `insertId`.
- Assert that DELETE returns `affectedRows: 1` for an existing row and `0` for a missing row.
- Assert that `delivery_log` INSERT succeeds silently (no error).
- Verify that `headers` arrives as a JSON string from the real DB (matching what the fake returns).

## How to unblock

Run `/telem-bdd-node:unblock-parity` once the MySQL instance is available.
