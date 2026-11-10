// Module-scoped variable — immune to Cucumber's per-step AsyncLocalStorage wrapping.
// Separate from world.ts to break the circular dependency: fakes import currentScenarioId()
// here, and world.ts imports fakes for wiring. If both lived in world.ts, Node would return
// a partial module for whichever file loaded second.

// Sentinel used during BeforeAll / app init so fakes can distinguish init-time calls
// (pass through to real module) from scenario-time calls (enforce strictness).
// Must be truthy and impossible to collide with a real UUID.
export const INIT_SENTINEL = '__init__';

let _scenarioId: string | undefined;

export function currentScenarioId(): string {
  if (_scenarioId === undefined) {
    throw new Error(
      'currentScenarioId() returned undefined. ' +
        'Probable cause: production code is running outside a scenario context ' +
        '(e.g., during module load or in a fire-and-forget async path). ' +
        'Fix: ensure this code path runs inside a Before/After hook or a step definition.',
    );
  }
  return _scenarioId;
}

export function setCurrentScenarioId(id: string): void {
  _scenarioId = id;
}
