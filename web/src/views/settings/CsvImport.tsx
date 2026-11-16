import { useMemo, useState, type ChangeEvent } from 'react';
import { assignableFor, autoMap, buildContent, columnsOf, guessOwner, guessPriority, guessStatus, MAX_PREVIEW_ROWS, normalizeTagName, parseCsv, parseEffort, splitTags,
  type CsvField, type CsvMapping, type StatusChoice } from '../../../../shared/csv';
import { dispatch } from '../../api';
import { canEditContent, useStore } from '../../store';
import { showToast } from '../../toast';

/** The server takes at most this many cards per import. */
const MAX_CARDS = 2000;
/** Larger files are refused before reading (the text is parsed in memory). */
const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** The dispatch request body is limited to 1 MiB (bytes) by the server. */
const MAX_BODY_BYTES = 1_000_000;
/** Distinct values shown for mapping; anything beyond is left at its guess, so a wrong column cannot flood the page. */
const MAX_DISTINCT = 200;

const FIELDS: [CsvField, string][] = [
  ['title', 'Title'], ['content', 'Content'], ['status', 'Status'], ['priority', 'Priority'], ['effort', 'Effort'], ['tags', 'Tags'], ['owner', 'Owner'],
];
const STATUS_CHOICES: [StatusChoice, string][] = [
  ['default', 'Default'], ['started', 'Started'], ['done', 'Done'], ['doc', 'Lore'], ['archived', 'Archived'],
];
const PRIORITY_CHOICES: [string, string][] = [['a', 'High'], ['b', 'Medium'], ['c', 'Low'], ['', 'None']];

type Parsed = { headers: string[]; rows: string[][]; capped: boolean };

/** Distinct non-empty values of one column, in first-seen order, capped. */
function distinct(rows: string[][], col: number | null, split?: (v: string) => string[]): string[] {
  const out = new Set<string>();
  if (col === null) return [];
  for (const r of rows) {
    for (const v of split ? split(r[col] ?? '') : [(r[col] ?? '').trim()]) {
      if (v !== '') out.add(v);
      if (out.size >= MAX_DISTINCT) return [...out];
    }
  }
  return [...out];
}

