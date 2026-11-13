import { useState } from 'react';
import type { ContributorView } from './client';

const SCENARIO_HELP: Record<string, string> = {
  random: 'Realistic: 80% answer in 5–20s (10% of those with no match), 20% never answer.',
  fast_match: 'Engine answers with a match after 5s.',
  slow_match: 'Engine answers with a match after 19s — just inside the normal window.',
  never: 'Engine never answers. Indistinguishable from slow until you act.',
  no_match: 'Engine answers after 8s: no suitable contributor.',
};

export function CreateTask({
  expertise,
  scenarios,
  contributors,
  onClose,
  onCreate,
}: {
  expertise: string[];
  scenarios: string[];
  contributors: ContributorView[];
  onClose: () => void;
  onCreate: (body: object) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [exp, setExp] = useState(expertise[0]);
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [scenario, setScenario] = useState('random');
  const [busy, setBusy] = useState(false);

  const matching = contributors.filter((c) => c.expertise.includes(exp));
  const free = matching.filter((c) => !c.active);

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onCreate({ title, description, expertise: exp, priority, scenario });
          setBusy(false);
        }}
      >
        <h2>New task</h2>
        <label>
          Title
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Hospital cost benchmarking" />
        </label>
        <label>
          Description
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row2">
          <label>
            Expertise
            <select value={exp} onChange={(e) => setExp(e.target.value)}>
              {expertise.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <small className={free.length ? 'muted' : 'warn-text'}>
              {matching.length === 0
                ? 'Nobody has this expertise — the task will need attention immediately.'
                : free.length === 0
                  ? `All ${matching.length} matching contributors are busy — the task will go straight to Needs attention.`
                  : `${free.length} of ${matching.length} matching contributors free`}
            </small>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as 'normal' | 'high')}>
              <option value="normal">normal</option>
              <option value="high">high</option>
            </select>
          </label>
        </div>
        <fieldset className="sim">
          <legend>Simulation (demo control)</legend>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {scenarios.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <small>{SCENARIO_HELP[scenario]} Applies to the first routing request only; retries are always random.</small>
        </fieldset>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !title.trim()}>Submit for routing</button>
        </div>
      </form>
    </div>
  );
}
