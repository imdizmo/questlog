import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type AccountSettings as Settings } from '../../../shared/types';
import { dispatch } from '../api';
import { isAdmin, store, useStore } from '../store';
import { navigate, useLocation } from '../router';
import { showToast } from '../toast';
import { Icon, type IconName } from './icons';
import { ArtworkSvg } from './CoverArt';
import { menuValue, parseMenu, sectionById, stepSection, visibleSections, type SectionDef, type SectionId } from '../workspaceMenu';
import { CalendarForm, FeaturesForm, GuidesSection, NUM_KEYS, TasksForm, WorkspaceForm, type Form, type NumKey } from '../views/menu/SettingsForms';
import {
  ArchiveSection, ConnectionsBody, ExportSection, FilesSection, ImportBody, LookSection, PreferencesBody, PublicSection, SubTabs, TypesSection,
} from '../views/menu/Sections';
import { MembersPanel } from '../views/Members';
import { BillingSettings } from '../views/settings/Billing';
import { DangerZone } from '../views/settings/DangerZone';

/** The id of the top-left button that opens the menu; focus returns to it when the menu closes. */
export const MENU_TRIGGER_ID = 'wsm-trigger';

/** Sections whose content is the shared settings form (one Save for all of them). */
const FORM_SECTIONS = new Set<SectionId>(['workspace', 'features', 'tasks', 'calendar']);

/** "Open full page" targets: pages that existed before the menu and still do. */
const FULL_PAGE: Partial<Record<SectionId, (tab: string | null) => string | null>> = {
  members: () => '?show=members',
  preferences: (tab) => (tab === 'tokens' ? '?show=apiTokens' : tab === 'account' ? '?show=myAccount' : '?show=emailSettings'),
  archive: () => '/decks',
};

/**
 * Unsaved edits of the settings sections, kept per person while the page lives: closing the menu (Esc, a click
 * outside) keeps them, so nothing typed is lost; Save or Discard clears them. Module-level on purpose: keyed by the
 * user id, so after a logout the next person starts clean, and switching workspace reloads the page (a new module).
 */
interface Draft { userId: string; name?: string; settings: Partial<Settings>; nums: Partial<Record<NumKey, string>> }
let draft: Draft | null = null;
/** The section last open, so the trigger opens where the person left off. */
let lastSection: string | null = null;

/** The `?menu=` value the trigger opens. */
export const menuOpenValue = (): string => lastSection ?? 'workspace';

/** Moves to another `?menu=` value (replacing the history entry) or closes the menu (`null`, a new entry). */
function setMenu(value: string | null, replace: boolean) {
  const q = new URLSearchParams(location.search);
  if (value === null) q.delete('menu');
  else q.set('menu', value);
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ''), { replace });
}

/**
 * The workspace menu (`?menu=<section>[/<tab>]`): a popover under the workspace name with the sections on the left and
 * the open section on the right. A modal <dialog>: focus stays inside, Esc closes and returns focus to the trigger.
 */
