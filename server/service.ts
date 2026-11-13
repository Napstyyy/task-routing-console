import type { DB } from './db.ts';

export const EXPERTISE = ['finance', 'healthcare', 'data analysis', 'operations', 'legal'] as const;
export type Expertise = (typeof EXPERTISE)[number];

/** Spec: a routing request normally returns in 5–20s. Past this we flag "overdue", never "dead". */
export const NORMAL_MIN_MS = 5_000;
export const NORMAL_MAX_MS = 20_000;
export const NEVER_RETURN_RATE = 0.2;
export const NO_MATCH_RATE = 0.1;

export type TaskState =
  | 'routing'
  | 'offered'
  | 'accepted'
  | 'in_progress'
  | 'done'
  | 'needs_attention'
  | 'cancelled';
export type Priority = 'normal' | 'high';
export type AttentionReason = 'no_eligible' | 'no_match' | 'result_rejected' | 'declined' | 'failed' | 'revoked';
export type AssignmentStatus = 'offered' | 'accepted' | 'in_progress' | 'completed' | 'declined' | 'failed' | 'revoked';
export type Disposition = 'applied' | 'no_match' | 'rejected' | 'late_ignored';
export type Actor = 'operator' | 'engine' | 'contributor' | 'system';
export type Scenario = 'random' | 'fast_match' | 'slow_match' | 'never' | 'no_match';
export type ContributorAction = 'accept' | 'decline' | 'fail' | 'start' | 'complete';

export const SCENARIOS: Scenario[] = ['random', 'fast_match', 'slow_match', 'never', 'no_match'];
const TERMINAL: TaskState[] = ['done', 'cancelled'];
const ACTIVE_ASSIGNMENT: AssignmentStatus[] = ['offered', 'accepted', 'in_progress'];

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  expertise: string;
  priority: Priority;
  state: TaskState;
  reason: AttentionReason | null;
  version: number;
  created_at: number;
  state_changed_at: number;
}
export interface AttemptRow {
  id: number;
  task_id: number;
  seq: number;
  status: 'pending' | 'returned';
  disposition: Disposition | null;
  note: string | null;
  eligible: string;
  started_at: number;
  resolved_at: number | null;
  abandoned_at: number | null;
  result_contributor_id: number | null;
  sim_returns_at: number | null;
  sim_outcome: number | null;
  sim_label: string;
}
export interface AssignmentRow {
  id: number;
  task_id: number;
  contributor_id: number;
  source: 'engine' | 'operator';
  attempt_id: number | null;
  status: AssignmentStatus;
  reason: string | null;
  created_at: number;
  updated_at: number;
}
export interface ContributorRow {
  id: number;
  name: string;
  expertise: string;
  created_at: number;
}
export interface EventRow {
  id: number;
  task_id: number | null;
  actor: Actor;
  type: string;
  message: string;
  data: string | null;
  at: number;
}

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Fate {
  returnsAt: number | null;
  outcome: number | null;
  label: string;
}

/**
 * Engine simulator. The fate of a request is decided the moment it is sent and stored with it.
 * The rest of the system never reads these fields to make decisions — only the delivery loop does,
 * playing the role of the external engine calling back.
 */
export function planFate(scenario: Scenario, eligible: number[], now: number, rng: () => number): Fate {
  const pick = () => eligible[Math.floor(rng() * eligible.length)] ?? null;
  // Forced scenarios pick deterministically (first eligible) so scripted demos never collide by chance.
  const first = eligible[0] ?? null;
  switch (scenario) {
    case 'fast_match':
      return { returnsAt: now + 5_000, outcome: first, label: 'fast match (5s)' };
    case 'slow_match':
      return { returnsAt: now + 19_000, outcome: first, label: 'slow match (19s)' };
    case 'never':
      return { returnsAt: null, outcome: null, label: 'never returns' };
    case 'no_match':
      return { returnsAt: now + 8_000, outcome: null, label: 'no match (8s)' };
    case 'random': {
      if (rng() < NEVER_RETURN_RATE) return { returnsAt: null, outcome: null, label: 'random: never returns' };
      const delay = NORMAL_MIN_MS + Math.round(rng() * (NORMAL_MAX_MS - NORMAL_MIN_MS));
      const noMatch = rng() < NO_MATCH_RATE;
      return {
        returnsAt: now + delay,
        outcome: noMatch ? null : pick(),
        label: `random: ${noMatch ? 'no match' : 'match'} in ${(delay / 1000).toFixed(1)}s`,
      };
    }
  }
}