/** CSV import: pick a file, map its columns and values, choose a deck, import. Parsing stays in the browser. */
export function CsvImport() {
  const projects = useStore((s) => s.projects);
  const decks = useStore((s) => s.decks);
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.accountRoles);
  const state = useStore((s) => s);
  const [deckId, setDeckId] = useState('');
  const [file, setFile] = useState('');
  const [data, setData] = useState<Parsed | null>(null);
  const [map, setMap] = useState<CsvMapping | null>(null);
  const [statusPick, setStatusPick] = useState<Record<string, StatusChoice>>({});
  const [priorityPick, setPriorityPick] = useState<Record<string, string>>({});
  const [ownerPick, setOwnerPick] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [factor, setFactor] = useState('1');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const access = useStore((s) => s.projectAccess);
  const deckProject = deckId ? projects.get(decks.get(deckId)?.projectId ?? '') : undefined;
  // Who may own an imported card: the server refuses an owner who cannot view the deck's project, so only they are offered and guessed.
  const members = useMemo(() => assignableFor(
    [...users.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({
      id: u.id, name: u.name, email: u.email, disabled: u.disabled, role: roles.get(u.id) ?? null,
      hasAccess: !!deckProject && access.has(`${deckProject.id}|${u.id}`),
    })),
    deckProject ? deckProject.visibility : null,
  ), [users, roles, access, deckProject]);
  const groups = useMemo(() => [...projects.values()].filter((p) => canEditContent(state, p)).sort((a, b) => a.seq - b.seq).map((p) => ({
    project: p, decks: [...decks.values()].filter((d) => d.projectId === p.id && d.deckType !== 'doc').sort((a, b) => a.seq - b.seq),
  })).filter((g) => g.decks.length > 0), [projects, decks, state]);

  const rows = data?.rows ?? [];
  const statusValues = useMemo(() => distinct(rows, map?.status ?? null), [rows, map?.status]);
  const priorityValues = useMemo(() => distinct(rows, map?.priority ?? null), [rows, map?.priority]);
  const ownerValues = useMemo(() => distinct(rows, map?.owner ?? null), [rows, map?.owner]);
  const effortValues = useMemo(() => distinct(rows, map?.effort ?? null).slice(0, 6), [rows, map?.effort]);
  const tagValues = useMemo(() => {
    const byName = new Map<string, string>();
    for (const t of distinct(rows, map?.tags ?? null, splitTags)) { const n = normalizeTagName(t); if (n && !byName.has(n)) byName.set(n, n); }
    return [...byName.keys()];
  }, [rows, map?.tags]);

  const statusOf = (v: string) => statusPick[v] ?? guessStatus(v);
  const priorityOf = (v: string) => (v in priorityPick ? priorityPick[v] : guessPriority(v) ?? '');
  const ownerOf = (v: string) => {
    const picked = v in ownerPick ? ownerPick[v] : guessOwner(v, members) ?? '';
    return members.some((m) => m.id === picked) ? picked : '';
  };
  const factorNum = Number(factor.replace(',', '.'));
  const factorOk = factor.trim() !== '' && Number.isFinite(factorNum) && factorNum >= 0;

  /** The cards the current mapping produces; rows with neither a title nor content are left out. */
  const build = () => {
    if (!map) return [];
    const cell = (r: string[], c: number | null) => (c === null ? null : (r[c] ?? '').trim());
    const out: object[] = [];
    for (const r of rows) {
      const title = cell(r, map.title) || null;
      const text = title ? buildContent(title, cell(r, map.content)) : buildContent(null, cell(r, map.content));
      if (text.trim() === '') continue;
      const st = map.status === null ? 'default' : statusOf((r[map.status] ?? '').trim());
      const pr = map.priority === null ? '' : priorityOf((r[map.priority] ?? '').trim());
      const ef = map.effort === null || !factorOk ? null : parseEffort(r[map.effort] ?? '', factorNum);
      const ow = map.owner === null ? '' : ownerOf((r[map.owner] ?? '').trim());
      const tags = map.tags === null ? [] : splitTags(r[map.tags] ?? '').map(normalizeTagName).filter((t): t is string => !!t && !skipped.has(t));
      out.push({
        content: text, priority: pr || null, effort: ef, assigneeId: ow || null, masterTags: [...new Set(tags)],
        ...(st === 'default' ? {} : { status: st }),
      });
    }
    return out;
  };
  const count = useMemo(() => {
    if (!map) return 0;
    return rows.filter((r) => {
      const t = map.title === null ? '' : (r[map.title] ?? '').trim();
      const c = map.content === null ? '' : (r[map.content] ?? '').trim();
      return t !== '' || c !== '';
    }).length;
  }, [rows, map]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setError(''); setDone('');
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setError('That file is larger than 30 MB. Split it into smaller files.'); return; }
    let parsed: string[][];
    try { parsed = parseCsv(await f.text()); } catch { setError('The file could not be read.'); return; }
    const cols = columnsOf(parsed);
    if (cols.headers.length === 0) { setError('The file has no columns.'); return; }
    setFile(f.name);
    setData({ ...cols, capped: parsed.length >= MAX_PREVIEW_ROWS });
    setMap(autoMap(cols.headers));
    setStatusPick({}); setPriorityPick({}); setOwnerPick({}); setSkipped(new Set()); setFactor('1');
  };

  const reset = () => { setData(null); setMap(null); setFile(''); setError(''); };

  const submit = async () => {
    setError(''); setDone('');
    if (!deckId) { setError('Choose the list to import into.'); return; }
    if (count === 0) { setError('Map a Title or Content column first; no task would be created.'); return; }
    if (count > MAX_CARDS) { setError(`A single import can hold at most ${MAX_CARDS.toLocaleString()} tasks; this file has ${count.toLocaleString()}. Split the file and import it in parts.`); return; }
    if (map?.effort != null && !factorOk) { setError('The effort scale factor must be a number.'); return; }
    const cards = build();
    const body = { deckId, cards };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_BODY_BYTES) { setError('These tasks are too large to send in one import. Split the file into smaller parts.'); return; }
    setBusy(true);
    try {
      const r = await dispatch<{ count: number }>('cards', 'bulkImport', body);
      const msg = `Imported ${r.count} ${r.count === 1 ? 'task' : 'tasks'}.`;
      showToast(msg, 'info', 4000);
      reset();
      setDone(msg);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  const colSelect = (f: CsvField, label: string) => (
    <label className="field" key={f}>
      <span>{label}</span>
      <select value={map?.[f] ?? ''} onChange={(e) => setMap((m) => ({ ...m!, [f]: e.target.value === '' ? null : Number(e.target.value) }))}>
        <option value="">Not mapped</option>
        {data!.headers.map((h, i) => <option key={i} value={i}>{h.trim() || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <div className="settings-stack">
      <p className="hint">Bring tasks in from a spreadsheet. The file is read in this browser; nothing is sent until you press Import.</p>
      <label className="field">
        <span>CSV file</span>
        <input type="file" accept=".csv,.tsv,text/csv,text/plain" onChange={(e) => void onFile(e)} />
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && <p role="status">{done}</p>}

      {data && map && (
        <>
          <p><strong>{file}</strong>: {data.capped ? `more than ${(MAX_PREVIEW_ROWS - 1).toLocaleString()}` : rows.length.toLocaleString()} rows, {data.headers.length} columns.
            {data.capped && ' Only the first 50,000 rows were read.'}</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{data.headers.map((h, i) => <th scope="col" key={i}>{h.trim() || `Column ${i + 1}`}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c.length > 80 ? `${c.slice(0, 80)}…` : c}</td>)}</tr>)}
              </tbody>
            </table>
          </div>

          <section className="settings-group" aria-labelledby="csv-columns">
            <h3 className="sub" id="csv-columns">Columns</h3>
            <div className="field-row">{FIELDS.map(([f, label]) => colSelect(f, label))}</div>
            <small className="hint">With only Content mapped, its first line becomes the title. With both, the content goes below the title.</small>
          </section>

          {statusValues.length > 0 && (
            <section className="settings-group" aria-labelledby="csv-status">
              <h3 className="sub" id="csv-status">Status values</h3>
              <p className="hint">A Started task with no owner becomes yours and goes into your active tasks.</p>
              {statusValues.map((v) => (
                <label className="field" key={v}>
                  <span>{v}</span>
                  <select aria-label={`Status for ${v}`} value={statusOf(v)} onChange={(e) => setStatusPick((p) => ({ ...p, [v]: e.target.value as StatusChoice }))}>
                    {STATUS_CHOICES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                  </select>
                </label>
              ))}
            </section>
          )}

          {priorityValues.length > 0 && (
            <section className="settings-group" aria-labelledby="csv-priority">
              <h3 className="sub" id="csv-priority">Priority values</h3>
              {priorityValues.map((v) => (
                <label className="field" key={v}>
                  <span>{v}</span>
                  <select aria-label={`Priority for ${v}`} value={priorityOf(v)} onChange={(e) => setPriorityPick((p) => ({ ...p, [v]: e.target.value }))}>
                    {PRIORITY_CHOICES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                  </select>
                </label>
              ))}
            </section>
          )}

          {map.effort !== null && (
            <section className="settings-group" aria-labelledby="csv-effort">
              <h3 className="sub" id="csv-effort">Effort</h3>
              <label className="field">
                <span>Scale factor</span>
                <input inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} aria-invalid={!factorOk} />
                <small className="hint">Each value is multiplied by this, for example 8 to turn days into hours.</small>
              </label>
              <p className="hint">{effortValues.map((v) => `${v} becomes ${factorOk ? parseEffort(v, factorNum) ?? 'no effort' : '?'}`).join('; ')}</p>
            </section>
          )}

          {tagValues.length > 0 && (
            <section className="settings-group" aria-labelledby="csv-tags">
              <h3 className="sub" id="csv-tags">Tags</h3>
              <p className="hint">Tags the project does not have yet are created. Click a tag to skip it.</p>
              <div className="strip">
                {tagValues.map((t) => (
                  <button key={t} type="button" className={skipped.has(t) ? 'chip' : 'chip on'} aria-pressed={!skipped.has(t)}
                    onClick={() => setSkipped((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}>
                    {t}
                  </button>
                ))}
              </div>
            </section>
          )}

          {ownerValues.length > 0 && (
            <section className="settings-group" aria-labelledby="csv-owner">
              <h3 className="sub" id="csv-owner">Owners</h3>
              {ownerValues.map((v) => (
                <label className="field" key={v}>
                  <span>{v}</span>
                  {ownerOf(v) === '' && <small className="hint">{deckId ? 'Nobody who can see this project matches; imported without an owner.' : 'No match; imported without an owner.'}</small>}
                  <select aria-label={`Owner for ${v}`} value={ownerOf(v)} onChange={(e) => setOwnerPick((p) => ({ ...p, [v]: e.target.value }))}>
                    <option value="">No owner</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              ))}
            </section>
          )}

          <section className="settings-group" aria-labelledby="csv-deck">
            <h3 className="sub" id="csv-deck">Import into</h3>
            <label className="field">
              <span>List</span>
              <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                <option value="">Choose a list</option>
                {groups.map((g) => (
                  <optgroup key={g.project.id} label={g.project.name}>
                    {g.decks.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="field-row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                Import {count.toLocaleString()} {count === 1 ? 'task' : 'tasks'}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={reset}>Choose another file</button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
