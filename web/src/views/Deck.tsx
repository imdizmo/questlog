import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Card, Deck as DeckRow, DeckType } from '../../../shared/types';
import { derivedStatus, seqFromCode, titleOf } from '../../../shared/cards';
import { groupCards, normalizeView, type DeckView, type OrderCtx, type ViewFeatures } from '../../../shared/order';
import { compileSearch, type SearchToken } from '../../../shared/search';
import { addChip, setChips, useChips } from '../search';
import { priorityLabel } from '../../../shared/properties';
import { dispatch } from '../api';
import { canEditContent, canManageProject, GUARDIAN_TIP, guardedAgainstMe, settingsOf, useStore } from '../store';
import { Link, navigate, setQuery, useLocation } from '../router';
import { spaceLabel } from '../spaces';
import { deckPath, keepSearch, deckStats, deleteDeckNote, localToday, openByCard, priorityName } from '../cards';
import { PriorityMark } from '../components/PriorityButtons';
import { DeckTypeIcon, DECK_TYPE_LABEL, Icon } from '../components/icons';
import { CardTile } from '../components/CardTile';
import { BulkBar, GroupSelect } from '../components/BulkBar';
import { clearSelection, pruneSelection } from '../selection';
import { CardTable, GroupFilterButton, groupStatsText } from '../components/CardTable';
import { OrderPanel } from '../components/OrderPanel';
import { PublicLink } from '../components/PublicLink';
import { usePublicDeck } from '../openDecks';
import { NOT_TAGGED, TagPanel, type TagCount } from '../components/TagPanel';
import { readArchived, readView, sameView, writeArchived, writeView } from './deckView';
import { segMs, trackingOn } from '../timeTracking';
import { AddCardPanel, Toggle } from '../components/AddCardPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeckDialog } from '../components/DeckDialog';
import { DeckTypeDialog } from '../components/DeckTypeDialog';
import { AutomationsDialog } from '../components/AutomationsDialog';
import { GuardiansDialog } from '../components/GuardiansDialog';
import { JourneyDialog } from '../components/JourneyDialog';
import { heroEffort } from '../../../shared/properties';
import { LatestActivity } from '../components/LatestActivity';
import { CardView, shortcutTarget } from './Card';
import { keysOf } from '../shortcuts';
import { InPane, keysHere, usePageNavigate } from './HomePane';
import { useShownTitle } from '../translate';

type Dialogs = 'type' | 'rename' | 'delete' | 'automations' | 'guardians' | 'journey' | null;
type StepKey = 'todo' | 'started' | 'review' | 'done';
const STEPS: { key: StepKey; label: string }[] = [{ key: 'todo', label: 'To do' }, { key: 'started', label: 'Started' }, { key: 'review', label: 'Review' }, { key: 'done', label: 'Done' }];

/** Deck page; with `cardCode` the card opens beside the list. */
export function Deck({ seq, cardCode }: { seq: number; cardCode?: string }) {
  const deck = useStore((s) => [...s.decks.values()].find((d) => d.seq === seq));

  useEffect(() => {
    if (!deck || cardCode) return; // the card view keeps card URLs canonical
    const want = deckPath(deck);
    if (location.pathname !== want) navigate(want + location.search, { replace: true });
  }, [deck?.seq, deck?.title, cardCode]);

  if (!deck) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/decks">← Lists</Link></p><h1>List not found</h1></div></div>
        <p className="muted">It may have been deleted, or you don't have access to its project.</p>
      </main>
    );
  }
  return <DeckPage key={deck.id} deck={deck} cardCode={cardCode} />;
}

