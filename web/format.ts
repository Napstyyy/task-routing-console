import type { TaskState, TaskView, Reason } from './client';

export function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const STATE_LABEL: Record<TaskState, string> = {
  routing: 'Routing',
  offered: 'Awaiting accept',
  accepted: 'Accepted',
  in_progress: 'In progress',
  done: 'Done',
  needs_attention: 'Needs attention',
  cancelled: 'Cancelled',
};

export const REASON_LABEL: Record<Exclude<Reason, null>, string> = {
  no_eligible: 'nobody available',
  no_match: 'engine: no match',
  result_rejected: 'engine pick unavailable',
  declined: 'declined',
  failed: 'dropped out',
  revoked: 'unassigned',
};

/** Overdue = the newest live request has outlived the engine's normal window. Says nothing about whether it will return. */
export function routingInfo(t: TaskView, now: number, normalMaxMs: number) {
  if (t.state !== 'routing' || t.liveAttempts.length === 0) return null;
  const newest = t.liveAttempts.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  const elapsed = now - newest.startedAt;
  return { newest, elapsed, overdue: elapsed > normalMaxMs, live: t.liveAttempts.length };
}

const ORDER: Record<TaskState, number> = {
  needs_attention: 1,
  routing: 2,
  offered: 3,
  accepted: 4,
  in_progress: 5,
  done: 6,
  cancelled: 7,
};

/** What the operator should look at first: anything needing a decision, high priority first, oldest first. */
export function urgency(t: TaskView, now: number, normalMaxMs: number): number {
  const r = routingInfo(t, now, normalMaxMs);
  const needsHuman = t.state === 'needs_attention' || r?.overdue;
  let score = needsHuman ? 0 : ORDER[t.state] * 10;
  if (t.priority === 'high' && score < 60) score -= 5;
  return score;
}
