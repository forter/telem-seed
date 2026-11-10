import { Router, Request, Response } from 'express';
import { getAll, upsert } from '../db/topicFlags';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const flags = await getAll();
    const result: Record<string, boolean> = {};
    for (const flag of flags) {
      result[flag.topic] = flag.blocked;
    }
    res.json(result);
  } catch (err) {
    console.error('GET /api/flags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:topic', async (req: Request, res: Response) => {
  const topic = req.params.topic;
  const { delivery_blocked } = req.body as { delivery_blocked?: unknown };

  if (typeof delivery_blocked !== 'boolean') {
    res.status(400).json({ error: 'delivery_blocked must be a boolean' });
    return;
  }

  try {
    await upsert(topic, delivery_blocked);
    res.json({ topic, delivery_blocked });
  } catch (err) {
    console.error(`PATCH /api/flags/${topic} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
