// Pieces the rule and scenario editors share: the draft of a stored value, the roles list, rows of named formulas.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Card, FieldDef, FormulaRole } from '../../../../shared/types';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { campaignChecks } from '../../wiki';
import type { Lookup } from '../../balance';
import { Icon } from '../icons';

/**
 * The draft of a rule or scenario field: edits change it at once (the live example and checks follow), `save` sends
 * it whole to wiki/setEntry when it differs from the stored value. A stored value that changes elsewhere replaces the
 * draft, but the echo of our own save does not (typing on in another box meanwhile is kept).
 */
export function useBalanceDraft<T>(card: Card, def: FieldDef, read: (v: unknown) => T | null, empty: () => T) {
  const stored = card.fields?.[def.key];
  const storedJson = canonical(stored ?? null);
  const [draft, setDraftState] = useState<T | null>(() => (stored == null ? empty() : read(stored)));
  const ref = useRef(draft);
  /** The last few values sent and not yet seen back (a quick second save must not be undone by the first one's echo). */
  const sent = useRef<SentValue[]>([]);
  const storedRef = useRef(storedJson);
  storedRef.current = storedJson;
  /** True while the draft holds edits that were not sent. */
  const dirty = useRef(false);
  useEffect(() => {
    const r = onStored(sent.current, storedJson, Date.now());
    sent.current = r.sent;
    if (!r.reset) return;
    const next = stored == null ? empty() : read(stored);
    ref.current = next;
    dirty.current = false;
    setDraftState(next);
  }, [storedJson]);
  const set = (next: T) => { ref.current = next; dirty.current = true; setDraftState(next); };
  const save = (next: T | null = ref.current) => {
    if (next === null) return;
    dirty.current = false;
    const json = canonical(next);
    if (json === storedRef.current || json === sent.current[sent.current.length - 1]?.json) return;
    sent.current = [...sent.current, { json, at: Date.now() }].slice(-SENT_KEPT);
    void dispatch('wiki', 'setEntry', { cardId: card.id, fields: { [def.key]: next } })
      .catch(() => { sent.current = sent.current.filter((x) => x.json !== json); });
  };
  // Leaving the page (or the entry) with unsaved edits saves them.
  useEffect(() => () => { if (dirty.current) save(); }, []);
  /** Changes the draft and saves at once (a pick from a list, a button). */
  const setAndSave = (next: T) => { set(next); save(next); };
  /** Starts over with an empty value when the stored one can't be read. */
  const replace = () => set(empty());
  return { draft, set, save, setAndSave, replace, stored };
}

/** JSON with object keys sorted: the server may store a value's keys in another order than they were sent. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** Values sent and not yet echoed back, kept at most. */
const SENT_KEPT = 8;
/**
 * A sent value not echoed back within this long is forgotten: the server may have stored something else, or its echo
 * was folded into a later change. Waiting for it longer would ignore teammates' changes and let a stale draft
 * overwrite them on the next save.
 */
export const SENT_MAX_AGE_MS = 3_000;
/** A value we sent (canonical JSON) and when. */
export interface SentValue { json: string; at: number }

/**
 * What a newly stored value means for the draft, given what we sent: an echo of one of ours clears it and the ones
 * before it (no reset); anything else resets the draft unless one of ours, sent in the last SENT_MAX_AGE_MS, is still
 * on the way (an older value arriving before our echo). Old entries are dropped first.
 */
export function onStored(sent: readonly SentValue[], storedJson: string, now: number): { sent: SentValue[]; reset: boolean } {
  const fresh = sent.filter((x) => now - x.at <= SENT_MAX_AGE_MS);
  const i = sent.findIndex((x) => x.json === storedJson);
  if (i >= 0) return { sent: sent.slice(i + 1).filter((x) => now - x.at <= SENT_MAX_AGE_MS), reset: false };
  return { sent: fresh, reset: fresh.length === 0 };
}

