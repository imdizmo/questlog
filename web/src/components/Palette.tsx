import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { dispatch } from '../api';
import { store, useStore } from '../store';
import { navigate, type Route } from '../router';
import { cardHref, pushRecentDeck } from '../cards';
import { wikiPath } from '../wiki';
import { newEntry } from './wiki/GuidedStart';
import { Icon, type IconName } from './icons';
import {
  createErrorText, createLabel, createOptions, createSub, guessOption, resolveActive, hitView, optionKey, paletteContext, pushRecent, readLastType, readRecent,
  recentHits, refOfHit, search, writeLastType, type CreateOption, type Hit, type HitGroup,
} from '../palette';

/** How long a new card may take to arrive over the socket before its page opens anyway (it then loads by itself). */
const ARRIVAL_MS = 4000;
function arrival(id: string): Promise<void> {
  return new Promise((resolve) => {
    if (store.get().cards.has(id)) { resolve(); return; }
    const done = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(done, ARRIVAL_MS);
    const unsubscribe = store.subscribe(() => { if (store.get().cards.has(id)) done(); });
  });
}

type Row = { key: string; hit: Hit } | { key: 'new'; option: CreateOption };
const rowKey = (h: Pick<Hit, 'kind' | 'id'>) => `${h.kind}:${h.id}`;

const KIND_ICON: Record<Hit['kind'], IconName> = { entry: 'doc', task: 'task', lore: 'doc', list: 'card', project: 'globe' };

/**
 * Ctrl/⌘+K: one input that finds tasks, wiki entries, lore, lists and projects, and whose last row makes a new thing
 * of that name. A combobox over a grouped listbox; focus stays in the input, the highlighted row is its active
 * descendant. Enter opens the highlighted row and nothing else: the New row is never highlighted by itself (only by
 * ↑/↓/End or the mouse), so a name that stops matching never turns Enter into a create.
 */
