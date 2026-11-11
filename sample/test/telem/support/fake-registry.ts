export interface Fake {
  name?: string;
  throwIfUnownedExist(scenarioId: string): void;
  cleanup(scenarioId: string): void;
}

/** One entry per faked IO boundary; built by seedRequireCache / addGlobalFake in world.ts. */
export interface WiredFake {
  boundary: string;
  category: string;
  /** Absolute resolved path for require.cache seeded fakes; null for global patchers. */
  cacheKey: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fake: any;
  /** The fake's test-facing module (seed / fail / takeOwnershipOf*), when it is not `fake` itself. */
  api?: Record<string, unknown>;
  /** The `name` this boundary's fake registered under — proves the safety net sweeps it. */
  registryName?: string;
}

// Test-facing surface each category must expose (on `api`); ownership-bearing ones also need a takeOwnershipOf*.
const CATEGORY_REQUIRED: Record<string, { functions: string[]; ownership: boolean }> = {
  'data-store': { functions: ['fail'], ownership: true },
  'external-service': { functions: ['fail'], ownership: true },
  // Flag reads are inputs: failure injection, no ownership.
  'flag-interceptor': { functions: ['fail'], ownership: false },
};

export const fakeRegistry: Fake[] = [];

export function registerFake(fake: Fake): void {
  fakeRegistry.push(fake);
}

/** Calls throwIfUnownedExist on every registered fake; collects all errors before throwing. */
export function throwIfAnyUnownedExist(scenarioId: string): void {
  const errors: string[] = [];
  for (const fake of fakeRegistry) {
    try {
      fake.throwIfUnownedExist(scenarioId);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Unowned IO after scenario ${scenarioId}:\n${errors.map((m) => `  ${m}`).join('\n')}`);
  }
}

/** Calls cleanup on every registered fake; logs (does not throw) on individual failures. */
export function cleanupScenario(scenarioId: string): void {
  for (const fake of fakeRegistry) {
    try {
      fake.cleanup(scenarioId);
    } catch (e) {
      console.warn(`[fake-registry] cleanup failed for scenario ${scenarioId}:`, (e as Error).message);
    }
  }
}

/**
 * Boot-time audit: verifies every faked IO boundary is wired correctly after the app loads.
 *
 * Checks:
 * (a) Identity — fake still installed at its require.cache key (guards against silent overwrites).
 * (b) Coverage — every boundary in `bootstrapBoundaries` has a wired fake.
 * (c) Presence — at least one fake is wired at all.
 * (d) Surface — each boundary's fake is in the registry the After hook sweeps, and its test-facing
 *     module has the category's API (fail, takeOwnershipOf*).
 *
 * Called in BeforeAll in world.ts after the app is loaded.
 */
export function auditFakeWiring(bootstrapBoundaries: string[], wiredFakes: WiredFake[]): void {
  const errors: string[] = [];

  // (a) Identity: fake we seeded is still at its cache key after the app loaded
  for (const { boundary, cacheKey, fake } of wiredFakes) {
    if (cacheKey !== null && require.cache[cacheKey]?.exports !== fake) {
      errors.push(
        `Fake for '${boundary}' is not installed at ${cacheKey} after load. ` +
          `Probable cause: the module was reloaded, or the seed key doesn't match what the app requires.`,
      );
    }
  }

  // (b) Every listed IO boundary has a wired fake
  const wiredBoundaries = new Set(wiredFakes.map((w) => w.boundary));
  for (const boundary of bootstrapBoundaries) {
    if (!wiredBoundaries.has(boundary)) {
      errors.push(`No fake wired for IO boundary '${boundary}'`);
    }
  }

  // (c) At least one fake wired
  if (wiredFakes.length === 0) {
    errors.push('No fakes wired — the wiredFakes list is empty');
  }

  // (d) Registered with the safety net, and the category's test-facing API is present
  const registered = new Set(fakeRegistry.map((f) => f.name));
  for (const { boundary, category, fake, api, registryName } of wiredFakes) {
    if (registryName !== undefined && !registered.has(registryName)) {
      errors.push(
        `Fake for '${boundary}' expects registry entry '${registryName}', which never registered. ` +
          'Probable cause: the fake module skipped registerFake() or uses another name — its IO would escape the unowned-IO check.',
      );
    }
    const required = CATEGORY_REQUIRED[category];
    if (!required) continue;
    const surface = api ?? fake;
    const missing = required.functions.filter((fn) => typeof surface?.[fn] !== 'function');
    if (required.ownership && !Object.keys(surface ?? {}).some((k) => k.startsWith('takeOwnershipOf'))) {
      missing.push('takeOwnershipOf*');
    }
    if (missing.length > 0) {
      errors.push(`Fake for '${boundary}' (${category}) is missing ${missing.join(', ')} on its test-facing module.`);
    }
  }

  if (errors.length > 0) {
    throw new Error('Boot-time audit failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  }
}
