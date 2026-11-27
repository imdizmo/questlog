import { useId, useState } from 'react';
import type { Project } from '../../../shared/types';
import type { GlossaryEntry } from '../../../shared/translate';
import { dispatch } from '../api';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/** Mirrors the server (server/commands/projects.ts): at most 200 terms of 80 characters, no term twice. */
const MAX_TERMS = 200;
const MAX_LEN = 80;

interface Row { key: number; term: string; en: string; it: string }

/** The rows as they are saved: trimmed, empty terms left out, an empty translation not sent. */
export function glossaryOf(rows: readonly Pick<Row, 'term' | 'en' | 'it'>[]): GlossaryEntry[] {
  return rows.filter((r) => r.term.trim()).map((r) => ({
    term: r.term.trim(), ...(r.en.trim() ? { en: r.en.trim() } : {}), ...(r.it.trim() ? { it: r.it.trim() } : {}),
  }));
}

/** The first term written twice (any case), or null. */
export function duplicateTerm(list: readonly GlossaryEntry[]): string | null {
  const seen = new Set<string>();
  for (const g of list) {
    const k = g.term.toLowerCase();
    if (seen.has(k)) return g.term;
    seen.add(k);
  }
  return null;
}

/**
 * A project's translation glossary: words the translator keeps as written (names, made-up words), or always renders
 * the way set here for English and for Italian. The whole list is saved at once.
 */
export function GlossaryDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [next, setNext] = useState(1000);
  const [rows, setRows] = useState<Row[]>(() => (project.glossary ?? []).map((g, i) => ({ key: i, term: g.term, en: g.en ?? '', it: g.it ?? '' })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errId = useId();
  const set = (key: number, p: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r))); setError(null); };
  const add = () => { setRows((rs) => [...rs, { key: next, term: '', en: '', it: '' }]); setNext((n) => n + 1); };

  const save = async () => {
    const list = glossaryOf(rows);
    if (list.length > MAX_TERMS) { setError(`At most ${MAX_TERMS} words.`); return; }
    const dup = duplicateTerm(list);
    if (dup) { setError(`"${dup}" is in the list twice.`); return; }
    setBusy(true);
    try { await dispatch('projects', 'update', { id: project.id, glossary: list }); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <Dialog title="Translation glossary" wide scroll onClose={onClose} onSubmit={save} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>Save glossary</button>
    </>}>
      <p className="hint">Words here are kept as written, or always translated the way you set. Leave both translations empty to keep a word as it is. Changes apply to existing text in the background.</p>
      {rows.length ? (
        <div className="table-wrap">
          <table className="table glossary-table" aria-label="Glossary">
            <thead><tr><th scope="col">Word</th><th scope="col">In English</th><th scope="col">In Italian</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td><input aria-label={`Word ${i + 1}`} value={r.term} maxLength={MAX_LEN} autoComplete="off" autoFocus={r.key >= 1000 && i === rows.length - 1}
                    onChange={(e) => set(r.key, { term: e.target.value })} aria-describedby={error ? errId : undefined} /></td>
                  <td><input aria-label={`${r.term || `Word ${i + 1}`} in English`} value={r.en} maxLength={MAX_LEN} autoComplete="off" placeholder="as written"
                    onChange={(e) => set(r.key, { en: e.target.value })} /></td>
                  <td><input aria-label={`${r.term || `Word ${i + 1}`} in Italian`} value={r.it} maxLength={MAX_LEN} autoComplete="off" placeholder="as written"
                    onChange={(e) => set(r.key, { it: e.target.value })} /></td>
                  <td><button type="button" className="icon-btn" aria-label={`Remove ${r.term || `word ${i + 1}`}`} title="Remove"
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Icon name="trash" size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No words yet. Names from the project's Lore are kept as written anyway.</p>}
      <div className="row">
        <button type="button" className="btn" disabled={rows.length >= MAX_TERMS} onClick={add}><Icon name="plus" size={16} /> Add word</button>
      </div>
      {error && <p className="form-error" id={errId} role="alert">{error}</p>}
    </Dialog>
  );
}
