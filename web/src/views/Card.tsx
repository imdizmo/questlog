import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card, Deck, Reaction, Resolvable, ResolvableContext, ResolvableEntry } from '../../../shared/types';
import { InlineTitle } from '../components/InlineTitle';
import { allowedActions, cardCode, derivedStatus, seqFromCode, STATUS_LABEL, titleOf } from '../../../shared/cards';
import { api, ApiError, dispatch } from '../api';
import { canEditCard, GUARDIAN_TIP, guardedAgainstMe, planAllows, settingsOf, useStore } from '../store';
import { Link, navigate, useLocation } from '../router';
import { useMinuteClock } from '../clock';
import { cardHref, copyText, deckPath, wordCount } from '../cards';
import { showToast } from '../toast';
import { Icon } from '../components/icons';
import { PublicLink, UpvoteButton } from '../components/PublicLink';
import { Menu, type MenuItem } from '../components/Menu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ThreadComposer } from '../components/ThreadComposer';
import { ThreadView } from '../components/ThreadView';
import { HistoryTab } from '../components/HistoryTab';
import { QuickBar } from '../components/QuickBar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { Editor } from '../components/Editor';
import { MarkdownView } from '../components/MarkdownView';
import { queueContentSave } from '../contentSave';
import { setCheckLine, splitTitle } from '../markdown';
import { SubCardsTab } from '../components/SubCardsTab';
import { AttachmentsTab, fileUrl } from '../components/AttachmentsTab';
import { DependencyBadge } from '../components/DependenciesPopover';
import { setBookmark } from '../hand';
import { myRunning, startTimer, stopTimer, trackingOn } from '../timeTracking';
import { heroEffort } from '../../../shared/properties';
import { keysOf } from '../shortcuts';
import { childrenOf, subCountLabel, unfinishedLockers } from '../relations';
import { boardOfCard, boardPath, createBoard } from '../board/boards';
import { entryPath } from '../wiki';
import { WorksOnRow } from '../components/wiki/LinksSection';

type SideTab = 'conversations' | 'history' | 'properties' | 'subcards' | 'attachments';
const SIDE_TABS: SideTab[] = ['conversations', 'history', 'properties', 'subcards', 'attachments'];
/** Single-key shortcuts that open (and close again) a side tab. */
const TAB_KEYS: Record<string, SideTab> = {
  [keysOf('card.properties')]: 'properties',
  [keysOf('card.subcards')]: 'subcards',
  [keysOf('card.conversations')]: 'conversations',
};
const TAB_KEY = 'jt:cardSideTab';

/** The side tab last chosen in this browser (Properties stays open across cards and reloads). */
function readSideTab(): SideTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return SIDE_TABS.includes(v as SideTab) ? (v as SideTab) : 'conversations';
  } catch { return 'conversations'; }
}
function writeSideTab(t: SideTab) {
  try { localStorage.setItem(TAB_KEY, t); } catch { /* storage blocked: the tab just won't be remembered */ }
}

/** Single-key shortcuts only fire when the person isn't typing and no dialog is open. */
export function shortcutTarget(e: globalThis.KeyboardEvent, allowAlt = false): boolean {
  if (e.ctrlKey || e.metaKey || (e.altKey && !allowAlt) || e.repeat) return false;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
  return !document.querySelector('dialog[open]');
}

interface Remote { card: Card; deck: Deck | null; resolvables: Resolvable[]; entries: ResolvableEntry[] }

/**
 * The card for a URL code. Live cards come from the store; deleted ones (which the snapshot
 * leaves out) and cards not yet pushed over the socket are fetched by seq.
 */
