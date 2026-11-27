// An entry's page laid out by its blocks (redesign decision 9): text blocks are the `## sections` of its markdown, Facts
// is the infobox, the rest are typed blocks (BlockBody). Half-width blocks sit side by side. Nothing written is hidden:
// text before the first heading comes first, and sections no block names follow the blocks.
import { useEffect, useMemo, type ReactNode } from 'react';
import type { Asset } from '../../../../shared/assets';
import { bodyOf, placeBlocks, splitSections, type Placed } from '../../../../shared/blocks';
import { titleOf } from '../../../../shared/cards';
import type { BlockData, Card, EntryLayout, EntryType, Project } from '../../../../shared/types';
import { dispatch } from '../../api';
import { useAssets } from '../../assets';
import { queueContentSave } from '../../contentSave';
import { setCheckLine } from '../../markdown';
import { useStore } from '../../store';
import { fieldsOf } from '../../../../shared/wiki';
import { InlineTitle } from '../InlineTitle';
import { TranslatedLine } from '../TranslatedLine';
import { openForTranslation, shownContent, useReadLang, useShowOriginal, type Shown } from '../../translate';
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
  const laid = useMemo(() => placeBlocks(layout, body), [layout, body]);
  const tr = useShownEntry(card, content);
  // Blocks are placed by the original's headings; a translation fills them section by section (same count, same order).
  const { intro, placed, title, translated } = useMemo(() => {
    const plain = { ...laid, title: titleOf(content), translated: false };
    if (tr.shown.text === content) return plain;
    const orig = splitSections(body), into = splitSections(bodyOf(tr.shown.text).body);
    if (orig.sections.length !== into.sections.length) return plain;
    const at = (line: number) => orig.sections.findIndex((x) => x.line === line);
    return {
      translated: true,
      title: titleOf(tr.shown.text),
      intro: into.intro,
      placed: laid.placed.map((p): Placed => {
        if (!p.section) return p;
        const t = into.sections[at(p.section.line)];
        return { ...p, block: p.extra ? { ...p.block, title: t.heading } : p.block, section: { ...p.section, text: t.text } };
      }),
    };
  }, [laid, content, body, tr.shown.text]);
  const assets = useLayoutAssets(layout, project.id);
  // Ticking works on the original's lines: only while the original is what is shown.
  const tick = card && editable && !translated ? ticker(card) : undefined;
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
        <h2 id={titleId} className="card-heading"><InlineTitle text={title} links={!!card} /></h2>
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
      {/* A translation whose sections don't line up with the original's is not shown, so neither is its line. */}
      {card && (translated || tr.showOriginal || tr.shown.pending) && (
        <TranslatedLine shown={tr.shown} showOriginal={tr.showOriginal} canTranslate={tr.canTranslate} onToggle={tr.toggle} />
      )}
    </div>
  );
}

/** The entry's text in the reader's language (none for a made-up example), and the "Show original" toggle. */
function useShownEntry(card: Card | null, content: string): { shown: Shown; showOriginal: boolean; canTranslate: boolean; toggle: () => void } {
  const [readLang] = useReadLang();
  const translations = useStore((s) => s.translations);
  const account = useStore((s) => s.account);
  const [showOriginal, toggle] = useShowOriginal(`card:${card?.id ?? ''}`);
  const st = { translations, account };
  const translated = card ? shownContent(card, readLang, false, st) : { text: content, from: null, pending: false };
  useEffect(() => {
    if (card && translated.pending) openForTranslation('card', card.id, card.contentVersion);
  }, [card?.id, card?.contentVersion, translated.pending]);
  const shown = showOriginal || !card ? { text: content, from: null, pending: false } : translated;
  return { shown, showOriginal, canTranslate: !!translated.from, toggle };
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
