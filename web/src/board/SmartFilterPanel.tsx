import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cardCode, titleOf } from '../../../shared/cards';
import { MAX_CHIPS, savedSearchName, suggest, type SearchToken } from '../../../shared/search';
import { dispatch } from '../api';
import { store, useStore } from '../store';
import { Icon } from '../components/icons';
import { chipLabel, type SearchContexts } from '../search';
import { useMatchingCards } from './SmartNode';
import { useShownTitle } from '../translate';

/** Matching cards drawn in the panel; the rest are counted. */
const LIST_LIMIT = 50;

const sameTokens = (a: SearchToken[], b: SearchToken[]) => JSON.stringify(a) === JSON.stringify(b);

/** The query arrives over the live socket after the command returns; wait so the node never flashes "not available". */
async function queryArrived(id: string, ms = 3000) {
  for (let waited = 0; waited < ms && !store.get().visionQueries.has(id); waited += 50) await new Promise((r) => setTimeout(r, 50));
}

interface Row { id: string; label: string; token: SearchToken }

/** Chips and a suggestion menu over local state (the top bar's SearchBox keeps its chips in the URL; these are a draft). */
function ChipInput({ tokens, forceOr, ctx, disabled, onTokens, onForceOr }: {
  tokens: SearchToken[]; forceOr: boolean; ctx: SearchContexts; disabled: boolean;
  onTokens: (t: SearchToken[]) => void; onForceOr: (v: boolean) => void;
}) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const groups = useMemo(() => {
    if (text.trim() === '') return [];
    return suggest(text, ctx.suggest)
      .map((g) => ({ heading: g.heading, rows: g.items.flatMap((it, i): Row[] => (it.token && !it.disabled ? [{ id: `${g.heading}-${i}`, label: it.label, token: it.token }] : [])) }))
      .filter((g) => g.rows.length);
  }, [text, ctx]);
  const flat = groups.flatMap((g) => g.rows);

  const add = (t: SearchToken) => {
    setText(''); setOpen(false); setActive(-1);
    if (tokens.length >= MAX_CHIPS || tokens.some((x) => sameTokens([x], [t]))) return;
    onTokens([...tokens, t]);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (flat.length) setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % flat.length : (i - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = active >= 0 ? flat[active] : undefined;
      if (row) add(row.token);
      else if (text.trim() && !/^[!#@$]/.test(text.trim())) add({ category: 'content', value: text.trim(), isNegated: false });
    } else if (e.key === 'Backspace' && text === '' && tokens.length) {
      onTokens(tokens.slice(0, -1));
    } else if (e.key === 'Escape' && open && flat.length > 0) {
      e.preventDefault(); // the first Esc closes the menu; the next one reaches the panel
      setOpen(false);
    }
  };

  const activeRow = active >= 0 ? flat[active] : undefined;
  return (
    <div className="sbox bfilter-box" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <div className="sbox-field" onClick={() => input.current?.focus()}>
        <ul className="sbox-chips" aria-label="Filter chips">
          {tokens.map((t, i) => {
            const label = chipLabel(t, ctx.suggest);
            return (
              <li key={i} className={t.isNegated ? 'stoken negated' : 'stoken'}>
                {t.isNegated && <span className="stoken-not">not</span>}
                <span>{label}</span>
                <button type="button" className="chip-x" disabled={disabled} aria-label={`Remove filter ${t.isNegated ? 'not ' : ''}${label}`}
                  onClick={(e) => { e.stopPropagation(); onTokens(tokens.filter((_, j) => j !== i)); input.current?.focus(); }}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
        <input ref={input} className="sbox-input" role="combobox" aria-label="Filter tasks" disabled={disabled}
          aria-expanded={open && flat.length > 0} aria-controls={`${uid}-list`} aria-autocomplete="list"
          aria-activedescendant={open && activeRow ? `${uid}-${activeRow.id}` : undefined}
          placeholder={tokens.length ? '' : 'Type # @ ! or words…'} autoComplete="off" spellCheck={false} value={text}
          onChange={(e) => { setText(e.target.value); setActive(-1); setOpen(true); }}
          onClick={() => setOpen(true)} onKeyDown={onKey} />
        {tokens.length > 1 && (
          <button type="button" className={forceOr ? 'btn btn-active sbox-btn' : 'btn sbox-btn'} aria-pressed={forceOr} disabled={disabled}
            title="Match tasks that fit any chip instead of all of them" onClick={(e) => { e.stopPropagation(); onForceOr(!forceOr); }}>Match any</button>
        )}
      </div>
      {open && flat.length > 0 && (
        <div className="sbox-menu" onMouseDown={(e) => e.preventDefault()}>
          <div id={`${uid}-list`} role="listbox" aria-label="Filter suggestions">
            {groups.map((g) => (
              <div key={g.heading} role="group" aria-label={g.heading} className="sbox-group">
                <div className="sbox-heading" aria-hidden>{g.heading}</div>
                {g.rows.map((r) => (
                  <div key={r.id} className="sbox-row" role="presentation">
                    <div id={`${uid}-${r.id}`} role="option" aria-selected={r === activeRow} className={r === activeRow ? 'sbox-opt active' : 'sbox-opt'} onClick={() => add(r.token)}>
                      <span className="sbox-opt-label">{r.label}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface SmartFilterPanelProps {
  /** Who keeps the query: a card board's host task, or on Home the project picked for the node (its tasks only). */
  owner: { cardId: string } | { projectId: string };
  /** The Smart Node's current query, if it has one. */
  queryId: string | null;
  canEdit: boolean;
  /** The new query is stored and visible; the caller writes it (and its name) into the node. */
  onSaved: (queryId: string, label: string) => void;
  onAdd: (cardId: string) => void;
  onClose: () => void;
}

/** Side panel for "Set up filter": a draft chip filter, the cards it matches, and Save. Nothing is written until Save. */
export function SmartFilterPanel({ owner, queryId, canEdit, onSaved, onAdd, onClose }: SmartFilterPanelProps) {
  const shownTitle = useShownTitle();
  const saved = useStore((s) => (queryId ? s.visionQueries.get(queryId) : undefined));
  const [tokens, setTokens] = useState<SearchToken[]>(saved?.query.tokens ?? []);
  const [forceOr, setForceOr] = useState(saved?.query.forceOr ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const projectId = 'projectId' in owner ? owner.projectId : null;
  const projectName = useStore((s) => (projectId ? s.projects.get(projectId)?.name : undefined));
  const { cards, ctx } = useMatchingCards(tokens, forceOr, false, projectId);

  useEffect(() => { document.querySelector<HTMLInputElement>('.board-filter-panel .sbox-input')?.focus(); }, []);

  // A single chip never needs "Match any"; drop the flag with it so the saved query stays canonical.
  const orFlag = tokens.length > 1 && forceOr;
  const dirty = !saved || !sameTokens(saved.query.tokens, tokens) || saved.query.forceOr !== orFlag;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { id } = await dispatch<{ id: string }>('visionBoard', 'createQuery', {
        ...owner, query: { type: 'filter', tokens, forceOr: orFlag },
      }); // no prevQueryId: the server keeps unused queries for an hour (undo can bring one back), then collects them
      await queryArrived(id);
      onSaved(id, savedSearchName(tokens, ctx.suggest, orFlag));
    } catch {
      setError("Couldn't save the filter."); // api shows the server's own message as a toast
    } finally {
      setBusy(false);
    }
  };

  const shown = cards.slice(0, LIST_LIMIT);
  return (
    <aside className="card-panel board-card-panel board-filter-panel" aria-label="Smart filter"
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}>
      <button type="button" className="icon-btn panel-close" aria-label="Close filter" onClick={onClose}><Icon name="close" /></button>
      <div className="stack">
        <h2 className="bfilter-title">Set up filter</h2>
        {!canEdit && <p className="hint">This board is read-only for you.</p>}
        {projectId && <p className="hint">Tasks of {projectName ?? 'its project'}</p>}
        <ChipInput tokens={tokens} forceOr={forceOr} ctx={ctx} disabled={!canEdit} onTokens={setTokens} onForceOr={setForceOr} />
        <div className="bpick-actions">
          <button type="button" className="btn btn-primary" disabled={!canEdit || busy || !dirty} onClick={() => void save()}>Save filter</button>
        </div>
        {error && <p role="alert" className="field-error">{error}</p>}
        <p className="hint" aria-live="polite">{cards.length} matching {cards.length === 1 ? 'task' : 'tasks'}</p>
        <ul className="bfilter-list" aria-label="Matching tasks">
          {shown.map((c) => (
            <li key={c.id} className="bfilter-item">
              <div className="bfilter-card">
                <span className="bfilter-card-title">{shownTitle(c)}</span>
                <span className="picker-sub">{taskId(c)}</span>
              </div>
              {canEdit && (
                <button type="button" className="btn btn-sm" onClick={() => onAdd(c.id)}>+ Add to board<span className="sr-only">: {shownTitle(c)}</span></button>
              )}
            </li>
          ))}
          {cards.length > shown.length && <li className="hint">Showing the first {shown.length} of {cards.length}.</li>}
        </ul>
      </div>
    </aside>
  );
}