/** Checks of this field that its inline marks don't show (loops, broken callees, examples, names left out). */
export function useFieldChecks(card: Card, def: FieldDef, projectId: string, inline: (rest: string) => boolean): string[] {
  const checks = useStore((s) => campaignChecks(s, projectId));
  const entry = card.entryKey ?? card.id;
  const prefix = `${def.key}: `;
  return checks.checks.filter((c) => c.entry === entry && c.detail.startsWith(prefix) && !inline(c.detail.slice(prefix.length))).map((c) => c.detail.slice(prefix.length));
}

/** The note shown instead of an editor when the stored value is not a rule/scenario the editor can read. */
export function Unreadable({ what, onReplace }: { what: string; onReplace: () => void }) {
  return (
    <div className="balance-unreadable">
      <p className="hint" role="status">This value is not a {what} the editor can read, so it is left as it is (the checks list it).</p>
      <button type="button" className="btn btn-sm" onClick={onReplace}>Replace it with a new {what}</button>
    </div>
  );
}

/** Up, down and remove buttons of a row in a list. */
export function RowButtons({ label, index, count, onMove, onRemove }: { label: string; index: number; count: number; onMove: (to: number) => void; onRemove: () => void }) {
  return (
    <span className="balance-row-buttons">
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(index - 1)}><Icon name="up" size={14} /></button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}><Icon name="down" size={14} /></button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={14} /></button>
    </span>
  );
}

export const moved = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
};
export const replaced = <T,>(list: T[], i: number, x: T): T[] => list.map((y, j) => (j === i ? x : y));

/** A name box that saves on leaving it. */
export function NameInput({ label, value, onChange, onBlur, problem, placeholder }: { label: string; value: string; onChange: (v: string) => void; onBlur: () => void; problem?: string | null; placeholder?: string }) {
  return (
    <span className="balance-name">
      <input type="text" className="balance-name-input" aria-label={label} value={value} placeholder={placeholder} spellCheck={false}
        aria-invalid={problem ? true : undefined} title={problem ?? undefined}
        onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onBlur(); } }} />
      {problem && <span className="formula-problems balance-name-problem">{problem}</span>}
    </span>
  );
}

/**
 * The roles of a rule or scenario: a name used in formulas and the type of entry it stands for. Renaming or removing a
 * role is not followed in the formulas: their checks show where the old name is still used.
 */
export function RolesEditor({ roles, problems, lookup, editable, max, onChange, onSave }: {
  roles: FormulaRole[]; problems: (string | null)[]; lookup: Lookup; editable: boolean; max: number;
  onChange: (r: FormulaRole[]) => void; onSave: (r?: FormulaRole[]) => void;
}) {
  if (!editable) {
    return <p className="balance-roles-read">{roles.length ? roles.map((r) => `${r.name} (${lookup.typeName(r.type)})`).join(', ') : 'No roles'}</p>;
  }
  return (
    <div className="balance-roles" role="group" aria-label="Roles">
      {roles.map((r, i) => (
        <div key={i} className="balance-role">
          <NameInput label={`Role ${i + 1} name`} value={r.name} placeholder="attacker" problem={problems[i]}
            onChange={(name) => onChange(replaced(roles, i, { ...r, name }))} onBlur={() => onSave()} />
          <span className="muted">is a</span>
          <select aria-label={`Role ${i + 1} type`} value={r.type} onChange={(e) => { const next = replaced(roles, i, { ...r, type: e.target.value }); onChange(next); onSave(next); }}>
            <option value="">Pick a type…</option>
            {lookup.types.map((t) => <option key={t.id} value={t.key}>{t.name}</option>)}
            {r.type && !lookup.typeFields(r.type) && <option value={r.type}>{r.type} (missing)</option>}
          </select>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove role ${r.name || i + 1}`} onClick={() => { const next = roles.filter((_, j) => j !== i); onChange(next); onSave(next); }}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      {roles.length < max && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...roles, { name: '', type: '' }])}><Icon name="plus" size={14} /> Add role</button>
      )}
    </div>
  );
}

/** A titled block of an editor. */
export function Block({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="balance-block" role="group" aria-label={title}>
      <h4 className="balance-block-title">{title}</h4>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  );
}
