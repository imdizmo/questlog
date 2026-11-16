import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { BoardEdge } from '../../../shared/board';
import type { Card } from '../../../shared/types';
import { titleOf } from '../../../shared/cards';
import { applySet, evalCond, fillText, parseLabel, parseVars, type Vars } from '../../../shared/story';
import { useStore } from '../store';
import { Dialog } from '../components/Dialog';
import { MarkdownView } from '../components/MarkdownView';
import { fileUrl } from '../components/AttachmentsTab';
import { Picture, isStartFrame, isStoryline } from '../components/wiki/Builder';
import { boardOfCard } from './boards';
import { connectBoard, type BoardConnection } from './provider';
import { readEdge, readNode } from './useBoard';

/** The story's starting variables, kept in the board itself (one `name = value` per line). */
export const storyVars = (doc: Y.Doc): string => { const v = doc.getMap<unknown>('story').get('vars'); return typeof v === 'string' ? v : ''; };

/** A frame's text for the player: no title, and no heading that has nothing written under it. */
function written(content: string): string {
  const lines = content.split('\n').slice(1);
  return lines.filter((l, i) => {
    if (!l.startsWith('#')) return true;
    const next = lines.slice(i + 1).find((x) => x.trim());
    return next !== undefined && !next.startsWith('#');
  }).join('\n').trim();
}

interface Graph { hostId: string; cardOf: Map<string, string>; edges: BoardEdge[]; start: string | null }
interface Step { graph: Graph; node: string; vars: Vars }

/** A board as Play needs it: which card each frame node shows, the lines, and the node the storyline starts with. */
function graphOf(doc: Y.Doc, hostId: string, links: { fromCardId: string; toCardId: string; kindKey: string; sortIndex: number }[]): Graph {
  const cardOf = new Map<string, string>();
  let left: { id: string; x: number } | null = null;
  doc.getMap<Y.Map<unknown>>('nodes').forEach((m, id) => {
    const n = readNode(id, m);
    if (n?.type !== 'card' || typeof n.value.id !== 'string') return;
    cardOf.set(id, n.value.id);
    if (!left || n.pos.x < left.x) left = { id, x: n.pos.x };
  });
  const edges: BoardEdge[] = [];
  doc.getMap<Y.Map<unknown>>('edges').forEach((m, id) => { const e = readEdge(id, m); if (e) edges.push(e); });
  const mine = links.filter((l) => l.fromCardId === hostId) as Parameters<typeof isStartFrame>[0];
  // The storyline's first frame; a board without it starts at its leftmost card.
  const first = [...cardOf].find(([, cardId]) => isStartFrame(mine, cardId))?.[0];
  return { hostId, cardOf, edges, start: first ?? (left as { id: string } | null)?.id ?? null };
}

/**
 * Walks a storyline's flow: the current frame's picture, text and sounds, and one button per line that leaves it and
 * whose {if …} holds; taking a line applies its {set …}. A card of another storyline continues in that storyline's
 * flow. Each board is read once, when the player reaches it.
 */
