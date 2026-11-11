import crypto from 'crypto';
import http from 'http';
import path from 'path';
import supertest from 'supertest';
import { World, IWorldOptions, setWorldConstructor, BeforeAll, AfterAll, Before } from '@cucumber/cucumber';
import { setCurrentScenarioId, currentScenarioId, INIT_SENTINEL } from './scenario-context';
import { auditFakeWiring, WiredFake } from './fake-registry';
import './network-guard'; // refuses non-loopback TCP, so an unfaked IO client fails loudly
import './fakes/fake-fetch'; // replaces global.fetch and registers with fake-registry
import './fakes/non-determinism'; // patches crypto.randomUUID and setTimeout for scenario isolation
import { subscribersFake, deliveryLogFake, topicFlagsFake, dbIndexFake, mysql2SafetyNet } from './fakes/fake-db';
import { openfeatureFake } from './fakes/fake-openfeature';
import { initKafkaFake, reseatKafkaConsumer, createFakeConsumer } from './fakes/fake-kafka';
import * as fakeDbApi from './fakes/fake-db';
import * as fakeFetchApi from './fakes/fake-fetch';
import * as fakeKafkaApi from './fakes/fake-kafka';
import * as fakeOpenFeatureApi from './fakes/fake-openfeature';
import * as nonDeterminismApi from './fakes/non-determinism';

// ---- Pre-stub IO boundaries in require.cache ----
//
// Each boundary is seeded before any app module loads so a plain require() of the app
// finds the fakes transitively. seedRequireCache records each entry in wiredFakes for the
// boot-time identity audit. See COLLECTED-WISDOM.md § "Module Loading" for why not proxyquire.

const wiredFakes: WiredFake[] = [];

type WiringMeta = Pick<WiredFake, 'boundary' | 'category' | 'api' | 'registryName'>;

