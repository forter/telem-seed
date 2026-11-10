import { createApp } from './api/index';
import * as db from './db/index';
import { startConsumer, stopConsumer } from './kafka/consumer';
import { initFlags } from './flags';
import type { Server } from 'http';

const PORT = parseInt(process.env.PORT || '3000', 10);

let server: Server | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received — shutting down`);
  server?.close();
  await stopConsumer();
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  // 1. Start Express first so /health responds immediately.
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`Express listening on port ${PORT}`);
      resolve(s);
    });
  });

  // 2. Connect to MySQL.
  await db.connect();

  // 3. Initialize feature flags (MySQL-backed). Fatal on failure — MySQL is already a hard
  //    dependency and serving without flags risks delivering to blocked topics.
  await initFlags();

  // 4. Start the Kafka consumer (subscribes to topics found in DB).
  try {
    await startConsumer();
  } catch (err) {
    // Log but don't crash — app still serves the REST API even if Kafka is unavailable.
    console.error('Kafka consumer failed to start:', err instanceof Error ? err.message : err);
  }

  console.log('Webhooks platform ready');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
