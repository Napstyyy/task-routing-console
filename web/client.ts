export type TaskState = 'routing' | 'offered' | 'accepted' | 'in_progress' | 'done' | 'needs_attention' | 'cancelled';
export type Reason = 'no_eligible' | 'no_match' | 'result_rejected' | 'declined' | 'failed' | 'revoked' | null;
export type Actor = 'operator' | 'engine' | 'contributor' | 'system';

export interface TaskView {
  id: number;
  title: string;
  description: string;
  expertise: string;
  priority: 'normal' | 'high';
  state: TaskState;
  reason: Reason;
  version: number;
  created_at: number;
  state_changed_at: number;
  assignee: { assignmentId: number; contributorId: number; name: string; status: string; source: 'engine' | 'operator' } | null;
  liveAttempts: { seq: number; startedAt: number }[];
  orphanedAttempts: number;
}
export interface ContributorView {
  id: number;
  name: string;
  expertise: string[];
  active: { taskId: number; title: string; status: string } | null;
  completed: number;
}
export interface EventView {
  id: number;
  task_id: number | null;
  actor: Actor;
  type: string;
  message: string;
  at: number;
}
export interface AppState {
  now: number;
  normalMaxMs: number;
  expertise: string[];
  scenarios: string[];
  tasks: TaskView[];
  contributors: ContributorView[];
  events: EventView[];
}
export interface AttemptView {
  id: number;
  seq: number;
  status: 'pending' | 'returned';
  disposition: 'applied' | 'no_match' | 'rejected' | 'late_ignored' | null;
  note: string | null;
  eligible: { id: number; name: string }[];
  started_at: number;
  resolved_at: number | null;
  abandoned_at: number | null;
  result_name: string | null;
  sim_returns_at: number | null;
  sim_label: string;
}
export interface AssignmentView {
  id: number;
  contributor_id: number;
  contributor_name: string;
  source: 'engine' | 'operator';
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
}
export interface TaskDetail {
  now: number;
  task: TaskView;
  attempts: AttemptView[];
  assignments: AssignmentView[];
  events: EventView[];
  candidates: { id: number; name: string; busy: boolean; refused: boolean }[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
  return data as T;
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  task: (id: number) => req<TaskDetail>('GET', `/api/tasks/${id}`),
  create: (body: object) => req<{ id: number }>('POST', '/api/tasks', body),
  taskAction: (id: number, action: 'retry' | 'revoke' | 'cancel' | 'assign' | 'priority', body: object) =>
    req('POST', `/api/tasks/${id}/${action}`, body),
  respond: (assignmentId: number, action: string, reason?: string) =>
    req('POST', `/api/assignments/${assignmentId}/${action}`, { reason }),
  scenarios: () => req<{ ids: number[] }>('POST', '/api/demo/scenarios'),
  reset: () => req('POST', '/api/demo/reset'),
};
