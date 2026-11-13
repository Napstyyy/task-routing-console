import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from './db.ts';
import { RoutingService, DomainError, planFate } from './service.ts';

let clock: number;
let db: DB;
let svc: RoutingService;
let ana: number, ben: number, cara: number;

const advance = (ms: number) => {
  clock += ms;
  return svc.deliverDue();
};
const task = (id: number) => svc.getTask(id);
const states = (id: number) => task(id).attempts.map((a) => a.disposition ?? (a.abandoned_at ? 'abandoned' : a.status));

function make(path = ':memory:') {
  db = openDb(path);
  svc = new RoutingService(db, { now: () => clock, rng: () => 0 }); // rng 0 => engine picks first eligible
}

beforeEach(() => {
  clock = 1_000_000;
  make();
  ana = svc.addContributor('Ana', ['finance', 'data analysis']);
  ben = svc.addContributor('Ben', ['finance']);
  cara = svc.addContributor('Cara', ['healthcare']);
});

describe('routine assignment', () => {
  it('routes, offers, accepts, starts, completes', () => {
    const id = svc.createTask({ title: 'Model review', expertise: 'finance', scenario: 'fast_match' });
    expect(task(id).task.state).toBe('routing');
    expect(advance(4_999)).toBe(0);
    expect(advance(1)).toBe(1);
    const t = task(id);
    expect(t.task.state).toBe('offered');
    expect(t.assignments[0]).toMatchObject({ contributor_id: ana, source: 'engine', status: 'offered' });
    const aid = t.assignments[0].id;
    svc.respond(aid, 'accept');
    expect(task(id).task.state).toBe('accepted');
    svc.respond(aid, 'start');
    svc.respond(aid, 'complete');
    expect(task(id).task.state).toBe('done');
  });

  it('skips the engine when nobody with the expertise is available', () => {
    const id = svc.createTask({ title: 'Contract review', expertise: 'legal' });
    const t = task(id);
    expect(t.task).toMatchObject({ state: 'needs_attention', reason: 'no_eligible' });
    expect(t.attempts).toHaveLength(0);
  });
});

describe('unresolved routing', () => {
  it('a request that never returns leaves the task routing indefinitely (no silent timeout)', () => {
    const id = svc.createTask({ title: 'Urgent', expertise: 'healthcare', priority: 'high', scenario: 'never' });
    advance(10 * 60_000);
    expect(task(id).task.state).toBe('routing');
    expect(states(id)).toEqual(['pending']);
  });
});

describe('hedging with controlled rng', () => {
  it('second request wins; first returns later and is logged late_ignored', () => {
    // rng draws: #1 slow_match pick (0.5 => Ben); #2 random: 0.5 not-never, 0 delay=5s, 0.5 not-no-match, 0 pick Ana
    const seq = [0.5, 0.5, 0, 0.5, 0];
    svc = new RoutingService(db, { now: () => clock, rng: () => seq.shift() ?? 0 });
    const id = svc.createTask({ title: 'Hedge', expertise: 'finance', scenario: 'slow_match' }); // 19s; pick uses rng => 0.5 => Ben
    advance(2_000);
    svc.retry(id, task(id).task.version); // #2 returns at +5s
    expect(task(id).attempts.map((a) => a.status)).toEqual(['pending', 'pending']);
    advance(5_000);
    let t = task(id);
    expect(t.task.state).toBe('offered');
    expect(states(id)).toEqual(['abandoned', 'applied']);
    advance(20_000); // #1 finally answers
    t = task(id);
    expect(states(id)).toEqual(['late_ignored', 'applied']);
    expect(t.assignments).toHaveLength(1);
    expect(t.events.at(-1)!.type).toBe('routing.result_ignored');
  });

  it('no-match on one hedge leg keeps the task routing while another leg is live', () => {
    const seq = [0.5, 0.5, 0.5, 0];
    svc = new RoutingService(db, { now: () => clock, rng: () => seq.shift() ?? 0 });
    const id = svc.createTask({ title: 'Hedge', expertise: 'finance', scenario: 'no_match' }); // answers at 8s, no match
    svc.retry(id, task(id).task.version); // random: returns at 5s+7.5s=12.5s, match
    advance(8_000);
    expect(task(id).task.state).toBe('routing');
    advance(5_000);
    expect(task(id).task.state).toBe('offered');
  });
});

