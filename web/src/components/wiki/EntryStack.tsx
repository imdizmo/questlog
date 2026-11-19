import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Card, Project } from '../../../../shared/types';
import { cardCode } from '../../../../shared/cards';
import { store, useStore } from '../../store';
import { navigate, parse, useLocation } from '../../router';
import { entryBySegment, entryPath } from '../../wiki';
import { closePanel, fitColumns, openFrom, parsePanels, PANELS_PARAM, promotePanel, serialisePanels, setPanelCloser, withPanels } from '../../panels';
import { hasDraft, useDrafts } from '../../drafts';
import { copyText } from '../../cards';
import { showToast } from '../../toast';
import { Menu } from '../Menu';
import { Icon } from '../icons';
import { entryTitle } from './FieldEditor';
import { EntryPage } from './EntryPage';
import { PanelContext, type PanelOpener } from './panelContext';

/** The URL segment of an entry: its key, else `$code` (what entryPath ends with). */
export const segmentOf = (c: Pick<Card, 'entryKey' | 'seq'>): string => c.entryKey ?? `$${cardCode(c.seq)}`;

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The open entry with side-by-side panels to its right (`?panels=`). A plain click on a link to another entry of this
 * wiki, in any column, opens it as a panel right of that column and replaces the panels further right (like a column
 * browser); each step is a history entry, so Back closes it again. Columns that don't fit fold from the left (the main
 * entry first, then the oldest panels) to a strip with their title, so every visible column is whole; at most three
 * panels show in full, so at most four entry pages are mounted. Unsaved text in a column's editor survives folding,
 * replacing and Open full page (web/src/drafts.ts).
 */
export function EntryStack({ main, project }: { main: Card; project: Project }) {
  const loc = useLocation();
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  useDrafts();
  const meId = useStore((s) => s.me?.id ?? null);
  const mainSeg = segmentOf(main);
  const raw = loc.query.get(PANELS_PARAM);
  // Each panel resolved from the store; the segment normalised to the entry's own (a `$code` of a keyed entry → key).
  const panels = useMemo(() => {
    const out: { seg: string; card: Card | undefined }[] = [];
    for (const seg of parsePanels(raw)) {
      const card = entryBySegment({ cards, decks }, project.id, seg);
      const canon = card ? segmentOf(card) : seg;
      if (canon !== mainSeg && !out.some((p) => p.seg === canon)) out.push({ seg: canon, card });
    }
    return out;
  }, [raw, cards, decks, project.id, mainSeg]);
  const segs = panels.map((p) => p.seg);
  const segsKey = segs.join(',');
  const stack = useRef<HTMLDivElement>(null);
  /** The column to focus once the URL has caught up (set by open, close, Open full page). */
  const focusNext = useRef<string | null>(null);

  // The row's width decides what folds (fitColumns); measured before paint and on every resize.
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = stack.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { strips, panelWidth } = fitColumns(width, panels.length);

  const go = (list: string[], focus: string | null) => {
    focusNext.current = focus;
    navigate(location.pathname + withPanels(location.search, list));
  };
  const col = (seg: string) => stack.current?.querySelector<HTMLElement>(`[data-col="${CSS.escape(seg)}"]`) ?? null;
  const bringIn = (seg: string, focus: boolean) => {
    const el = col(seg);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) (el.querySelector<HTMLElement>('.wiki-panel-title') ?? el).focus({ preventScroll: true });
  };
  /** Unfolds column `at` (0 = main) like a click on its strip: the columns after it close. */
  const expand = (at: number) => {
    const { mainSeg: m, segs: p } = latest.current;
    go(p.slice(0, at), at === 0 ? m : p[at - 1]);
  };

  const latest = useRef({ mainSeg, segs, strips });
  latest.current = { mainSeg, segs, strips };
  const openers = useMemo(() => {
    const make = (column: number): PanelOpener => {
      const openCard = (card: Card) => {
        const { mainSeg: m, segs: p, strips: folded } = latest.current;
        const target = segmentOf(card);
        const next = openFrom(m, p, column, target);
        if (next) { go(next, target); return; }
        const at = [m, ...p].indexOf(target);
        if (at !== -1 && at < folded) expand(at); // folded into a strip: show it, as its strip does
        else bringIn(target, true);
      };
      return {
        column,
        openCard,
        openHref: (href) => {
          let url: URL;
          try { url = new URL(href, location.origin); } catch { return false; }
          if (url.origin !== location.origin) return false;
          const r = parse(url.pathname);
          if (r.name !== 'wikiEntry' || r.projectSeq !== project.seq) return false;
          const card = entryBySegment(store.get(), project.id, r.entry);
          if (!card) return false;
          openCard(card);
          return true;
        },
      };
    };
    return Array.from({ length: segs.length + 1 }, (_, i) => make(i));
  }, [segs.length, project.id, project.seq]);

  // A `?panels=` that isn't the list shown (a `$code` of a keyed entry, repeats, the main entry, junk) is rewritten
  // once, in place, so Esc, Back and links all work on the same list.
  useEffect(() => {
    if (raw === null || raw === (serialisePanels(segs) ?? '')) return;
    navigate(location.pathname + withPanels(location.search, segs), { replace: true });
  }, [raw, segsKey]);

  // Esc (App.tsx) closes the rightmost panel through the stack, so it only acts on panels that are on screen.
  useEffect(() => setPanelCloser(() => {
    const p = latest.current.segs;
    if (!p.length) return false;
    go(p.slice(0, -1), null);
    return true;
  }), []);

  // Plain clicks on entry links inside a column open beside it (before the link's own handler navigates).
  const capture = (column: number) => (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || !plainClick(e)) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target || a.hasAttribute('download') || !e.currentTarget.contains(a)) return;
    if (openers[column]?.openHref(a.getAttribute('href') ?? '')) { e.preventDefault(); e.stopPropagation(); }
  };

  // After the panels change: focus what was asked for; else, when the focused panel went away (Back, Esc), focus the
  // newest; else, when the newest panel changed (Forward, a reload, a longer list), scroll it into view.
  const last = useRef<string | null>(null);
  useLayoutEffect(() => {
    const want = focusNext.current;
    focusNext.current = null;
    const newest = segs[segs.length - 1] ?? mainSeg;
    const wasNewest = last.current;
    last.current = newest;
    if (want) bringIn(want, true);
    else if (wasNewest !== null && (!document.activeElement || document.activeElement === document.body)) bringIn(newest, true);
    else if (segs.length && newest !== wasNewest) bringIn(newest, false);
  }, [segsKey, mainSeg]);

  const has = panels.length > 0;
  const strip = (at: number, seg: string, card: Card | undefined) => {
    const title = card ? entryTitle(card) : seg;
    const draft = !!card && card.visibility !== 'deleted' && hasDraft(meId, card.id);
    return (
      <button key={seg} type="button" className="wiki-strip" data-col={seg} data-testid="wiki-strip"
        aria-label={`Show ${title}${draft ? ', unsaved text' : ''} (closes the panels after it)`}
        title={`${title}: show it (closes the panels after it)${draft ? '. Its text has unsaved changes.' : ''}`}
        onClick={() => expand(at)}>
        {draft && <span className="wiki-strip-draft" aria-hidden>●</span>}
        <span className="wiki-strip-title">{title}</span>
      </button>
    );
  };
  return (
    <div className={`wiki-stack${has ? ' has-panels' : ''}`} ref={stack} data-testid="wiki-stack">
      {strips > 0 ? strip(0, mainSeg, main) : (
        <PanelContext.Provider value={openers[0]}>
          <div className="wiki-col wiki-col-main" data-col={mainSeg} tabIndex={-1} onClickCapture={capture(0)}>
            <EntryPage key={main.id} card={main} project={project} />
          </div>
        </PanelContext.Provider>
      )}
      {panels.map((p, j) => {
        const i = j + 1;
        if (i < strips) return strip(i, p.seg, p.card);
        const close = () => go(closePanel(segs, i), segs[j - 1] ?? mainSeg);
        return (
          <PanelContext.Provider key={p.seg} value={openers[i]}>
            <Panel seg={p.seg} card={p.card} project={project} width={panelWidth} onClose={close}
              onPromote={p.card ? () => {
                const next = promotePanel(mainSeg, segs, i);
                focusNext.current = next.main;
                navigate(`${entryPath(project.seq, p.card!)}${withPanels(location.search, next.panels)}`);
              } : undefined}
              onCloseRight={i < segs.length ? () => go(segs.slice(0, i), p.seg) : undefined}
              onClick={capture(i)} />
          </PanelContext.Provider>
        );
      })}
    </div>
  );
}

