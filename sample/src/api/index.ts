import express from 'express';
import type { Express } from 'express';
import path from 'path';
import subscribersRouter from './subscribers';
import flagsRouter from './flags';
import { ping } from '../db';
import { isConsumerConnected } from '../kafka/consumer';
import { isFlagsReady } from '../flags';

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const mysqlOk = await ping().then(() => true, () => false);
    const deps = {
      mysql: mysqlOk ? 'ok' : 'error',
      kafka: isConsumerConnected() ? 'ok' : 'error',
      flags: isFlagsReady() ? 'ok' : 'error',
    };
    const healthy = Object.values(deps).every((v) => v === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', dependencies: deps });
  });

  // REST API
  app.use('/api/subscribers', subscribersRouter);
  app.use('/api/flags', flagsRouter);

  // After compilation dist/api/index.js has __dirname = <outDir>/api,
  // so ../public resolves to <outDir>/public — where the Dockerfile places the frontend build.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Catch-all: return index.html for any non-API route so React Router works.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
