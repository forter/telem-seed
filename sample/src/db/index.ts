import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';

// Lazily initialized pool — connect() must be called before any queries.
let pool: Pool | undefined;

export async function connect(): Promise<void> {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'webhooks',
    password: process.env.MYSQL_PASSWORD || 'webhooks',
    database: process.env.MYSQL_DATABASE || 'webhooks',
    waitForConnections: true,
    connectionLimit: 10,
  });

  // Verify connectivity early so startup fails fast if MySQL is unreachable.
  const conn = await pool.getConnection();
  conn.release();
  console.log('MySQL connected');
}

export function getPool(): Pool {
  if (!pool) throw new Error('DB pool not initialised — call connect() first');
  return pool;
}

export async function ping(): Promise<void> {
  await getPool().query('SELECT 1');
}

export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