function seedRequireCache(specifier: string, fake: unknown, meta: WiringMeta): void {
  // Node built-ins can't be whole-module-seeded: bare and `node:`-prefixed specifiers are distinct
  // require.cache keys for one shared-singleton exports object, so seeding one silently misses requirers
  // using the other. Method-patch the required module object instead (see non-determinism.ts for crypto).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require('module').isBuiltin(specifier)) {
    throw new Error(`[world] seedRequireCache: '${specifier}' is a Node built-in — method-patch the module object instead of whole-module seeding`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cacheKey = require.resolve(specifier);
  if (require.cache[cacheKey]) {
    throw new Error(`[world] seedRequireCache: '${specifier}' already in require.cache — seed before any app module loads`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require.cache as any)[cacheKey] = {
    id: cacheKey, filename: cacheKey, loaded: true, parent: null, children: [], paths: [],
    exports: fake,
  };
  wiredFakes.push({ ...meta, cacheKey, fake });
}

// Global patchers (global.fetch replacements, fs patches, crypto/setTimeout overrides) have no
// require.cache key. Included in wiredFakes for boundary-coverage check only; identity check skipped.
function addGlobalFake(meta: WiringMeta): void {
  wiredFakes.push({ ...meta, cacheKey: null, fake: null });
}

// The database is faked at the repository seam (src/db/*), not at the mysql2 driver: emulating SQL is
// impractical, and fake-db's parity suite compares these fakes against the real repositories on a real
// MySQL. dist/db/index is faked too (connect/ping/close); mysql2/promise stays a throw-on-use safety net.
const distDb = (name: string) => path.join(__dirname, '../../../dist/db', name);
const dbMeta = { category: 'data-store', api: fakeDbApi, registryName: 'db' };
seedRequireCache(distDb('subscribers'), subscribersFake, { ...dbMeta, boundary: 'db/subscribers' });
seedRequireCache(distDb('deliveryLog'), deliveryLogFake, { ...dbMeta, boundary: 'db/deliveryLog' });
seedRequireCache(distDb('topicFlags'), topicFlagsFake, { ...dbMeta, boundary: 'db/topicFlags' });
seedRequireCache(distDb('index'), dbIndexFake, { ...dbMeta, boundary: 'db/index' });
seedRequireCache('mysql2/promise', mysql2SafetyNet, { boundary: 'mysql2/promise', category: 'no-op-stub' });

// dist/kafka/consumer.js only instantiates `new Kafka(...)` in startConsumer(), which reseatKafkaConsumer()
// calls. The consumer is inert (no broker connection). Its subscribe / run / stop / commitOffsets calls are
// recorded and owned like any other write — see fake-kafka.ts; its parity suite compares them with a real broker.
const kafkaStub = {
  Kafka: class {
    // A model of the real consumer (fake-kafka.ts): its lifecycle calls are owned effects and can fail().
    consumer(config: { groupId: string }) {
      return createFakeConsumer(config);
    }
  },
};
seedRequireCache('kafkajs', kafkaStub, { boundary: 'kafkajs', category: 'external-service', api: fakeKafkaApi, registryName: 'kafka-inbound' });

seedRequireCache('@openfeature/server-sdk', openfeatureFake, {
  boundary: '@openfeature/server-sdk', category: 'flag-interceptor', api: fakeOpenFeatureApi, registryName: 'openfeature',
});

// Global patchers (side effects from the imports at the top of this file)
addGlobalFake({ boundary: 'fetch', category: 'external-service', api: fakeFetchApi, registryName: 'fetch' });
addGlobalFake({ boundary: 'non-determinism', category: 'global-patcher', api: nonDeterminismApi, registryName: 'non-determinism' });

// ---- App singleton (shared across scenarios) ----
let request: ReturnType<typeof supertest>;
let server: http.Server;

BeforeAll(async function () {
  // Set sentinel so flag fakes can distinguish init-time reads (pass through) from
  // scenario-time reads (enforce strictness).
  setCurrentScenarioId(INIT_SENTINEL);

  // dist/db/index is the fake (seeded above); connect() mirrors production startup and is a no-op.
  // The plain require('./dist/api/index') below finds the same cached fakes (no proxyquire cache eviction).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require(path.join(__dirname, '../../../dist/db/index'));
  await db.connect();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createApp } = require(path.join(__dirname, '../../../dist/api/index'));
  // One shared server on the IPv4 loopback. supertest's default is a fresh `listen(0)` on `::` per request, and
  // macOS lets that bind a port another process (an IDE, a VM forwarder) already holds on 127.0.0.1, so the request
  // to 127.0.0.1:<port> reaches the stranger: an intermittent empty 404, or a run that never exits.
  server = http.createServer(createApp());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  request = supertest(server);

  // Mirror production startup: initFlags() sets flagsInitialized=true so isFlagsReady()
  // returns true. dist/flags/index is already in require.cache (loaded by createApp above).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flagsModule = require(path.join(__dirname, '../../../dist/flags/index'));
  await flagsModule.initFlags();

  // Gives dist/kafka/consumer its stub consumer, so handleMessage()'s commitOffsets() doesn't throw.
  await initKafkaFake();

  // Verify every IO boundary is wired and still at its cache key after the app loaded.
  const bootstrapBoundaries = [
    'db/subscribers', 'db/deliveryLog', 'db/topicFlags', 'db/index', 'mysql2/promise',
    'kafkajs', '@openfeature/server-sdk', 'fetch', 'non-determinism',
  ];
  auditFakeWiring(bootstrapBoundaries, wiredFakes);
});

// ---- Per-scenario lifecycle ----
Before(async function () {
  this.scenarioId = crypto.randomUUID();
  setCurrentScenarioId(this.scenarioId);
  this.request = request;
  // The consumer module keeps subscribedTopics/isRunning at module level; give each scenario a fresh copy so
  // what it observes (does registering "orders" subscribe?) never depends on which scenarios ran before.
  await reseatKafkaConsumer();
});

// ---- World constructor ----
export class WebhooksWorld extends World {
  scenarioId!: string;
  request!: ReturnType<typeof supertest>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response?: any; // populated by When steps that make HTTP requests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses?: any[]; // populated by When steps that make several HTTP requests at once (in request order)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registrationResponses: any[] = []; // every POST /api/subscribers response the register steps got, in order
  seededSubscriberId?: number; // set by Given steps that seed a specific subscriber ID
  seededSubscriberUrls: string[] = []; // accumulated by every subscriber-seeding Given step
  seededSubscriberIds: number[] = [];  // accumulated by every subscriber-seeding Given step
  dispatchedPayload?: string | null; // set by Kafka When steps; null means message.value was null
  dispatchedKey?: string | null; // set by Kafka When steps; read by delivery log assertion steps
  dispatchedPayloadByKey = new Map<string, string>(); // keyed dispatches, so a multi-message Then expects each row's own payload
  thrownError?: Error | null; // set by error-path When steps that catch infrastructure failures
  injectedErrors: Error[] = []; // every Error a failure-injecting Given handed a fake, so a Then can check the thrown one by identity
  seededSubscriberHeaders?: Record<string, string>; // set when seeding a subscriber with custom headers
  // The registration request body a POST When step sent — lets Then steps build expected values from
  // the submitted input rather than reading them back out of the captured INSERT (a tautology).
  lastSubscriberRequest?: { name: string; topic: string; url: string; headers: Record<string, string> };
  _skippedDefaults?: Set<string>;

  constructor(options: IWorldOptions) {
    super(options);
  }

  /** The payload the keyed message was dispatched with; throws if no message was sent with that key. */
  payloadSentWithKey(key: string): string {
    const payload = this.dispatchedPayloadByKey.get(key);
    if (payload === undefined) throw new Error(`[world] no Kafka message was dispatched with key "${key}" in this scenario`);
    return payload;
  }

  /**
   * Inject a failure through the World so the scenario id can't be the wrong one:
   * `this.failFake(fakeDb, 'deliveryLog.logAttempt', [err])` rather than `fail(this.scenarioId, …)`.
   */
  failFake<Op extends string, Seq>(fake: { fail(scenarioId: string, operation: Op, sequence: Seq): void }, operation: Op, sequence: Seq): void {
    fake.fail(this.scenarioId, operation, sequence);
  }
}

setWorldConstructor(WebhooksWorld);

AfterAll(async function () {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
