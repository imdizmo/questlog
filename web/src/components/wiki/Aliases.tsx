import { useId, useMemo, useState } from 'react';
import type { Card } from '../../../../shared/types';
import { titleOf } from '../../../../shared/cards';
import { ambiguousNames, nameKey, nameSourceOf } from '../../../../shared/autolink';
import { api, ApiError, messageFor } from '../../api';
import { store, useStore } from '../../store';
import { campaignLore, projectIdOf } from '../../wiki';
import { useShownTitle } from '../../translate';

/** The server's reason, in plain words (wiki/setAliases). */
export function aliasError(e: unknown): string {
  if (!(e instanceof ApiError)) return messageFor('network');
  const data = (e.data ?? {}) as { message?: unknown; maxChars?: unknown; max?: unknown };
  if (typeof data.message === 'string') return data.message;
  if (e.code === 'invalid_payload' && typeof data.maxChars === 'number') return `An alias can have at most ${data.maxChars} characters.`;
  if (e.code === 'limit' && typeof data.max === 'number') return `An entry can have at most ${data.max} aliases.`;
  return messageFor(e.code);
}

/**
 * Other names of an entry ("Also called"), recognised in text like its title. Chips with × and an add field for
 * editors; read-only chips for others (nothing when there are none).
 */
export function Aliases({ card, editable }: { card: Card; editable: boolean }) {
  const shownTitle = useShownTitle();
  const aliases = card.aliases ?? [];
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errId = useId();
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  // Names of this entry that another entry of the campaign also has: neither links until one changes.
  const shared = useMemo(() => {
    const projectId = projectIdOf(decks, card);
    if (!projectId) return [];
    const lore = campaignLore(cards.values(), projectId, decks);
    return ambiguousNames(lore.map(nameSourceOf)).filter((a) => a.cardIds.includes(card.id)).map((a) => ({
      name: a.name,
      others: a.cardIds.filter((id) => id !== card.id).map((id) => { const c = cards.get(id); return c ? shownTitle(c) : ''; }),
    }));
  }, [cards, decks, card]);
  if (!editable && aliases.length === 0) return null;

  /**
   * Saves one change on top of the newest aliases the store holds (a teammate's add or remove that arrived meanwhile
   * is kept): the server only takes the whole list.
   */
  const save = async (change: (current: string[]) => string[]) => {
    setBusy(true);
    setError(null);
    try {
      const current = store.get().cards.get(card.id)?.aliases ?? aliases;
      await api.setAliases(card.id, change(current));
      return true;
    } catch (e) {
      setError(aliasError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const a = draft.trim();
    if (!a || busy) return;
    const key = nameKey(a);
    const latest = store.get().cards.get(card.id) ?? card;
    if (key === nameKey(titleOf(latest.content)) || (latest.aliases ?? []).some((x) => nameKey(x) === key)) {
      setError('Already a name of this entry.');
      return;
    }
    if (await save((current) => [...current, a])) setDraft('');
  };

  return (
    <div className="entry-aliases" role="group" aria-label="Aliases" data-testid="aliases">
      <span className="hint">Also called</span>
      {aliases.map((a) => (
        <span key={a} className="chip alias-chip">
          {a}
          {editable && (
            <button type="button" className="chip-x" aria-label={`Remove alias ${a}`} disabled={busy}
              onClick={() => void save((current) => current.filter((x) => x !== a))}>×</button>
          )}
        </span>
      ))}
      {aliases.length === 0 && <span className="hint">no other names</span>}
      {editable && (
        <form className="alias-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="input input-sm" aria-label="New alias" placeholder="Add a name…" value={draft} maxLength={200}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
            onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }} />
          <button type="submit" className="btn btn-sm" disabled={busy || !draft.trim()}>Add</button>
        </form>
      )}
      {error && <p className="field-error alias-error" id={errId} role="alert">{error}</p>}
      {shared.map((x) => (
        <p key={x.name} className="alias-warn" data-testid="alias-shared">
          "{x.name}" is also the name of {x.others.join(', ')}: neither will link until one changes.
        </p>
      ))}
    </div>
  );
}
