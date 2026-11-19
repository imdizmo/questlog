import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Rect } from '../../../shared/board';
import { api, dispatch } from '../api';
import { Link, navigate, openInTab, useLocation, type Route } from '../router';
import { roleOf, store, useStore } from '../store';
import * as Y from 'yjs';
import { DEFAULT_SETTINGS } from '../../../shared/types';
import { useMinuteClock } from '../clock';
import { Icon, type IconName } from '../components/icons';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Rail } from '../components/Rail';
import { buildHomeModel, viewOf, type HomeEdge, type HomeNode, type HomeState } from '../homeModel';
import { CARD_KINDS, fitView, layoutKey, pickCards, treeLayout, type Box, type CardKind } from '../homeLayout';
import { agoText, recentRows } from '../homeRecent';
import { paintScene, picOf, PICS } from '../homePictures';
import { useHomePrefs, type HomePrefs } from '../homePrefs';
import { boardBySeq } from '../board/boards';
import { Canvas, type WorkLayer } from '../board/Canvas';
import { askHome, syncWork, useHomeWork, workHash, workKey, workRects } from '../board/homeWork';
import { WorkContext, workFace, workLabel, type WorkInfo } from '../board/WorkNode';
import { BoardsRail, BoardStatusBar, CardBoardView, useBoardConnection } from './CardBoard';
import { HomeSplit, openSide, sideClick, useSplit } from './HomePane';

/**
 * Home: a painted picture fills the page; on it "Welcome back", what this person worked on lately, and the workspace's
 * Home board, one for everyone and live (the vision-board engine, web/src/board/*): the projects, areas, lists and
 * quests are nodes of it (web/src/board/homeWork.ts), each moved on its own, with the lines Questlog has (a project has
 * areas, an area has lists, a list has quests; dashed: this locks that); notes, scenes, frames and lines go on it with
 * the Add tools. The old vision boards open here too, from the Boards toolbar (`?board=<seq>`, web/src/views/CardBoard.tsx).
 *
 * A plain click on the work or on "Recently worked on" shows that page beside Home, in the same tab (`?side=`,
 * web/src/views/HomePane.tsx); Ctrl/⌘ or a middle click opens it in a tab of its own.
 *
 * Toolbars, one look: Boards top centre, Add on the left (the canvas's), View, Cards and the picture on the right
 * (Home only). Per person (web/src/homePrefs.ts): the picture, Web or Tree View, which kinds show as cards (drawn in
 * place for this person only), what to show, "Recently worked on" open or folded. Tree View is a computed arrangement
 * of the work (read only; the board's notes are not in it).
 *
 * Kept cheap on a big workspace: the model is capped (web/src/homeModel.ts), at most MAX_CARDS_PER_KIND cards of a
 * kind; the minute clock lives in "Recently worked on" alone.
 */

const KINDS: [CardKind, string, IconName][] = [['proj', 'Projects', 'folder'], ['area', 'Areas', 'grid'], ['list', 'Lists', 'list'], ['quest', 'Quests', 'task']];
type Labels = typeof DEFAULT_SETTINGS.priorityLabels;

/** `page`: a page as the shell shows it (App.tsx's ShellBody), for the pane beside Home. */
export function Home({ page }: { page: (r: Route) => ReactNode }) {
  const seq = Number(useLocation().query.get('board')) || 0;
  const board = useStore((s) => (seq ? boardBySeq(s, seq) : undefined));
  const [hp, setHp] = useHomePrefs();
  const mainRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);

  // The picture is painted for the page's size, again when it changes size or another picture is picked.
  const picRef = useRef(hp.pic);
  picRef.current = hp.pic;
  useEffect(() => {
    const m = mainRef.current, cv = sceneRef.current;
    if (!m || !cv) return;
    let frame = 0;
    const redo = () => { frame = 0; paintScene(cv, picRef.current, m.clientWidth, m.clientHeight); };
    const ro = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(redo); });
    ro.observe(m);
    redo();
    return () => { ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    const m = mainRef.current, cv = sceneRef.current;
    if (m && cv) paintScene(cv, hp.pic, m.clientWidth, m.clientHeight);
  }, [hp.pic]);

  return (
    <HomeSplit page={page}>
      <main className={seq ? 'home on-board' : 'home'} id="main" ref={mainRef}>
        <canvas className="home-scene" ref={sceneRef} aria-hidden />
        {seq ? <CardBoardView seq={seq} board={board} /> : <HomeBoard hp={hp} setHp={setHp} mainRef={mainRef} />}
      </main>
    </HomeSplit>
  );
}