export function StoryPlayer({ doc, host, onClose }: { doc: Y.Doc; host: Card; onClose: () => void }) {
  const s = useStore((x) => x);
  const first = useMemo<Step | null>(() => {
    const graph = graphOf(doc, host.id, [...s.entryLinks.values()]);
    return graph.start ? { graph, node: graph.start, vars: parseVars(storyVars(doc)) } : null;
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [trail, setTrail] = useState<Step[]>(first ? [first] : []);
  /** Other storylines' boards opened by a jump; closed with the player. */
  const opened = useRef(new Map<string, BoardConnection>());
  useEffect(() => () => { for (const c of opened.current.values()) c.destroy(); }, []);

  const at = trail[trail.length - 1];
  const cardAt = (g: Graph, nodeId: string) => s.cards.get(g.cardOf.get(nodeId) ?? '');
  const card = at ? cardAt(at.graph, at.node) : undefined;
  const title = (c: Card | undefined) => titleOf(c?.content ?? '') || 'Untitled';
  const visits = (t: string) => trail.filter((st) => title(cardAt(st.graph, st.node)).toLowerCase() === t.toLowerCase()).length;
  const choices = !at ? [] : at.graph.edges.filter((e) => e.value.source.nodeId === at.node && at.graph.cardOf.has(e.value.target.nodeId))
    .map((e) => ({ e, ...parseLabel(e.label ?? '') })).filter((c) => !c.cond || evalCond(c.cond, at.vars, visits));

  const take = async (c: (typeof choices)[number]) => {
    const vars = c.sets.reduce((v, set) => applySet(set, v), at!.vars);
    const target = cardAt(at!.graph, c.e.value.target.nodeId);
    // A card of another storyline is a jump: the story goes on at that storyline's first frame.
    const board = target && target.id !== at!.graph.hostId && isStoryline(s, target) ? boardOfCard(s, target.id) : undefined;
    if (board) {
      let conn = opened.current.get(board.id);
      if (!conn) { conn = connectBoard(board.id); opened.current.set(board.id, conn); }
      await conn.doc.whenSynced;
      const graph = graphOf(conn.doc, target!.id, [...s.entryLinks.values()]);
      if (graph.start) { setTrail([...trail, { graph, node: graph.start, vars }]); return; }
    }
    setTrail([...trail, { graph: at!.graph, node: c.e.value.target.nodeId, vars }]);
  };
  const sounds = card ? [...s.files.values()].filter((f) => f.cardId === card.id && f.mime.startsWith('audio/')) : [];
  const shown = Object.entries(at?.vars ?? {});

  return (
    <Dialog title={`Play: ${titleOf(host.content)}`} onClose={onClose} wide scroll actions={<>
      <button type="button" className="btn btn-ghost" disabled={trail.length < 2} onClick={() => setTrail(trail.slice(0, -1))}>Back</button>
      <button type="button" className="btn btn-ghost" disabled={trail.length < 2} onClick={() => setTrail(trail.slice(0, 1))}>Restart</button>
    </>}>
      {card ? (
        <div className="story-play" data-testid="story-play">
          <span className="wk-frame-pic"><Picture card={card} /></span>
          <h3>{title(card)}</h3>
          <MarkdownView content={fillText(written(card.content), at!.vars)} />
          {/* The person presses play: nothing sounds by itself. */}
          {sounds.map((f) => <label key={f.id} className="story-sound"><span className="muted">{f.name}</span><audio controls preload="none" src={fileUrl(f.id)} /></label>)}
          <div className="story-choices">
            {choices.map((c) => (
              <button key={c.e.id} type="button" className="btn story-choice" onClick={() => void take(c)}>{c.text || title(cardAt(at!.graph, c.e.value.target.nodeId))}</button>
            ))}
            {!choices.length && <p className="muted">The end. No line you can take leaves this frame.</p>}
          </div>
          {shown.length > 0 && <p className="story-vars" aria-label="Variables">{shown.map(([k, v]) => <span key={k} className="badge">{k} = {String(v)}</span>)}</p>}
        </div>
      ) : <p className="muted">There are no frames on this board yet.</p>}
    </Dialog>
  );
}

/** The storyline's starting variables and a reminder of what a line's label can say. */
export function StoryVarsDialog({ doc, canEdit, onClose }: { doc: Y.Doc; canEdit: boolean; onClose: () => void }) {
  const [text, setText] = useState(() => storyVars(doc));
  return (
    <Dialog title="Story variables" onClose={onClose} onSubmit={() => { if (canEdit) doc.getMap<unknown>('story').set('vars', text); onClose(); }} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      {canEdit && <button type="submit" className="btn btn-primary">Save</button>}
    </>}>
      <label className="field">
        <span>Starting values, one per line</span>
        <textarea rows={6} value={text} readOnly={!canEdit} placeholder={'gold = 10\nhas_key = false'} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="hint story-help">
        <p>In a line's label (double-click a line), after the text the player reads:</p>
        <p><code>{'Open the door {if has_key}'}</code> offers the line only when that holds. Use <code>and</code>, <code>or</code>, <code>!</code>, and <code>== != &gt; &gt;= &lt; &lt;=</code>.</p>
        <p><code>{'Pay the toll {if gold >= 5} {set gold -= 5}'}</code> changes a value when the line is taken.</p>
        <p><code>{'{if seen The gate}'}</code> holds once the frame with that title was visited.</p>
        <p>In a frame's text, <code>{'{gold}'}</code> shows the value.</p>
      </div>
    </Dialog>
  );
}
