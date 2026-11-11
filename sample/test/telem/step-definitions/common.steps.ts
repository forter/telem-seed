import assert from 'assert';
import { When, Then } from '@cucumber/cucumber';
import { WebhooksWorld } from '../support/world';

// Used by: health-check.feature, subscribers.feature, flags.feature
Then<WebhooksWorld>('the response status should be {int}', function (status: number) {
  // Several registrations in a row: each overwrote this.response, so check every one, not just the last.
  const regs = this.registrationResponses;
  if (regs.length > 1 && regs[regs.length - 1] === this.response) {
    assert.deepStrictEqual(
      regs.map((r) => r.status),
      regs.map(() => status),
      `Expected every registration in this scenario to answer HTTP ${status}. ` +
        `Bodies: ${JSON.stringify(regs.map((r) => r.body)).slice(0, 400)}`,
    );
  }
  assert.strictEqual(
    this.response.status,
    status,
    `Expected HTTP ${status} but got ${this.response.status}. ` +
      `Probable cause: request failed or reached the wrong handler. ` +
      `What to check: verify the route handler for this endpoint returns ${status}; check middleware (express.json(), validators) for early-exit paths that may have intercepted the request. ` +
      `Response body: ${JSON.stringify(this.response.body)}`,
  );
});

// ── Framework-owned protocol surface (shared across all HTTP endpoints) ─────────
// These exercise app-wide behaviour that sits in front of every route handler:
// express.json() body rejection, Express's auto-derived HEAD, and method routing.
// The endpoint is named (not spelled as a URL) because Cucumber expressions treat
// "/" as an alternative separator — a literal path throws at parse time.
const ENDPOINT_PATHS: Record<string, string> = {
  health: '/health',
  subscribers: '/api/subscribers',
  flags: '/api/flags',
};

function endpointPath(name: string): string {
  const p = ENDPOINT_PATHS[name];
  if (!p) throw new Error(`Unknown endpoint name "${name}" — add it to ENDPOINT_PATHS in common.steps.ts`);
  return p;
}

When<WebhooksWorld>('I request the {word} endpoint with a malformed JSON body', async function (name: string) {
  this.response = await this.request.get(endpointPath(name)).type('json').send('{ this is not valid json }');
});

When<WebhooksWorld>('I request the {word} endpoint with an oversized JSON body', async function (name: string) {
  // express.json()'s default limit is 100kb; 200kb forces a 413 before the handler runs.
  const oversized = JSON.stringify({ payload: 'x'.repeat(200 * 1024) });
  this.response = await this.request.get(endpointPath(name)).type('json').send(oversized);
});

When<WebhooksWorld>('I send a HEAD request to the {word} endpoint', async function (name: string) {
  this.response = await this.request.head(endpointPath(name));
});

When<WebhooksWorld>('I send an unsupported PUT request to the {word} endpoint', async function (name: string) {
  this.response = await this.request.put(endpointPath(name));
});

Then<WebhooksWorld>('the response body should be empty', function () {
  assert.ok(
    !this.response.text,
    `Expected an empty response body but got: ${JSON.stringify(this.response.text)}. ` +
      `Probable cause: a HEAD request unexpectedly returned a body, or Express did not strip the GET body for HEAD. ` +
      `What to check: the route handler must not write a body that survives HEAD stripping.`,
  );
});
