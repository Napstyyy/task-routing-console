import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type AppState, type TaskDetail, type TaskView } from './client';
import { dur, clock, STATE_LABEL, REASON_LABEL, routingInfo, urgency } from './format';
import { TaskPanel } from './TaskPanel';
import { CreateTask } from './CreateTask';

type Filter = 'action' | 'open' | 'closed' | 'all';
export type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [selected, setSelected] = useState<number | null>(() => Number(new URLSearchParams(location.search).get('task')) || null);
  const [filter, setFilter] = useState<Filter>('open');
  const [creating, setCreating] = useState(false);
  const [internals, setInternals] = useState(false);
  const [toast, setToast] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const skew = useRef(0); // serverNow - localNow, so timers use the server's clock
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      skew.current = s.now - Date.now();
      setState(s);
      setOffline(false);
      if (selected != null) {
        try {
          setDetail(await api.task(selected));
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) setSelected(null);
        }
      }
    } catch {
      setOffline(true);
    }
  }, [selected]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 1000);
    return () => clearInterval(poll);
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set('task', String(selected));
    else url.searchParams.delete('task');
    history.replaceState(null, '', url);
    if (selected == null) setDetail(null);
  }, [selected]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const run: Run = useCallback(
    async (fn, success) => {
      try {
        await fn();
        if (success) setToast({ kind: 'ok', text: success });
        return true;
      } catch (e) {
        setToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const now = Date.now() + skew.current;

  const tasks = useMemo(() => {
    if (!state) return [];
    const isClosed = (t: TaskView) => t.state === 'done' || t.state === 'cancelled';
    const list = state.tasks.filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'closed') return isClosed(t);
      if (filter === 'open') return !isClosed(t);
      return t.state === 'needs_attention' || routingInfo(t, now, state.normalMaxMs)?.overdue;
    });
    return list.sort((a, b) => urgency(a, now, state.normalMaxMs) - urgency(b, now, state.normalMaxMs) || a.created_at - b.created_at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, filter, Math.floor(now / 1000)]);

  if (!state) return <div className="boot">{offline ? 'Cannot reach the server. Retrying…' : 'Loading…'}</div>;

  const count = (pred: (t: TaskView) => boolean) => state.tasks.filter(pred).length;
  const overdue = count((t) => !!routingInfo(t, now, state.normalMaxMs)?.overdue);
  const attention = count((t) => t.state === 'needs_attention');
  const free = state.contributors.filter((c) => !c.active).length;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">◆</span> Routing console
          {offline && <span className="offline">server unreachable — showing last known state</span>}
        </div>
        <div className="stats">
          <Stat label="Needs attention" value={attention} tone={attention ? 'bad' : undefined} onClick={() => setFilter('action')} />
          <Stat label="Routing" value={count((t) => t.state === 'routing')} sub={overdue ? `${overdue} overdue` : undefined} tone={overdue ? 'warn' : undefined} />
          <Stat label="Awaiting accept" value={count((t) => t.state === 'offered')} />
          <Stat label="Accepted / in progress" value={count((t) => t.state === 'accepted' || t.state === 'in_progress')} />
          <Stat label="Done" value={count((t) => t.state === 'done')} />
          <Stat label="Contributors free" value={`${free}/${state.contributors.length}`} />
        </div>
        <div className="top-actions">
          <button className="primary" onClick={() => setCreating(true)}>+ New task</button>
          <details className="menu">
            <summary>Demo</summary>
            <div className="menu-body">
              <button onClick={() => run(() => api.scenarios(), 'Loaded the four use-case tasks')}>Load use-case scenarios</button>
              <label className="check">
                <input type="checkbox" checked={internals} onChange={(e) => setInternals(e.target.checked)} />
                Reveal engine internals
                <small>Shows each request's simulated fate. An operator could never see this.</small>
              </label>
              <button className="danger" onClick={() => confirm('Wipe everything and reseed?') && run(() => api.reset().then(() => setSelected(null)), 'Reset to seed data')}>
                Reset to seed data
              </button>
            </div>
          </details>
        </div>
      </header>

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      <main className={selected ? 'with-panel' : ''}>
        <section className="tasks">
          <div className="tabs">
            {(['action', 'open', 'closed', 'all'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {{ action: 'Needs action', open: 'Open', closed: 'Closed', all: 'All' }[f]}
                {f === 'action' && attention + overdue > 0 && <span className="pill bad">{attention + overdue}</span>}
              </button>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Expertise</th>
                <th>State</th>
                <th>Routing</th>
                <th>Assignee</th>
                <th className="num">Age</th>
                <th className="num">In state</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <TaskRow key={t.id} t={t} now={now} normalMaxMs={state.normalMaxMs} selected={t.id === selected} onClick={() => setSelected(t.id === selected ? null : t.id)} />
              ))}
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    {filter === 'action' ? 'Nothing needs you right now.' : 'No tasks here.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="lower">
            <section className="card">
              <h3>Contributors</h3>
              <ul className="contributors">
                {state.contributors.map((c) => (
                  <li key={c.id}>
                    <span className={`dot ${c.active ? 'busy' : 'free'}`} title={c.active ? 'busy' : 'free'} />
                    <span className="cname">{c.name}</span>
                    <span className="chips">{c.expertise.map((e) => <span key={e} className="chip">{e}</span>)}</span>
                    <span className="cload">
                      {c.active ? (
                        <a onClick={() => setSelected(c.active!.taskId)}>
                          T-{c.active.taskId} · {c.active.status.replace('_', ' ')}
                        </a>
                      ) : (
                        <span className="muted">free</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="card">
              <h3>Activity</h3>
              <ul className="feed">
                {state.events.map((e) => (
                  <li key={e.id} className={e.task_id ? 'link' : ''} onClick={() => e.task_id && setSelected(e.task_id)}>
                    <span className="when" title={new Date(e.at).toLocaleString()}>{clock(e.at)}</span>
                    <span className={`actor ${e.actor}`}>{e.actor}</span>
                    {e.task_id && <span className="tid">T-{e.task_id}</span>}
                    <span className="msg">{e.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </section>

        {selected && detail && detail.task.id === selected && (
          <TaskPanel d={detail} now={now} normalMaxMs={state.normalMaxMs} internals={internals} run={run} onClose={() => setSelected(null)} />
        )}
      </main>

      {creating && (
        <CreateTask
          expertise={state.expertise}
          scenarios={state.scenarios}
          contributors={state.contributors}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            let id = 0;
            const ok = await run(async () => (id = (await api.create(body)).id), 'Task submitted for routing');
            if (ok) {
              setCreating(false);
              setSelected(id);
            }
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone, onClick }: { label: string; value: number | string; sub?: string; tone?: 'bad' | 'warn'; onClick?: () => void }) {
  return (
    <div className={`stat ${tone ?? ''} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

function TaskRow({ t, now, normalMaxMs, selected, onClick }: { t: TaskView; now: number; normalMaxMs: number; selected: boolean; onClick: () => void }) {
  const r = routingInfo(t, now, normalMaxMs);
  return (
    <tr className={`row ${selected ? 'sel' : ''} ${r?.overdue || t.state === 'needs_attention' ? 'hot' : ''}`} onClick={onClick}>
      <td>
        <div className="title">
          {t.priority === 'high' && <span className="hi" title="High priority">▲</span>}
          <span className="tid">T-{t.id}</span> {t.title}
        </div>
      </td>
      <td><span className="chip">{t.expertise}</span></td>
      <td>
        <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
        {t.reason && t.state === 'needs_attention' && <div className="reason">{REASON_LABEL[t.reason]}</div>}
      </td>
      <td className="routing">
        {r ? (
          <span className={r.overdue ? 'overdue' : 'waiting'}>
            <span className="spinner" /> #{r.newest.seq} · {dur(r.elapsed)}
            {r.overdue && ' · overdue'}
            {r.live > 1 && <span className="muted"> (+{r.live - 1} live)</span>}
          </span>
        ) : (
          <span className="muted">{t.orphanedAttempts > 0 ? `${t.orphanedAttempts} outstanding, ignored` : '—'}</span>
        )}
      </td>
      <td>
        {t.assignee ? (
          <>
            {t.assignee.name}
            {t.assignee.source === 'operator' && <span className="muted" title="Assigned manually by operator"> · manual</span>}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num" title={new Date(t.created_at).toLocaleString()}>{dur(now - t.created_at)}</td>
      <td className="num">{dur(now - t.state_changed_at)}</td>
    </tr>
  );
}