function Panel({ seg, card, project, width, onClose, onPromote, onCloseRight, onClick }: {
  seg: string; card: Card | undefined; project: Project; width: number; onClose: () => void; onPromote?: () => void; onCloseRight?: () => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
}) {
  const titleId = useId();
  const icon = useStore((s) => (card?.entryTypeId ? s.entryTypes.get(card.entryTypeId)?.icon ?? null : null));
  const title = card ? entryTitle(card) : 'Lore not found';
  const href = card ? entryPath(project.seq, card) : `/wiki/${project.seq}/${seg}`;
  const items = [
    { label: 'Open in new tab', onSelect: () => { window.open(href, '_blank', 'noopener'); } },
    { label: 'Copy link', onSelect: () => { void copyText(new URL(href, location.origin).href).then((ok) => showToast(ok ? 'Link copied.' : "Couldn't copy the link.", ok ? 'info' : 'error', 3000)); } },
    ...(onCloseRight ? [{ label: 'Close the panels to its right', onSelect: onCloseRight }] : []),
  ];
  let body: ReactNode;
  if (card) body = <EntryPage key={card.id} card={card} project={project} compact />;
  else body = <div className="empty"><p className="muted">No lore with the key “{seg}” in {project.name}. It may have been deleted or renamed.</p></div>;
  return (
    <section className="wiki-col wiki-panel" data-col={seg} data-testid="wiki-panel" aria-labelledby={titleId} onClickCapture={onClick}
      style={{ flexBasis: width, width }}>
      <header className="wiki-panel-head">
        {icon && <span aria-hidden className="wiki-panel-ico">{icon}</span>}
        <h2 id={titleId} className="wiki-panel-title" tabIndex={-1}>{title}</h2>
        <span className="wiki-panel-actions">
          <Menu label={`More for ${title}`} trigger={<Icon name="more" size={16} />} items={items} />
          {onPromote && <button type="button" className="btn btn-sm btn-ghost" onClick={onPromote} title="Make it the main entry; the other panels stay open">Open full page</button>}
          <button type="button" className="icon-btn" aria-label={`Close ${title}`} title="Close (Esc closes the rightmost panel)" onClick={onClose}><Icon name="close" size={16} /></button>
        </span>
      </header>
      <div className="wiki-panel-body">{body}</div>
    </section>
  );
}
