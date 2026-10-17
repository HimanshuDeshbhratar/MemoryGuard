import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import * as demoService from '../services/demo.js';

export const demo = Router();

demo.post('/seed', (_req: Request, res: Response) => {
  demoService
    .seed()
    .then(() => res.json({ ok: true, message: 'demo dataset seeded (synthetic demonstration data)' }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'seed failed';
      res.status(503).json({ ok: false, error: 'seed_failed', message: 'seed failed; database unavailable' });
    });
});

const resetSchema = z.object({
  confirmPhrase: z.literal('reset-demo'),
  acknowledgeSynthetic: z.boolean().refine((v) => v, 'must acknowledge synthetic demo reset'),
});

demo.post('/reset', (req: Request, res: Response) => {
  if (!env.allowDemoReset) {
    res.status(403).json({ ok: false, error: 'forbidden', message: 'demo reset disabled via ALLOW_DEMO_RESET' });
    return;
  }
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'validation_error', message: 'provide { confirmPhrase: "reset-demo", acknowledgeSynthetic: true }' });
    return;
  }
  demoService
    .reset()
    .then(() => res.json({ ok: true, message: 'demo graph cleared and reseeded with synthetic data' }))
    .catch((err: unknown) => {
      console.error('[demo reset]', err instanceof Error ? err.message : err);
      res.status(503).json({ ok: false, error: 'reset_failed', message: 'reset failed; database unavailable' });
    });
});
