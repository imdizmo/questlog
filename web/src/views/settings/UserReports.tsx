import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, dispatch } from '../../api';
import { useStore } from '../../store';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyField } from './CopyField';

type Severity = 'critical' | 'high' | 'low';
export interface UserReportSettings {
  app: { id: string; name: string; deckId: string | null; severityDecks: Partial<Record<Severity, string>>; severityPriority: boolean; createdAt: number } | null;
  tokens: { id: string; label: string; enabled: boolean; createdAt: number }[];
}
/** A secret shown once (after setup, a new token or a new access key); it lives only in this page's state. */
type Reveal = { title: string; fields: [string, string][] };

const SEVERITIES: [Severity, string][] = [['critical', 'Critical'], ['high', 'High'], ['low', 'Low']];
const PATH = '/user-report/v1';

/** Task decks grouped by project, for the deck pickers (doc decks can't take reports). */
function useDeckGroups() {
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  return useMemo(() => [...projects.values()].sort((a, b) => a.seq - b.seq).map((p) => ({
    project: p, decks: [...decks.values()].filter((d) => d.projectId === p.id && d.deckType !== 'doc').sort((a, b) => a.seq - b.seq),
  })).filter((g) => g.decks.length > 0), [projects, decks]);
}

export function DeckOptions() {
  return <>{useDeckGroups().map((g) => (
    <optgroup key={g.project.id} label={g.project.name}>
      {g.decks.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
    </optgroup>
  ))}</>;
}

/**
 * User reports (the `unity` and `userReportApi` tabs): the one-time setup, then the app's deck and severity rules,
 * the access key and the report tokens. `variant` only changes the how-to at the top.
 */
export function UserReports({ variant }: { variant: 'unity' | 'api' }) {
  const [data, setData] = useState<UserReportSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const load = useCallback(() => api.userReports().then((d) => { setData(d); setFailed(false); }, () => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);

  const revealDialog = reveal && (
    <Dialog key="reveal" title={reveal.title} onClose={() => setReveal(null)} actions={<button type="button" className="btn btn-primary" onClick={() => setReveal(null)}>Done</button>}>
      <p role="status"><strong>You won't see this again.</strong> Copy it now and keep it somewhere safe.</p>
      {reveal.fields.map(([label, value], i) => <CopyField key={label} label={label} value={value} autoFocus={i === 0} />)}
    </Dialog>
  );
  if (failed) return <p role="alert" className="field-error">Couldn't load the user report settings.</p>;
  if (!data) return <p className="hint">Loading…</p>;
  if (!data.app) {
    return (
      <>
        <SetupForm onDone={(r) => {
          setReveal({ title: 'User reports are ready', fields: [['Default report token', r.token], ['Access key', r.accessKey]] });
          void load();
        }} />
        {revealDialog}
      </>
    );
  }
  return (
    <div className="settings-stack">
      {variant === 'unity' ? <UnityHowTo /> : <ApiHowTo />}
      <AppForm key={data.app.id} app={data.app} onSaved={load} />
      <AccessKey onNew={(accessKey) => setReveal({ title: 'New access key', fields: [['Access key', accessKey]] })} />
      <Tokens tokens={data.tokens} onToggle={(id, enabled) => {
        // Shown at once; the server's answer (or the reload after a refusal) settles it.
        setData((d) => d && { ...d, tokens: d.tokens.map((t) => (t.id === id ? { ...t, enabled } : t)) });
        void dispatch('userReports', 'setTokenEnabled', { id, enabled }).catch(() => load());
      }} onNew={(label, token) => { setReveal({ title: `Token "${label}"`, fields: [['Report token', token]] }); void load(); }} />
      {revealDialog}
    </div>
  );
}

function SetupForm({ onDone }: { onDone: (r: { accessKey: string; token: string }) => void }) {
  const groups = useDeckGroups();
  const [name, setName] = useState('');
  const [deckId, setDeckId] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !deckId) return;
    setBusy(true);
    try {
      onDone(await dispatch<{ accessKey: string; token: string }>('userReports', 'setup', { name: name.trim(), deckId }));
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-stack" onSubmit={submit} aria-labelledby="ur-setup">
      <h3 className="sub" id="ur-setup">Set up user reports</h3>
      <p className="hint">Players send bug reports and feedback from inside your game; each report becomes a task.</p>
      <label className="field"><span>Name of the game or app</span>
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <small className="hint">Reporters see this name in the emails about their reports.</small></label>
      <label className="field"><span>Create tasks in</span>
        <select required value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          <option value="" disabled>Choose a list</option>
          {groups.length > 0 && <DeckOptions />}
        </select></label>
      {groups.length === 0 && <p className="hint">Create a list first: reports need a list to land in.</p>}
      <div><button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !deckId}>Continue</button></div>
    </form>
  );
}