export interface ServiceOptions {
  now?: () => number;
  rng?: () => number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  expertise: string;
  priority?: Priority;
  scenario?: Scenario;
}

export class RoutingService {
  readonly now: () => number;
  private rng: () => number;

  constructor(
    private db: DB,
    opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
  }

  // ───────────────────────── infrastructure ─────────────────────────

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  private one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  private run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }

  private event(taskId: number | null, actor: Actor, type: string, message: string, data?: unknown) {
    this.run(
      'INSERT INTO events (task_id, actor, type, message, data, at) VALUES (?,?,?,?,?,?)',
      taskId,
      actor,
      type,
      message,
      data === undefined ? null : JSON.stringify(data),
      this.now(),
    );
  }

  private task(id: number): TaskRow {
    const t = this.one<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw new DomainError(404, 'not_found', `Task T-${id} not found`);
    return t;
  }

  private contributor(id: number): ContributorRow {
    const c = this.one<ContributorRow>('SELECT * FROM contributors WHERE id = ?', id);
    if (!c) throw new DomainError(404, 'not_found', `Contributor ${id} not found`);
    return c;
  }

  private name(contributorId: number | null): string {
    if (contributorId == null) return 'nobody';
    return this.one<{ name: string }>('SELECT name FROM contributors WHERE id = ?', contributorId)?.name ?? `#${contributorId}`;
  }

  /** Optimistic concurrency: operator acted on a view that is no longer current. */
  private checkVersion(t: TaskRow, expected: number | undefined) {
    if (expected === undefined || expected === t.version) return;
    const last = this.one<EventRow>('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 1', t.id);
    throw new DomainError(
      409,
      'stale',
      `T-${t.id} changed since you loaded it (now ${t.state}). Latest: ${last?.message ?? 'n/a'}. Review and try again.`,
    );
  }

  private requireState(t: TaskRow, allowed: TaskState[], action: string) {
    if (!allowed.includes(t.state))
      throw new DomainError(409, 'invalid_state', `Cannot ${action} T-${t.id} while it is ${t.state}`);
  }

  private setState(t: TaskRow, state: TaskState, reason: AttentionReason | null = null) {
    const changed = state !== t.state;
    this.run(
      'UPDATE tasks SET state = ?, reason = ?, version = version + 1, state_changed_at = ? WHERE id = ?',
      state,
      reason,
      changed ? this.now() : t.state_changed_at,
      t.id,
    );
  }

  private bump(t: TaskRow) {
    this.run('UPDATE tasks SET version = version + 1 WHERE id = ?', t.id);
  }

  private busyIds(): Set<number> {
    const rows = this.all<{ contributor_id: number }>(
      `SELECT contributor_id FROM assignments WHERE status IN ('offered','accepted','in_progress')`,
    );
    return new Set(rows.map((r) => r.contributor_id));
  }

  private hasExpertise(c: ContributorRow, expertise: string) {
    return (JSON.parse(c.expertise) as string[]).includes(expertise);
  }

  /** Contributors who already declined or dropped out of this task. Not re-sent to the engine for it. */
  private refusedIds(taskId: number): Set<number> {
    const rows = this.all<{ contributor_id: number }>(
      `SELECT contributor_id FROM assignments WHERE task_id = ? AND status IN ('declined','failed')`,
      taskId,
    );
    return new Set(rows.map((r) => r.contributor_id));
  }

  /** Contributors who match the expertise, have no active assignment, and haven't refused this task. */
  private eligibleFor(t: TaskRow): { eligible: ContributorRow[]; excluded: ContributorRow[] } {
    const busy = this.busyIds();
    const refused = this.refusedIds(t.id);
    const free = this.all<ContributorRow>('SELECT * FROM contributors ORDER BY id').filter(
      (c) => this.hasExpertise(c, t.expertise) && !busy.has(c.id),
    );
    return { eligible: free.filter((c) => !refused.has(c.id)), excluded: free.filter((c) => refused.has(c.id)) };
  }

  private liveAttempts(taskId: number): AttemptRow[] {
    return this.all<AttemptRow>(
      `SELECT * FROM attempts WHERE task_id = ? AND status = 'pending' AND abandoned_at IS NULL ORDER BY seq`,
      taskId,
    );
  }

  private activeAssignment(taskId: number): AssignmentRow | undefined {
    return this.one<AssignmentRow>(
      `SELECT * FROM assignments WHERE task_id = ? AND status IN ('offered','accepted','in_progress') ORDER BY id DESC LIMIT 1`,
      taskId,
    );
  }

  /** Mark outstanding requests as moot. The engine doesn't know; they may still return and get ignored. */
  private abandonLive(taskId: number, why: string): number {
    const live = this.liveAttempts(taskId);
    for (const a of live) this.run('UPDATE attempts SET abandoned_at = ?, note = ? WHERE id = ?', this.now(), why, a.id);
    return live.length;
  }

  private sendRequest(t: TaskRow, scenario: Scenario, actor: Actor): AttemptRow | null {
    const { eligible, excluded } = this.eligibleFor(t);
    if (eligible.length === 0) return null;
    const ids = eligible.map((c) => c.id);
    const seq = (this.one<{ m: number | null }>('SELECT MAX(seq) AS m FROM attempts WHERE task_id = ?', t.id)?.m ?? 0) + 1;
    const fate = planFate(scenario, ids, this.now(), this.rng);
    const res = this.run(
      `INSERT INTO attempts (task_id, seq, status, eligible, started_at, sim_returns_at, sim_outcome, sim_label)
       VALUES (?,?,?,?,?,?,?,?)`,
      t.id,
      seq,
      'pending',
      JSON.stringify(ids),
      this.now(),
      fate.returnsAt,
      fate.outcome,
      fate.label,
    );
    const others = this.liveAttempts(t.id).filter((a) => a.seq !== seq);
    this.event(
      t.id,
      actor,
      'routing.request_sent',
      `Routing request #${seq} sent with ${ids.length} eligible: ${eligible.map((c) => c.name).join(', ')}` +
        (excluded.length ? ` (excluded ${excluded.map((c) => c.name).join(', ')}: already refused this task)` : '') +
        (others.length ? `. Request${others.length > 1 ? 's' : ''} ${others.map((a) => '#' + a.seq).join(', ')} still live — first valid answer wins` : ''),
      { attemptSeq: seq, eligible: ids },
    );
    return this.one<AttemptRow>('SELECT * FROM attempts WHERE id = ?', Number(res.lastInsertRowid))!;
  }

  // ───────────────────────── operator commands ─────────────────────────

  createTask(input: CreateTaskInput): number {
    const title = input.title?.trim();
    if (!title) throw new DomainError(400, 'invalid', 'Title is required');
    if (!(EXPERTISE as readonly string[]).includes(input.expertise))
      throw new DomainError(400, 'invalid', `Unknown expertise "${input.expertise}"`);
    const priority = input.priority ?? 'normal';
    if (priority !== 'normal' && priority !== 'high') throw new DomainError(400, 'invalid', 'Bad priority');
    const scenario = input.scenario ?? 'random';
    if (!SCENARIOS.includes(scenario)) throw new DomainError(400, 'invalid', `Unknown scenario "${scenario}"`);

    return this.tx(() => {
      const now = this.now();
      const res = this.run(
        `INSERT INTO tasks (title, description, expertise, priority, state, created_at, state_changed_at)
         VALUES (?,?,?,?,?,?,?)`,
        title,
        input.description?.trim() ?? '',
        input.expertise,
        priority,
        'routing',
        now,
        now,
      );
      const id = Number(res.lastInsertRowid);
      this.event(id, 'operator', 'task.created', `Task created (${input.expertise}, ${priority} priority) and submitted for routing`, {
        scenario,
      });
      const t = this.task(id);
      if (!this.sendRequest(t, scenario, 'system')) {
        this.setState(t, 'needs_attention', 'no_eligible');
        this.event(id, 'system', 'routing.skipped', `No available contributor has "${t.expertise}" expertise — nothing sent to the engine`);
      }
      return id;
    });
  }

  /** Send another routing request. Earlier pending requests stay live (hedge): first valid answer wins. */
  retry(taskId: number, expectedVersion?: number) {
    this.tx(() => {
      const t = this.task(taskId);
      this.checkVersion(t, expectedVersion);
      this.requireState(t, ['routing', 'needs_attention'], 'retry routing for');
      const a = this.sendRequest(t, 'random', 'operator');
      if (!a)
        throw new DomainError(409, 'no_eligible',
          `No available contributor with "${t.expertise}" expertise who hasn't already refused this task. Assign manually or wait.`);
      if (t.state === 'needs_attention') this.setState(t, 'routing');
      else this.bump(t);
    });
  }

  assign(taskId: number, contributorId: number, expectedVersion?: number) {
    this.tx(() => {
      const t = this.task(taskId);
      this.checkVersion(t, expectedVersion);
      this.requireState(t, ['routing', 'needs_attention', 'offered'], 'assign');
      const c = this.contributor(contributorId);
      if (!this.hasExpertise(c, t.expertise))
        throw new DomainError(409, 'not_eligible', `${c.name} has no "${t.expertise}" expertise`);
      const current = this.activeAssignment(t.id);
      if (current?.contributor_id === c.id) throw new DomainError(409, 'noop', `${c.name} already holds this offer`);
      if (this.busyIds().has(c.id)) throw new DomainError(409, 'busy', `${c.name} already has an active assignment`);

      if (current) {
        this.run(`UPDATE assignments SET status = 'revoked', reason = ?, updated_at = ? WHERE id = ?`,
          `replaced by operator assignment to ${c.name}`, this.now(), current.id);
        this.event(t.id, 'operator', 'assignment.revoked', `Offer to ${this.name(current.contributor_id)} revoked — reassigning to ${c.name}`);
      }
      const abandoned = this.abandonLive(t.id, `abandoned: operator assigned ${c.name} manually`);
      this.run(
        `INSERT INTO assignments (task_id, contributor_id, source, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        t.id, c.id, 'operator', 'offered', this.now(), this.now(),
      );
      this.setState(t, 'offered');
      this.event(t.id, 'operator', 'assignment.offered',
        `Operator assigned ${c.name} manually` +
          (abandoned ? `. ${abandoned} routing request${abandoned > 1 ? 's' : ''} still outstanding at the engine — any late answer will be ignored` : ''),
        { contributorId: c.id, abandoned });
    });
  }

  /** Pull an offer or an accepted-but-not-started assignment back. */
  revoke(taskId: number, expectedVersion?: number) {
    this.tx(() => {
      const t = this.task(taskId);
      this.checkVersion(t, expectedVersion);
      this.requireState(t, ['offered', 'accepted'], 'unassign');
      const a = this.activeAssignment(t.id)!;
      this.run(`UPDATE assignments SET status = 'revoked', reason = 'revoked by operator', updated_at = ? WHERE id = ?`, this.now(), a.id);
      this.setState(t, 'needs_attention', 'revoked');
      this.event(t.id, 'operator', 'assignment.revoked', `Operator unassigned ${this.name(a.contributor_id)}`);
    });
  }

  cancel(taskId: number, expectedVersion?: number) {
    this.tx(() => {
      const t = this.task(taskId);
      this.checkVersion(t, expectedVersion);
      if (TERMINAL.includes(t.state)) throw new DomainError(409, 'invalid_state', `T-${t.id} is already ${t.state}`);
      const a = this.activeAssignment(t.id);
      if (a) this.run(`UPDATE assignments SET status = 'revoked', reason = 'task cancelled', updated_at = ? WHERE id = ?`, this.now(), a.id);
      const abandoned = this.abandonLive(t.id, 'abandoned: task cancelled');
      this.setState(t, 'cancelled');
      this.event(t.id, 'operator', 'task.cancelled',
        'Task cancelled' + (a ? `; ${this.name(a.contributor_id)} released` : '') + (abandoned ? `; ${abandoned} outstanding request(s) will be ignored` : ''));
    });
  }

  setPriority(taskId: number, priority: Priority, expectedVersion?: number) {
    if (priority !== 'normal' && priority !== 'high') throw new DomainError(400, 'invalid', 'Bad priority');
    this.tx(() => {
      const t = this.task(taskId);
      this.checkVersion(t, expectedVersion);
      if (t.priority === priority) return;
      this.run('UPDATE tasks SET priority = ?, version = version + 1 WHERE id = ?', priority, t.id);
      this.event(t.id, 'operator', 'task.priority', `Priority changed ${t.priority} → ${priority}`);
    });
  }

  // ───────────────────────── contributor responses (simulated) ─────────────────────────

  respond(assignmentId: number, action: ContributorAction, reason?: string) {
    const a = this.one<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', assignmentId);
    if (!a) throw new DomainError(404, 'not_found', `Assignment ${assignmentId} not found`);
    const from: Record<ContributorAction, AssignmentStatus[]> = {
      accept: ['offered'],
      decline: ['offered'],
      fail: ['offered', 'accepted'],
      start: ['accepted'],
      complete: ['in_progress'],
    };
    const who = this.name(a.contributor_id);
    if (!from[action].includes(a.status)) {
      // A contributor answering an offer that is gone (revoked/replaced) is normal in real life. Record it, change nothing.
      this.tx(() =>
        this.event(a.task_id, 'contributor', 'contributor.response_ignored',
          `${who} tried to ${action}, but their assignment is ${a.status} — ignored`),
      );
      throw new DomainError(409, 'invalid_state', `${who}'s assignment is ${a.status}; cannot ${action}`);
    }
    this.tx(() => {
      const t = this.task(a.task_id);
      const set = (s: AssignmentStatus, r: string | null = null) =>
        this.run('UPDATE assignments SET status = ?, reason = ?, updated_at = ? WHERE id = ?', s, r, this.now(), a.id);
      const why = reason?.trim() || null;
      switch (action) {
        case 'accept':
          set('accepted');
          this.setState(t, 'accepted');
          this.event(t.id, 'contributor', 'assignment.accepted', `${who} accepted — routing complete`);
          break;
        case 'decline':
          set('declined', why);
          this.setState(t, 'needs_attention', 'declined');
          this.event(t.id, 'contributor', 'assignment.declined', `${who} declined${why ? `: "${why}"` : ''}`);
          break;
        case 'fail':
          set('failed', why);
          this.setState(t, 'needs_attention', 'failed');
          this.event(t.id, 'contributor', 'assignment.failed',
            `${who} dropped out before starting${why ? `: "${why}"` : ''}`);
          break;
        case 'start':
          set('in_progress');
          this.setState(t, 'in_progress');
          this.event(t.id, 'contributor', 'assignment.started', `${who} started work`);
          break;
        case 'complete':
          set('completed');
          this.setState(t, 'done');
          this.event(t.id, 'contributor', 'assignment.completed', `${who} completed the task`);
          break;
      }
    });
  }

  // ───────────────────────── engine callbacks ─────────────────────────

  /** Deliver every engine answer that is due. Called by the scheduler tick; safe to call anytime. */
  deliverDue(): number {
    const due = this.all<AttemptRow>(
      `SELECT * FROM attempts WHERE status = 'pending' AND sim_returns_at IS NOT NULL AND sim_returns_at <= ? ORDER BY sim_returns_at, id`,
      this.now(),
    );
    for (const a of due) this.tx(() => this.applyResult(a));
    return due.length;
  }

  /** The heart of the system: re-validate an engine answer against current state before acting on it. */
  private applyResult(a: AttemptRow) {
    const t = this.task(a.task_id);
    const pickedName = a.sim_outcome == null ? 'no match' : `picked ${this.name(a.sim_outcome)}`;
    const delayNote = a.sim_returns_at != null && this.now() - a.sim_returns_at > 2_000
      ? ` (delivered ${Math.round((this.now() - a.sim_returns_at) / 1000)}s after the engine answered — server was down)` : '';
    const resolve = (d: Disposition, note: string | null) =>
      this.run(
        `UPDATE attempts SET status = 'returned', resolved_at = ?, result_contributor_id = ?, disposition = ?, note = COALESCE(?, note) WHERE id = ?`,
        this.now(), a.sim_outcome, d, note, a.id,
      );

    // 1. Answer is moot: task moved on while this request was outstanding.
    if (a.abandoned_at != null || t.state !== 'routing') {
      const why = a.abandoned_at != null ? (a.note ?? 'request abandoned') : `task is already ${t.state}`;
      resolve('late_ignored', a.note ?? why);
      this.event(t.id, 'engine', 'routing.result_ignored', `Late answer to request #${a.seq} (${pickedName}) ignored — ${why}${delayNote}`);
      return;
    }

    const othersLive = this.liveAttempts(t.id).filter((x) => x.id !== a.id);
    const stillWaiting = othersLive.length
      ? `; still waiting on request ${othersLive.map((x) => '#' + x.seq).join(', ')}` : '';

    // 2. Engine found nobody.
    if (a.sim_outcome == null) {
      resolve('no_match', null);
      this.event(t.id, 'engine', 'routing.no_match', `Request #${a.seq}: engine found no match${stillWaiting}${delayNote}`);
      if (!othersLive.length) this.setState(t, 'needs_attention', 'no_match');
      else this.bump(t);
      return;
    }

    // 3. Engine picked someone who became busy while the request was in flight (concurrent routing).
    if (this.busyIds().has(a.sim_outcome)) {
      resolve('rejected', `${this.name(a.sim_outcome)} was no longer available`);
      this.event(t.id, 'engine', 'routing.result_rejected',
        `Request #${a.seq} picked ${this.name(a.sim_outcome)}, who took another assignment while the request was in flight — rejected${stillWaiting}${delayNote}`);
      if (!othersLive.length) this.setState(t, 'needs_attention', 'result_rejected');
      else this.bump(t);
      return;
    }

    // 4. Valid match: first one wins, the rest of the hedge is abandoned.
    resolve('applied', null);
    this.run(
      `INSERT INTO assignments (task_id, contributor_id, source, attempt_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      t.id, a.sim_outcome, 'engine', a.id, 'offered', this.now(), this.now(),
    );
    for (const o of othersLive)
      this.run('UPDATE attempts SET abandoned_at = ?, note = ? WHERE id = ?', this.now(), `abandoned: request #${a.seq} matched first`, o.id);
    this.setState(t, 'offered');
    this.event(t.id, 'engine', 'routing.matched',
      `Request #${a.seq} matched ${this.name(a.sim_outcome)} — offer sent` +
        (othersLive.length ? `; request ${othersLive.map((x) => '#' + x.seq).join(', ')} no longer needed` : '') + delayNote);
  }

  /** Written once per process start so the timeline shows restarts explicitly. */
  recordBoot() {
    this.tx(() => {
      const c = this.one<{ live: number; moot: number }>(
        `SELECT SUM(abandoned_at IS NULL) AS live, SUM(abandoned_at IS NOT NULL) AS moot FROM attempts WHERE status = 'pending'`,
      )!;
      const live = c.live ?? 0;
      const moot = c.moot ?? 0;
      this.event(null, 'system', 'system.started',
        `Server started. ${live} live routing request${live === 1 ? '' : 's'} resumed` +
          (moot ? `; ${moot} abandoned request${moot === 1 ? '' : 's'} still outstanding (answers will be ignored)` : '') + '.');
    });
  }

  // ───────────────────────── contributors & seed helpers ─────────────────────────

  addContributor(name: string, expertise: string[]): number {
    return this.tx(() => {
      const res = this.run('INSERT INTO contributors (name, expertise, created_at) VALUES (?,?,?)', name, JSON.stringify(expertise), this.now());
      return Number(res.lastInsertRowid);
    });
  }

  // ───────────────────────── read model ─────────────────────────

  getState() {
    const now = this.now();
    const tasks = this.all<TaskRow>('SELECT * FROM tasks ORDER BY id DESC');
    const attempts = this.all<AttemptRow>(`SELECT * FROM attempts WHERE status = 'pending'`);
    const assignments = this.all<AssignmentRow & { contributor_name: string }>(
      `SELECT a.*, c.name AS contributor_name FROM assignments a JOIN contributors c ON c.id = a.contributor_id
       WHERE a.status IN ('offered','accepted','in_progress','completed') ORDER BY a.id`,
    );
    const byTask = new Map<number, (typeof assignments)[number]>();
    for (const a of assignments) byTask.set(a.task_id, a); // latest wins

    const taskViews = tasks.map((t) => toView(t, attempts.filter((a) => a.task_id === t.id), byTask.get(t.id)));

    const contributors = this.all<ContributorRow>('SELECT * FROM contributors ORDER BY name').map((c) => {
      const active = assignments.find((a) => a.contributor_id === c.id && ACTIVE_ASSIGNMENT.includes(a.status));
      const completed = assignments.filter((a) => a.contributor_id === c.id && a.status === 'completed').length;
      const activeTask = active ? tasks.find((t) => t.id === active.task_id) : undefined;
      return {
        id: c.id,
        name: c.name,
        expertise: JSON.parse(c.expertise) as string[],
        active: active && activeTask ? { taskId: active.task_id, title: activeTask.title, status: active.status } : null,
        completed,
      };
    });

    const events = this.all<EventRow>('SELECT * FROM events ORDER BY id DESC LIMIT 40');
    return { now, normalMaxMs: NORMAL_MAX_MS, expertise: EXPERTISE, scenarios: SCENARIOS, tasks: taskViews, contributors, events };
  }

  getTask(taskId: number) {
    const t = this.task(taskId);
    const attempts = this.all<AttemptRow>('SELECT * FROM attempts WHERE task_id = ? ORDER BY seq', taskId).map((a) => ({
      ...a,
      eligible: (JSON.parse(a.eligible) as number[]).map((id) => ({ id, name: this.name(id) })),
      result_name: a.result_contributor_id != null ? this.name(a.result_contributor_id) : null,
    }));
    const assignments = this.all<AssignmentRow & { contributor_name: string }>(
      `SELECT a.*, c.name AS contributor_name FROM assignments a JOIN contributors c ON c.id = a.contributor_id WHERE a.task_id = ? ORDER BY a.id`,
      taskId,
    );
    const events = this.all<EventRow>('SELECT * FROM events WHERE task_id = ? ORDER BY id', taskId);
    const busy = this.busyIds();
    const refused = this.refusedIds(taskId);
    const candidates = this.all<ContributorRow>('SELECT * FROM contributors ORDER BY name')
      .filter((c) => this.hasExpertise(c, t.expertise))
      .map((c) => ({ id: c.id, name: c.name, busy: busy.has(c.id), refused: refused.has(c.id) }));
    const pending = this.all<AttemptRow>(`SELECT * FROM attempts WHERE task_id = ? AND status = 'pending'`, taskId);
    const current = assignments.filter((a) => a.status !== 'declined' && a.status !== 'failed' && a.status !== 'revoked').at(-1);
    return { now: this.now(), task: toView(t, pending, current), attempts, assignments, events, candidates };
  }
}

/** Single list/detail projection of a task, so both endpoints return the same shape. */
function toView(t: TaskRow, pendingAttempts: AttemptRow[], asg: (AssignmentRow & { contributor_name: string }) | undefined) {
  const live = pendingAttempts.filter((a) => a.abandoned_at == null);
  return {
    ...t,
    assignee: asg
      ? { assignmentId: asg.id, contributorId: asg.contributor_id, name: asg.contributor_name, status: asg.status, source: asg.source }
      : null,
    liveAttempts: live.map((a) => ({ seq: a.seq, startedAt: a.started_at })),
    orphanedAttempts: pendingAttempts.length - live.length, // abandoned, but the engine may still answer
  };
}
