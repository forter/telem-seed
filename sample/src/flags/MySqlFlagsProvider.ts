import type { Provider, ProviderMetadata, ResolutionDetails, EvaluationContext, Logger, JsonValue } from '@openfeature/server-sdk';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/index';

interface FlagRow extends RowDataPacket {
  topic: string;
  blocked: number;
}

export class MySqlFlagsProvider implements Provider {
  readonly metadata: ProviderMetadata = { name: 'MySqlFlagsProvider' };

  private cache = new Map<string, boolean>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly ttlMs = 5000;

  async initialize(): Promise<void> {
    await this.loadCache();
    this.refreshTimer = setInterval(() => {
      this.loadCache().catch((err: unknown) => {
        console.warn(
          'MySqlFlagsProvider: cache refresh failed (serving stale):',
          err instanceof Error ? err.message : err,
        );
      });
    }, this.ttlMs);
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async loadCache(): Promise<void> {
    const [rows] = await getPool().query<FlagRow[]>(
      'SELECT topic, blocked FROM topic_flags',
    );
    const next = new Map<string, boolean>();
    for (const row of rows) {
      next.set(row.topic, row.blocked === 1);
    }
    this.cache = next;
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    const cached = this.cache.get(flagKey);
    return { value: cached !== undefined ? cached : defaultValue };
  }

  async resolveStringEvaluation(
    _flagKey: string,
    defaultValue: string,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return { value: defaultValue };
  }

  async resolveNumberEvaluation(
    _flagKey: string,
    defaultValue: number,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return { value: defaultValue };
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    _flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    return { value: defaultValue };
  }
}
