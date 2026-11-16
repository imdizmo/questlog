import { taskId } from '../taskId';
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isFileUrl, isVideoId, SMART_LABEL_MAX, type BoardNode, type NodeType } from '../../../shared/board';
import { cardCode, derivedStatus, STATUS_LABEL, titleOf } from '../../../shared/cards';
import type { ResolvableContext } from '../../../shared/types';
import { priorityLabel } from '../../../shared/properties';
import { settingsOf, useStore } from '../store';
import { Icon } from '../components/icons';
import { openByCard } from '../cards';
import { boardOfCard } from './boards';
import { SmartBody } from './SmartNode';
import { Picture, isStartFrame } from '../components/wiki/Builder';
import { entryExcerpt } from '../wiki';
import { WORKS_ON } from '../../../shared/wiki';

/** What the tool rail calls each type, and how a node is announced. */
export const TYPE_LABEL: Record<NodeType, string> = {
  text: 'Text', image: 'Image', video: 'Video', card: 'Task', filter: 'Smart Node', container: 'Container',
};

/** The value a freshly placed node starts with. Card, image and video get theirs from their dialogs, so they start empty here. */
export function initialValue(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'text': return { content: '' };
    case 'filter': return { queryId: null, mode: 'horBar' };
    case 'card': case 'image': case 'video': case 'container': return {};
  }
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];
const ALL: Handle[] = ['n', 's', 'e', 'w', ...CORNERS];

/** Resize hit areas per type: containers on every edge and corner, cards (mini) and Smart Nodes fixed. */
export function handlesFor(type: NodeType): Handle[] {
  return type === 'container' ? ALL : type === 'text' || type === 'image' || type === 'video' ? CORNERS : [];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The text a node is announced by. */
export function nodeName(n: BoardNode): string {
  const what = n.type === 'text' ? str(n.value.content) : n.type === 'container' || n.type === 'filter' ? str(n.value.label) : '';
  return what ? `${TYPE_LABEL[n.type]} node: ${what}` : `${TYPE_LABEL[n.type]} node`;
}

export interface NodeViewProps {
  node: BoardNode;
  /** Drag or resize preview in board units; the stored pos stays in the data attributes. */
  preview?: { x: number; y: number; w: number; h: number };
  selected: boolean;
  editing: boolean;
  onCommit: (id: string, value: Record<string, unknown>) => void;
  /** refocus: the edit ended from the keyboard (Enter/Esc), so focus goes back to the node; not on blur. */
  onEndEdit: (id: string, refocus: boolean) => void;
  /** Smart Node: the in-node "Set up filter" button. Absent when the viewer may not edit. */
  onSetup?: (id: string) => void;
  /** A storyboard frame grows with what it shows: its drawn height, whenever that changes. Not stored; lines and the selection use it. */
  onGrow?: (id: string, height: number) => void;
}

/** One node on the board layer. Stored pos goes in data-x/y/w/h/parent/color (the e2e reads those). */
export const NodeView = memo(function NodeView({ node, preview, selected, editing, onCommit, onEndEdit, onSetup, onGrow }: NodeViewProps) {
  const r = preview ?? node.pos;
  // A frame is as tall as its title, text and links need; its stored height is only the least it can be.
  const scene = node.type === 'card' && node.value.mode === 'scene';
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!scene || !el || !onGrow) return;
    const ro = new ResizeObserver(() => onGrow(node.id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scene, node.id, onGrow]);
  return (
    <div ref={box}
      className={`bnode bnode-${node.type}${scene ? ' is-scene' : ''}${selected ? ' is-selected' : ''}${node.color ? ` bc-${node.color}` : ''}`}
      style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, ...(scene ? { minHeight: r.h } : { height: r.h }) }}
      role="group" aria-label={nodeName(node)} tabIndex={0}
      data-node-id={node.id} data-node-type={node.type}
      data-x={node.pos.x} data-y={node.pos.y} data-w={node.pos.w} data-h={node.pos.h}
      data-parent={node.pos.parent ?? ''} data-color={node.color ?? ''}
    >
      <NodeBody node={node} editing={editing} onCommit={onCommit} onEndEdit={onEndEdit} onSetup={onSetup} />
    </div>
  );
});

function NodeBody({ node, editing, onCommit, onEndEdit, onSetup }: Pick<NodeViewProps, 'node' | 'editing' | 'onCommit' | 'onEndEdit' | 'onSetup'>) {
  const v = node.value;
  switch (node.type) {
    case 'text':
      return editing
        ? <InlineEdit multiline label="Text" initial={str(v.content)} onDone={(t, key) => {
            if (t !== null && t !== str(v.content)) onCommit(node.id, { ...v, content: t });
            onEndEdit(node.id, key);
          }} />
        : <div className="bnode-copy">{str(v.content) || <span className="muted">Empty text</span>}</div>;
    case 'container':
      return (
        <div className="bnode-frame">
          {editing
            ? <InlineEdit label="Container label" initial={str(v.label)} onDone={(t, key) => {
                if (t !== null && t.trim() !== str(v.label)) {
                  const { label: _old, ...rest } = v;
                  onCommit(node.id, t.trim() ? { ...rest, label: t.trim() } : rest);
                }
                onEndEdit(node.id, key);
              }} />
            : str(v.label) && <div className="bnode-label">{str(v.label)}</div>}
        </div>
      );
    case 'card': return v.mode === 'scene' ? <SceneBody cardId={str(v.id)} /> : <CardBody cardId={str(v.id)} />;
    case 'filter': {
      const labelSlot = editing
        ? (name: string) => <InlineEdit label="Smart Node label" initial={name} onDone={(t, key) => {
            const next = t === null ? null : t.trim().slice(0, SMART_LABEL_MAX);
            if (next !== null && next !== name) {
              const { label: _old, ...rest } = v;
              onCommit(node.id, next ? { ...rest, label: next } : rest);
            }
            onEndEdit(node.id, key);
          }} />
        : undefined;
      return <SmartBody value={v} labelSlot={labelSlot} onSetup={onSetup && (() => onSetup(node.id))} />;
    }
    case 'image': return <ImageBody url={str(v.url)} />;
    case 'video': return <VideoBody videoId={str(v.videoId)} />;
  }
}

