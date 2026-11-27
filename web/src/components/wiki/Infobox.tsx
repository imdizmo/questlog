import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card, EntryType, FieldDef } from '../../../../shared/types';
import { seqFromCode, titleOf } from '../../../../shared/cards';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { campaignLore, cardCodeOfHref, entriesOfTypes, formatValue, infoboxFields, projectIdOf, safeColor, usedValues } from '../../wiki';
import { fileUrl } from '../AttachmentsTab';
import { FieldEditor, IMAGE_MIME } from './FieldEditor';
import { useShownPiece, useShownTitle } from '../../translate';
import { pieceKey } from '../../../../shared/translate';

/** Type name with its icon and colour. The icon is text (React escapes it); the colour only if it is #rrggbb. */
export function TypeBadge({ type }: { type: EntryType | null | undefined }) {
  if (!type) return <span className="badge wiki-type" data-testid="type-badge">Page</span>;
  const color = safeColor(type.color);
  return (
    <span className="badge wiki-type" data-testid="type-badge" style={color ? { borderColor: color, color } : undefined}>
      {type.icon && <span aria-hidden>{type.icon}</span>}{type.name}
    </span>
  );
}

/** Looks up entry titles by key within one project. */
export function useTitleOfKey(projectId: string | null) {
  const shownTitle = useShownTitle();
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const byKey = useMemo(() => {
    const m = new Map<string, string>();
    if (projectId) for (const c of campaignLore(cards.values(), projectId, decks)) if (c.entryKey) m.set(c.entryKey, shownTitle(c) || 'Untitled');
    return m;
  }, [cards, decks, projectId, shownTitle]);
  return useCallback((k: string) => byKey.get(k) ?? null, [byKey]);
}

/** A stored value for reading: images as a thumbnail, colours as a swatch, the rest as text. */
function ValueView({ def, v, titleOfKey }: { def: FieldDef; v: unknown; titleOfKey: (k: string) => string | null }) {
  if (def.kind === 'image' && typeof v === 'string' && v) return <img className="wiki-img" src={fileUrl(v)} alt={def.label} />;
  if (def.kind === 'color' && typeof v === 'string') {
    const c = safeColor(v);
    return c ? <span className="wiki-swatch-row"><span className="wiki-swatch" style={{ background: c }} aria-hidden />{c}</span> : <span className="muted">{v}</span>;
  }
  const text = formatValue(def, v, titleOfKey);
  return text ? <>{text}</> : <span className="muted">—</span>;
}

/**
 * The entry's fields (visible ones of its type, inherited first). Editors change each one inline; every save sends a
 * one-key patch to wiki/setEntry.
 */
export function Infobox({ card, type, projectId, editable }: { card: Card; type: EntryType; projectId: string; editable: boolean }) {
  const types = useStore((s) => s.entryTypes);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const files = useStore((s) => s.files);
  const titleOfKey = useTitleOfKey(projectId);
  const shown = useShownPiece(card.id);
  /** A text field's translation, when there is one (editing keeps the original). */
  const translated = (f: FieldDef): string | null => {
    const v = card.fields?.[f.key];
    if ((f.kind !== 'text' && f.kind !== 'longtext') || typeof v !== 'string') return null;
    const t = shown(pieceKey.field(f.key), v);
    return t !== v ? t : null;
  };
  // Rules and scenarios have sections of their own below the text (BalanceSections).
  const defs = useMemo(() => infoboxFields(types, type.id).filter((f) => f.kind !== 'rule' && f.kind !== 'scenario'), [types, type.id]);
  const lore = useMemo(() => campaignLore(cards.values(), projectId, decks), [cards, decks, projectId]);
  const images = useMemo(() => [...files.values()].filter((f) => f.cardId === card.id && IMAGE_MIME.has(f.mime)), [files, card.id]);
  /** Entry candidates per target type, computed once per change of the project's lore. */
  const candidates = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const f of defs) {
      if ((f.kind !== 'entry' && f.kind !== 'entries') || m.has(f.target ?? '')) continue;
      m.set(f.target ?? '', entriesOfTypes(types, lore, f.target ? [f.target] : []).filter((c) => c.id !== card.id));
    }
    return m;
  }, [defs, types, lore, card.id]);
  const save = (key: string, v: unknown) => void dispatch('wiki', 'setEntry', { cardId: card.id, fields: { [key]: v ?? null } }).catch(() => {});

  if (!defs.length) return null;
  return (
    <aside className="infobox" aria-label="Infobox" data-testid="infobox">
      <dl>
        {defs.map((f) => (
          <div key={f.key} className="infobox-row">
            <dt title={f.help}>{f.label}{f.required && <span className="req" aria-label="required">*</span>}</dt>
            <dd>
              {editable ? (
                <span className="infobox-edit">
                  <FieldEditor def={f} value={card.fields?.[f.key]} onSave={(v) => save(f.key, v)} titleOfKey={titleOfKey} images={images}
                    suggestions={f.kind === 'text' ? usedValues(lore, f.key) : undefined}
                    entries={candidates.get(f.target ?? '') ?? []} />
                  {f.unit && <span className="muted">{f.unit}</span>}
                  {translated(f) && <span className="muted infobox-tr">{translated(f)}</span>}
                </span>
              ) : translated(f) ?? <ValueView def={f} v={card.fields?.[f.key]} titleOfKey={titleOfKey} />}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/**
 * Wraps rendered text: hovering (or focusing) a `$code` link to a wiki entry shows its type badge and its first three
 * infobox fields.
 */
export function EntryPreviews({ children }: { children: ReactNode }) {
  const shownTitle = useShownTitle();
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const types = useStore((s) => s.entryTypes);
  const bySeq = useMemo(() => new Map([...cards.values()].map((c) => [c.seq, c])), [cards]);
  const wrap = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ card: Card; anchor: Element; top: number; left: number } | null>(null);
  // References in the previewed entry resolve in that entry's own project.
  const titleOfKey = useTitleOfKey(at ? projectIdOf(decks, at.card) : null);

  const show = (t: EventTarget) => {
    const a = (t as HTMLElement).closest?.('a.card-ref');
    if (!a || !wrap.current) return;
    const code = cardCodeOfHref(a.getAttribute('href') ?? '');
    const seq = code === null ? null : seqFromCode(code);
    const card = seq === null ? undefined : bySeq.get(seq);
    if (!card?.isDoc || card.visibility === 'deleted' || (at?.card === card && at.anchor === a)) return;
    const box = wrap.current.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    setAt({ card, anchor: a, top: r.bottom - box.top + 4, left: r.left - box.left });
  };
  const hide = (t: EventTarget) => { if ((t as HTMLElement).closest?.('a.card-ref')) setAt(null); };
  const type = at?.card.entryTypeId ? types.get(at.card.entryTypeId) : null;
  const defs = type ? infoboxFields(types, type.id).slice(0, 3) : [];

  return (
    <div className="preview-host" ref={wrap} onMouseOver={(e) => show(e.target)} onMouseOut={(e) => hide(e.target)}
      onFocus={(e) => show(e.target)} onBlur={(e) => hide(e.target)}>
      {children}
      {at && (
        <div className="entry-preview" role="tooltip" data-testid="entry-preview" style={{ top: at.top, left: at.left }}>
          <strong>{shownTitle(at.card) || 'Untitled'}</strong> <TypeBadge type={type} />
          {defs.length > 0 && (
            <dl>
              {defs.map((f) => (
                <div key={f.key} className="infobox-row"><dt>{f.label}</dt><dd><ValueView def={f} v={at.card.fields?.[f.key]} titleOfKey={titleOfKey} /></dd></div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
