import { useState, type ReactNode } from 'react';
import { api, type TaskDetail, type AttemptView } from './client';
import { dur, clock, STATE_LABEL, routingInfo } from './format';
import type { Run } from './App';

export function TaskPanel({
  d,
  now,
  normalMaxMs,
  internals,
  run,
  onClose,
}: {
  d: TaskDetail;
  now: number;
  normalMaxMs: number;
  internals: boolean;
  run: Run;
  onClose: () => void;
}) {
  const t = d.task;
  const expectedVersion = t.version; // every operator command carries the version we are looking at
  const act = (action: 'retry' | 'revoke' | 'cancel', msg: string) => run(() => api.taskAction(t.id, action, { expectedVersion }), msg);
  const [pick, setPick] = useState<number | ''>('');
  const [reason, setReason] = useState('');

  const r = routingInfo(t, now, normalMaxMs);
  const active = d.assignments.findLast((a) => ['offered', 'accepted', 'in_progress'].includes(a.status));
  const lastClosed = d.assignments.at(-1);
  const canRoute = t.state === 'routing' || t.state === 'needs_attention';
  const canAssign = canRoute || t.state === 'offered';
  const open = t.state !== 'done' && t.state !== 'cancelled';
  const freeCandidates = d.candidates.filter((c) => !c.busy && c.id !== active?.contributor_id);

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="muted small">
            T-{t.id} · created {clock(t.created_at)} · {dur(now - t.created_at)} ago
          </div>
          <h2>{t.title}</h2>
          {t.description && <p className="desc">{t.description}</p>}
          <div className="meta">
            <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
            <span className="chip">{t.expertise}</span>
            <button
              className={`prio ${t.priority}`}
              disabled={!open}
              title="Toggle priority"
              onClick={() => run(() => api.taskAction(t.id, 'priority', { priority: t.priority === 'high' ? 'normal' : 'high', expectedVersion }))}
            >
              {t.priority === 'high' ? '▲ high priority' : 'normal priority'}
            </button>
          </div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <Situation d={d} now={now} r={r} lastClosed={lastClosed} />

      {open && (
        <section className="actions">
          <h3>Operator actions</h3>
          <div className="btns">
            {canRoute && (
              <button onClick={() => act('retry', 'Sent another routing request')} title="Sends a new request. Pending requests stay live; first valid answer wins.">
                {t.state === 'routing' ? 'Send another request' : 'Retry routing'}
              </button>
            )}
            {(t.state === 'offered' || t.state === 'accepted') && (
              <button onClick={() => act('revoke', 'Unassigned')}>Unassign {active?.contributor_name}</button>
            )}
            <button className="danger ghost" onClick={() => confirm(`Cancel T-${t.id}?`) && act('cancel', 'Task cancelled')}>
              Cancel task
            </button>
          </div>
          {canAssign && (
            <div className="assign">
              <select value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Assign manually…</option>
                {d.candidates
                  .filter((c) => c.id !== active?.contributor_id)
                  .map((c) => (
                    <option key={c.id} value={c.id} disabled={c.busy}>
                      {c.name}
                      {c.busy ? ' (busy)' : c.refused ? ' (already refused this task)' : ''}
                    </option>
                  ))}
              </select>
              <button
                className="primary"
                disabled={pick === ''}
                onClick={async () => {
                  if (await run(() => api.taskAction(t.id, 'assign', { contributorId: pick, expectedVersion }), 'Assigned manually')) setPick('');
                }}
              >
                Assign
              </button>
              {freeCandidates.length === 0 && <small className="warn-text">No free contributor with {t.expertise} expertise.</small>}
              {t.state === 'routing' && <small className="muted">Ends routing. Outstanding requests may still answer; those answers will be logged and ignored.</small>}
            </div>
          )}
        </section>
      )}

      {active && (
        <section className="sim-box">
          <h3>
            Simulate {active.contributor_name} <span className="muted small">(contributor side — not an operator action)</span>
          </h3>
          <div className="btns">
            {active.status === 'offered' && (
              <button onClick={() => run(() => api.respond(active.id, 'accept'), `${active.contributor_name} accepted`)}>Accept</button>
            )}
            {active.status === 'accepted' && (
              <button onClick={() => run(() => api.respond(active.id, 'start'), 'Work started')}>Start work</button>
            )}
            {active.status === 'in_progress' && (
              <button onClick={() => run(() => api.respond(active.id, 'complete'), 'Completed')}>Complete</button>
            )}
            {active.status === 'offered' && (
              <button onClick={() => run(() => api.respond(active.id, 'decline', reason), 'Declined').then(() => setReason(''))}>Decline</button>
            )}
            {(active.status === 'offered' || active.status === 'accepted') && (
              <button onClick={() => run(() => api.respond(active.id, 'fail', reason), 'Dropped out').then(() => setReason(''))}>Drop out</button>
            )}
          </div>
          {(active.status === 'offered' || active.status === 'accepted') && (
            <input className="reason-input" placeholder="Reason for decline / drop out (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </section>
      )}

      <section>
        <h3>Routing requests</h3>
        {d.attempts.length === 0 ? (
          <p className="muted small">None sent.</p>
        ) : (
          <ol className="attempts">
            {d.attempts.map((a) => (
              <Attempt key={a.id} a={a} now={now} normalMaxMs={normalMaxMs} internals={internals} />
            ))}
          </ol>
        )}
      </section>

      {d.assignments.length > 0 && (
        <section>
          <h3>Assignments</h3>
          <ul className="assignments">
            {d.assignments.map((a) => (
              <li key={a.id}>
                <span className={`astatus ${a.status}`}>{a.status.replace('_', ' ')}</span>
                <b>{a.contributor_name}</b>
                <span className="muted"> · {a.source === 'operator' ? 'manual' : 'engine'} · {clock(a.created_at)}</span>
                {a.reason && <div className="small muted">“{a.reason}”</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>History</h3>
        <ol className="timeline">
          {d.events.map((e) => (
            <li key={e.id} className={`ev ${e.actor} ${e.type.replace('.', '-')}`}>
              <span className="when" title={new Date(e.at).toLocaleString()}>{clock(e.at)}</span>
              <span className={`actor ${e.actor}`}>{e.actor}</span>
              <span className="msg">{e.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

/** Plain-language "what is going on and what can I do" box. The single most important thing on the panel. */
function Situation({ d, now, r, lastClosed }: { d: TaskDetail; now: number; r: ReturnType<typeof routingInfo>; lastClosed: TaskDetail['assignments'][number] | undefined }) {
  const t = d.task;
  const lastEngine = [...d.attempts].reverse().find((a) => a.status === 'returned' && a.disposition !== 'late_ignored');
  let tone: 'info' | 'warn' | 'bad' | 'ok' = 'info';
  let body: ReactNode = null;

  if (t.state === 'routing' && r) {
    if (r.overdue) {
      tone = t.priority === 'high' ? 'bad' : 'warn';
      body = (
        <>
          <b>Request #{r.newest.seq} has been pending {dur(r.elapsed)}</b> — past the engine's normal 5–20s window. It may be slow or it may never
          answer; there is no way to tell from here. <b>Send another request</b> to hedge (this one stays live, first valid answer wins), or{' '}
          <b>assign manually</b>.
        </>
      );
    } else {
      body = (
        <>
          Waiting on routing request #{r.newest.seq} ({dur(r.elapsed)}). Normal answers arrive within 5–20s.
          {r.live > 1 && ` ${r.live} requests live; the first valid answer wins.`}
        </>
      );
    }
  } else if (t.state === 'needs_attention') {
    tone = 'bad';
    const who = lastClosed?.contributor_name;
    const msg: Record<string, ReactNode> = {
      no_eligible: <>No free contributor has <b>{t.expertise}</b> expertise, so nothing was sent to the engine. Retry when someone frees up, or cancel.</>,
      no_match: <>The engine answered request #{lastEngine?.seq} with <b>no match</b>. Retry (the engine may pick differently) or assign manually.</>,
      result_rejected: (
        <>
          Request #{lastEngine?.seq} picked <b>{lastEngine?.result_name}</b>, but they took another assignment while the request was in flight. Retry or
          assign someone else.
        </>
      ),
      declined: <><b>{who}</b> declined{lastClosed?.reason ? <>: “{lastClosed.reason}”</> : ''}. Retry routing or assign someone else.</>,
      failed: <><b>{who}</b> dropped out before work began{lastClosed?.reason ? <>: “{lastClosed.reason}”</> : ''}. Retry routing or assign someone else.</>,
      revoked: <>You unassigned <b>{who}</b>. Retry routing or assign someone else.</>,
    };
    body = msg[t.reason ?? ''] ?? 'Needs a decision.';
  } else if (t.state === 'offered') {
    body = <>Offered to <b>{t.assignee?.name}</b> ({t.assignee?.source === 'operator' ? 'manual' : 'engine'}) {dur(now - t.state_changed_at)} ago. Waiting for them to accept.</>;
  } else if (t.state === 'accepted') {
    tone = 'ok';
    body = <><b>{t.assignee?.name}</b> accepted — routing complete. Waiting for work to start.</>;
  } else if (t.state === 'in_progress') {
    tone = 'ok';
    body = <><b>{t.assignee?.name}</b> is working on it.</>;
  } else if (t.state === 'done') {
    tone = 'ok';
    body = <>Completed by <b>{t.assignee?.name}</b>.</>;
  } else if (t.state === 'cancelled') {
    body = 'Cancelled.';
  }

  const orphaned = d.attempts.filter((a) => a.status === 'pending' && a.abandoned_at != null).length;
  return (
    <div className={`situation ${tone}`}>
      {body}
      {orphaned > 0 && (
        <div className="small orphan">
          {orphaned} earlier request{orphaned > 1 ? 's are' : ' is'} still outstanding at the engine. If {orphaned > 1 ? 'they answer' : 'it answers'}, the answer
          will be logged and ignored.
        </div>
      )}
    </div>
  );
}

function Attempt({ a, now, normalMaxMs, internals }: { a: AttemptView; now: number; normalMaxMs: number; internals: boolean }) {
  const pending = a.status === 'pending';
  const elapsed = (a.resolved_at ?? now) - a.started_at;
  let status: ReactNode;
  if (pending && a.abandoned_at == null)
    status = <span className={elapsed > normalMaxMs ? 'overdue' : 'waiting'}><span className="spinner" /> pending {dur(elapsed)}{elapsed > normalMaxMs && ' · overdue'}</span>;
  else if (pending) status = <span className="muted">outstanding, will be ignored · {dur(elapsed)}</span>;
  else {
    const label = { applied: `matched ${a.result_name}`, no_match: 'no match', rejected: `picked ${a.result_name} — rejected`, late_ignored: `late: ${a.result_name ?? 'no match'} — ignored` }[a.disposition!];
    status = <span className={`disp ${a.disposition}`}>{label} · after {dur(elapsed)}</span>;
  }
  return (
    <li className={pending && a.abandoned_at == null ? 'live' : ''}>
      <div>
        <b>#{a.seq}</b> <span className="muted small">sent {clock(a.started_at)}</span> · {status}
      </div>
      <div className="small muted">eligible: {a.eligible.map((e) => e.name).join(', ')}</div>
      {a.note && <div className="small muted">{a.note}</div>}
      {internals && (
        <div className="small internals">
          sim: {a.sim_label}
          {a.sim_returns_at && pending ? ` · answers in ${dur(a.sim_returns_at - now)}` : ''}
        </div>
      )}
    </li>
  );
}
