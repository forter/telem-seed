# How to block network connections during tests

The outbound block is a `BeforeAll` / `before_all` hook. The mechanism only fails a scenario when unfaked code tries to reach the network.

Here are some examples showing how to execute the block:

## Example: Node
- **Outbound:** Pick any of three blocks in `BeforeAll`:
  - `nock.disableNetConnect()`, with `enableNetConnect('127.0.0.1')` allowed.
  - Replacing `http`/`https.globalAgent.createConnection` with a function that throws.
  - Overriding `dns.lookup` so every lookup fails.
- **Inbound:** For instance, for an HTTP server using `express`, `http.createServer` is faked, so the real `main()` runs but `listen()` does nothing. Scenarios drive the app through `supertest(app)`.

## Example: Python
- **Outbound:** two layers, installed in order in `before_all`.
  1. `responses` (for `requests`) or `respx` (for `httpx`). These give errors that name the URL nobody faked.
  2. A catch-all that replaces `socket.socket` with a class that raises, and `socket.getaddrinfo` with a function that raises.
- **Inbound:** the app is driven through framework test clients (`app.test_client()`, Starlette/Falcon `TestClient`), which call it as a WSGI/ASGI app with no socket.
