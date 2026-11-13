# Routing console

A small full-stack system that routes tasks to contributors by expertise, with a simulated
unreliable routing engine and an operator console for monitoring and intervening.

```bash
npm install
npm run dev        # API on :3001, console on http://localhost:5173
npm test           # domain tests (Vitest, fake clock)
npm run build && npm start   # single process serving the built console on :3001
```

Node 22.5+ is required (uses the built-in `node:sqlite`). Data lives in `data/app.db`; delete it, or use
**Demo → Reset to seed data**, to start over. **Demo → Load use-case scenarios** creates one task per
core scenario (routine, unresolved routing, intervention, recovery).

## What the operator gets

- **Queue** sorted by what needs a human: tasks needing attention and overdue routing first, high priority
  first within that, then oldest first. Each row shows state, why it's in that state, live routing timer,
  assignee, age since creation and time in current state.
- **Header counts** for needs attention / routing (with overdue count) / awaiting accept / active / done,
  and free contributors.
- **Task panel**: a plain-language *situation* box (what happened, what you can do), operator actions,
  every routing request with its outcome, assignment history, and a full event timeline.
- **Contributors** with expertise and current load; a global **activity feed**.

## Model

| | |
|---|---|
| Task states | `routing → offered → accepted → in_progress → done`, plus `needs_attention` (always with a reason) and `cancelled` |
| Attention reasons | `no_eligible`, `no_match`, `result_rejected`, `declined`, `failed`, `revoked` |
| Routing attempt | one row per request sent to the engine: `pending` until it answers, then `returned` with a disposition `applied` / `no_match` / `rejected` / `late_ignored`. Can be *abandoned* while still pending. |
| Assignment | `offered → accepted → in_progress → completed`, or `declined` / `failed` / `revoked` |
| Event | append-only log, actor = operator / engine / contributor / system |

"Routing complete" = the contributor accepted. A contributor has capacity 1: anyone
with an offered, accepted or in-progress assignment is busy.

## Key decisions

**1. Engine answers are re-validated against current state before they are applied.** This is the core
of the design. Every request is its own row. When an answer arrives the server checks, in one transaction:
- task no longer routing, or request abandoned → record `late_ignored` with the reason, change nothing;
- no match → `needs_attention` unless another request for the task is still live;
- picked a contributor who became busy while the request was in flight (concurrent routing) →
  `rejected`, same fallback;
- otherwise → offer, and abandon any other live requests for the task.

So "the outstanding request may still return afterward" is safe by construction, and visible: the late
answer shows struck through in the panel and in the timeline ("Late answer to request #1 (picked Dev
Patel) ignored — abandoned: operator assigned Grace Liu manually").

**2. Never time out a request; flag it.** The operator *cannot know* whether a pending
request is slow or dead, so the system doesn't pretend to. After 20s (the engine's normal upper bound)
the request is marked *overdue — past normal window*; high-priority overdue tasks turn red and sort to
the top. Nothing is killed automatically. If an overdue request does answer and the task is still
routing, the answer is used.

**3. Retry hedges instead of superseding.** "Send another request" fires a new request while earlier ones
stay live; the first valid answer wins and the rest become `late_ignored`. Throwing away a request that
might be seconds from answering only makes the operator's wait longer. Manual assignment and cancel end
routing: outstanding requests are marked abandoned but still tracked, because the engine doesn't know.

**4. No automatic retry, even for high priority.** The system surfaces; the operator decides. Auto-hedging
high-priority tasks after the window is an obvious next step but adds an actor that can surprise people.