function AppForm({ app, onSaved }: { app: NonNullable<UserReportSettings['app']>; onSaved: () => void }) {
  const id = useId();
  const [name, setName] = useState(app.name);
  const [deckId, setDeckId] = useState(app.deckId ?? '');
  const [map, setMap] = useState<Partial<Record<Severity, string>>>(app.severityDecks);
  const [priority, setPriority] = useState(app.severityPriority);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const severityDecks = Object.fromEntries(SEVERITIES.map(([s]) => [s, map[s] || null]));
      await dispatch('userReports', 'update', { name: name.trim(), ...(deckId ? { deckId } : {}), severityDecks, severityPriority: priority });
      onSaved();
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-group" aria-labelledby={`${id}-h`} onSubmit={save}>
      <h3 className="sub" id={`${id}-h`}>Where reports go</h3>
      <label className="field"><span>Name of the game or app</span>
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Create tasks in</span>
        <select required value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {!deckId && <option value="" disabled>Choose a list (the old one is gone)</option>}
          <DeckOptions />
        </select></label>
      <fieldset className="field-set">
        <legend>List by severity</legend>
        {SEVERITIES.map(([s, label]) => (
          <label key={s} className="field"><span>{label}</span>
            <select value={map[s] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [s]: e.target.value }))}>
              <option value="">Same as above</option>
              <DeckOptions />
            </select></label>
        ))}
      </fieldset>
      <div className="setting-row">
        <div>
          <label htmlFor={`${id}-prio`} className="setting-label">Severity sets priority</label>
          <p className="hint" id={`${id}-prio-d`}>Critical and high reports get priority A, low reports priority C.</p>
        </div>
        <span className="switch">
          <input id={`${id}-prio`} type="checkbox" role="switch" checked={priority} aria-describedby={`${id}-prio-d`} onChange={(e) => setPriority(e.target.checked)} />
          <span aria-hidden className="track" />
        </span>
      </div>
      <div><button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !deckId}>Save</button></div>
    </form>
  );
}

function AccessKey({ onNew }: { onNew: (key: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="settings-group" aria-labelledby="ur-key">
      <div className="section-head"><h3 id="ur-key">Access key</h3>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>Regenerate</button></div>
      <p className="hint">Build scripts use the access key to make a new report token per build or channel. It was shown once; if it is lost, make a new one.</p>
      {confirming && (
        <ConfirmDialog title="New access key" confirmLabel="Regenerate" danger onClose={() => setConfirming(false)}
          onConfirm={async () => onNew((await dispatch<{ accessKey: string }>('userReports', 'regenerateAccessKey', {})).accessKey)}>
          The current access key stops working at once. Report tokens made with it keep working.
        </ConfirmDialog>
      )}
    </section>
  );
}

function Tokens({ tokens, onToggle, onNew }: { tokens: UserReportSettings['tokens']; onToggle: (id: string, enabled: boolean) => void; onNew: (label: string, token: string) => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const l = label.trim();
    if (!l) return;
    setBusy(true);
    try {
      const r = await dispatch<{ token: string }>('userReports', 'createToken', { label: l });
      setLabel('');
      onNew(l, r.token);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-group" aria-labelledby="ur-tokens">
      <h3 className="sub" id="ur-tokens">Report tokens</h3>
      <p className="hint">A token goes into a game build. Its name becomes a tag on every report sent with it. Switch a token off to stop its reports.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Enabled</th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.label}</th>
                <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                <td>
                  <span className="switch">
                    <input type="checkbox" role="switch" aria-label={`${t.label} enabled`} checked={t.enabled} onChange={(e) => onToggle(t.id, e.target.checked)} />
                    <span aria-hidden className="track" />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="field-row" onSubmit={create}>
        <label className="field"><span>New token name</span>
          <input maxLength={80} value={label} placeholder="e.g. Steam beta" onChange={(e) => setLabel(e.target.value)} /></label>
        <button type="submit" className="btn" disabled={busy || !label.trim()}>Create token</button>
      </form>
    </section>
  );
}

function UnityHowTo() {
  return (
    <section className="settings-group" aria-labelledby="ur-unity">
      <h3 className="sub" id="ur-unity">Unity plugin</h3>
      <ol className="steps">
        <li>In Unity (2021 or newer), open the Package Manager, choose <em>Add package from disk</em> and pick <code>integrations/unity/JatifyReporter/package.json</code> from this tracker's source.</li>
        <li>Add the <strong>Jatify Reporter</strong> component to an object in your first scene. Set its server address and a report token from the list below.</li>
        <li>Add <strong>Jatify Report Form</strong> for a ready-made in-game form (F8 opens it), or call <code>SendReport</code> from your own menu.</li>
      </ol>
      <CopyField label="Server address" value={location.origin} />
      <p className="hint">Players' machines must reach this address. The plugin has not been tried in Unity yet; its README lists what to check.</p>
    </section>
  );
}

function ApiHowTo() {
  return (
    <section className="settings-group" aria-labelledby="ur-api">
      <h3 className="sub" id="ur-api">Send reports over HTTP</h3>
      <CopyField label="Create a report (POST, JSON)" value={`${location.origin}${PATH}/create-report`} />
      <ul className="steps">
        <li>Send the report token in an <code>X-Report-Token</code> header. (A <code>?token=</code> query parameter also works, but addresses end up in logs more easily than headers.)</li>
        <li>Body: <code>{'{"content": "First line is the title", "severity": "critical" | "high" | "low" | null, "fileNames": ["log.txt"], "userEmail": "player@example.com"}'}</code>. Only <code>content</code> is required (up to 10,000 characters).</li>
        <li>The answer is <code>{'{"ok": true, "cardId": "…", "uploadUrls": [{"fileName", "url", "fields"}]}'}</code>. Send each file as the raw body of a <code>PUT</code> to its <code>url</code> on this server, within 15 minutes; each URL works once.</li>
        <li>Limits: 30 reports a minute per token, 5 files of up to 10 MB each, and per token 500 reports and 1 GB of files a day (UTC).</li>
      </ul>
      <CopyField label="Create a report token (POST, JSON)" value={`${location.origin}${PATH}/create-report-token`} />
      <ul className="steps"><li>Send the access key in an <code>X-Access-Key</code> header (or <code>?accessKey=</code>).</li><li>Body: <code>{'{"label": "Steam beta"}'}</code>. The answer is <code>{'{"ok": true, "token": "…"}'}</code>.</li></ul>
    </section>
  );
}
