import express, { type Request, type Response, type NextFunction } from 'express';
import type { DB } from './db.ts';
import { RoutingService, DomainError, type ContributorAction } from './service.ts';
import { seed, wipe, loadScenarios } from './seed.ts';

const ACTIONS: ContributorAction[] = ['accept', 'decline', 'fail', 'start', 'complete'];

export function createApp(db: DB, svc: RoutingService) {
  const app = express();
  app.use(express.json());

  const id = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n)) throw new DomainError(400, 'invalid', 'Bad id');
    return n;
  };
  const ver = (req: Request) => (req.body?.expectedVersion == null ? undefined : Number(req.body.expectedVersion));
  const ok = (res: Response) => res.json({ ok: true });

  app.get('/api/state', (_req, res) => res.json(svc.getState()));
  app.get('/api/tasks/:id', (req, res) => res.json(svc.getTask(id(req))));

  app.post('/api/tasks', (req, res) => res.status(201).json({ id: svc.createTask(req.body ?? {}) }));
  app.post('/api/tasks/:id/retry', (req, res) => (svc.retry(id(req), ver(req)), ok(res)));
  app.post('/api/tasks/:id/assign', (req, res) => (svc.assign(id(req), Number(req.body?.contributorId), ver(req)), ok(res)));
  app.post('/api/tasks/:id/revoke', (req, res) => (svc.revoke(id(req), ver(req)), ok(res)));
  app.post('/api/tasks/:id/cancel', (req, res) => (svc.cancel(id(req), ver(req)), ok(res)));
  app.post('/api/tasks/:id/priority', (req, res) => (svc.setPriority(id(req), req.body?.priority, ver(req)), ok(res)));

  // Simulated contributor side.
  app.post('/api/assignments/:id/:action', (req, res) => {
    const action = req.params.action as ContributorAction;
    if (!ACTIONS.includes(action)) throw new DomainError(404, 'not_found', 'Unknown action');
    svc.respond(id(req), action, req.body?.reason);
    ok(res);
  });

  // Demo controls.
  app.post('/api/demo/scenarios', (_req, res) => res.json({ ids: loadScenarios(svc) }));
  app.post('/api/demo/reset', (_req, res) => {
    wipe(db);
    seed(db);
    svc.recordBoot();
    ok(res);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal', message: 'Unexpected server error' });
  });

  return app;
}