export function Palette({ route, onClose, initial = '' }: { route: Route; onClose: () => void; initial?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const base = useId();
  const s = useStore((x) => x);
  const [query, setQuery] = useState(initial);
  /** The highlighted row by key (not index, so rows moving under it never shift the highlight); null: automatic. */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** The type chosen with Tab, kept while typing on. */
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the last create failed, shown under the New row (a toast would sit behind this modal). */
  const [error, setError] = useState<string | null>(null);
  /** False once the palette is closed: a create still in flight then neither navigates nor closes a reopened one. */
  const alive = useRef(true);
  const hintId = useId();
  /** Focus goes back to where it was on Esc, but not after something was opened. */
  const restore = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    alive.current = true;
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    d.querySelector<HTMLInputElement>('input')?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', onCancel);
    return () => {
      alive.current = false;
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
      if (restore.current && opener?.isConnected) opener.focus();
    };
  }, []);

  const recents = useMemo(() => readRecent(), []);
  const recentIds = useMemo(() => recents.map((r) => r.id), [recents]);
  const trimmed = query.trim();
  const groups: HitGroup[] = useMemo(() => {
    if (!trimmed) {
      const hits = recentHits(s, recents);
      return hits.length ? [{ kind: 'recent', label: 'Recent', hits }] : [];
    }
    return search(s, trimmed, recentIds);
  }, [s.cards, s.decks, s.projects, s.entryTypes, trimmed, recents, recentIds]);
  const ctx = useMemo(() => paletteContext(s, route), [s.cards, s.decks, s.projects, s.me, s.accountRoles, s.projectAccess, route]);
  const options = useMemo(() => createOptions(s, ctx), [s.entryTypes, s.decks, s.accountRoles, s.projectAccess, s.me, ctx]);
  const last = useMemo(() => readLastType(), []);
  const guessed = useMemo(() => guessOption(options, trimmed, last, !!ctx.deck), [options, trimmed, last, ctx.deck]);
  const pickedIdx = picked ? options.findIndex((o) => optionKey(o) === picked) : -1;
  const optionIdx = pickedIdx >= 0 ? pickedIdx : guessed;
  const option = trimmed && optionIdx >= 0 ? options[optionIdx] : null;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = groups.flatMap((g) => g.hits.map((hit) => ({ key: rowKey(hit), hit })));
    if (option) out.push({ key: 'new', option });
    return out;
  }, [groups, option]);
  const hitCount = option ? rows.length - 1 : rows.length;
  // Automatic highlight: the first result, never the New row.
  const active = resolveActive(rows.map((r) => r.key), activeKey, hitCount);
  const activeIdx = active === null ? -1 : rows.findIndex((r) => r.key === active);
  const optId = (key: string) => `${base}-${key.replace(/[^\w-]/g, '_')}`;

  // The highlighted row stays in view.
  useEffect(() => {
    if (active) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = (opened: boolean) => { if (opened) restore.current = false; onClose(); };

  const open = (hit: Hit) => {
    if (busy) return;
    const v = hitView(store.get(), hit);
    if (!v) return;
    pushRecent(refOfHit(hit));
    close(true);
    navigate(v.href);
  };

  const create = async (o: CreateOption) => {
    const name = trimmed;
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      let href: string;
      let id: string;
      if (o.kind === 'task') {
        const r = await dispatch<{ id: string; accountSeq: number }>('cards', 'create', { deckId: o.deck.id, content: name });
        pushRecentDeck(o.deck.id);
        id = r.id;
        href = cardHref({ seq: r.accountSeq, content: name }, o.deck);
        if (!alive.current) return;
      } else {
        // A type with a guided start asks its questions first (null: cancelled there).
        const r = o.kind === 'entry' ? await newEntry({ project: o.project, type: o.type, name })
          : await dispatch<{ id: string; key: string }>('wiki', 'createEntry', { projectId: o.project.id, typeId: null, name });
        if (!r) { if (alive.current) setBusy(false); return; }
        id = r.id;
        href = `${wikiPath(o.project.seq)}/${r.key}`;
        if (!alive.current) return;
      }
      writeLastType(o);
      pushRecent({ kind: 'card', id });
      await arrival(id);
      if (!alive.current) return; // closed meanwhile (Esc, Ctrl+K): it was made, but nothing opens
      close(true);
      navigate(href);
    } catch (e) {
      if (!alive.current) return;
      setBusy(false); // the palette stays for another try, the reason under the New row
      setError(createErrorText(e));
    }
  };

  const choose = (row: Row) => {
    if ('hit' in row) open(row.hit);
    else void create(row.option);
  };

  const move = (to: number) => {
    if (!rows.length) return;
    setActiveKey(rows[Math.max(0, Math.min(rows.length - 1, to))].key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(activeIdx + 1); break;
      case 'ArrowUp': e.preventDefault(); move(activeIdx < 0 ? rows.length - 1 : activeIdx - 1); break;
      case 'Home': if (rows.length) { e.preventDefault(); move(0); } break;
      case 'End': if (rows.length) { e.preventDefault(); move(rows.length - 1); } break;
      case 'PageDown': e.preventDefault(); move(activeIdx + 5); break;
      case 'PageUp': e.preventDefault(); move(Math.max(0, activeIdx - 5)); break;
      case 'Tab':
        // Focus stays in the input (nothing else here takes it); Tab / Shift+Tab turn the New row's type.
        e.preventDefault();
        if (option && options.length > 1) {
          const n = options.length;
          setPicked(optionKey(options[(optionIdx + (e.shiftKey ? n - 1 : 1)) % n]));
          setError(null);
        }
        break;
      case 'Enter': {
        e.preventDefault();
        const row = activeIdx >= 0 ? rows[activeIdx] : null;
        // A held Enter never creates twice.
        if (!row || busy || (row.key === 'new' && e.repeat)) return;
        choose(row);
        break;
      }
    }
  };

  const groupBlock = (key: string, label: string, children: ReactNode) => (
    <div role="group" aria-labelledby={`${base}-g-${key}`} className="pal-group" key={key}>
      <div className="pal-heading" id={`${base}-g-${key}`} role="presentation">{label}</div>
      {children}
    </div>
  );

  const hitRow = (h: Hit) => {
    const v = hitView(s, h);
    if (!v) return null;
    const key = rowKey(h);
    const deckType = h.kind === 'list' ? s.decks.get(h.id)?.deckType : undefined;
    const icon = v.icon ?? null;
    return (
      <div key={key} id={optId(key)} role="option" aria-selected={key === active}
        className={`pal-opt${key === active ? ' active' : ''}`}
        onMouseMove={() => { if (key !== active) setActiveKey(key); }}
        onMouseDown={(e) => e.preventDefault()} onClick={() => open(h)}>
        <span className="pal-ico" aria-hidden>{icon ?? <Icon name={deckType && deckType !== 'mixed' ? deckType : KIND_ICON[h.kind]} size={16} />}</span>
        <span className="pal-title">{h.title}</span>
        {v.sub && <span className="pal-sub">{v.sub}</span>}
      </div>
    );
  };

  const hint = !rows.length ? (trimmed ? 'Nothing found.' : 'Type to find tasks, wiki entries, lore, lists and projects.')
    : trimmed && !hitCount && option && active !== 'new' ? 'Nothing found. ↓ then Enter makes it.' : '';
  const typeIcon = option?.kind === 'entry' ? option.type.icon : null;
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Find or create"
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="pal-field">
        <Icon name="search" size={16} />
        <input
          role="combobox" aria-expanded={rows.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active ? optId(active) : undefined} aria-label="Find or create" aria-busy={busy || undefined}
          aria-describedby={hintId}
          placeholder="Find a task, entry, list or project, or name a new one" value={query} maxLength={200}
          autoComplete="off" spellCheck={false} readOnly={busy}
          onChange={(e) => { setQuery(e.target.value.replace(/[\r\n]+/g, ' ')); setActiveKey(null); setError(null); }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="pal-list" role="listbox" id={listId} aria-label="Results">
        {groups.map((g) => groupBlock(g.kind, g.label, g.hits.map(hitRow)))}
        {option && groupBlock('new', 'Create', (
          <div id={optId('new')} role="option" aria-selected={active === 'new'}
            className={`pal-opt pal-new${active === 'new' ? ' active' : ''}`}
            onMouseMove={() => { if (active !== 'new') setActiveKey('new'); }}
            onMouseDown={(e) => e.preventDefault()} onClick={() => void create(option)}>
            <span className="pal-ico" aria-hidden>{typeIcon ?? <Icon name={option.kind === 'task' ? 'task' : 'plus'} size={16} />}</span>
            <span className="pal-title">{busy ? 'Creating…' : createLabel(option, trimmed)}</span>
            <span className="pal-sub">{createSub(option)}</span>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="field-error pal-error">{error}</p>}
      {/* Always mounted, so screen readers announce its changes; empty (and hidden) once the New row is highlighted. */}
      <p id={hintId} className="pal-empty" aria-live="polite">{hint}</p>
      <footer className="pal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> {active === 'new' ? 'create' : 'open'}</span>
        {option && options.length > 1 && <span><kbd>Tab</kbd> type</span>}
        <span><kbd>Esc</kbd> close</span>
      </footer>
    </dialog>
  );
}
