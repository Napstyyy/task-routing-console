import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contributors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  expertise   TEXT NOT NULL,            -- JSON array of strings
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  expertise        TEXT NOT NULL,
  priority         TEXT NOT NULL CHECK (priority IN ('normal','high')),
  state            TEXT NOT NULL,
  reason           TEXT,                 -- why the task is in its current state (needs_attention etc.)
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL
);

-- One row per request sent to the routing engine.
-- status: 'pending' until the engine answers, then 'returned'.
-- abandoned_at: operator/another attempt made this request moot. The engine does not know that,
--   so the row stays 'pending' and may still return; its result is then logged and ignored.
-- disposition (set when returned): applied | no_match | rejected | late_ignored
CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id),
  seq              INTEGER NOT NULL,
  status           TEXT NOT NULL,
  disposition      TEXT,
  note             TEXT,
  eligible         TEXT NOT NULL,        -- JSON array of contributor ids sent to the engine
  started_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  abandoned_at     INTEGER,
  result_contributor_id INTEGER,
  -- Simulation only: the engine's fate is decided when the request is sent and persisted,
  -- so a server restart neither loses nor re-rolls in-flight requests.
  sim_returns_at   INTEGER,              -- NULL = never returns
  sim_outcome      INTEGER,              -- contributor id, NULL = no match
  sim_label        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_pending ON attempts(status, sim_returns_at);
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);

-- status: offered | accepted | in_progress | completed | declined | failed | revoked
CREATE TABLE IF NOT EXISTS assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id),
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  source         TEXT NOT NULL CHECK (source IN ('engine','operator')),
  attempt_id     INTEGER REFERENCES attempts(id),
  status         TEXT NOT NULL,
  reason         TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_task ON assignments(task_id);
CREATE INDEX IF NOT EXISTS assignments_contributor ON assignments(contributor_id, status);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER,
  actor    TEXT NOT NULL CHECK (actor IN ('operator','engine','contributor','system')),
  type     TEXT NOT NULL,
  message  TEXT NOT NULL,
  data     TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
