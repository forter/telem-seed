import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { getPool } from './index';

export interface Subscriber {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: Record<string, string>;
  created_at: Date;
}

// Shape of a raw row from the subscribers table — headers arrives as a JSON string.
interface SubscriberRow extends RowDataPacket {
  id: number;
  name: string;
  topic: string;
  url: string;
  headers: string;
  created_at: Date;
}

interface TopicRow extends RowDataPacket {
  topic: string;
}

// Parse the JSON `headers` column coming back from MySQL.
function parseRow(row: SubscriberRow): Subscriber {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    url: row.url,
    headers: typeof row.headers === 'string' ? (JSON.parse(row.headers) as Record<string, string>) : row.headers,
    created_at: row.created_at,
  };
}

export async function listAll(): Promise<Subscriber[]> {
  const [rows] = await getPool().query<SubscriberRow[]>(
    'SELECT id, name, topic, url, headers, created_at FROM subscribers ORDER BY id'
  );
  return rows.map(parseRow);
}

export async function findByTopic(topic: string): Promise<Subscriber[]> {
  const [rows] = await getPool().query<SubscriberRow[]>(
    'SELECT id, name, topic, url, headers, created_at FROM subscribers WHERE topic = ?',
    [topic]
  );
  return rows.map(parseRow);
}

export async function findDistinctTopics(): Promise<string[]> {
  const [rows] = await getPool().query<TopicRow[]>('SELECT DISTINCT topic FROM subscribers');
  return rows.map((r) => r.topic);
}

export async function create({
  name,
  topic,
  url,
  headers = {},
}: {
  name: string;
  topic: string;
  url: string;
  headers?: Record<string, string>;
}): Promise<Omit<Subscriber, 'created_at'>> {
  const [result] = await getPool().query<ResultSetHeader>(
    'INSERT INTO subscribers (name, topic, url, headers) VALUES (?, ?, ?, ?)',
    [name, topic, url, JSON.stringify(headers)]
  );
  return { id: result.insertId, name, topic, url, headers };
}

export async function remove(id: number): Promise<number> {
  const [result] = await getPool().query<ResultSetHeader>(
    'DELETE FROM subscribers WHERE id = ?',
    [id]
  );
  return result.affectedRows;
}
