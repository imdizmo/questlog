import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { useStore } from '../store';
import { tabActions, useTabs } from '../tabRuntime';
import { current, TAB_CAP } from '../tabs';
import { tabLabel } from '../tabLabel';
import { Icon } from './icons';
import { IS_MAC } from '../linkIgnores';

/**
 * The open pages, right beside the workspace switcher: a click shows one, double-click pins or unpins it, a middle
 * click or × closes it (pinned ones stay), "+" opens a New tab. The Home tab is pinned first and has no ×.
 */
export function TabBar() {
  const tabs = useTabs();
  const projects = useStore((s) => s.projects);
  const decks = useStore((s) => s.decks);
  const cards = useStore((s) => s.cards);
  const milestones = useStore((s) => s.milestones);
  const entryTypes = useStore((s) => s.entryTypes);
  const urls = tabs?.list.map(current).join('\n') ?? '';
  const labels = useMemo(
    () => (tabs ? tabs.list.map((t) => tabLabel({ projects, decks, cards, milestones, entryTypes }, current(t))) : []),
    [urls, projects, decks, cards, milestones, entryTypes],
  );
  // More tabs than fit scroll sideways: the one showing is always scrolled into view.
  const bar = useRef<HTMLDivElement>(null);
  const active = tabs?.active;
  useEffect(() => {
    bar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs?.list.length]);
  if (!tabs) return null;
  const tabEls = () => [...(bar.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
  /** Keyboard on a focused tab: ←/→ (Home/End) move, Enter or Space shows it, Delete closes it, Shift+P pins it. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>, id: string, i: number, pinned: boolean) => {
    const els = tabEls();
    const move = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: els.length - 1 }[e.key];
    if (move !== undefined) { e.preventDefault(); els[(move + els.length) % els.length]?.focus(); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tabActions.switchTo(id); return; }
    if (e.key === 'Delete' && !pinned) {
      e.preventDefault();
      tabActions.close(id);
      requestAnimationFrame(() => { const left = tabEls(); left[Math.min(i, left.length - 1)]?.focus(); });
      return;
    }
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyP') { e.preventDefault(); tabActions.pin(id); }
  };
  const onAux = (e: MouseEvent<HTMLDivElement>, id: string, pinned: boolean) => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (!pinned) tabActions.close(id);
  };
  return (
    <>
    <div className="tab-nav">
      <button type="button" className="qtab-nav" aria-label="Back" title="Back in this tab" disabled={!tabActions.canGo(-1)} onClick={() => tabActions.back()}>
        <Icon name="back" size={15} />
      </button>
      <button type="button" className="qtab-nav" aria-label="Forward" title="Forward in this tab" disabled={!tabActions.canGo(1)} onClick={() => tabActions.forward()}>
        <Icon name="forward" size={15} />
      </button>
    </div>
    <div className="tabs-bar" role="tablist" aria-label="Open pages" ref={bar}>
      {tabs.list.map((t, i) => {
        const { label, icon } = labels[i];
        const selected = t.id === tabs.active;
        return (
          <div key={t.id} className={t.pinned ? 'qtab pinned' : 'qtab'} role="tab" tabIndex={selected ? 0 : -1} aria-selected={selected}
            title={`${label}${t.pinned ? ' (pinned)' : ''} · double-click or Shift+P to ${t.pinned ? 'unpin' : 'pin'}${i < 9 && !IS_MAC ? ` · Alt+${i + 1}` : ''}`}
            data-testid="tab"
            onClick={() => tabActions.switchTo(t.id)} onDoubleClick={() => { if (!t.home) tabActions.pin(t.id); }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onAuxClick={(e) => onAux(e, t.id, t.pinned)}
            onKeyDown={(e) => onKey(e, t.id, i, t.pinned)}>
            <Icon name={icon} size={15} />
            <span className="qtab-t">{label}</span>
            {t.pinned
              ? <span className="qtab-pin" aria-label="pinned" />
              : (
                <button type="button" className="qtab-x" tabIndex={-1} aria-label={`Close ${label}`} title="Close (Delete, or Ctrl+W in the desktop app)"
                  onClick={(e) => { e.stopPropagation(); tabActions.close(t.id); }}>
                  <Icon name="close" size={13} />
                </button>
              )}
          </div>
        );
      })}
      <button type="button" className="qtab-add" aria-label="New tab" title={`New tab (${tabs.list.length} of ${TAB_CAP} open)`} onClick={() => tabActions.newTab()}>
        <Icon name="plus" size={15} />
      </button>
    </div>
    </>
  );
}