function useCardByCode(code: string) {
  const seq = seqFromCode(code);
  const cards = useStore((s) => s.cards);
  const local = useMemo(() => (seq === null ? undefined : [...cards.values()].find((c) => c.seq === seq)), [cards, seq]);
  // Tagged with the seq it was fetched for, so a previous card never shows under a new URL.
  const [remote, setRemote] = useState<{ seq: number; data: Remote | 'missing' } | null>(null);

  useEffect(() => {
    setRemote(null);
    if (local || seq === null) return;
    let alive = true;
    api.card(seq)
      .then((r) => { if (alive) setRemote({ seq, data: r }); })
      .catch(() => { if (alive) setRemote({ seq, data: 'missing' }); });
    return () => { alive = false; };
  }, [seq, local]);

  if (seq === null) return { card: null, remote: null, missing: true };
  if (local) return { card: local, remote: null, missing: false };
  const data = remote?.seq === seq ? remote.data : null;
  if (data === 'missing') return { card: null, remote: null, missing: true };
  return { card: data?.card ?? null, remote: data, missing: false };
}

type Dialogs = { kind: 'compose'; context: ResolvableContext } | { kind: 'delete' } | { kind: 'startLocked'; count: number } | null;

/** Card page: workflow buttons, quick bar, text, and the Conversations / History side tabs. */
/** `embedded`: shown in a panel over another page (the vision board), so the URL is left alone. */
export function CardView({ code, inDeck, embedded }: { code: string; inDeck: boolean; embedded?: boolean }) {
  const s = useStore((x) => x);
  const { card, remote, missing } = useCardByCode(code);
  const deck = card?.deckId ? s.decks.get(card.deckId) ?? remote?.deck ?? null : null;

  // Keep the URL canonical: current slug, and the card's current deck when shown inside a deck.
  useEffect(() => {
    if (!card || embedded) return;
    const want = cardHref(card, inDeck ? deck : null);
    if (location.pathname !== want) navigate(want + location.search, { replace: true });
  }, [card?.seq, card?.content, card?.deckId, deck?.seq, deck?.title, inDeck]);

  if (missing) {
    return (
      <article className="card-page" data-testid="card-page">
        <h2>Task not found</h2>
        <p className="muted">It may have been removed, or you don't have access to it.</p>
      </article>
    );
  }
  if (!card) return <article className="card-page" data-testid="card-page" aria-busy="true"><p className="muted">Loading…</p></article>;
  // Keyed by card: switching cards drops any open draft, dialog and its base contentVersion.
  return <CardBody key={card.id} card={card} deck={deck} remote={remote} inDeck={inDeck} />;
}