function DeckPage({ deck, cardCode }: { deck: DeckRow; cardCode?: string }) {
  const shownTitle = useShownTitle();
  const go = usePageNavigate(); // in the pane beside Home, it stays there
  const s = useStore((x) => x);
  const loc = useLocation();
  const project = s.projects.get(deck.projectId);
  const editable = project ? canEditContent(s, project) : false;
  const [dialog, setDialog] = useState<Dialogs>(null);
  const canManage = project ? canManageProject(s, project) : false;
  const subscribed = s.deckSubscriptions.has(`${s.me?.id}|${deck.id}`);
  const publicDeck = usePublicDeck(deck.projectId);
  const guarded = guardedAgainstMe(s, deck);
  const guardiansOn = deck.guardiansEnabled && [...s.deckGuardians.values()].some((g) => g.deckId === deck.id);
  const subscribe = () => {
    if (!s.me) return;
    void dispatch('watchings', subscribed ? 'removeDeck' : 'addDeck', { deckId: deck.id, userId: s.me.id }).catch(() => {});
  };
  const [mine, setMine] = useState(false);
  /** The open task takes the whole page instead of the side panel. */
  const [wide, setWide] = useState(false);
  /** Board (four step columns) or the grouped tiles; kept per browser. The table is the view's own mode. */
  const [shape, setShapeState] = useState<'board' | 'groups'>(() => { try { return localStorage.getItem('ql.listShape') === 'groups' ? 'groups' : 'board'; } catch { return 'board'; } });
  /** The less used deck actions (subscribe, reviewers, archived, automations, delete) sit behind More. */
  const [more, setMore] = useState(false);
  const [withArchived, setWithArchivedState] = useState(readArchived);
  const setWithArchived = (b: boolean) => { setWithArchivedState(b); writeArchived(b); };
  const [local, setLocal] = useState<DeckView | null>(() => readView(deck.id));
  // Tag selection lives in component state, per deck.
  const [tagSel, setTagSel] = useState<Record<string, { keys: string[]; any: boolean }>>({});
  const { keys: tagKeys, any: tagAny } = tagSel[deck.id] ?? { keys: [], any: false };
  const setTagFilter = (f: { keys: string[]; any: boolean }) => setTagSel((m) => ({ ...m, [deck.id]: f }));
  useEffect(() => { setLocal(readView(deck.id)); setSaved(null); }, [deck.id]);
  // After Save the local view stays on screen until the live deck update carries the same order.
  const [saved, setSaved] = useState<DeckView | null>(null);

  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  const deckCards = useMemo(() => [...s.cards.values()].filter((c) => c.deckId === deck.id), [s.cards, deck.id]);
  const live = deckCards.filter((c) => c.visibility === 'default');
  // Filter order: visibility, My Cards, tags, chips, then grouping.
  const visible = deckCards.filter((c) => c.visibility === 'default' || (withArchived && c.visibility === 'archived'));
  const settings = settingsOf(s);
  const features: ViewFeatures = {
    milestonesEnabled: settings.milestonesEnabled, sprintsEnabled: settings.sprintsEnabled,
    dueDateEnabled: settings.dueDateEnabled, timeTrackingOn: trackingOn(s),
  };
  const view = normalizeView(local ?? deck.preferredOrder, features);
  const storedView = normalizeView(deck.preferredOrder, features);
  useEffect(() => {
    if (saved && sameView(storedView, saved)) { setLocal(null); setSaved(null); }
  }, [deck.preferredOrder, saved]);
  const changeView = (v: DeckView) => { setSaved(null); setLocal(v); writeView(deck.id, v); };

  const isDone = (c: Card) => derivedStatus(c, open.get(c.id) ?? new Set()) === 'done';
  const workflow = live.filter((c) => !c.isDoc);
  const doneCount = workflow.filter(isDone).length;
  const pct = workflow.length ? Math.round((doneCount / workflow.length) * 100) : 0;
  const stats = deckStats(live, isDone, settings);
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  const myTags = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of s.userCardTags.values()) {
      if (t.userId !== s.me?.id) continue;
      const l = m.get(t.cardId);
      if (l) l.push(t.tag); else m.set(t.cardId, [t.tag]);
    }
    return m;
  }, [s.userCardTags, s.me?.id]);

  const projectTagsOf = (c: Card) => [...new Set([...c.tags, ...c.masterTags])];
  const tagKeysOf = (c: Card): string[] => {
    const keys = [...projectTagsOf(c).map((t) => `project:${t}`), ...(myTags.get(c.id) ?? []).map((t) => `personal:${t}`)];
    return keys.length ? keys : [NOT_TAGGED];
  };
  const tagPanel = useMemo(() => {
    const count = (key: string, m: Map<string, TagCount>, name: string) => {
      const e = m.get(name);
      if (e) e.count += 1; else m.set(name, { key, name, count: 1 });
    };
    const project = new Map<string, TagCount>(), personal = new Map<string, TagCount>();
    let notTagged = 0;
    for (const c of visible) {
      const pt = projectTagsOf(c), mt = myTags.get(c.id) ?? [];
      if (!pt.length && !mt.length) notTagged += 1;
      for (const t of pt) count(`project:${t}`, project, t);
      for (const t of new Set(mt)) count(`personal:${t}`, personal, t);
    }
    const sorted = (m: Map<string, TagCount>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { project: sorted(project), personal: sorted(personal), notTagged };
  }, [visible, myTags]);

  const selectedSeq = cardCode ? seqFromCode(cardCode) : null;
  const selected = selectedSeq !== null ? deckCards.find((c) => c.seq === selectedSeq)?.id : undefined;
  const section = project?.spaces.find((sp) => sp.id === deck.spaceId);
  const panelOpen = loc.query.get('panel') === 'add-card' && editable;
  const orderOpen = loc.query.get('panel') === 'sort';
  const tagsOpen = loc.query.get('panel') === 'tags';
  // `o` and `t` toggle the Order and Tag panels.
  const panelKeys = useRef({ orderOpen, tagsOpen });
  panelKeys.current = { orderOpen, tagsOpen };
  const inPane = useContext(InPane);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = e.key === keysOf('deck.order') ? 'sort' : e.key === keysOf('deck.tags') ? 'tags' : null;
      if (!panel || !shortcutTarget(e) || !keysHere(e, inPane)) return;
      e.preventDefault();
      const open = panel === 'sort' ? panelKeys.current.orderOpen : panelKeys.current.tagsOpen;
      setQuery('panel', open ? null : panel);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPane]);

  const titleOfCard = (id: string) => { const p = s.cards.get(id); return p ? shownTitle(p) : undefined; };
  // Heroes are cards with at least one sub card (the store holds no deleted cards).
  const kidsOf = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const c of s.cards.values()) {
      if (!c.parentCardId) continue;
      const l = m.get(c.parentCardId);
      if (l) l.push(c); else m.set(c.parentCardId, [c]);
    }
    return m;
  }, [s.cards]);
  const heroOf = (c: Card) => {
    const kids = kidsOf.get(c.id);
    return kids?.length ? { subCount: kids.length, effort: heroEffort(c, kids, settings) } : undefined;
  };
  const timeTotals = useMemo(() => {
    const m = new Map<string, number>();
    const now = Date.now();
    for (const t of s.timeSegments.values()) m.set(t.cardId, (m.get(t.cardId) ?? 0) + segMs(t, now));
    return m;
  }, [s.timeSegments]);
  const unseen = useMemo(() => {
    const cardIds = new Set<string>();
    for (const n of s.notifications.values()) {
      if (n.userId !== s.me?.id || n.unseenEntryCount <= 0) continue;
      const r = s.resolvables.get(n.resolvableId);
      if (r) cardIds.add(r.cardId);
    }
    return cardIds;
  }, [s.notifications, s.resolvables, s.me?.id]);
  const sprintList = useMemo(() => [...s.sprints.values()].sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr), [s.sprints]);
  const milestoneList = useMemo(() => [...s.milestones.values()].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.accountSeq - b.accountSeq), [s.milestones]);
  const today = localToday();
  const orderCtx: OrderCtx = {
    users: [...s.users.values()], milestones: milestoneList, sprints: sprintList,
    isDone, status: (c) => derivedStatus(c, open.get(c.id) ?? new Set()),
    hasOpenNotification: (id) => unseen.has(id), timeTotal: (id) => timeTotals.get(id) ?? 0,
    subCount: (id) => kidsOf.get(id)?.length ?? 0, personalTags: (id) => myTags.get(id) ?? [],
    fallbackEffort: settings.fallbackEffort, priorityLabel: (p) => priorityLabel(p, settings),
    currentSprintStart: (configId) => {
      const cur = sprintList.find((x) => x.configId === configId && !x.isFinished && x.startDay <= today && today <= x.endDay);
      return cur ? new Date(`${cur.startDay}T00:00:00`).getTime() : null;
    },
  };
  // Chips live in ?search= and show in the top bar search box; group headers add to them.
  const chips = useChips();
  const byMine = mine ? visible.filter((c) => c.assigneeId === s.me?.id) : visible;
  const byTags = tagKeys.length
    ? byMine.filter((c) => {
      const have = tagKeysOf(c);
      return tagAny ? tagKeys.some((k) => have.includes(k)) : tagKeys.every((k) => have.includes(k));
    })
    : byMine;
  const filtered = chips.tokens.length
    ? byTags.filter(compileSearch(chips.tokens, chips.forceOr, {
      status: orderCtx.status, personalTags: orderCtx.personalTags, subCount: orderCtx.subCount, todayDay: today, sprints: sprintList, now: Date.now(),
    }))
    : byTags;
  const hidden = visible.length - filtered.length;
  const clearFilters = () => { setMine(false); setTagFilter({ keys: [], any: tagAny }); if (chips.tokens.length) setChips({ tokens: [], forceOr: false }); };
  const groups = groupCards(filtered, view, orderCtx);
  const setShape = (x: 'board' | 'groups') => {
    setShapeState(x);
    try { localStorage.setItem('ql.listShape', x); } catch { /* private window */ }
    if (view.mode === 'tableView') changeView({ ...view, mode: 'miniCard' });
  };
  /** The board's column of a task: blocked stays in the step it was in, with its red mark. */
  const stepOf = (c: Card): StepKey | null => {
    const d = orderCtx.status(c);
    if (d === null) return null;
    if (d === 'done' || d === 'review') return d;
    return d === 'started' || d === 'snoozing' || (d === 'blocked' && c.status === 'started') ? 'started' : 'todo';
  };
  const ordered = groups.flatMap((g) => g.cards);
  const lore = ordered.filter((c) => stepOf(c) === null);
  const addFilter = (t: SearchToken) => addChip(chips, t);
  const order = groups.flatMap((g) => g.cards.map((c) => c.id));
  // The selection follows the list: leaving the deck clears it, and cards that drop out (archived, filtered) leave it.
  useEffect(() => clearSelection, [deck.id]);
  const orderKey = order.join(',');
  useEffect(() => { pruneSelection(new Set(order)); }, [orderKey]);
  const automated = !!deck.autoTag || !!deck.defaultCardId;
  const tile = (c: Card) => (
    <li key={c.id}>
      <CardTile card={c} deck={deck} open={open.get(c.id) ?? new Set()}
        owner={c.assigneeId ? s.users.get(c.assigneeId) : undefined} selected={c.id === selected}
        settings={settings} projectTags={project?.tags} personalTags={myTags.get(c.id)}
        parentTitle={c.parentCardId ? titleOfCard(c.parentCardId) : undefined} hero={heroOf(c)} compact={view.isCompact} selectOrder={editable ? order : undefined} />
    </li>
  );

  return (
    <main className={cardCode ? `page page-wide deck-layout with-card${wide ? ' card-wide' : ''}` : 'page deck-layout'} id="main">
      <div className="deck-main">
        <div className="page-head deck-head">
          <div className="deck-head-text">
            <p className="eyebrow">
              <Link href="/decks">Lists</Link>
              {project && <> / {project.name} – {section ? spaceLabel(section) : ''}</>}
            </p>
            <div className="deck-title-row">
              <button type="button" className="btn btn-ghost type-btn" disabled={!editable}
                aria-label={`List type: ${DECK_TYPE_LABEL[deck.deckType]}`} title="Change list type" onClick={() => setDialog('type')}>
                <DeckTypeIcon type={deck.deckType} size={16} />
                <span>{DECK_TYPE_LABEL[deck.deckType].replace(/ list$/, '')}</span>
              </button>
              <h1>{deck.title}</h1>
              <PublicLink projectId={deck.projectId} path={`/deck/${deck.seq}`} what="deck" />
              {editable && (
                <button type="button" className="icon-btn" aria-label="Rename list" title="Rename list" onClick={() => setDialog('rename')}>
                  <Icon name="edit" />
                </button>
              )}
            </div>
          </div>
          <div className="deck-actions">
            <div className="view-seg" role="group" aria-label="View">
              <button type="button" aria-pressed={view.mode !== 'tableView' && shape === 'board'} onClick={() => setShape('board')}>Board</button>
              <button type="button" aria-pressed={view.mode !== 'tableView' && shape === 'groups'} onClick={() => setShape('groups')}>Groups</button>
              <button type="button" aria-pressed={view.mode === 'tableView'} onClick={() => changeView({ ...view, mode: 'tableView' })}>Table</button>
            </div>
            <button type="button" className={orderOpen ? 'btn btn-active' : 'btn'} aria-label="Order" aria-pressed={orderOpen} aria-keyshortcuts={keysOf('deck.order')} title="Order and group tasks"
              onClick={() => setQuery('panel', orderOpen ? null : 'sort')}>
              <Icon name="sort" size={16} /> Order
            </button>
            <button type="button" className={tagsOpen || tagKeys.length ? 'btn btn-active' : 'btn'} aria-label="Tags" aria-pressed={tagsOpen} aria-keyshortcuts={keysOf('deck.tags')}
              title="Filter by tags" onClick={() => setQuery('panel', tagsOpen ? null : 'tags')}>
              # Tags
            </button>
            <button type="button" className={mine ? 'btn btn-active' : 'btn'} aria-pressed={mine} onClick={() => setMine((m) => !m)}>
              <Icon name="user" size={16} /> My tasks
            </button>
            <button type="button" className={more || subscribed || guardiansOn || withArchived || automated ? 'btn btn-active' : 'btn'} aria-label="More list options" aria-expanded={more}
              title="Subscribe, reviewers, archived tasks, automations, delete" onClick={() => setMore((m) => !m)}>
              <Icon name="more" size={16} /> More
            </button>
            {editable && <button type="button" className="btn btn-primary" onClick={() => setQuery('panel', 'add-card')}><Icon name="plus" /> Add task</button>}
          </div>
          {more && (
            <div className="deck-actions deck-more" role="group" aria-label="More list options">
            <button type="button" className={subscribed ? 'btn btn-active' : 'btn'} onClick={subscribe}
              title={subscribed ? 'Stop getting notified about new tasks in this list' : 'Get notified about new tasks in this list'}>
              <Icon name="bell" size={16} /> {subscribed ? 'Unsubscribe' : 'Subscribe'}
            </button>
            {canManage && (
              <button type="button" className={guardiansOn ? 'btn btn-active' : 'btn'} onClick={() => setDialog('guardians')}>
                <Icon name="shield" size={16} /> Reviewers
              </button>
            )}
            {settingsOf(s).workflowMode === 'journeys' && (
              <button type="button" className={s.journeys.has(deck.id) ? 'btn btn-active' : 'btn'} onClick={() => setDialog('journey')}>Task chain</button>
            )}
            <Toggle label="Include archived tasks" checked={withArchived} onChange={setWithArchived} />
            {editable && (
              <>
                <button type="button" className={automated ? 'btn btn-active' : 'btn'} aria-label="Automations"
                  title={automated ? 'Automations are on for this list' : 'List automations'} onClick={() => setDialog('automations')}>
                  <Icon name="gear" size={16} /> Automations
                </button>
                <button type="button" className="icon-btn" aria-label="Delete list" title={guarded ? GUARDIAN_TIP : 'Delete list'} disabled={guarded} onClick={() => setDialog('delete')}><Icon name="trash" /></button>
              </>
            )}
            </div>
          )}
        </div>

        {orderOpen && (
          <OrderPanel view={view} features={features} atDefault={sameView(view, storedView)} canSave={editable}
            onChange={changeView}
            onReset={() => { writeView(deck.id, null); setLocal(null); }}
            onSave={() => { void dispatch('decks', 'update', { id: deck.id, preferredOrder: view }).then(() => { writeView(deck.id, null); setSaved(view); }).catch(() => {}); }}
            visitors={publicDeck && canManage ? {
              isDefault: !!deck.publicOrder && sameView(view, normalizeView(deck.publicOrder, features)),
              onSet: () => { void dispatch('decks', 'update', { id: deck.id, publicOrder: view }).catch(() => {}); },
            } : undefined}
            onClose={() => setQuery('panel', null)} />
        )}

        {tagsOpen && (
          <TagPanel {...tagPanel} selected={tagKeys} any={tagAny} onClose={() => setQuery('panel', null)}
            onMode={(any) => setTagFilter({ keys: tagKeys, any })}
            onToggle={(k) => setTagFilter({ keys: tagKeys.includes(k) ? tagKeys.filter((x) => x !== k) : [...tagKeys, k], any: tagAny })} />
        )}

        {visible.length === 0 ? (
          <div className="empty">
            <h2>No tasks yet</h2>
            <p>{editable ? 'Add the first task.' : 'Nothing here yet.'}</p>
          </div>
        ) : (
          <>
            {hidden > 0 && (
              <p className="hint filter-note" role="status">
                Your filters hide {hidden} {hidden === 1 ? 'task' : 'tasks'}{' '}
                <button type="button" className="btn btn-ghost" onClick={clearFilters}>Clear filters</button>
              </p>
            )}
            {view.mode === 'tableView' ? (
              <CardTable groups={groups} deck={deck} settings={settings} sprints={s.sprints} milestones={s.milestones} users={s.users}
                projectTags={project?.tags} open={open} timeOf={features.timeTrackingOn ? (id) => timeTotals.get(id) ?? 0 : null}
                selected={selected} selectable={editable} onFilter={addFilter} />
            ) : shape === 'board' ? (
              <>
                <div className="step-board" data-testid="step-board">
                  {STEPS.map((st) => {
                    const cs = ordered.filter((c) => stepOf(c) === st.key);
                    return (
                      <section key={st.key} className={`step-col step-${st.key}`} aria-label={st.label}>
                        <div className="step-head"><span className="step-dot" aria-hidden /><h3>{st.label}</h3><span className="group-stats" data-testid="step-count">{cs.length}</span></div>
                        <ul className="card-list" aria-label={`${st.label} tasks`}>{cs.map(tile)}</ul>
                        {cs.length === 0 && <p className="muted step-empty">Nothing here.</p>}
                      </section>
                    );
                  })}
                </div>
                {lore.length > 0 && (
                  <section className="card-group doc-group" aria-label="Lore">
                    <div className="group-bar"><h3 className="group-head">Lore</h3><span className="group-stats">{lore.length}</span></div>
                    <ul className="card-list" aria-label="Lore tasks">{lore.map(tile)}</ul>
                  </section>
                )}
              </>
            ) : groups.map((g) => {
              const prio = g.key.startsWith('priority:') ? g.key.slice(9) : null;
              return (
                <section key={g.key} className="card-group" aria-label={g.label}>
                  <div className="group-bar">
                    {editable && <GroupSelect label={g.label} ids={g.cards.map((c) => c.id)} />}
                    <GroupFilterButton group={g} onFilter={addFilter} />
                    <h3 className={`group-head${prio ? ` prio-head ${prio === 'none' ? 'prio-head-none' : `prio-${prio}`}` : ''}`}>{g.label}</h3>
                    <span className="group-stats" data-testid="group-stats">{groupStatsText(g, settings.effortEnabled)}</span>
                  </div>
                  <ul className="card-list" aria-label={`${g.label} tasks`}>{g.cards.map(tile)}</ul>
                </section>
              );
            })}
          </>
        )}

        {editable && <BulkBar cards={s.cards} />}

        <LatestActivity key={deck.id} deckId={deck.id} href={`${deckPath(deck)}/activity`} />

        <footer className="deck-foot" aria-label="List summary">
          <ul className="prio-stats" aria-label="Tasks by priority">
            {stats.byPriority.map((r) => (
              <li key={r.priority ?? 'none'} className={r.total ? '' : 'muted'}>
                {r.priority ? <PriorityMark priority={r.priority} /> : <span className="prio-none" aria-hidden />}
                <span className="prio-stat-name">{priorityName(r.priority, settings)}</span>
                <span className="prio-stat-num">{r.done}/{r.total}</span>
              </li>
            ))}
          </ul>
          <div className="deck-totals">
            <span>{live.length} {live.length === 1 ? 'task' : 'tasks'}</span>
            {settings.effortEnabled && (
              <span data-testid="deck-effort" title={`Done effort / total effort. Tasks without effort count as ${settings.fallbackEffort}.`}>
                Effort {fmt(stats.effortDone)} / {fmt(stats.effortTotal)}
              </span>
            )}
            <span>{pct}% done</span>
          </div>
        </footer>
      </div>

      {cardCode && (
        <aside className="card-panel" aria-label="Open task">
          <button type="button" className="icon-btn panel-wide" aria-pressed={wide} aria-label={wide ? 'Shrink to a side panel' : 'Expand to the full page'} title={wide ? 'Shrink to a side panel' : 'Expand to the full page'}
            onClick={() => setWide((w) => !w)}>{wide ? '⇥' : '⤢'}</button>
          <Link href={keepSearch(deckPath(deck))} className="icon-btn panel-close" aria-label="Close task"><Icon name="close" /></Link>
          <CardView code={cardCode} inDeck />
        </aside>
      )}

      {panelOpen && <AddCardPanel deckId={deck.id} onClose={() => setQuery('panel', null)} />}
      {dialog === 'type' && (
        <DeckTypeDialog current={deck.deckType} onClose={() => setDialog(null)}
          onSubmit={(deckType: DeckType) => dispatch('decks', 'update', { id: deck.id, deckType }).then(() => {})} />
      )}
      {dialog === 'journey' && <JourneyDialog deck={deck} onClose={() => setDialog(null)} />}
      {dialog === 'guardians' && <GuardiansDialog deck={deck} onClose={() => setDialog(null)} />}
      {dialog === 'automations' && <AutomationsDialog deck={deck} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && (
        <DeckDialog projectId={deck.projectId} initialTitle={deck.title} initialCover={deck.cover} onClose={() => setDialog(null)}
          onSubmit={(title, cover) => dispatch('decks', 'update', { id: deck.id, title, ...cover }).then(() => {})} />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title="Delete list?" confirmLabel="Delete list" danger onClose={() => setDialog(null)}
          onConfirm={async () => { await dispatch('decks', 'delete', { id: deck.id }); go('/decks'); }}>
          <p>
            <strong>{deck.title}</strong> will be removed. {deleteDeckNote(deckCards.length)}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}