/** The workspace's Home board id and whether this person may edit it, asked again when they or their role change. */
function useHomeBoard(): { id: string; canEdit: boolean } | null {
  const who = useStore((s) => `${s.me?.id ?? ''}:${roleOf(s, s.me?.id) ?? ''}`);
  const [home, setHome] = useState<{ who: string; id: string; canEdit: boolean } | null>(null);
  useEffect(() => {
    if (who.startsWith(':')) return;
    let live = true;
    void askHome(who, () => dispatch<{ id: string; canEdit: boolean }>('visionBoard', 'openHome', {}))
      .then((h) => { if (live) setHome({ who, ...h }); }, () => {});
    return () => { live = false; };
  }, [who]);
  return home && home.who === who ? home : null;
}

/**
 * A doc of this page alone holding the work where the Web layout puts it (no notes: those are in the room), for while
 * the room has no board for us; null when `keyId` is null. Rebuilt from the store as it changes; freed when unused.
 */
function useLocalHome(keyId: string | null, nodes: HomeNode[]): Y.Doc | null {
  const doc = useMemo(() => (keyId ? new Y.Doc() : null), [keyId]);
  useEffect(() => () => doc?.destroy(), [doc]);
  useEffect(() => { if (doc && keyId) syncWork(doc, keyId, nodes, store.get()); }, [doc, keyId, nodes]);
  return doc;
}

