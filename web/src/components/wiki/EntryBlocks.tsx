// An entry's page laid out by its blocks (redesign decision 9): text blocks are the `## sections` of its markdown, Facts
// is the infobox, the rest are typed blocks (BlockBody). Half-width blocks sit side by side. Nothing written is hidden:
// text before the first heading comes first, and sections no block names follow the blocks.
import { useMemo, type ReactNode } from 'react';
import type { Asset } from '../../../../shared/assets';
import { bodyOf, placeBlocks, type Placed } from '../../../../shared/blocks';
import { titleOf } from '../../../../shared/cards';
import type { BlockData, Card, EntryLayout, EntryType, Project } from '../../../../shared/types';
import { dispatch } from '../../api';
import { useAssets } from '../../assets';
import { queueContentSave } from '../../contentSave';
import { setCheckLine } from '../../markdown';
import { useStore } from '../../store';
import { fieldsOf } from '../../../../shared/wiki';
import { InlineTitle } from '../InlineTitle';
import { MarkdownView } from '../MarkdownView';
import { BlockBody } from './BlockBody';
import { Infobox } from './Infobox';

const ASSET_KINDS = new Set(['model', 'picture', 'map', 'gallery']);

/** Ticks a checklist item in the newest stored text (as the card page does); the box flips back when that fails. */
function ticker(card: Card) {
  return (line: number, checked: boolean, box: HTMLInputElement) => {
    const clicked = card.content.split('\n')[line];
    let aborted = false;
    queueContentSave(card.id, (cur) => {
      const next = setCheckLine(cur.content, line, checked, clicked);
      if (next === null) { aborted = true; return null; }
      return next === cur.content ? null : { content: next, contentVersion: cur.contentVersion };
    }, card).then(() => { if (aborted) box.checked = !checked; }, () => { box.checked = !checked; });
  };
}

/** The project's assets, read only when the layout has a block that shows one. */
export function useLayoutAssets(layout: EntryLayout, projectId: string): Asset[] | null {
  return useAssets(layout.blocks.some((b) => ASSET_KINDS.has(b.kind)) ? projectId : null).items;
}

export interface EntryBlocksProps {
  /** The entry; null for a made-up example (beside a template). */
  card: Card | null;
  content: string;
  layout: EntryLayout;
  type: EntryType;
  project: Project;
  editable: boolean;
  /** One column (a side panel, or the example beside a template). */
  compact?: boolean;
  titleId?: string;
  /** Opens the text editor (an empty text block's prompt is a way in). */
  onEditText?: () => void;
  /** A made-up example's facts, by field label. */
  exampleFacts?: Record<string, string>;
  /** Shown instead of the title (an example's tag). */
  badge?: ReactNode;
}

export function EntryBlocks({ card, content, layout, type, project, editable, compact, titleId, onEditText, exampleFacts, badge }: EntryBlocksProps) {
  const { body, bodyStart } = bodyOf(content);
  const { intro, placed } = useMemo(() => placeBlocks(layout, body), [layout, body]);
  const assets = useLayoutAssets(layout, project.id);
  const tick = card && editable ? ticker(card) : undefined;
  const save = card && editable
    // `expected`: the data this page shows; if someone saved first, the server says conflict and the page shows theirs
    // (the editor stays open with this person's draft, to save again over it or cancel).
    ? (blockId: string) => (d: BlockData | null) => dispatch('wiki', 'setBlock', { cardId: card.id, blockId, data: d, expected: layout.data[blockId] ?? null })
    : null;

  const text = (p: Placed) => {
    const s = p.section;
    if (s && s.text.trim()) {
      return <MarkdownView content={s.text} lineOffset={bodyStart + s.line + 1} onToggle={tick} card={card} editable={editable} testId="block-text" />;
    }
    const prompt = <p className="bprompt">{p.block.prompt || 'A few lines.'}</p>;
    return editable && onEditText ? <button type="button" className="bprompt-btn" title="Write it" onClick={onEditText}>{prompt}</button> : prompt;
  };

  return (
    <div className="eblocks">
      <div className="eblocks-head">
        {badge}
        <h2 id={titleId} className="card-heading"><InlineTitle text={titleOf(content)} links={!!card} /></h2>
      </div>
      {intro.trim() && <MarkdownView content={intro} lineOffset={bodyStart} onToggle={tick} card={card} editable={editable} testId="block-intro" />}
      <div className={compact ? 'egrid one' : 'egrid'} data-testid="entry-blocks">
        {placed.map((p) => (
          <section key={p.block.id} className={`eblk ${compact ? 'full' : p.block.width}`} aria-label={p.block.title} data-kind={p.block.kind}>
            {p.block.kind !== 'facts' && <h3 className="hd2">{p.block.title}</h3>}
            {p.block.kind === 'text' ? text(p)
              : p.block.kind === 'facts' ? (card ? <FactsOf card={card} type={type} project={project} editable={editable} /> : <ExampleFacts type={type} values={exampleFacts ?? {}} />)
              : <BlockBody block={p.block} data={layout.data[p.block.id]} type={type} project={project} assets={assets} card={card} onSave={save?.(p.block.id)} />}
          </section>
        ))}
      </div>
    </div>
  );
}

/** The entry's fields; a type with none says so instead of leaving a blank. */
function FactsOf({ card, type, project, editable }: { card: Card; type: EntryType; project: Project; editable: boolean }) {
  const types = useStore((s) => s.entryTypes);
  const any = fieldsOf(types, type.id).some((f) => !f.hidden);
  return any ? <Infobox card={card} type={type} projectId={project.id} editable={editable} /> : <p className="bprompt">{type.name} has no fields yet.</p>;
}

/** A made-up example's facts: each visible field with the example's value, else its kind in grey. */
function ExampleFacts({ type, values }: { type: EntryType; values: Record<string, string> }) {
  const types = useStore((s) => s.entryTypes);
  const defs = fieldsOf(types, type.id).filter((f) => !f.hidden && f.inInfobox !== false && f.kind !== 'rule' && f.kind !== 'scenario');
  if (!defs.length) return <p className="bprompt">{type.name} has no fields yet.</p>;
  return (
    <dl className="bfacts">
      {defs.map((f) => (
        <div key={f.key} className="bfacts-row">
          <dt>{f.label}</dt>
          <dd className={values[f.label] ? '' : 'ph'}>{values[f.label] ?? placeholderOf(f.kind)}</dd>
        </div>
      ))}
    </dl>
  );
}

const placeholderOf = (kind: string): string => ({
  integer: 'a whole number', number: 'a number', boolean: 'yes or no', enum: 'one of a list', multienum: 'some of a list', entry: 'an entry',
  entries: 'entries', range: 'from–to', image: 'a picture', color: 'a colour', table: 'a table', longtext: 'text', text: 'text',
} as Record<string, string>)[kind] ?? '…';