function CardBody({ card, deck, remote, inDeck }: { card: Card; deck: Deck | null; remote: Remote | null; inDeck: boolean }) {
  const s = useStore((x) => x);
  const titleId = useId();
  const project = deck ? s.projects.get(deck.projectId) : undefined;
  const editable = canEditCard(s, card, project);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [tab, setTabState] = useState<SideTab>(readSideTab);
  const setTab = (t: SideTab) => { setTabState(t); writeSideTab(t); };

  // `z` opens and closes the Properties tab, `s` the Sub cards tab.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const want = TAB_KEYS[e.key];
      if (!want || !shortcutTarget(e)) return;
      e.preventDefault();
      setTabState((cur) => {
        const next = cur === want && want !== 'conversations' ? 'conversations' : want;
        writeSideTab(next);
        return next;
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [closed, setClosed] = useState<{ resolvable: Resolvable; entries: ResolvableEntry[]; reactions: Reaction[] }[]>([]);
  const now = useMinuteClock();
  // The inbox opens threads with ?tab=conversations: show that tab whatever tab was used last, so markSeen runs.
  const wantTab = useLocation().query.get('tab');
  useEffect(() => {
    if (wantTab !== 'conversations') return;
    setTab('conversations');
    navigate(location.pathname, { replace: true });
  }, [wantTab]);

  const threads = useMemo(() => {
    const list = remote ? remote.resolvables : [...s.resolvables.values()];
    return list.filter((r) => r.cardId === card.id && !r.isClosed).sort((a, b) => a.createdAt - b.createdAt);
  }, [remote, s.resolvables, card.id]);
  const watching = s.cardSubscriptions.has(`${s.me?.id}|${card.id}`);
  const bookmarked = s.bookmarks.has(`${s.me?.id}|${card.id}`);
  const guarded = guardedAgainstMe(s, deck);
  const board = boardOfCard(s, card.id);
  // Closed threads are loaded on demand; reloaded when an open one closes while they are shown.
  useEffect(() => {
    if (!showClosed) { setClosed([]); return; }
    let alive = true;
    api.closedThreads(card.id).then((r) => { if (alive) setClosed(r.threads); }).catch(() => { if (alive) setClosed([]); });
    return () => { alive = false; };
  }, [showClosed, card.id, threads.length]);
  // Opening the tab marks the visible threads' unseen messages as seen.
  const seenSent = useRef(new Set<string>());
  useEffect(() => {
    if (tab !== 'conversations') return;
    for (const r of threads) {
      const n = s.notifications.get(`${s.me?.id}|${r.id}`);
      if (!n || n.unseenEntryCount === 0) continue;
      const key = `${r.id}:${n.latestEntryId}`;
      if (seenSent.current.has(key)) continue;
      seenSent.current.add(key);
      void dispatch('resolvables', 'markSeen', { resolvableId: r.id }).catch(() => seenSent.current.delete(key));
    }
  }, [tab, threads, s.notifications, s.me?.id]);
  const reactionsFor = (rid: string) => {
    const ids = new Set(entriesFor(rid).map((e) => e.id));
    return [...s.reactions.values()].filter((x) => ids.has(x.entryId));
  };
  const entriesFor = (rid: string) => (remote ? remote.entries : [...s.entries.values()]).filter((e) => e.resolvableId === rid);
  const open = useMemo(() => new Set(threads.map((t) => t.context)), [threads]);
  const settings = settingsOf(s);
  // A hero is any card with a sub card: no Block/Review; the server sets it done when all its sub cards are done
  // (and back to not started when one isn't); its effort includes the sub cards.
  const children = useMemo(() => childrenOf(s.cards.values(), card.id), [s.cards, card.id]);
  const isHero = children.length > 0;
  const hero = card.parentCardId ? s.cards.get(card.parentCardId) : undefined;
  const fileCount = useMemo(() => [...s.files.values()].filter((f) => f.cardId === card.id).length, [s.files, card.id]);
  const lockers = settings.dependenciesEnabled ? unfinishedLockers(s.cardDeps.values(), s.cards, card.id) : [];
  const a = allowedActions(card, open, { isHero });
  const status = derivedStatus(card, open);
  const deleted = card.visibility === 'deleted';
  const code = cardCode(card.seq);
  const title = titleOf(card.content);

  const update = async (patch: object) => {
    setBusy(true);
    try { await dispatch('cards', 'update', { id: card.id, ...patch }); } catch { /* toast */ } finally { setBusy(false); }
  };

  /** Starting a card that unfinished cards still lock asks first. */
  const start = () => {
    if (lockers.length) setDialog({ kind: 'startLocked', count: lockers.length });
    else void update({ status: 'started' });
  };

  const copyLink = async () => {
    const ok = await copyText(location.origin + cardHref(card, deck));
    showToast(ok ? `Link to ${taskId(card)} copied` : "Couldn't copy the link", ok ? 'info' : 'error', 3000);
  };
  const copyContent = async () => {
    const ok = await copyText(card.content);
    showToast(ok ? 'Task text copied' : "Couldn't copy the text", ok ? 'info' : 'error', 3000);
  };

  // A doc in a doc deck can't become a task card there.
  const taskBlocked = card.isDoc && deck?.deckType === 'doc';
  const more: MenuItem[] = [
    { label: card.isDoc ? 'Turn into task' : 'Turn into lore', disabled: !editable || !a.toggleDoc || taskBlocked, onSelect: () => void update({ isDoc: !card.isDoc }) },
    ...(settings.workflowMode === 'journeys' && deck && s.journeys.has(deck.id) && !card.parentCardId
      ? [{ label: 'Apply task chain', disabled: !editable || card.visibility === 'deleted' || card.isDoc, onSelect: () => void dispatch('journeys', 'apply', { cardId: card.id }).catch(() => {}) }]
      : []),
    { label: 'Copy task text', onSelect: () => void copyContent() },
    {
      label: bookmarked ? 'Remove bookmark' : 'Bookmark',
      onSelect: () => void setBookmark(s.me!.id, card.id, !bookmarked),
    },
    {
      label: watching ? 'Stop watching' : 'Watch task',
      onSelect: () => void dispatch('watchings', watching ? 'removeCard' : 'addCard', { cardId: card.id }).catch(() => {}),
    },
    { label: 'Archive', disabled: !editable || !a.archive || guarded, title: guarded ? GUARDIAN_TIP : undefined, onSelect: () => void update({ visibility: 'archived' }) },
    { label: 'Restore', disabled: !editable || !a.restore, onSelect: () => void update({ visibility: 'default' }) },
    { label: 'Delete', danger: true, disabled: !editable || !a.delete || guarded, title: guarded ? GUARDIAN_TIP : undefined, onSelect: () => setDialog({ kind: 'delete' }) },
  ];
  // Without the plan feature a running timer can still be stopped, but no new one starts.
  const tracking = trackingOn(s) && (planAllows(s, 'timeTracking') || myRunning(s)?.cardId === card.id);
  const myTimer = tracking ? myRunning(s)?.cardId === card.id ? myRunning(s) : undefined : undefined;
  const can = (ok: boolean) => !editable || busy || !ok;

  const Heading = inDeck ? 'h2' : 'h1';
  return (
    <article className={`card-page${inDeck ? ' in-deck' : ''}`} data-testid="card-page" aria-labelledby={titleId}>
      {!inDeck && (
        <p className="eyebrow">
          <Link href="/decks">Lists</Link>
          {deck && <> / <Link href={deckPath(deck)}>{deck.title}</Link></>}
        </p>
      )}
      <div className="card-toolbar">
        {deleted ? (
          editable && (
            <button type="button" className="btn btn-primary" disabled={can(a.restore)} onClick={() => void update({ visibility: 'default' })}>
              <Icon name="restore" size={16} /> Restore
            </button>
          )
        ) : (
          <>
            {/* Read-only viewers (observers, archived projects) get no workflow buttons at all. */}
            {editable && !card.isDoc && (
              <>
                {tracking && !isHero ? (
                  myTimer ? (
                    <button type="button" className="btn btn-active" onClick={() => void stopTimer(myTimer.id)}><Icon name="stop" size={16} /> Stop</button>
                  ) : card.status === 'started' ? (
                    <>
                      <button type="button" className="btn" disabled={can(true)} onClick={() => void startTimer(s.me!.id, card.id)}><Icon name="play" size={16} /> Start Time Tracking</button>
                      <button type="button" className="btn" disabled={can(a.stop)} onClick={() => void update({ status: 'not_started' })}>Unstart Task</button>
                    </>
                  ) : (
                    <button type="button" className="btn" disabled={can(a.start) || lockers.length > 0} onClick={() => void startTimer(s.me!.id, card.id)}
                      title={lockers.length ? 'Locked: unfinished tasks lock this one' : undefined}>
                      <Icon name={lockers.length ? 'lock' : 'play'} size={16} /> Start Task and Tracking
                    </button>
                  )
                ) : a.stop ? (
                  <button type="button" className="btn btn-active" disabled={can(true)} onClick={() => void update({ status: 'not_started' })}><Icon name="stop" size={16} /> Stop</button>
                ) : (
                  <button type="button" className="btn" disabled={can(a.start)} onClick={start}
                    title={lockers.length ? 'Locked: unfinished tasks lock this one' : undefined}>
                    <Icon name={lockers.length ? 'lock' : 'play'} size={16} /> Start
                  </button>
                )}
                {!isHero && (
                  <>
                    <button type="button" className="btn" disabled={can(a.block)} onClick={() => setDialog({ kind: 'compose', context: 'block' })}><Icon name="block" size={16} /> Block</button>
                    <button type="button" className="btn" disabled={can(a.review)} onClick={() => setDialog({ kind: 'compose', context: 'review' })}><Icon name="review" size={16} /> Review</button>
                  </>
                )}
                {card.status === 'done' ? (
                  <button type="button" className="btn btn-done" aria-pressed="true" disabled={can(a.reopen)} onClick={() => void update({ status: 'not_started' })}><Icon name="check" size={16} /> Reopen</button>
                ) : (
                  <button type="button" className="btn" disabled={can(a.done) || guarded} onClick={() => void update({ status: 'done' })}
                    title={guarded ? GUARDIAN_TIP : isHero ? 'A main task is marked done for you once all its subtasks are done, and reopens when one of them isn\'t' : undefined}>
                    <Icon name="check" size={16} /> Mark as done
                  </button>
                )}
              </>
            )}
            {settings.visionBoardEnabled && (board || editable) && (
              <button type="button" className="btn" disabled={busy}
                onClick={() => {
                  if (board) return navigate(boardPath(board.accountSeq));
                  setBusy(true);
                  void createBoard(card).then((seq) => navigate(boardPath(seq))).catch(() => {}).finally(() => setBusy(false));
                }}>
                <Icon name="eye" size={16} /> Board
              </button>
            )}
            <Menu label="More options" trigger={<Icon name="more" />} items={more} />
            <button type="button" className="btn btn-ghost code-btn" aria-label={`Copy link to task ${taskId(card)}`} title="Copy link" onClick={() => void copyLink()}>
              <Icon name="link" size={15} /> {taskId(card)}
            </button>
            {/* Archived and deleted cards are not public (their link would be a 404). */}
            {card.visibility === 'default' && (
              <>
                <PublicLink projectId={deck?.projectId} path={`/card/${code}`} what="card" />
                <UpvoteButton projectId={deck?.projectId} cardId={card.id} />
              </>
            )}
            {watching && <span className="watching-mark" role="img" aria-label="Watching" title="You are watching this task"><Icon name="eye" size={15} /></span>}
            {editable && <button type="button" className="btn" disabled={editing} onClick={() => setEditing(true)}><Icon name="edit" size={16} /> Edit</button>}
          </>
        )}
      </div>

      {deleted && <p className="notice notice-danger">This task is deleted.</p>}
      {card.visibility === 'archived' && <p className="notice">This task is archived. Restore it from More options to put it back in its list.</p>}

      {card.coverFileId && <img className="card-cover" src={fileUrl(card.coverFileId)} alt="" data-testid="card-cover" />}

      <div className="card-head">
        {status && <span className={`status-badge lg status-${status}`} data-testid="card-status">{STATUS_LABEL[status]}</span>}
        {card.isDoc && <span className="badge">Lore</span>}
        {card.isDoc && project && !deleted && (
          <Link href={entryPath(project.seq, card)} className="btn btn-sm btn-ghost"><Icon name="doc" size={14} /> Open in Wiki</Link>
        )}
        {isHero && (
          <button type="button" className="btn btn-sm" onClick={() => setTab('subcards')} aria-keyshortcuts={keysOf('card.subcards')}>
            <Icon name="hero" size={14} /> {subCountLabel(children.length)}
          </button>
        )}
        {hero && (
          <Link href={cardHref(hero, hero.deckId ? s.decks.get(hero.deckId) : undefined)} className="hero-link"
            aria-label={`Open main task ${titleOf(hero.content)}`} title="Open main task">
            <Icon name="up" size={14} /><span className="muted">Main task</span> {titleOf(hero.content) ? <InlineTitle text={titleOf(hero.content)} /> : 'Untitled'}
          </Link>
        )}
      </div>

      <ContentEditor card={card} titleId={titleId} Heading={Heading} editing={editing && !deleted} onDone={() => setEditing(false)}
        canTick={editable && !deleted} projectId={project?.id ?? null} onSetProperties={() => setTab('properties')} />

      {!card.isDoc && project && !deleted && <WorksOnRow card={card} project={project} editable={editable} />}

      {settings.dependenciesEnabled && <DependencyBadge card={card} editable={editable && planAllows(s, 'dependencies')} />}

      {card.isDoc && <p className="card-foot muted">Words {wordCount(card.content)}</p>}
      {isHero && settings.effortEnabled && (
        <p className="card-foot muted" data-testid="hero-effort" title={`Tasks without effort count as ${settings.fallbackEffort}.`}>
          Effort <strong className="hero-effort">{heroEffort(card, children, settings)}</strong>
          {' '}· own {card.effort ?? `${settings.fallbackEffort} (fallback)`} + {subCountLabel(children.length)}
        </p>
      )}

      {!deleted && <QuickBar card={card} project={project} disabled={!editable || busy} moveLocked={guarded} update={(p) => void update(p)} />}

      <SideTabs tab={tab} setTab={setTab} counts={{ conversations: threads.length, subcards: children.length, attachments: fileCount }}>
        {tab === 'properties' ? (
          <PropertiesPanel card={card} project={project} editable={editable && !deleted} update={(p) => void update(p)} />
        ) : tab === 'subcards' ? (
          <SubCardsTab card={card} editable={editable} />
        ) : tab === 'attachments' ? (
          <AttachmentsTab card={card} editable={editable} />
        ) : tab === 'conversations' ? (
          <>
            <div className="thread-bar">
              {editable && !deleted && (
                <button type="button" className="btn btn-sm" aria-keyshortcuts={keysOf('card.conversations')} onClick={() => setDialog({ kind: 'compose', context: 'comment' })}><Icon name="plus" size={14} /> New</button>
              )}
              <button type="button" className={showClosed ? 'btn btn-sm btn-active' : 'btn btn-sm'} aria-pressed={showClosed} onClick={() => setShowClosed((v) => !v)}>Show closed</button>
            </div>
            {threads.length ? (
              threads.map((r) => (
                <ThreadView key={r.id} resolvable={r} entries={entriesFor(r.id)} reactions={reactionsFor(r.id)} users={s.users} meId={s.me?.id}
                  note={s.notifications.get(`${s.me?.id}|${r.id}`)} canAct={editable && !deleted} guarded={guarded} now={now} />
              ))
            ) : (
              <p className="muted">No open conversations. New, Block or Review starts one.</p>
            )}
            {showClosed && (closed.length ? closed.map((t) => (
              <ThreadView key={t.resolvable.id} resolvable={t.resolvable} entries={t.entries} reactions={t.reactions} users={s.users}
                meId={s.me?.id} canAct={false} closed now={now} />
            )) : <p className="muted">No closed conversations.</p>)}
          </>
        ) : (
          <HistoryTab cardId={card.id} version={card.version} users={s.users} decks={s.decks} cards={s.cards} priorityLabels={settings.priorityLabels} />
        )}
      </SideTabs>

      {dialog?.kind === 'compose' && <ThreadComposer cardId={card.id} context={dialog.context} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'startLocked' && (
        <ConfirmDialog title="Start a locked task?" confirmLabel="Start anyway" onClose={() => setDialog(null)}
          onConfirm={() => dispatch('cards', 'update', { id: card.id, status: 'started' })}>
          <p>{dialog.count === 1 ? '1 unfinished task locks' : `${dialog.count} unfinished tasks lock`} this one. Start anyway?</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title="Delete task?" confirmLabel="Delete task" danger onClose={() => setDialog(null)}
          onConfirm={() => dispatch('cards', 'update', { id: card.id, visibility: 'deleted' })}>
          <p><strong>{title}</strong> leaves its list. You can restore it from its link.</p>
        </ConfirmDialog>
      )}
    </article>
  );
}

/**
 * Title + Markdown text; Edit swaps in the editor, which saves with Ctrl+Enter against the version it
 * started from. Checklist boxes in the view save straight away, one line at a time.
 */
export function ContentEditor({ card, titleId, Heading, editing, onDone, canTick, projectId, onSetProperties }: {
  card: Card; titleId: string; Heading: 'h1' | 'h2'; editing: boolean; onDone: () => void;
  canTick: boolean; projectId: string | null; onSetProperties?: () => void;
}) {
  const files = useStore((s) => s.files);
  const images = useMemo(() => [...files.values()].filter((f) => f.cardId === card.id), [files, card.id]);
  const { title, body, bodyStart } = splitTitle(card.content);
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState(card.contentVersion);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  // Entering edit mode snapshots the text and the version it is based on.
  useEffect(() => {
    if (editing) { setDraft(card.content); setBase(card.contentVersion); setConflict(false); }
    else setDraft(null);
  }, [editing]);

  const cancel = () => { setDraft(null); setConflict(false); onDone(); };
  const save = async () => {
    if (draft === null || busy) return;
    if (draft === card.content) { cancel(); return; }
    setBusy(true);
    try {
      // Queued behind any checkbox save still in flight; sent against the version editing started from.
      await queueContentSave(card.id, () => ({ content: draft, contentVersion: base }), card);
      setDraft(null);
      setConflict(false);
      onDone();
    } catch (e) {
      // Someone saved first: keep this draft, show theirs, and let the person decide.
      if (e instanceof ApiError && e.code === 'conflict') {
        setConflict(true);
        const theirs = (e.data as Card | undefined)?.contentVersion;
        if (typeof theirs === 'number') setBase(theirs);
      }
    } finally {
      setBusy(false);
    }
  };
  /**
   * Sets one checklist item in the newest stored text. The item is matched by its line text as
   * clicked, so a save that lands after the lines moved never ticks a different item. The box flips
   * back when the item is gone or the save fails.
   */
  const tick = (line: number, checked: boolean, box: HTMLInputElement) => {
    const clicked = card.content.split('\n')[line];
    let aborted = false;
    queueContentSave(card.id, (cur) => {
      const next = setCheckLine(cur.content, line, checked, clicked);
      if (next === null) { aborted = true; return null; }
      return next === cur.content ? null : { content: next, contentVersion: cur.contentVersion };
    }, card).then(() => { if (aborted) box.checked = !checked; }, () => { box.checked = !checked; });
  };

  if (draft !== null) {
    return (
      <div className="card-edit">
        <Heading id={titleId} className="sr-only">{title}</Heading>
        {conflict && (
          <div className="notice notice-danger" role="alert">
            <p>Someone else changed this task while you were editing. Their text:</p>
            <pre className="card-text">{card.content}</pre>
            <p>Save again to replace it with yours, or Cancel to keep theirs.</p>
          </div>
        )}
        <Editor value={draft} onChange={setDraft} onSave={() => void save()} onCancel={cancel} autoFocus label={card.isDoc ? 'Text' : 'Task text'}
          projectId={projectId} images={images} onSetProperties={onSetProperties} />
        <div className="row">
          <span className="hint foot-hint">Ctrl+Enter saves · Esc cancels</span>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card-content">
      <Heading id={titleId} className="card-heading"><InlineTitle text={title} links /></Heading>
      {body.trim()
        ? <MarkdownView content={body} lineOffset={bodyStart} onToggle={canTick ? tick : undefined} testId="card-markdown" />
        : <p className="muted">No text yet.</p>}
    </div>
  );
}

function SideTabs({ tab, setTab, counts, children }: {
  tab: SideTab; setTab: (t: SideTab) => void; counts: Partial<Record<SideTab, number>>; children: ReactNode;
}) {
  const id = useId();
  const tabs: { key: SideTab; label: string; hint?: string; shortcut?: string }[] = [
    { key: 'conversations', label: 'Conversations' },
    { key: 'history', label: 'History' },
    { key: 'properties', label: 'Properties', hint: `Shortcut: ${keysOf('card.properties').toUpperCase()}`, shortcut: keysOf('card.properties') },
    { key: 'subcards', label: 'Subtasks', hint: `Shortcut: ${keysOf('card.subcards').toUpperCase()}`, shortcut: keysOf('card.subcards') },
    { key: 'attachments', label: 'Attachments' },
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = SIDE_TABS.indexOf(tab);
    const next = SIDE_TABS[(i + (e.key === 'ArrowRight' ? 1 : SIDE_TABS.length - 1)) % SIDE_TABS.length];
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="side-tabs">
      <div role="tablist" aria-label="Task activity" className="tabs" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.key} id={`${id}-tab-${t.key}`} type="button" role="tab" className="tab"
            aria-selected={tab === t.key} aria-controls={`${id}-panel`} tabIndex={tab === t.key ? 0 : -1}
            title={t.hint} aria-keyshortcuts={t.shortcut} onClick={() => setTab(t.key)}
          >
            {t.label}{!!counts[t.key] && <span className={t.key === 'conversations' ? 'tab-count' : 'tab-count quiet'}>{counts[t.key]}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="tab-panel" tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
