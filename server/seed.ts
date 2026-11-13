import type { DB } from './db.ts';
import { RoutingService } from './service.ts';

const CONTRIBUTORS: [string, string[]][] = [
  ['Ana Ruiz', ['finance', 'data analysis']],
  ['Ben Okafor', ['healthcare', 'operations']],
  ['Chloe Park', ['healthcare']],
  ['Dev Patel', ['data analysis']],
  ['Elena Rossi', ['operations']],
  ['Farid Haddad', ['finance']],
  ['Grace Liu', ['healthcare', 'data analysis']],
  ['Hugo Silva', ['operations', 'finance']],
];

export function wipe(db: DB) {
  db.exec(`DELETE FROM events; DELETE FROM assignments; DELETE FROM attempts; DELETE FROM tasks; DELETE FROM contributors;
           DELETE FROM sqlite_sequence;`);
}

/**
 * Seed contributors plus a few tasks with realistic history. History is produced by driving the real
 * service with a fake clock that ends before "now", so seeded timelines are genuine, not hand-written rows.
 */
export function seed(db: DB) {
  let clock = Date.now() - 3 * 60 * 60_000;
  const svc = new RoutingService(db, { now: () => clock, rng: () => 0 });
  const tick = (ms: number) => {
    clock += ms;
    svc.deliverDue();
  };
  const ids = Object.fromEntries(CONTRIBUTORS.map(([n, e]) => [n, svc.addContributor(n, e)]));
  const current = (taskId: number) => svc.getTask(taskId).assignments.at(-1)!.id;
  const version = (taskId: number) => svc.getTask(taskId).task.version;

  // Done: full happy path.
  const done = svc.createTask({ title: 'Q3 revenue model review', description: 'Sanity-check assumptions in the Q3 revenue model.', expertise: 'finance', scenario: 'fast_match' });
  tick(5_000);
  svc.respond(current(done), 'accept');
  tick(60_000);
  svc.respond(current(done), 'start');
  tick(45 * 60_000);
  svc.respond(current(done), 'complete');

  // In progress.
  const wip = svc.createTask({ title: 'Readmission dataset cleanup', description: 'Deduplicate and label 30-day readmission records.', expertise: 'data analysis', scenario: 'fast_match' });
  tick(5_000);
  svc.respond(current(wip), 'accept');
  tick(2 * 60_000);
  svc.respond(current(wip), 'start');

  // Declined → needs attention (recovery case ready to demo).
  tick(30 * 60_000);
  const declined = svc.createTask({ title: 'Payer contract benchmarks', description: 'Compare reimbursement rates across three payers.', expertise: 'healthcare', priority: 'high', scenario: 'fast_match' });
  tick(5_000);
  svc.respond(current(declined), 'decline', 'Conflict of interest — previously consulted for one of the payers');

  // Operator-assigned offer awaiting response.
  tick(10 * 60_000);
  const offered = svc.createTask({ title: 'Vendor onboarding runbook', description: 'Draft step-by-step onboarding for new logistics vendors.', expertise: 'operations', scenario: 'never' });
  tick(40_000);
  svc.assign(offered, ids['Elena Rossi'], version(offered));

  // Nobody has the expertise.
  tick(5 * 60_000);
  svc.createTask({ title: 'Contract clause audit', description: 'Flag non-standard indemnity clauses.', expertise: 'legal' });
}

/** One-click setup of the four core scenarios, using live time. */
export function loadScenarios(svc: RoutingService) {
  const made = [
    svc.createTask({ title: 'Routine: market sizing memo', description: 'Engine will match in 5s. Accept → start → complete.', expertise: 'finance', scenario: 'fast_match' }),
    svc.createTask({ title: 'Unresolved: ICU staffing analysis', description: 'Engine will never answer. Watch it go overdue; retry or assign.', expertise: 'healthcare', priority: 'high', scenario: 'never' }),
    svc.createTask({ title: 'Intervention: KPI dashboard audit', description: 'Engine answers at 19s. Assign manually before then and watch the late answer get ignored.', expertise: 'data analysis', scenario: 'slow_match' }),
    svc.createTask({ title: 'Recovery: supplier risk review', description: 'Engine matches in 5s. Have the contributor decline or drop out, then recover.', expertise: 'operations', scenario: 'fast_match' }),
  ];
  return made;
}
