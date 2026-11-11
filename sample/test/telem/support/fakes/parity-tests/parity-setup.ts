/**
 * Shared bootstrap for parity suites. Parity runs OUTSIDE Cucumber: no World is constructed, so
 * nothing sets the scenario id the fakes key their per-scenario state on. Every suite goes through
 * here so that plumbing lives in one place — a spec that passes only because a sibling set the id
 * first is green in a full run and broken alone. Verify a suite by running it on its own.
 *
 * Cucumber also loads this file (it globs test/telem/support/**); it only defines functions, so that is
 * a no-op.
 */

import { setCurrentScenarioId } from '../../scenario-context';

let counter = 0;

/** Run `fn` as a fresh scenario (new id) and always run `cleanup(id)` afterwards. */
export async function withScenario<T>(cleanup: (scenarioId: string) => void, fn: (scenarioId: string) => Promise<T>): Promise<T> {
  const scenarioId = `parity-${++counter}`;
  setCurrentScenarioId(scenarioId);
  try {
    return await fn(scenarioId);
  } finally {
    cleanup(scenarioId);
  }
}

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

/** True for "the real side isn't reachable" — the one failure a parity suite may turn into a skip. */
export function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && CONNECTION_ERROR_CODES.has(code)) return true;
  // KafkaJS carries no `code`, and with no retries left it throws KafkaJSNumberOfRetriesExceeded with only
  // the original message — "Connection error: <cause>" (the cause is empty for a Node dual-stack refusal)
  // or "Connection timeout" — so that text is the only signal that the broker was not reachable.
  const kafka = err as { name?: string; message?: string } | null;
  if (kafka?.name?.startsWith('KafkaJS') && /^Connection (error|timeout)/.test(kafka.message ?? '')) return true;
  // mysql2 wraps multi-address failures in an AggregateError whose members carry the codes.
  const inner = (err as { errors?: unknown[] } | null)?.errors;
  return Array.isArray(inner) && inner.length > 0 && inner.every(isConnectionError);
}

/**
 * Print the skip marker run.sh recognises and stop. A skip is legitimate on a laptop without Docker;
 * in CI the real side is provided, so run.sh turns a skip there into a failure.
 */
export function skipSuite(suite: string, reason: string): never {
  console.log(`\n⚠ ${suite} parity SKIPPED: ${reason}`);
  console.log(`PARITY_SKIPPED=${suite}: ${reason}`);
  process.exit(0);
}
