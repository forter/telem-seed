import crypto from 'crypto';
import path from 'path';
import supertest from 'supertest';
import { World, IWorldOptions, setWorldConstructor, BeforeAll, Before } from '@cucumber/cucumber';
import { setCurrentScenarioId, currentScenarioId, INIT_SENTINEL } from './scenario-context';
import { auditFakeWiring, WiredFake } from './fake-registry';
import './fakes/fake-fetch'; // replaces global.fetch and registers with fake-registry
import './fakes/non-determinism'; // patches crypto.randomUUID and setTimeout for scenario isolation
import { mysqlFake } from './fakes/fake-mysql';
import { openfeatureFake } from './fakes/fake-openfeature';
import { initKafkaFake, recordCommitOffsetsCall } from './fakes/fake-kafka';

// ---- Pre-stub IO boundaries in require.cache ----
//
// Each boundary is seeded before any app module loads so a plain require() of the app
// finds the fakes transitively. seedRequireCache records each entry in wiredFakes for the
// boot-time identity audit. See COLLECTED-WISDOM.md § "proxyquire @global: true" for why
// direct require.cache seeding replaced the earlier proxyquire approach.

const wiredFakes: WiredFake[] = [];

function seedRequireCache(specifier: string, fake: unknown, meta: { boundary: string; category: string }): void {
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
  wiredFakes.push({ boundary: meta.boundary, category: meta.category, cacheKey, fake });
}

// Global patchers (global.fetch replacements, fs patches, crypto/setTimeout overrides) have no
// require.cache key. Included in wiredFakes for boundary-coverage check only; identity check skipped.
function addGlobalFake(meta: { boundary: string; category: string }): void {
  wiredFakes.push({ boundary: meta.boundary, category: meta.category, cacheKey: null, fake: null });
}

seedRequireCache('mysql2/promise', mysqlFake, { boundary: 'mysql2/promise', category: 'data-store' });

// dist/kafka/consumer.js only instantiates `new Kafka(...)` in startConsumer(), which is
// bypassed in tests (createApp() does not call startConsumer()). The consumer stays null.
const kafkaStub = {
  Kafka: class {
    consumer() {
      return {
        connect: async () => {},
        subscribe: async () => {},
        run: async () => {},
        stop: async () => {},
        disconnect: async () => {},
        // Spy: records the call so scenarios can assert at-least-once semantics.
        commitOffsets: async () => {
          try {
            recordCommitOffsetsCall(currentScenarioId());
          } catch { /* no-op if called outside a scenario (e.g. during startConsumer()) */ }
        },
      };
    }
  },
};
seedRequireCache('kafkajs', kafkaStub, { boundary: 'kafkajs', category: 'no-op-stub' });

seedRequireCache('@openfeature/server-sdk', openfeatureFake, { boundary: '@openfeature/server-sdk', category: 'external-service' });

// Global patchers (side effects from the imports at the top of this file)
addGlobalFake({ boundary: 'fetch', category: 'external-service' });
addGlobalFake({ boundary: 'non-determinism', category: 'global-patcher' });

// ---- App singleton (shared across scenarios) ----
let request: ReturnType<typeof supertest>;

BeforeAll(async function () {
  // Set sentinel so flag fakes can distinguish init-time reads (pass through) from
  // scenario-time reads (enforce strictness).
  setCurrentScenarioId(INIT_SENTINEL);

  // Pre-load dist/db/index so it sees the fake mysql2 pool. connect() sets the pool
  // on this instance. The plain require('./dist/api/index') below will find this same
  // instance in require.cache (no proxyquire cache eviction), so route handlers share it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require(path.join(__dirname, '../../../dist/db/index'));
  await db.connect();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createApp } = require(path.join(__dirname, '../../../dist/api/index'));
  request = supertest(createApp());

  // Mirror production startup: initFlags() sets flagsInitialized=true so isFlagsReady()
  // returns true. dist/flags/index is already in require.cache (loaded by createApp above).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flagsModule = require(path.join(__dirname, '../../../dist/flags/index'));
  await flagsModule.initFlags();

  // Initialise the inbound-Kafka test driver: sets the module-level `consumer` in
  // dist/kafka/consumer to the kafkajs stub so handleMessage()'s commitOffsets() doesn't throw.
  await initKafkaFake();

  // Verify every IO boundary is wired and still at its cache key after the app loaded.
  const bootstrapBoundaries = [
    'mysql2/promise', 'kafkajs', '@openfeature/server-sdk',
    'fetch', 'non-determinism',
  ];
  auditFakeWiring(bootstrapBoundaries, wiredFakes);
});

// ---- Per-scenario lifecycle ----
Before(function () {
  this.scenarioId = crypto.randomUUID();
  setCurrentScenarioId(this.scenarioId);
  this.request = request;
});

// ---- World constructor ----
export class WebhooksWorld extends World {
  scenarioId!: string;
  request!: ReturnType<typeof supertest>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response?: any; // populated by When steps that make HTTP requests
  seededSubscriberId?: number; // set by Given steps that seed a specific subscriber ID
  seededSubscriberUrls: string[] = []; // accumulated by every subscriber-seeding Given step
  seededSubscriberIds: number[] = [];  // accumulated by every subscriber-seeding Given step
  dispatchedPayload?: string | null; // set by Kafka When steps; null means message.value was null
  dispatchedKey?: string | null; // set by Kafka When steps; read by delivery log assertion steps
  thrownError?: Error | null; // set by error-path When steps that catch infrastructure failures
  seededSubscriberHeaders?: Record<string, string>; // set when seeding a subscriber with custom headers
  // The registration request body a POST When step sent — lets Then steps build expected values from
  // the submitted input rather than reading them back out of the captured INSERT (a tautology).
  lastSubscriberRequest?: { name: string; topic: string; url: string; headers: Record<string, string> };
  _skippedDefaults?: Set<string>;

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(WebhooksWorld);
