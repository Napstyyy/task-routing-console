import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { openDb } from './db.ts';
import { RoutingService } from './service.ts';
import { createApp } from './app.ts';
import { seed } from './seed.ts';

const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), 'data', 'app.db');
const PORT = Number(process.env.PORT ?? 3001);
const TICK_MS = 500;

const db = openDb(DB_PATH);
const svc = new RoutingService(db);

const empty = (db.prepare('SELECT COUNT(*) AS n FROM contributors').get() as { n: number }).n === 0;
if (empty) {
  seed(db);
  console.log('Seeded fresh database');
}
svc.recordBoot();

// Stand-in for the engine calling back: deliver any answers that are due.
setInterval(() => {
  try {
    svc.deliverDue();
  } catch (e) {
    console.error('delivery tick failed', e);
  }
}, TICK_MS);

const app = createApp(db, svc);
const dist = join(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}
app.listen(PORT, () => console.log(`API on http://localhost:${PORT} (db: ${DB_PATH})`));
