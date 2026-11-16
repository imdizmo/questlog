import { useMemo, useState, type ChangeEvent } from 'react';
import { dispatch, JsonText } from '../../api';
import { canManageProject, useStore } from '../../store';
import { showToast } from '../../toast';

/** Mirrors server/commands/imports.ts. */
const MAX_TRELLO_BYTES = 20 * 1024 * 1024;
const MAX_CARDS = 5000;

type Result = { decks: number; cards: number };
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const resultText = (r: Result) => `Imported ${plural(r.cards, 'task', 'tasks')} into ${plural(r.decks, 'new list', 'new lists')}.`;

/** Projects the person may import into: admins and the project's producers. */
function useImportTargets() {
  const projects = useStore((s) => s.projects);
  const state = useStore((s) => s);
  return useMemo(() => [...projects.values()].filter((p) => !p.isArchived && canManageProject(state, p)).sort((a, b) => a.seq - b.seq), [projects, state]);
}

function ProjectPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const targets = useImportTargets();
  return (
    <label className="field">
      <span>Import into project</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a project</option>
        {targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <small className="hint">Each list becomes a new list in this project.</small>
    </label>
  );
}

/** What the export holds, counted in the browser before anything is sent. */
type Summary = { lists: number; cards: number; skipped: number; labels: number };
function summarise(board: any): Summary | null {
  if (!board || !Array.isArray(board.lists) || !Array.isArray(board.cards)) return null;
  const open = new Set(board.lists.filter((l: any) => !l?.closed).map((l: any) => l?.id));
  const cards = board.cards.filter((c: any) => !c?.closed && open.has(c?.idList)).length;
  return { lists: open.size, cards, skipped: board.cards.length - cards, labels: Array.isArray(board.labels) ? board.labels.length : 0 };
}

/** Trello: the board's JSON export, chosen here and sent as is. */
export function TrelloImport() {
  const [projectId, setProjectId] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; summary: Summary } | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setError(''); setDone(''); setFile(null);
    if (!f) return;
    if (f.size > MAX_TRELLO_BYTES) { setError('That file is larger than 20 MB. Archive old tasks in Trello and export again.'); return; }
    const text = await f.text();
    let board: unknown;
    try { board = JSON.parse(text); } catch { setError("That file isn't valid JSON. Use the board's Export as JSON in Trello."); return; }
    const summary = summarise(board);
    if (!summary) { setError("That doesn't look like a Trello board export (no lists or tasks)."); return; }
    setFile({ name: f.name, text, summary });
  };

  const submit = async () => {
    setError(''); setDone('');
    if (!file) return;
    if (!projectId) { setError('Choose the project to import into.'); return; }
    if (file.summary.cards > MAX_CARDS) { setError(`One import takes at most ${MAX_CARDS.toLocaleString()} tasks.`); return; }
    setBusy(true);
    try {
      // The file text goes inside the request as is: no second copy of a large board in this tab.
      const r = await dispatch<Result>('imports', `trello?projectId=${encodeURIComponent(projectId)}`, new JsonText(`{"projectId":${JSON.stringify(projectId)},"board":${file.text}}`));
      const msg = resultText(r);
      showToast(msg, 'info', 4000);
      setFile(null);
      setDone(msg);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-stack">
      <p className="hint">
        In Trello, open the board menu and export it as JSON, then choose that file here. Open lists become lists, labels
        become tags and checklists become checkboxes. Archived lists and tasks, and comments, stay behind. Attachments
        come over as links. A task's first member becomes its owner when someone here has the same name or email.
      </p>
      <label className="field">
        <span>Trello export (JSON)</span>
        <input type="file" accept=".json,application/json" onChange={(e) => void onFile(e)} />
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && <p role="status">{done}</p>}
      {file && (
        <>
          <p><strong>{file.name}</strong>: {plural(file.summary.lists, 'list', 'lists')}, {plural(file.summary.cards, 'card', 'cards')}
            {file.summary.skipped > 0 && ` (${file.summary.skipped.toLocaleString()} archived, skipped)`}, {plural(file.summary.labels, 'label', 'labels')}.</p>
          <ProjectPicker value={projectId} onChange={setProjectId} />
          <div className="field-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Importing…' : `Import ${plural(file.summary.cards, 'card', 'cards')}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** HacknPlan: read over its API with the person's key (sent to HacknPlan only, never stored). */
export function HacknPlanImport() {
  const [projectId, setProjectId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hpProject, setHpProject] = useState('');
  const [groupBy, setGroupBy] = useState<'category' | 'board'>('category');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(''); setDone('');
    const hp = Number(hpProject.trim());
    if (!apiKey.trim()) { setError('Enter your HacknPlan API key.'); return; }
    if (!/^\d+$/.test(hpProject.trim()) || hp <= 0) { setError('Enter the HacknPlan project number (digits only).'); return; }
    if (!projectId) { setError('Choose the project to import into.'); return; }
    setBusy(true);
    try {
      const r = await dispatch<Result>('imports', 'hacknplan', { projectId, apiKey: apiKey.trim(), hpProjectId: hp, groupBy });
      const msg = resultText(r);
      showToast(msg, 'info', 4000);
      setApiKey('');
      setDone(msg);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="notice" role="note">
        Your API key is sent to HacknPlan (api.hacknplan.com) to read the project, and to nobody else. It is used for
        this import only and not saved. Create a key in HacknPlan under your user settings, and revoke it afterwards if
        you like.
      </p>
      <p className="hint">
        Categories or boards become lists, user stories become main tasks with their tasks as subtasks, and subtasks
        become a checklist. Tags, importance, estimated cost, due dates, milestones and assignees who are members here
        come along. Attachments and covers come over as links.
      </p>
      <label className="field">
        <span>HacknPlan API key</span>
        <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </label>
      <label className="field">
        <span>HacknPlan project number</span>
        <input inputMode="numeric" value={hpProject} onChange={(e) => setHpProject(e.target.value)} />
        <small className="hint">The number in the project's address in HacknPlan.</small>
      </label>
      <label className="field">
        <span>Make lists from</span>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'category' | 'board')}>
          <option value="category">Categories</option>
          <option value="board">Boards</option>
        </select>
      </label>
      <ProjectPicker value={projectId} onChange={setProjectId} />
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && <p role="status">{done}</p>}
      <div className="field-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Importing…' : 'Import from HacknPlan'}</button>
      </div>
    </form>
  );
}
