import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { settingsOf, store, useStore } from '../store';
import { navigate, setQuery, useLocation } from '../router';
import { visionHref } from '../board/boards';
import { useWorkspaceKind } from '../workspaceKind';
import { MENU_TRIGGER_ID, menuOpenValue } from './WorkspaceMenu';
import { Icon } from './icons';
import { WorkspaceKindLine } from './WorkspaceKindLine';

/**
 * The top bar's workspace switcher (it replaces the workspace name and the "This computer / Team" badge): it shows
 * which workspace this page is and where it is kept. Its menu lists what this page can open: this workspace, and
 * Workspace settings (the Workspace menu, `?menu=`). Switching to another workspace stays with the desktop app's strip
 * at the window's left (shell-owned; a page never switches it), so on This computer the menu says where that is.
 * While the Vision board feature is on (or boards exist), the menu also opens the old boards: Home took their place in
 * the sidebar, and nothing on them is lost.
 */
export function WorkspaceSwitcher() {
  const name = useStore((s) => s.account?.name) ?? 'Workspace';
  const kind = useWorkspaceKind();
  const settingsOpen = useLocation().query.get('menu') !== null;
  const boards = useStore((s) => settingsOf(s).visionBoardEnabled || s.visionBoards.size > 0);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = items();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const settings = () => { setOpen(false); setQuery('menu', menuOpenValue()); };
  const openBoards = () => { setOpen(false); navigate(visionHref(store.get())); };
  const where = kind?.label ?? '';
  const initial = name.trim().slice(0, 1).toUpperCase() || 'Q';

  return (
    <div className="wsw" ref={wrap}>
      <button type="button" id={MENU_TRIGGER_ID} ref={button} className="wsw-btn" aria-haspopup="menu" aria-expanded={open || settingsOpen}
        aria-label={`Workspace: ${name}${where ? `, ${where}` : ''}`} title="Switch workspace or open its settings"
        onClick={() => setOpen((o) => !o)}>
        <span className="wsw-logo" aria-hidden>{initial}</span>
        <span className="wsw-name">
          <b>{name}</b>
          <WorkspaceKindLine workspace={kind} />
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="wsw-menu" role="menu" aria-label="Workspaces" onKeyDown={onMenuKey}>
          <div className="wsw-head">Workspaces</div>
          <button type="button" className="wsw-item" role="menuitemradio" aria-checked onClick={() => setOpen(false)}>
            <span className="wsw-av" aria-hidden>{initial}</span>
            <span className="wsw-text"><span>{name}</span>{where && <span className="wsw-sub">{where}</span>}</span>
            <span className="wsw-ck" aria-hidden><Icon name="check" size={15} /></span>
          </button>
          {kind?.kind === 'local' && <p className="wsw-note">Your team servers are in the strip at the window&apos;s left.</p>}
          <hr />
          <button type="button" className="wsw-item" role="menuitem" onClick={settings}>
            <span className="wsw-av" aria-hidden><Icon name="gear" size={14} /></span>
            <span className="wsw-text"><span>Workspace settings, people, look…</span></span>
          </button>
          {boards && (
            <button type="button" className="wsw-item" role="menuitem" onClick={openBoards}>
              <span className="wsw-av" aria-hidden><Icon name="frame" size={14} /></span>
              <span className="wsw-text"><span>Vision boards</span><span className="wsw-sub">The free canvases of ideas and sketches</span></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
