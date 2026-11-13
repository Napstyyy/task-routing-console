import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type AppState, type TaskDetail, type TaskView } from './client';
import { dur, clock, STATE_LABEL, REASON_LABEL, routingInfo, urgency } from './format';
import { TaskPanel } from './TaskPanel';
import { Avatar } from './Avatar';
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

  const kpis: { key: string; label: string; value: string | number; sub?: string; tone?: string; filter?: Filter }[] = [
    { key: 'att', label: 'Needs attention', value: attention, tone: attention ? 'bad' : '', filter: 'action' },
    { key: 'route', label: 'Routing', value: count((t) => t.state === 'routing'), sub: overdue ? `${overdue} overdue` : 'none overdue', tone: overdue ? 'warn' : '', filter: 'open' },
    { key: 'offer', label: 'Awaiting accept', value: count((t) => t.state === 'offered'), filter: 'open' },
    { key: 'active', label: 'Accepted · in progress', value: count((t) => t.state === 'accepted' || t.state === 'in_progress'), filter: 'open' },
    { key: 'done', label: 'Done', value: count((t) => t.state === 'done'), filter: 'closed' },
    { key: 'free', label: 'Contributors free', value: `${free}/${state.contributors.length}` },
  ];

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 20 20" width="18" height="18"><path d="M3 10h6l3-6v12l3-6h2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <div className="brand-name">Routing console</div>
            <div className="brand-sub">Tasks → contributors · live</div>
          </div>
          {offline && <span className="offline">Server unreachable — showing last known state</span>}
        </div>
        <div className="top-actions">
          <details className="menu">
            <summary>Demo controls</summary>
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
          <button className="primary" onClick={() => setCreating(true)}>
            <span aria-hidden>＋</span> New task
          </button>
        </div>
      </header>

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)} role="status">
          {toast.text}
        </div>
      )}

      <div className="kpis">
        {kpis.map((k) => (
          <button key={k.key} className={`kpi ${k.tone ?? ''}`} disabled={!k.filter} onClick={() => k.filter && setFilter(k.filter)}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
            {k.sub && <span className="kpi-sub">{k.sub}</span>}
          </button>
        ))}
      </div>

      <main className={selected ? 'with-panel' : ''}>
        <section className="tasks">
          <div className="card table-card">
            <div className="card-head">
              <div className="tabs" role="tablist">
                {(['action', 'open', 'closed', 'all'] as Filter[]).map((f) => (
                  <button key={f} role="tab" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                    {{ action: 'Needs action', open: 'Open', closed: 'Closed', all: 'All' }[f]}
                    {f === 'action' && attention + overdue > 0 && <span className="pill bad">{attention + overdue}</span>}
                  </button>
                ))}
              </div>
              <span className="muted small">{tasks.length} task{tasks.length === 1 ? '' : 's'} · most urgent first</span>
            </div>
            <table>
              <colgroup>
                <col />
                <col style={{ width: 150 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Task</th>
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
                    <td colSpan={6} className="empty">
                      {filter === 'action' ? '✓ Nothing needs you right now.' : 'No tasks here.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="lower">
            <section className="card">
              <div className="card-head">
                <h3>Contributors</h3>
                <span className="muted small">{free} free · {state.contributors.length - free} busy</span>
              </div>
              <ul className="people">
                {state.contributors.map((c) => (
                  <li key={c.id} className={c.active ? 'busy' : 'free'}>
                    <Avatar id={c.id} name={c.name} />
                    <div className="person-main">
                      <div className="person-name">{c.name}</div>
                      <div className="chips">{c.expertise.map((e) => <span key={e} className="chip">{e}</span>)}</div>
                    </div>
                    {c.active ? (
                      <a className="load busy" onClick={() => setSelected(c.active!.taskId)} title={c.active.title}>
                        T-{c.active.taskId} · {c.active.status.replace('_', ' ')}
                      </a>
                    ) : (
                      <span className="load free">Free</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section className="card">
              <div className="card-head">
                <h3>Activity</h3>
                <span className="legend">
                  {(['operator', 'engine', 'contributor', 'system'] as const).map((a) => (
                    <span key={a}><i className={`adot ${a}`} />{a}</span>
                  ))}
                </span>
              </div>
              <ul className="feed">
                {state.events.map((e) => (
                  <li key={e.id} className={e.task_id ? 'link' : ''} onClick={() => e.task_id && setSelected(e.task_id)}>
                    <i className={`adot ${e.actor}`} title={e.actor} />
                    <span className="msg">
                      {e.task_id && <span className="tid">T-{e.task_id}</span>} {e.message}
                    </span>
                    <span className="when" title={new Date(e.at).toLocaleString()}>{clock(e.at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </section>

        {selected && detail && detail.task.id === selected && (
          <PanelBoundary key={selected} onClose={() => setSelected(null)}>
            <TaskPanel d={detail} now={now} normalMaxMs={state.normalMaxMs} internals={internals} run={run} onClose={() => setSelected(null)} />
          </PanelBoundary>
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

function TaskRow({ t, now, normalMaxMs, selected, onClick }: { t: TaskView; now: number; normalMaxMs: number; selected: boolean; onClick: () => void }) {
  const r = routingInfo(t, now, normalMaxMs);
  const hot = r?.overdue || t.state === 'needs_attention';
  return (
    <tr className={`row ${selected ? 'sel' : ''} ${hot ? 'hot' : ''}`} onClick={onClick}>
      <td>
        <div className="title">
          {t.priority === 'high' && <span className="hi" title="High priority">HIGH</span>}
          <span className="tid">T-{t.id}</span>
          <span className="title-text">{t.title}</span>
        </div>
        <div className="subline">
          <span className="chip">{t.expertise}</span>
          {t.description && <span className="desc-line">{t.description}</span>}
        </div>
      </td>
      <td>
        <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
        {t.reason && t.state === 'needs_attention' && <div className="reason">{REASON_LABEL[t.reason]}</div>}
      </td>
      <td className="routing">
        {r ? (
          <span className={r.overdue ? 'overdue' : 'waiting'}>
            <span className="spinner" /> #{r.newest.seq} · {dur(r.elapsed)}
            {r.overdue && <span className="od-tag">overdue</span>}
            {r.live > 1 && <div className="muted small">+{r.live - 1} more live</div>}
          </span>
        ) : t.orphanedAttempts > 0 ? (
          <span className="muted small" title="Abandoned requests the engine may still answer. Answers will be ignored.">
            {t.orphanedAttempts} stray request{t.orphanedAttempts > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        {t.assignee ? (
          <span className="assignee">
            <Avatar id={t.assignee.contributorId} name={t.assignee.name} size={24} />
            <span>
              <span className="assignee-name">{t.assignee.name}</span>
              <span className="muted small">{t.assignee.source === 'operator' ? 'manual' : 'engine'}</span>
            </span>
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="num" title={new Date(t.created_at).toLocaleString()}>{dur(now - t.created_at)}</td>
      <td className="num">{dur(now - t.state_changed_at)}</td>
    </tr>
  );
}

/** A rendering bug in one task's panel must not take down the whole console. */
class PanelBoundary extends Component<{ children: ReactNode; onClose: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <aside className="panel">
        <div className="situation bad">
          This task's details failed to render: {this.state.error.message}. The rest of the console is unaffected.
        </div>
        <button onClick={this.props.onClose}>Close</button>
      </aside>
    );
  }
}