**5. Optimistic concurrency on every operator command.** Commands carry the task `version` the operator
was looking at. If the engine answered, a contributor responded or another tab acted in between, the
server returns 409 with what changed ("T-3 changed since you loaded it (now offered). Latest: Request #1
matched Ana Ruiz — offer sent") instead of overwriting it.

**6. Re-routing excludes people who already refused the task.** After a decline or drop-out the contributor
is free again; without this, "Retry routing" could send them straight back to the engine. The exclusion is
logged on the request. Manual assignment still lists them, labelled, because the operator may know better.

**7. Restart and refresh lose nothing.** All state is in SQLite and the UI is a projection polled every
second. The simulated engine's fate for each request (when it answers and with what, or never) is decided
when the request is sent and **persisted with it**, so a restart neither drops in-flight requests nor
re-rolls them. Answers that came due while the server was down are delivered on boot and annotated
("delivered 2s after the engine answered — server was down"). Each boot writes a system event with how many
live and abandoned requests were resumed. This models an external engine that retries its callback.

**8. Don't send hopeless requests.** If nobody free has the expertise, nothing is sent to the engine;
the task goes straight to `needs_attention / no_eligible`.

**9. Contributors are simulated, and visibly so.** This is an operator product, so contributor
responses (accept, decline with reason, drop out before starting, start, complete) are buttons in a dashed
"Simulate …" box on the task panel, separated from operator actions.

## Engine simulation

- `random` (default; all retries): 20% never answer. The rest answer uniformly in 5–20s; 10% of those
  are "no match", otherwise a random contributor from the eligible snapshot sent with the request.
- Demo scenarios, chosen when creating a task, force the *first* request: `fast_match` (5s),
  `slow_match` (19s), `never`, `no_match` (8s). Forced scenarios pick the first eligible contributor so
  scripted demos are deterministic.
- **Demo → Reveal engine internals** shows each request's simulated fate. This is deliberately off by
  default: it is information the operator could never have.
- The engine only reads the snapshot it was sent; it doesn't know about load. The server validates.

## Code map

```
server/db.ts            schema (SQLite via node:sqlite)
server/service.ts       domain: commands, engine callback handling, read model, engine simulator
server/service.test.ts  scenario tests with injected clock and RNG
server/seed.ts          seed data (built by driving the real service with a fake clock) + demo scenarios
server/app.ts           HTTP routes, DomainError → status code
server/index.ts         boot, 500ms delivery tick
web/                    React console (App, TaskPanel, CreateTask)
docs/DESIGN.md          the plan written before any code; deviations listed below
```

## Verification

- `npm test`: 17 tests covering the happy path; never-returning request stays routing indefinitely; hedge
  where the second request wins and the first is ignored when it lands; no-match on one hedge leg while
  another is live; manual assign then late answer; cancel then late answer; stale-version 409; concurrent
  routing where the engine's pick was taken in flight; decline/drop-out recovery; decliner excluded on
  retry; contributor answering a revoked offer; restart with an answer due during downtime; list/detail
  projection parity; simulated fate distribution.
- All four use cases were driven in a real browser (Playwright) against the dev server, including a
  server kill and restart while a request was in flight.

## Assumptions

- One operator role, no auth. Several tabs are possible and handled by the version check.
- A contributor works on one task at a time.
- Accepting ends routing; "fails before work begins" can happen after acceptance (contributor drops out
  before starting), which reopens the task.
- Operator assignment still needs the contributor to accept: it skips routing, not consent.

## Intentional omissions

- **Offer expiry.** An offer nobody answers waits forever; the operator sees time in state and can
  unassign. A timer is easy; choosing its value without real data isn't.
- **Automatic retry / escalation** (see decision 4).
- **Real-time push.** One-second polling is simple and survives restarts with no reconnect logic. At scale,
  SSE.
- **Auth, multiple operators, contributor-facing app, notifications.**
- **Matching quality.** Expertise match plus availability; no skill levels, load balancing or history.
- **Multi-process.** One process owns the DB and the delivery loop. Scaling out would need a lease on
  delivery and a real callback endpoint.
- **Automated browser tests.** The domain rules are unit-tested; the UI was verified by driving it.
- **Pagination, search, editing tasks after creation.**

## Deviations from the plan in `docs/DESIGN.md`

- Engine picks randomly rather than least-recently-assigned (matching quality isn't the focus here).
- Added: excluding decliners from re-routing, deterministic forced scenarios. Both came out of driving the
  UI: the "Recovery" demo task collided with another task's random pick, and retrying after a decline
  could have sent the same person again.

## Next steps

1. Auto-hedge for high priority after the normal window, as a visible, per-task policy the operator can
   turn off.
2. Offer expiry with a visible countdown.
3. SSE for updates; a "since you last looked" marker on tasks.
4. Contributor-side app with real acceptance, replacing the simulation buttons.