describe('human intervention while routing is pending', () => {
  it('manual assignment wins; the late engine answer is recorded and ignored', () => {
    const id = svc.createTask({ title: 'Intervene', expertise: 'finance', scenario: 'slow_match' });
    advance(3_000);
    svc.assign(id, ben, task(id).task.version);
    expect(task(id).task.state).toBe('offered');
    expect(states(id)).toEqual(['abandoned']);
    advance(16_000);
    const t = task(id);
    expect(states(id)).toEqual(['late_ignored']);
    expect(t.assignments).toHaveLength(1);
    expect(t.assignments[0]).toMatchObject({ contributor_id: ben, source: 'operator', status: 'offered' });
  });

  it('late answer after cancel is ignored', () => {
    const id = svc.createTask({ title: 'Cancel me', expertise: 'finance', scenario: 'fast_match' });
    svc.cancel(id, task(id).task.version);
    advance(5_000);
    expect(task(id).task.state).toBe('cancelled');
    expect(states(id)).toEqual(['late_ignored']);
  });

  it('stale operator view is rejected with 409 instead of overwriting the engine result', () => {
    const id = svc.createTask({ title: 'Race', expertise: 'finance', scenario: 'fast_match' });
    const seenVersion = task(id).task.version;
    advance(5_000); // engine answers while operator is looking
    expect(() => svc.assign(id, ben, seenVersion)).toThrow(DomainError);
    try {
      svc.assign(id, ben, seenVersion);
    } catch (e) {
      expect((e as DomainError).status).toBe(409);
      expect((e as DomainError).code).toBe('stale');
    }
  });
});

describe('concurrent routing', () => {
  it('engine picks someone who was taken by another task meanwhile: result rejected', () => {
    const a = svc.createTask({ title: 'A', expertise: 'finance', scenario: 'slow_match' }); // snapshot [Ana, Ben], picks Ana at 19s
    const b = svc.createTask({ title: 'B', expertise: 'finance', scenario: 'fast_match' }); // picks Ana at 5s
    advance(5_000);
    expect(task(b).assignments[0].contributor_id).toBe(ana);
    advance(14_000);
    const t = task(a);
    expect(t.task).toMatchObject({ state: 'needs_attention', reason: 'result_rejected' });
    expect(states(a)).toEqual(['rejected']);
  });
});

describe('recovery', () => {
  it('declined → needs_attention → retry → new contributor', () => {
    const id = svc.createTask({ title: 'Recover', expertise: 'finance', scenario: 'fast_match' });
    advance(5_000);
    svc.respond(task(id).assignments[0].id, 'decline', 'conflict of interest');
    let t = task(id);
    expect(t.task).toMatchObject({ state: 'needs_attention', reason: 'declined' });
    expect(t.assignments[0]).toMatchObject({ status: 'declined', reason: 'conflict of interest' });
    // Ana is free again, so she is eligible again; operator picks Ben explicitly instead.
    svc.assign(id, ben, t.task.version);
    t = task(id);
    expect(t.assignments.map((a) => a.status)).toEqual(['declined', 'offered']);
  });

  it('fail after accept but before start → needs_attention', () => {
    const id = svc.createTask({ title: 'Recover', expertise: 'healthcare', scenario: 'fast_match' });
    advance(5_000);
    const aid = task(id).assignments[0].id;
    svc.respond(aid, 'accept');
    svc.respond(aid, 'fail', 'sick');
    expect(task(id).task).toMatchObject({ state: 'needs_attention', reason: 'failed' });
    expect(() => svc.respond(aid, 'start')).toThrow(/failed/);
    expect(task(id).events.at(-1)!.type).toBe('contributor.response_ignored');
  });

  it('contributor accepting a revoked offer is ignored and logged', () => {
    const id = svc.createTask({ title: 'Revoke', expertise: 'finance', scenario: 'fast_match' });
    advance(5_000);
    const aid = task(id).assignments[0].id;
    svc.revoke(id, task(id).task.version);
    expect(() => svc.respond(aid, 'accept')).toThrow();
    expect(task(id).task.state).toBe('needs_attention');
  });

  it('cannot assign a busy contributor', () => {
    const a = svc.createTask({ title: 'A', expertise: 'healthcare', scenario: 'fast_match' });
    advance(5_000);
    const b = svc.createTask({ title: 'B', expertise: 'healthcare' });
    expect(task(b).task.reason).toBe('no_eligible');
    expect(() => svc.assign(b, cara)).toThrow(/active assignment/);
    expect(task(a).task.state).toBe('offered');
  });
});

describe('restart', () => {
  it('pending requests survive a restart; answers due during downtime are delivered on boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-'));
    const path = join(dir, 'test.db');
    make(path);
    const c = svc.addContributor('Dee', ['operations']);
    const slow = svc.createTask({ title: 'Slow', expertise: 'operations', scenario: 'slow_match' });
    const never = svc.createTask({ title: 'Never', expertise: 'operations', scenario: 'never' });
    db.close();

    clock += 60_000; // down for a minute
    make(path);
    svc.recordBoot();
    svc.deliverDue();
    expect(task(slow).task.state).toBe('offered');
    expect(task(slow).assignments[0].contributor_id).toBe(c);
    expect(task(slow).events.at(-1)!.message).toMatch(/server was down/);
    expect(task(never).task.state).toBe('routing'); // still outstanding, still unknowable
    expect(task(never).attempts[0].status).toBe('pending');
  });
});

describe('planFate', () => {
  it('random distribution roughly matches spec', () => {
    let never = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const f = planFate('random', [1, 2], 0, Math.random);
      if (f.returnsAt == null) never++;
      else expect(f.returnsAt).toBeGreaterThanOrEqual(5_000), expect(f.returnsAt).toBeLessThanOrEqual(20_000);
    }
    expect(never / n).toBeGreaterThan(0.18);
    expect(never / n).toBeLessThan(0.22);
  });
});
