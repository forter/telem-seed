import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from './index';

export interface TopicFlag {
  topic: string;
  blocked: boolean;
}

interface TopicFlagRow extends RowDataPacket {
  topic: string;
  blocked: number;
}

export async function getAll(): Promise<TopicFlag[]> {
  const [rows] = await getPool().query<TopicFlagRow[]>(
    'SELECT topic, blocked FROM topic_flags ORDER BY topic',
  );
  return rows.map((r) => ({ topic: r.topic, blocked: r.blocked === 1 }));
}

export async function upsert(topic: string, blocked: boolean): Promise<void> {
  const blockedInt = blocked ? 1 : 0;
  await getPool().execute(
    'INSERT INTO topic_flags (topic, blocked) VALUES (?, ?) ON DUPLICATE KEY UPDATE blocked = ?, updated_at = CURRENT_TIMESTAMP',
    [topic, blockedInt, blockedInt],
  );
}
