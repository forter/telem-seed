import { Router, Request, Response } from 'express';
import * as db from '../db/subscribers';
import { subscribeToTopic } from '../kafka/consumer';

const router = Router();

function isValidWebhookUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// GET /api/subscribers — list all subscribers
router.get('/', async (_req: Request, res: Response) => {
  try {
    const subscribers = await db.listAll();
    res.json(subscribers);
  } catch (err) {
    console.error('GET /api/subscribers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscribers — create a subscriber
router.post('/', async (req: Request, res: Response) => {
  const { name, topic, url, headers } = req.body as {
    name?: string;
    topic?: string;
    url?: string;
    headers?: Record<string, string>;
  };

  if (!name || !topic || !url) {
    res.status(400).json({ error: 'name, topic, and url are required' });
    return;
  }

  if (!isValidWebhookUrl(url)) {
    res.status(400).json({ error: 'url must be a valid http or https URL' });
    return;
  }

  try {
    const subscriber = await db.create({ name, topic, url, headers: headers ?? {} });
    // Don't await — Kafka stop/restart can take a moment; subscriber is already persisted.
    subscribeToTopic(topic).catch((err) =>
      console.error(`Failed to subscribe to Kafka topic "${topic}":`, err)
    );
    res.status(201).json(subscriber);
  } catch (err) {
    console.error('POST /api/subscribers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/subscribers/:id — delete a subscriber
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  try {
    const affected = await db.remove(id);
    if (affected === 0) {
      res.status(404).json({ error: 'Subscriber not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error(`DELETE /api/subscribers/${id} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