export function WorkspaceMenu({ value }: { value: string }) {
  const admin = useStore(isAdmin);
  const meId = useStore((s) => s.me?.id ?? '');
  const account = useStore((s) => s.account);
  const loc = useLocation();
  const target = parseMenu(value, { admin })!;
  const sections = visibleSections({ admin });
  const section = sectionById(target.section)!;
  const ref = useRef<HTMLDialogElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const navId = useId();
  lastSection = menuValue(target.section, target.tab);

  // A link to a section this person can't open (or a typo) lands on the first one: say so in the URL too.
  useEffect(() => {
    const v = menuValue(target.section, target.tab);
    if (v !== value) setMenu(v, true);
  }, [value, target.section, target.tab]);

  // ---- the shared settings form ----
  const stored: Settings = { ...DEFAULT_SETTINGS, ...account?.settings };
  const [, rerender] = useState(0);
  const d: Draft = draft && draft.userId === meId ? draft : { userId: meId, settings: {}, nums: {} };
  const update = (fn: (x: Draft) => Draft) => { draft = fn(d); rerender((n) => n + 1); };
  const storedNum = (k: NumKey) => String(k === 'autoArchiveHours' ? stored.autoArchiveHours ?? DEFAULT_SETTINGS.autoArchiveHours : stored[k]);
  const nums = Object.fromEntries(NUM_KEYS.map((k) => [k, d.nums[k] ?? storedNum(k)])) as Record<NumKey, string>;
  const name = d.name ?? account?.name ?? '';
  const changedSettings = (Object.keys(d.settings) as (keyof Settings)[]).filter((k) => JSON.stringify(d.settings[k]) !== JSON.stringify(stored[k]));
  const changedNums = NUM_KEYS.filter((k) => d.nums[k] !== undefined && d.nums[k] !== storedNum(k));
  const dirty = admin && (changedSettings.length > 0 || changedNums.length > 0 || (d.name !== undefined && d.name.trim() !== (account?.name ?? '').trim()));
  const form: Form = {
    v: { ...stored, ...d.settings }, name, nums, editable: admin,
    set: (p) => update((x) => ({ ...x, settings: { ...x.settings, ...p } })),
    setName: (n) => update((x) => ({ ...x, name: n })),
    setNum: (k, v) => update((x) => ({ ...x, nums: { ...x.nums, [k]: v } })),
  };
  const [busy, setBusy] = useState(false);
  const discard = () => { draft = null; rerender((n) => n + 1); };
  const save = async () => {
    if (!dirty || busy) return;
    const labels: Record<NumKey, string> = { staleHours: 'the snooze time', autoArchiveHours: 'the archive time', fallbackEffort: 'the size of unsized tasks' };
    const out: Partial<Settings> = {};
    for (const k of changedSettings) (out as Record<string, unknown>)[k] = form.v[k];
    for (const k of changedNums) {
      if (k === 'autoArchiveHours' && form.v.autoArchiveHours === null) continue;
      const n = Number(nums[k]);
      if (nums[k].trim() === '' || !Number.isFinite(n)) {
        showToast(`Enter a number for ${labels[k]}.`);
        setMenu(menuValue('tasks'), true);
        return;
      }
      out[k] = n;
    }
    // "After" picked with the hours left as they were: the hours shown are the ones saved.
    if (out.autoArchiveHours !== undefined && out.autoArchiveHours !== null && !changedNums.includes('autoArchiveHours')) out.autoArchiveHours = Number(nums.autoArchiveHours);
    const newName = d.name !== undefined && d.name.trim() && d.name.trim() !== account?.name ? d.name.trim() : undefined;
    if (d.name !== undefined && !d.name.trim()) { showToast('The workspace needs a name.'); setMenu(menuValue('workspace'), true); return; }
    setBusy(true);
    try {
      await dispatch('accounts', 'update', { ...(newName ? { name: newName } : {}), ...(Object.keys(out).length ? { settings: out } : {}) });
      draft = null;
      showToast('Settings saved', 'info', 3000);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  // ---- opening, closing, focus ----
  const close = () => {
    if (dirty) showToast('Your unsaved changes are kept until you save or discard them.', 'info', 4000);
    setMenu(null, false);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const dlg = ref.current!;
    if (!dlg.open) dlg.showModal();
    const place = () => {
      const t = document.getElementById(MENU_TRIGGER_ID)?.getBoundingClientRect();
      const top = Math.max(8, Math.round(t ? t.bottom + 6 : 56));
      const left = Math.max(8, Math.round(t ? Math.min(t.left, window.innerWidth - dlg.offsetWidth - 8) : 12));
      dlg.style.top = `${top}px`;
      dlg.style.left = `${left}px`;
      dlg.style.setProperty('--wsm-top', `${top}px`);
    };
    place();
    window.addEventListener('resize', place);
    document.getElementById(`${navId}-${target.section}`)?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    // The browser may close a dialog on its own (Esc pressed twice quickly): follow it.
    const onClose = () => { if (new URLSearchParams(location.search).has('menu')) closeRef.current(); };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    return () => {
      window.removeEventListener('resize', place);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      document.getElementById(MENU_TRIGGER_ID)?.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A new section starts at its top.
  useEffect(() => { paneRef.current?.scrollTo?.({ top: 0 }); }, [target.section]);

  const select = (id: SectionId, focus = true) => {
    setMenu(menuValue(id, sectionById(id)?.tabs?.[0]?.id ?? null), true);
    if (focus) requestAnimationFrame(() => document.getElementById(`${navId}-${id}`)?.focus());
  };
  /** Into the pane: its first control, else the pane itself. */
  const enterPane = () => {
    const pane = paneRef.current;
    if (!pane) return;
    const first = pane.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex="0"]');
    (first ?? pane).focus();
  };
  const onNavKey = (e: KeyboardEvent) => {
    const next = stepSection(sections, target.section, e.key);
    if (next) { e.preventDefault(); select(next); return; }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); enterPane(); }
  };
  const openFull = (href: string) => {
    if (href.startsWith('?')) {
      const q = new URLSearchParams(location.search);
      q.delete('menu');
      for (const [k, v] of new URLSearchParams(href.slice(1))) q.set(k, v);
      navigate(`${location.pathname}?${q}`);
    } else navigate(href);
  };
  const full = FULL_PAGE[target.section]?.(target.tab) ?? null;
  const tabTo = (t: string) => setMenu(menuValue(target.section, t), true);
  const wikiProject = loc.route.name.startsWith('wiki') && 'projectSeq' in loc.route
    ? [...store.get().projects.values()].find((p) => p.seq === (loc.route as { projectSeq: number }).projectSeq)?.id ?? null : null;

  let body: ReactNode;
  switch (target.section) {
    case 'workspace': body = <WorkspaceForm f={form} />; break;
    case 'guides': body = <GuidesSection />; break;
    case 'features': body = <FeaturesForm f={form} />; break;
    case 'tasks': body = <TasksForm f={form} />; break;
    case 'calendar': body = <CalendarForm f={form} />; break;
    case 'types': body = <TypesSection initialProjectId={wikiProject} onFullPage={openFull} />; break;
    case 'files': body = <FilesSection />; break;
    case 'members': body = <MembersPanel />; break;
    case 'public': body = <PublicSection />; break;
    case 'connections': body = <SubTabs section="connections" tab={target.tab} onTab={tabTo}><ConnectionsBody tab={target.tab} /></SubTabs>; break;
    case 'look': body = <LookSection />; break;
    case 'import': body = <SubTabs section="import" tab={target.tab} onTab={tabTo}><ImportBody tab={target.tab} /></SubTabs>; break;
    case 'export': body = <ExportSection />; break;
    case 'billing': body = <BillingSettings />; break;
    case 'preferences': body = <SubTabs section="preferences" tab={target.tab} onTab={tabTo}><PreferencesBody tab={target.tab} /></SubTabs>; break;
    case 'archive': body = <ArchiveSection />; break;
    case 'disable': body = <DangerZone />; break;
  }

  const navItem = (s: SectionDef) => (
    <button key={s.id} id={`${navId}-${s.id}`} type="button" role="tab" aria-selected={s.id === target.section} aria-controls={`${navId}-pane`}
      tabIndex={s.id === target.section ? 0 : -1} className={s.id === target.section ? 'wsm-nav-item on' : 'wsm-nav-item'} title={s.label}
      onClick={() => select(s.id, false)}>
      <Icon name={s.icon as IconName} size={17} />
      <span className="wsm-nav-label">{s.label}</span>
    </button>
  );

  return (
    <dialog ref={ref} className="wsm" aria-label="Workspace menu" data-testid="workspace-menu"
      onMouseDown={(e) => { if (e.target === ref.current) close(); }}>
      <div className="wsm-frame">
        <div role="tablist" aria-orientation="vertical" aria-label="Sections" className="wsm-nav" onKeyDown={onNavKey}>
          <div className="wsm-nav-head" aria-hidden>
            <span className="wsm-nav-pic">{account?.settings?.coverArt ? <ArtworkSvg id={account.settings.coverArt} /> : (account?.name ?? '?').slice(0, 1).toUpperCase()}</span>
            <span className="wsm-nav-label wsm-ellipsis">{account?.name}</span>
          </div>
          {sections.filter((s) => !s.bottom).map(navItem)}
          <div className="wsm-nav-gap" aria-hidden />
          {sections.filter((s) => s.bottom).map(navItem)}
        </div>
        <div className="wsm-main">
          <header className="wsm-head">
            <div className="wsm-head-text">
              <h2 className="wsm-title">{section.label}</h2>
              <p className="wsm-help">{section.blurb}</p>
            </div>
            {full && <button type="button" className="btn btn-sm btn-ghost wsm-full-btn" onClick={() => openFull(full)}>Open full page</button>}
            <button type="button" className="icon-btn" aria-label="Close" onClick={close}><Icon name="close" /></button>
          </header>
          <div ref={paneRef} role="tabpanel" id={`${navId}-pane`} aria-labelledby={`${navId}-${target.section}`} tabIndex={-1} className="wsm-pane"
            data-testid="workspace-menu-pane">
            {FORM_SECTIONS.has(target.section)
              ? <form className="wsm-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>{body}</form>
              : body}
          </div>
          {dirty && (
            <footer className="wsm-foot" role="group" aria-label="Unsaved changes">
              <span className="wsm-foot-text">You have unsaved changes.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={discard}>Discard</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save changes</button>
            </footer>
          )}
        </div>
      </div>
    </dialog>
  );
}
