import assert from 'assert';
import { Given, Then } from '@cucumber/cucumber';
import { throwIfAnyUnownedExist } from '../support/fake-registry';
import { takeOwnershipOfSubscriberInsert, failAllMysql } from '../support/fakes/fake-mysql';
import type { WebhooksWorld } from '../support/world';

Given('a subscriber is created via the API without claiming ownership', async function (this: WebhooksWorld) {
  // POST /api/subscribers — writes to the MySQL fake (one unowned INSERT).
  // Intentionally NOT claiming ownership here — the Then step verifies the check catches it.
  const res = await this.request
    .post('/api/subscribers')
    .send({ name: 'Meta Test Sub', topic: 'meta-test', url: 'https://meta.example.com/wh' });
  assert.strictEqual(
    res.status, 201,
    `POST /api/subscribers returned ${res.status}. Check that the MySQL fake is wired and db.connect() was called in BeforeAll. Response: ${JSON.stringify(res.body)}`,
  );
});

Given('the MySQL fake is configured to fail', function (this: WebhooksWorld) {
  failAllMysql(this.scenarioId, [new Error('Injected DB failure')]);
});

Then('the unowned IO check catches the unclaimed subscriber write', function (this: WebhooksWorld) {
  // Verify the check throws before ownership is claimed.
  let caught: Error | undefined;
  try {
    throwIfAnyUnownedExist(this.scenarioId);
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(
    caught !== undefined,
    'throwIfAnyUnownedExist did not throw. Probable cause: fake-registry not wired or INSERT not captured. Check that fake-mysql registered itself and the POST route ran.',
  );
  assert.ok(
    caught.message.toLowerCase().includes('subscriber insert') || caught.message.toLowerCase().includes('insert'),
    `Error message did not mention a subscriber insert. Got: "${caught.message}". Check fake-mysql's throwIfUnownedExist reports inserts.`,
  );
  // Claim ownership now so the After hook does not throw a second time (by the URL POSTed above).
  takeOwnershipOfSubscriberInsert(this.scenarioId, 'https://meta.example.com/wh');
});