/** A mini card: live title, effort, priority and status colour. A card the viewer can't see (or a deleted one) is not shown. */
function CardBody({ cardId }: { cardId: string }) {
  const card = useStore((s) => s.cards.get(cardId));
  const settings = useStore(settingsOf);
  const hostsBoard = useStore((s) => !!card && !!boardOfCard(s, card.id));
  const resolvables = useStore((s) => s.resolvables);
  const open = useMemo(() => openByCard(resolvables.values()).get(cardId) ?? new Set<ResolvableContext>(), [resolvables, cardId]);
  if (!card || card.visibility === 'deleted') return <div className="bnode-placeholder bcard-gone">Task not available</div>;
  const status = derivedStatus(card, open);
  const prio = card.priority ? priorityLabel(card.priority, settings) : null;
  return (
    <div className={`bcard${status ? ` status-${status}` : ' is-doc'}`}>
      <div className="bcard-title">{titleOf(card.content)}</div>
      <div className="bcard-meta">
        <span className="bcard-code">{taskId(card)}</span>
        {hostsBoard && <span title="Has a board"><Icon name="frame" size={13} /><span className="sr-only">Has a board</span></span>}
        {card.effort !== null && <span className="bcard-effort" title="Effort">{card.effort}</span>}
        {prio && <span className="bcard-prio" title={`${prio} priority`}>{prio}</span>}
        <span className="bcard-status">{status ? STATUS_LABEL[status] : 'Lore'}</span>
      </div>
    </div>
  );
}

/**
 * A storyboard frame: the entry's picture, title and first line, who and what it links to, and a star on the frame
 * its storyline starts with.
 */
function SceneBody({ cardId }: { cardId: string }) {
  const card = useStore((s) => s.cards.get(cardId));
  const links = useStore((s) => s.entryLinks);
  const cards = useStore((s) => s.cards);
  const types = useStore((s) => s.entryTypes);
  // ponytail: one pass over every wiki link per frame card; index the links by source if boards get hundreds of frames.
  const { cast, start } = useMemo(() => {
    const all = [...links.values()];
    const cast = all.filter((l) => l.fromCardId === cardId && l.kindKey !== 'frames' && l.kindKey !== WORKS_ON).map((l) => cards.get(l.toCardId))
      .filter((c): c is NonNullable<typeof c> => !!c && c.visibility !== 'deleted');
    return { cast, start: isStartFrame(all, cardId) };
  }, [links, cards, cardId]);
  if (!card || card.visibility === 'deleted') return <div className="bnode-placeholder bcard-gone">Entry not available</div>;
  // Another storyline on the flow: the story jumps there.
  if (card.entryTypeId && types.get(card.entryTypeId)?.key === 'storyline') {
    return (
      <div className="bcard bscene bjump is-doc">
        <span className="wk-frame-pic"><Picture card={card} /></span>
        <div className="bcard-meta">Continues in</div>
        <div className="bcard-title">{titleOf(card.content)}</div>
        <div className="bscene-text">{entryExcerpt(card)}</div>
      </div>
    );
  }
  return (
    <div className="bcard bscene is-doc">
      <span className="wk-frame-pic"><Picture card={card} />{start && <span className="wk-frame-n" title="The story starts here">★<span className="sr-only">Start</span></span>}</span>
      <div className="bcard-title">{titleOf(card.content)}</div>
      <div className="bscene-text">{entryExcerpt(card) || 'Nothing written yet.'}</div>
      {cast.length > 0 && <span className="wk-facts">{cast.map((c) => <span key={c.id} className="badge">{(c.entryTypeId && types.get(c.entryTypeId)?.icon) || ''} {titleOf(c.content)}</span>)}</span>}
    </div>
  );
}

/** Only /api/files/<id> is shown: a value written by anyone else must not point the browser elsewhere. */
function ImageBody({ url }: { url: string }) {
  return isFileUrl(url)
    ? <img className="bnode-image" src={url} alt="" draggable={false} />
    : <div className="bnode-placeholder">Image not available</div>;
}

/** No embed and no thumbnail (the CSP allows no external requests): a play glyph, the id and a link out. */
function VideoBody({ videoId }: { videoId: string }) {
  const id = isVideoId(videoId) ? videoId : null;
  if (!id) return <div className="bnode-placeholder">Video not available</div>;
  return (
    <div className="bvideo">
      <Icon name="play" size={36} />
      <code className="bvideo-id">{id}</code>
      <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noopener noreferrer">Open on YouTube</a>
    </div>
  );
}

/** A focused input that reports its text on Enter or blur, or null on Esc (`key` tells the two apart). Shift+Enter adds a line when multiline. */
export function InlineEdit({ label, initial, multiline, onDone }: { label: string; initial: string; multiline?: boolean; onDone: (text: string | null, key: boolean) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (t: string | null, key = false) => { if (done.current) return; done.current = true; onDone(t, key); };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation(); // the board's Delete / Ctrl+Z keys stay out of the input
    if (e.key === 'Escape') { e.preventDefault(); finish(null, true); }
    else if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); finish(text, true); }
  };
  const common = {
    ref, value: text, 'aria-label': label, className: 'bnode-input',
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => finish(text), onKeyDown,
    onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}
