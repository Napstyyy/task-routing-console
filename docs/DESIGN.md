# Task Routing — Design Plan

Status: approved. Fork A = hedge, Fork B = flag only.

## Stack

- **TypeScript everywhere.** One package, two entry points.
- **Server:** Node 26 + Express + `node:sqlite` (built-in, no native build). Single process owns DB and the engine simulator.
- **Web:** React + Vite. Polls `/api/state` every 1s (simple, survives server restart with no reconnect logic).
- **Tests:** Vitest against the domain service with injected clock + RNG. Browser verification via Playwright.

## Domain model

| Entity | Key fields |
|---|---|
| `contributor` | id, name, expertise[] , capacity = 1 active assignment |
| `task` | id, title, expertise, priority (`normal`/`high`), state, version, createdAt, stateChangedAt |
| `routing_attempt` | id, taskId, status, eligibleSnapshot[], startedAt, resolvedAt, **sim fate** (`returnsAt` or `never`, planned outcome), result, disposition |
| `assignment` | id, taskId, contributorId, source (`engine`/`operator`), status, reason, timestamps |
| `event` | append-only log: taskId, actor (`operator`/`engine`/`contributor`/`system`), type, payload, at |

### Task states

```
            submit
              │
              ▼
          ┌────────┐  engine match   ┌─────────┐  accept  ┌──────────┐ start ┌─────────────┐ complete ┌──────┐
          │routing │────────────────▶│ offered │─────────▶│ accepted │──────▶│ in_progress │─────────▶│ done │
          └────────┘                 └─────────┘          └──────────┘       └─────────────┘          └──────┘
           │  ▲  operator assign ──────────▲                   │
           │  │                            │ decline / fail    │ fail before start
           │  └── retry ──┐                ▼                   ▼
           │  no match    │         ┌─────────────────┐
           └─────────────▶└─────────│ needs_attention │  (reason: no_match | declined | failed | result_rejected)
                                    └─────────────────┘
          any non-terminal ── cancel ──▶ cancelled
```

- **Routing complete** = contributor accepted. Before that, operator can do anything.
- `needs_attention` always carries a **reason** + link to the event that caused it. Never auto-loop.

## Core mechanism: attempts are fenced, results are never trusted blindly

Every engine request is a `routing_attempt` row with its own id. When a result arrives, the server re-checks **current** state before applying it:

1. Attempt still `pending` and task still `routing`? → apply (create offer).
2. Task moved on (operator assigned manually, cancelled, another attempt already won)? → record result as **`late_ignored`** with reason, emit event, change nothing. Visible in history.
3. Engine picked a contributor who is now busy (another task grabbed them while this request was in flight)? → **`result_rejected`**, task → `needs_attention` (reason: contributor no longer available).

Result: the "outstanding request may still return afterward" case is safe by construction and shows up in the timeline as a greyed "late result from attempt #2 — ignored, task already assigned to Dana by operator".

## Operator actions

| Action | Allowed when | Effect |
|---|---|---|
| Submit task | create | task → `routing`, attempt #1 starts |
| **Retry routing** | `routing`, `needs_attention` | new attempt; earlier pending attempts **stay live** (hedge). First valid result wins; the rest are logged `late_ignored` |
| **Assign manually** | `routing`, `needs_attention`, `offered` | pick from eligible + available contributors; outstanding attempts marked `abandoned` (late returns logged, ignored); existing offer revoked |
| Revoke offer | `offered` | assignment `revoked`, task → `needs_attention` |
| Cancel task | any non-terminal | outstanding attempts abandoned, offer revoked |
| Bump priority | any non-terminal | high-priority sorts to top, gets louder overdue alert |

All mutations send `expectedVersion`; stale UI → **409** with "task changed since you looked: <latest event>". Covers two tabs and the engine landing a result while operator is clicking.

## Unresolved routing (no timeout can be "right")

- Spec: normal return 5–20s; 20% never return; can't tell which.
- UI shows per-attempt elapsed time with bands: `< 20s` normal · `> 20s` **overdue — past normal window** (we don't claim "dead"). High priority + overdue → task pinned to top, red.
- **No automatic kill.** Overdue attempts stay live; if they do return, result still honoured (if task still routing) — operator lost nothing by waiting.
- **Decision:** no auto-retry, even for high priority. System flags; operator decides. Auto-escalation is a listed next step.

## Contributor side (simulated)

Contributors aren't users of this app. Each offered/accepted assignment shows a clearly labelled **"Simulate contributor"** control: Accept / Decline (with reason) / Fail before start / Start / Complete. Keeps recovery scenarios deterministic for the demo.

## Engine simulator

- In-process, but modelled as external: server only sees "request sent" and later "result callback".
- Fate decided at request time and **persisted** on the attempt row: 80% → `returnsAt = now + U(5s, 20s)` with outcome (pick among eligible snapshot, or no_match ~10%); 20% → `never`.
- Scheduler tick (500ms) delivers due results. Because fate is in DB, **server restart resumes exactly**: pending attempts keep pending, due ones deliver on boot ("result arrived while we were down").
- **Deterministic scenarios:** create-task form has a "Simulation" dropdown (Random / Fast match / Slow match 18s / Never returns / No match) — forces attempt #1's fate. Plus a "Scenarios" button seeding the four use cases in one click.
- Engine choice rule: least-recently-assigned eligible contributor from the snapshot taken at request time (snapshot = matching expertise, not necessarily free — engine is dumb about load, server validates).

## Restart / refresh

- All state in SQLite; UI is a pure projection, reload loses nothing.
- On boot: `system` event "server started; N attempts still pending" so the timeline shows the gap.
- Contributor offers have no auto-expiry (omission, documented).

## UI (single page)

- **Header strip:** counts — routing / overdue / needs attention / offered / active / done; contributors free vs busy.
- **Task table:** priority, title, expertise, state badge (+reason), age since created, time in current state, assignee, live attempts count with elapsed timer. Sort: needs-attention & overdue-high first.
- **Task drawer:** actions, attempts list (each with status + elapsed + disposition), assignment history, full event timeline.
- **Contributors panel:** expertise chips, current load, history count.
- **Create task** form.

## Testing plan

- Unit (Vitest, fake clock): happy path; late result after manual assign → ignored; hedged attempts first-wins; result for busy contributor → rejected; decline → needs_attention → retry → accept; version conflict 409; restart resume (reopen DB, tick, verify delivery).
- E2E: Playwright drive of the four use cases.

## Intentional omissions (planned)

Auth/multi-operator identity, offer expiry timers, contributor-facing app, real recommendation logic, websockets, multi-assignee, horizontal scaling (single process owns scheduler).