function HomeBoard({ hp, setHp, mainRef }: { hp: HomePrefs; setHp: (p: Partial<HomePrefs>) => void; mainRef: React.RefObject<HTMLElement | null> }) {
  const me = useStore((s) => s.me);
  const projects = useStore((s) => s.projects);
  const decks = useStore((s) => s.decks);
  const cards = useStore((s) => s.cards);
  const cardDeps = useStore((s) => s.cardDeps);
  const resolvables = useStore((s) => s.resolvables);
  const account = useStore((s) => s.account);
  const home = useHomeBoard();
  const { conn, status, reason, reconnect } = useBoardConnection(home?.id ?? null);
  const canEdit = !!home?.canEdit && !(status === 'offline' && reason);
  const tree = hp.layout === 'tree';
  const split = useSplit();
  // Beside a page Home is narrow: "Recently worked on" folds away there, unless a row of it opened the page or it is
  // unfolded there. That is for this visit only: the saved choice is Home's alone, and only changes without a page beside.
  const [recentBeside, setRecentBeside] = useState(false);
  useEffect(() => { if (!split) setRecentBeside(false); }, [split]);
  const recent = split ? recentBeside : hp.recent;
  const foldRecent = () => (split ? setRecentBeside(!recentBeside) : setHp({ recent: !hp.recent }));
  const cardKinds = hp.cards;
  const questsOn = hp.show.quest || cardKinds.includes('quest');

  const state: HomeState = useMemo(() => ({ projects, decks, cards, cardDeps, resolvables, account }), [projects, decks, cards, cardDeps, resolvables, account]);
  const model = useMemo(() => buildHomeModel(state, { quests: questsOn }), [state, questsOn]);
  const boardId = home?.id ?? '';
  // Keys are made with the board's id; the stand-in doc below uses its own when the id is not known yet.
  const keyId = boardId || 'local';
  useHomeWork(conn?.doc ?? null, boardId, canEdit, model.nodes);
  // Until the room has the board (loading, full, refused, offline), the work is drawn read only where the Web layout
  // puts it, from the store, on a doc of this page alone.
  const [synced, setSynced] = useState<object | null>(null);
  useEffect(() => {
    if (!conn) return;
    let live = true;
    void conn.doc.whenSynced.then(() => { if (live) setSynced(conn); });
    return () => { live = false; };
  }, [conn]);
  const roomUp = !!conn && synced === conn && !reason;
  const local = useLocalHome(roomUp || tree ? null : keyId, model.nodes);

  const view = useMemo(() => viewOf(model, { area: hp.show.area, list: hp.show.list }), [model, hp.show.area, hp.show.list]);
  const cardKey = cardKinds.join(',');
  const asCards = useMemo(() => pickCards(view.nodes, cardKinds), [view.nodes, cardKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = account?.settings?.priorityLabels ?? DEFAULT_SETTINGS.priorityLabels;
  // The nodes this person sees, by their key on the board (the doc holds no ids, see web/src/board/homeWork.ts).
  const viewMap = useMemo(() => new Map(view.nodes.map((n) => [workHash(keyId, n.id), n])), [view.nodes, keyId]);
  const info: WorkInfo = useMemo(() => ({ nodes: viewMap, cards: asCards, labels, projectName: (id: string) => projects.get(id)?.name ?? '' }), [viewMap, asCards, labels, projects]);
  const work: WorkLayer = useMemo(() => ({
    place: (nodes) => workRects(nodes, viewMap, asCards),
    lines: (rectOf) => <WorkLines edges={view.edges} rectOf={(ref) => rectOf(workKey(keyId, ref))} />,
    open: (key, newTab) => {
      const n = viewMap.get(key);
      if (!n) return;
      if (!newTab) openSide(n.href, document.activeElement);
      else if (!openInTab(n.href)) navigate(n.href);
    },
    clearLeft: recent ? 430 : 70,
    fit: split ? 'split' : '',
  }), [viewMap, asCards, view.edges, recent, keyId, split]);

  // ---- the gear and the sliders ----
  const [pop, setPop] = useState<null | 'set' | 'fil'>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.gpop, .rail.r')) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setPop(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [pop]);
  useEffect(() => {
    if (pop !== 'set') return;
    popRef.current?.querySelectorAll<HTMLCanvasElement>('canvas[data-pic]').forEach((cv) => paintScene(cv, cv.dataset.pic as typeof hp.pic, 64, 40));
  }, [pop]);
  const toggleCard = (k: CardKind | 'all' | 'none') => {
    if (k === 'none') setHp({ cards: [] });
    else if (k === 'all') setHp({ cards: cardKinds.length === CARD_KINDS.length ? [] : [...CARD_KINDS] });
    else setHp({ cards: cardKinds.includes(k) ? cardKinds.filter((x) => x !== k) : [...cardKinds, k] });
  };

  const drawnQuests = view.nodes.filter((n) => n.kind === 'quest').length;
  const links = view.edges.filter((e) => e.kind === 'has').length;
  const locks = view.edges.reduce((t, e) => t + (e.kind === 'lock' ? e.n ?? 1 : 0), 0);
  const first = (me?.name ?? '').split(' ')[0];

  // In the page, the welcome column and the toolbars come before the canvas, so Tab reaches them first; CSS places them.
  return (
    <>
      <div className={recent ? 'home-left' : 'home-left shut'}>
        <h1>Welcome back{first ? `, ${first}` : ''}</h1>
        <div className="lbl2">
          <span id="home-recent">Recently worked on</span>
          <button type="button" className="rfold" aria-expanded={recent} aria-controls="home-recent-list"
            aria-label={recent ? 'Fold away recently worked on' : 'Show recently worked on'} title={recent ? 'Fold away' : 'Recently worked on'}
            onClick={foldRecent}>
            <Icon name={recent ? 'chevron' : 'clock'} size={recent ? 15 : 18} />
          </button>
        </div>
        {recent && <RecentList onOpen={() => setRecentBeside(true)} />}
      </div>

      <BoardsRail current={null} />
      <Rail className="v r" label="View, cards and picture" vertical>
        <div className="vh" aria-hidden>View</div>
        <ToolButton icon="web" label="Web view" tip="Web view: the shared board" pressed={!tree} onClick={() => setHp({ layout: 'web' })} />
        <ToolButton icon="tree" label="Tree View" tip="Tree View: project, areas, lists, quests" pressed={tree} onClick={() => setHp({ layout: 'tree' })} />
        <hr />
        <div className="vh" aria-hidden>Cards</div>
        {KINDS.map(([k, l, ic]) => <ToolButton key={k} icon={ic} label={`${l} as cards`} tip={`${l} as cards`} pressed={cardKinds.includes(k)} onClick={() => toggleCard(k)} />)}
        <hr />
        <button type="button" className="allb" aria-pressed={cardKinds.length === CARD_KINDS.length} aria-label="Everything as cards" onClick={() => toggleCard('all')}>All<span className="tip2">Everything as cards</span></button>
        <ToolButton icon="more" label="Everything as pills" tip="Everything as pills" pressed={cardKinds.length === 0} onClick={() => toggleCard('none')} />
        <hr />
        <button type="button" aria-expanded={pop === 'set'} aria-label="Picture and layout" onClick={() => setPop(pop === 'set' ? null : 'set')}><Icon name="gear" size={16} /><span className="tip2">Picture and layout</span></button>
        <button type="button" aria-expanded={pop === 'fil'} aria-label="What to show" onClick={() => setPop(pop === 'fil' ? null : 'fil')}><Icon name="sliders" size={16} /><span className="tip2">What to show</span></button>
      </Rail>
      {pop === 'set' && (
        <div className="gpop" ref={popRef} role="group" aria-label="Picture and layout">
          <h2>Background</h2>
          <div className="pics">
            {PICS.map((p) => (
              <button key={p.key} type="button" aria-pressed={p.key === hp.pic} aria-label={p.name} title={p.name} onClick={() => setHp({ pic: p.key })}>
                <canvas data-pic={p.key} aria-hidden />
              </button>
            ))}
          </div>
          <p className="pn">Four gradients for now. Your choice is yours alone.</p>
          <h2>Layout</h2>
          <p className="pn">Where things sit on the Web view is the same for everyone: drag one to move it. Tree View lays the work out by itself.</p>
        </div>
      )}
      {pop === 'fil' && (
        <div className="gpop" role="group" aria-label="What to show">
          <h2>Show</h2>
          {(['area', 'list', 'quest'] as const).map((k) => (
            <label key={k}><input type="checkbox" checked={hp.show[k]} onChange={(e) => setHp({ show: { ...hp.show, [k]: e.target.checked } })} /> {{ area: 'Areas', list: 'Lists', quest: 'Quests' }[k]}</label>
          ))}
        </div>
      )}

      {tree ? <TreeView nodes={view.nodes} edges={view.edges} asCards={asCards} cardKey={cardKey} recent={recent} labels={labels} mainRef={mainRef} />
        : (
          <WorkContext.Provider value={info}>
            <ErrorBoundary what="Home" resetKey={home?.id ?? ''}>
              <Canvas key={roomUp ? 'live' : 'local'} doc={roomUp && conn ? conn.doc : local} canEdit={roomUp && canEdit} host={null} awareness={roomUp && conn ? conn.awareness : null} work={work} />
            </ErrorBoundary>
          </WorkContext.Provider>
        )}
      {!tree && <BoardStatusBar conn={conn} status={status} />}
      <div className="board-notices">
        {!roomUp && !tree && (reason || status === 'offline') && <p className="notice" role="status">Home's board can't be joined right now: the work is shown where it would be, read only.</p>}
        {reason && !tree && (
          <p className="notice notice-danger" role="alert">
            {reason}
            {status === 'offline' && <button type="button" className="btn btn-sm" onClick={reconnect}>Reconnect</button>}
          </p>
        )}
      </div>
      <div className="gpic">{picOf(hp.pic).name}</div>
      <div className="gcount" data-testid="home-count">
        {model.totals.projects} {model.totals.projects === 1 ? 'project' : 'projects'} · {model.totals.lists} {model.totals.lists === 1 ? 'list' : 'lists'}
        {questsOn && <> · {model.totals.quests} quests{drawnQuests < model.totals.quests ? ` (${drawnQuests} drawn)` : ''}</>}
        {' · '}{links} links{locks > 0 && <> · <span className="depkey">{locks} {locks === 1 ? 'lock' : 'locks'}</span></>}
      </div>
    </>
  );
}

/** The lines Questlog has between the work on the board, from the data: centre to centre; locks dashed. */
function WorkLines({ edges, rectOf }: { edges: HomeEdge[]; rectOf: (ref: string) => Rect | undefined }) {
  return (
    <svg className="home-lines" width="1" height="1" aria-hidden>
      {edges.map((e, i) => {
        const a = rectOf(e.a), b = rectOf(e.b);
        if (!a || !b) return null;
        const [ax, ay, bx, by] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
        return e.kind === 'lock'
          ? <line key={i} className="ln dep" data-a={e.a} data-b={e.b} x1={ax} y1={ay} x2={bx} y2={by}><title>{e.n && e.n > 1 ? `${e.n} tasks here lock tasks there` : 'This locks that'}</title></line>
          : <line key={i} className="ln" data-a={e.a} data-b={e.b} x1={ax} y1={ay} x2={bx} y2={by} />;
      })}
    </svg>
  );
}

/**
 * "Recently worked on": its own component, so the minute clock that ages the times re-renders only this list. `onOpen`:
 * a row opened its page beside Home.
 */
function RecentList({ onOpen }: { onOpen: () => void }) {
  const now = useMinuteClock();
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const [items, setItems] = useState<{ cardId: string; at: number }[] | null>(null);
  useEffect(() => {
    let live = true;
    api.homeRecent().then((r) => { if (live) setItems(r.items); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, []);
  const rows = useMemo(() => recentRows({ cards, decks, projects }, items ?? []), [items, cards, decks, projects]);
  return (
    <nav className="recent" id="home-recent-list" aria-labelledby="home-recent">
      {items !== null && rows.length === 0 && <p className="recent-none">Nothing yet: the tasks and pages you change show up here.</p>}
      {rows.map((r) => (
        <Link key={r.id} href={r.href} className="rr" title={`${r.title} (opens beside Home; Ctrl+click: in a new tab)`}
          onClick={(e) => { sideClick(e); if (e.defaultPrevented) onOpen(); }}>
          {r.doc ? <span className="st doc"><Icon name="doc" size={12} /></span> : <span className={r.done ? 'st done' : 'st'} />}
          <span className="t1">{r.title}</span>
          <span className="ago">{agoText(r.at, now)}</span>
          <span className="t2">{r.sub}</span>
        </Link>
      ))}
    </nav>
  );
}

function ToolButton({ icon, label, tip, pressed, onClick }: { icon: IconName; label: string; tip: string; pressed: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={pressed} aria-label={label} onClick={onClick}><Icon name={icon} size={16} /><span className="tip2">{tip}</span></button>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tree View: the work laid out project → areas → lists → quests, computed (read only). Drag anywhere to move the
// picture; the canvas is one tab stop, the arrow keys move between its nodes (Home and End: the first and last), Enter
// opens one, and the picture pans to the focused node.

/** Where the tree was dragged to, while the page lives; another layout resets it. */
let pan = { x: 0, y: 0 };
let panFor = '';

function TreeView({ nodes, edges, asCards, cardKey, recent, labels, mainRef }: {
  nodes: HomeNode[]; edges: HomeEdge[]; asCards: Set<string>; cardKey: string; recent: boolean; labels: Labels; mainRef: React.RefObject<HTMLElement | null>;
}) {
  const projects = useStore((s) => s.projects);
  const key = layoutKey(nodes, asCards, true);
  const layout = useMemo(() => treeLayout(nodes, (n) => asCards.has(n.id)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitKey = useMemo(() => `${asCards.size}|${nodes.map((n) => n.id).join(',')}`, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const layerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const fit = useRef({ scale: 1, x: 0, y: 0 });
  const space = useRef({ left: 0, top: 0, w: 0, h: 0 });
  if (panFor !== cardKey) { pan = { x: 0, y: 0 }; panFor = cardKey; }
  const apply = () => {
    const w = worldRef.current;
    if (w) w.style.transform = `translate(${fit.current.x + pan.x}px, ${fit.current.y + pan.y}px) scale(${fit.current.scale})`;
  };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const refit = () => {
    const m = mainRef.current;
    if (!m) return;
    const W = m.clientWidth, H = m.clientHeight;
    const left = recent && W > 900 ? 430 : 70;
    const top = recent && W <= 900 ? H * 0.5 : 64;
    space.current = { left, top, w: W, h: H };
    fit.current = fitView(layoutRef.current.bounds, { w: W, h: H, left, top }, true);
    apply();
  };
  useLayoutEffect(refit, [fitKey, recent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mainRef.current;
    if (!m) return;
    let frame = 0;
    const ro = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; refit(); }); });
    ro.observe(m);
    return () => { ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag anywhere to move the picture; a drag of more than a few pixels is not a click.
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number; moved: boolean; frame: number } | null>(null);
  const dragged = useRef(false);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false, frame: 0 };
    dragged.current = false;
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      d.moved = true;
      dragged.current = true;
      e.currentTarget.setPointerCapture(e.pointerId); // only now: capturing earlier would steal the click from the node
      e.currentTarget.classList.add('drag');
    }
    pan.x = d.px + dx;
    pan.y = d.py + dy;
    if (!d.frame) d.frame = requestAnimationFrame(() => { if (drag.current) drag.current.frame = 0; apply(); });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    drag.current = null;
    apply();
    e.currentTarget.classList.remove('drag');
  };
  const noClickAfterDrag = (e: React.MouseEvent) => { if (dragged.current) { e.preventDefault(); dragged.current = false; } };

  // ---- hover: a node, its lines and its neighbours stand out ----
  const near = useMemo(() => {
    const m = new Map<string, { lines: number[]; nodes: string[] }>();
    edges.forEach((e, i) => {
      for (const [a, b] of [[e.a, e.b], [e.b, e.a]]) {
        const x = m.get(a) ?? { lines: [], nodes: [] };
        x.lines.push(i); x.nodes.push(b);
        m.set(a, x);
      }
    });
    return m;
  }, [edges]);
  const lit = useRef<{ id: string | null; els: Element[] }>({ id: null, els: [] });
  const light = (id: string | null) => {
    if (lit.current.id === id) return;
    const w = worldRef.current;
    if (!w) return;
    for (const el of lit.current.els) el.classList.remove('on', 'near');
    lit.current = { id, els: [] };
    w.classList.toggle('hl', !!id);
    if (!id) return;
    const self = w.querySelector(`[data-n="${CSS.escape(id)}"]`);
    if (self) { self.classList.add('on'); lit.current.els.push(self); }
    const x = near.get(id);
    if (!x) return;
    const lines = w.querySelector('svg')?.children;
    for (const i of x.lines) { const l = lines?.[i]; if (l) { l.classList.add('on'); lit.current.els.push(l); } }
    for (const n of x.nodes) { const el = w.querySelector(`[data-n="${CSS.escape(n)}"]`); if (el) { el.classList.add('near'); lit.current.els.push(el); } }
  };
  useEffect(() => () => {
    for (const el of lit.current.els) el.classList.remove('on', 'near');
    worldRef.current?.classList.remove('hl');
    lit.current = { id: null, els: [] };
  }, [layout]);
  const idOf = (t: EventTarget) => (t as Element).closest?.('[data-n]')?.getAttribute('data-n') ?? null;

  // ---- keyboard: one tab stop; arrows move between nodes; the picture follows the focus ----
  const [roving, setRoving] = useState<string | null>(null);
  const current = roving && layout.pos.has(roving) ? roving : nodes[0]?.id ?? null;
  const showNode = (id: string) => {
    const m = mainRef.current, b = layoutRef.current.pos.get(id);
    if (!m || !b) return;
    if (m.scrollTop || m.scrollLeft) m.scrollTo(0, 0);
    const layer = layerRef.current;
    if (layer && (layer.scrollTop || layer.scrollLeft)) layer.scrollTo(0, 0);
    const { scale, x, y } = fit.current, sp = space.current;
    const sx = b.x * scale + x + pan.x, sy = b.y * scale + y + pan.y;
    const hw = (b.w * scale) / 2, hh = (b.h * scale) / 2;
    const x0 = sp.left, x1 = sp.w - 80, y0 = sp.top, y1 = sp.h - 50;
    if (sx - hw < x0 || sx + hw > x1) pan.x += (x0 + x1) / 2 - sx;
    if (sy - hh < y0 || sy + hh > y1) pan.y += (y0 + y1) / 2 - sy;
    apply();
  };
  const onFocus = (e: React.FocusEvent) => {
    const id = idOf(e.target);
    light(id);
    if (!id) return;
    if ((e.target as Element).matches?.(':focus-visible')) showNode(id);
    if (id !== current) setRoving(id);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const from = idOf(e.target);
    if (!from) return;
    let to: string | null = null;
    if (e.key === 'Home') to = nodes[0]?.id ?? null;
    else if (e.key === 'End') to = nodes[nodes.length - 1]?.id ?? null;
    else {
      const dir = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, [number, number]>)[e.key];
      if (!dir) return;
      to = nearestInDirection(layoutRef.current.pos, from, dir);
    }
    e.preventDefault();
    if (!to || to === from) return;
    const el = worldRef.current?.querySelector<HTMLElement>(`[data-n="${CSS.escape(to)}"]`);
    if (el) { el.tabIndex = 0; el.focus({ preventScroll: true }); }
  };

  return (
    <>
      <p id="home-keys" className="sr-only">Arrow keys move between the projects, areas, lists and quests; Enter opens one beside Home.</p>
      <div className="home-layer" ref={layerRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onClickCapture={noClickAfterDrag} role="region" aria-label="How your work connects" aria-describedby="home-keys">
        <div className="home-world tree" ref={worldRef} onPointerOver={(e) => light(idOf(e.target))} onPointerLeave={() => light(null)}
          onFocus={onFocus} onBlur={() => light(null)} onKeyDown={onKey}>
          <svg className="home-lines" width="1" height="1" aria-hidden>
            {edges.map((e, i) => <TreeLine key={i} e={e} pos={layout.pos} />)}
          </svg>
          {nodes.map((n) => {
            const b = layout.pos.get(n.id);
            return b ? <TreeNode key={n.id} n={n} b={b} tab={n.id === current ? 0 : -1} card={asCards.has(n.id)} labels={labels} projectName={projects.get(n.projectId)?.name ?? ''} /> : null;
          })}
        </div>
      </div>
    </>
  );
}

/** The node nearest to `from` in a direction (screen axes), preferring ones straight that way over ones off to a side. */
function nearestInDirection(pos: Map<string, Box>, from: string, [dx, dy]: [number, number]): string | null {
  const a = pos.get(from);
  if (!a) return null;
  let best: string | null = null, bestScore = Infinity;
  for (const [id, b] of pos) {
    if (id === from) continue;
    const along = (b.x - a.x) * dx + (b.y - a.y) * dy;
    if (along <= 1) continue;
    const side = Math.abs((b.x - a.x) * dy) + Math.abs((b.y - a.y) * dx);
    const score = along + side * 2;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  return best;
}

/** A curve from the parent's right edge to the child's left edge; locks bow out to the right, dashed. */
function TreeLine({ e, pos }: { e: HomeEdge; pos: Map<string, Box> }) {
  const a = pos.get(e.a), b = pos.get(e.b);
  if (!a || !b) return null;
  if (e.kind === 'lock') {
    // Both ends sit in one column: a bow out to the right, so it never runs through the pills between.
    const sx = a.x + a.w / 2, ex = b.x + b.w / 2, bow = 30 + Math.min(160, Math.abs(b.y - a.y) * 0.25);
    return <path className="ln dep" data-a={e.a} data-b={e.b} d={`M${sx},${a.y} C${Math.max(sx, ex) + bow},${a.y} ${Math.max(sx, ex) + bow},${b.y} ${ex},${b.y}`}><title>{e.n && e.n > 1 ? `${e.n} tasks here lock tasks there` : 'This locks that'}</title></path>;
  }
  const sx = a.x + a.w / 2, ex = b.x - b.w / 2, mx = (sx + ex) / 2;
  return <path className="ln curve" data-a={e.a} data-b={e.b} d={`M${sx},${a.y} C${mx},${a.y} ${mx},${b.y} ${ex},${b.y}`} />;
}

/** Nodes re-render only when their own data, place or tab stop changes (a live update elsewhere leaves them be). */
const sameNode = (a: HomeNode, b: HomeNode): boolean => {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof HomeNode)[]) {
    const x = a[k], y = b[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.join('\u0000') === y.join('\u0000')) continue;
    if (k === 'cover' && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
};
const sameBox = (a: Box, b: Box) => a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

const TreeNode = memo(function TreeNode({ n, b, tab, card, labels, projectName }: { n: HomeNode; b: Box; tab: number; card: boolean; labels: Labels; projectName: string }) {
  const f = workFace(n, card, labels, projectName);
  const style = card && n.kind !== 'more' ? { ...f.style, left: b.x, top: b.y, width: b.w, height: b.h } : { left: b.x, top: b.y };
  const body: ReactNode = f.body;
  return (
    <Link data-n={n.id} href={n.href} draggable={false} tabIndex={tab} className={f.className} style={style} onClick={sideClick}
      title={n.kind === 'more' ? 'Open the list to see them all' : n.kind === 'quest' ? n.label : undefined} aria-label={card ? undefined : workLabel(n)}>
      {body}
    </Link>
  );
}, (p, q) => sameNode(p.n, q.n) && sameBox(p.b, q.b) && p.tab === q.tab && p.card === q.card && p.labels === q.labels && p.projectName === q.projectName);
