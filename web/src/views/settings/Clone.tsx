import { useMemo, useState } from 'react';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { showToast } from '../../toast';

/** Mirrors server/commands/clone.ts. */
const MAX_PROJECTS = 20;

/** Copy whole projects inside this workspace (admins; the settings dialog is admins-only). */
export function CloneProjects() {
  const projects = useStore((s) => s.projects);
  const list = useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq), [projects]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [visibility, setVisibility] = useState<'full' | 'limited'>('full');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const submit = async () => {
    setError(''); setDone('');
    const ids = list.filter((p) => picked.has(p.id)).map((p) => p.id);
    if (!ids.length) { setError('Choose at least one project to copy.'); return; }
    if (ids.length > MAX_PROJECTS) { setError(`Copy at most ${MAX_PROJECTS} projects at a time.`); return; }
    setBusy(true);
    try {
      const r = await dispatch<{ projects: { id: string; name: string }[] }>('clone', 'projects', { projectIds: ids, visibility });
      const msg = `Created ${r.projects.map((p) => p.name).join(', ')}.`;
      showToast(msg, 'info', 4000);
      setPicked(new Set());
      setDone(msg);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-stack">
      <p className="hint">
        Make a copy of a project in this workspace, named after it with "(copy)" added. The copy gets the project's tags
        and areas, its lists with their task chains and followers, and every task that isn't in the trash, with
        attachments, comments, followers, booked time and history. Milestones stay shared: the copy joins them.
      </p>
      <p className="hint">Left behind: active tasks, bookmarks, notifications, personal tags, boards and uploaded covers.</p>
      <fieldset className="settings-group">
        <legend className="sub">Projects to copy</legend>
        {list.length === 0 && <p className="hint">There are no projects yet.</p>}
        <div className="check-list">
          {list.map((p) => (
            <label className="check" key={p.id}>
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.name}{p.isArchived ? ' (archived)' : ''}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Who sees the copies</span>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'full' | 'limited')}>
          <option value="full">Everyone in the workspace</option>
          <option value="limited">Only people given access</option>
        </select>
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && <p role="status">{done}</p>}
      <div className="field-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Copying…' : picked.size > 1 ? `Copy ${picked.size} projects` : 'Copy project'}
        </button>
      </div>
    </div>
  );
}
