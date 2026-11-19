import { useEffect, useMemo, useState } from 'react';
import type { Card, Project } from '../../../../shared/types';
import type { ChecksResult } from '../../../../shared/wiki';
import { titleOf } from '../../../../shared/cards';
import { useStore } from '../../store';
import { Link } from '../../router';
import { Dialog } from '../Dialog';
import { cardHref } from '../../cards';
import { campaignChecks, campaignLore, checkGroups, checksBadgeText, checksTruncatedText, entryPath } from '../../wiki';

/** "⚠ N checks" for the Wiki header; it opens the checks panel. Nothing shows while every check passes. */
export function ChecksBadge({ project }: { project: Project }) {
  // campaignChecks is memoised on the store collections, so this selector is cheap on unrelated changes.
  const checks = useStore((s) => campaignChecks(s, project.id));
  const [open, setOpen] = useState(false);
  // All fixed (here or elsewhere) while open: close, so the panel doesn't pop up by itself when a new check appears.
  useEffect(() => { if (!checks.total) setOpen(false); }, [checks.total]);
  if (!checks.total) return null;
  return (
    <>
      <button type="button" className="btn btn-sm wiki-checks-badge" onClick={() => setOpen(true)}>
        {checksBadgeText(checks)}
      </button>
      {open && <ChecksPanel project={project} checks={checks} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Value problem codes (shared/wiki.ts validateValue) in words; the rest of a check's detail is shown as it is. */
const CODE_TEXT: Record<string, string> = {
  wrong_kind: 'not the right kind of value', below_min: 'below the minimum', above_max: 'above the maximum',
  not_an_option: 'not one of the options', broken_ref: 'points at missing lore', wrong_type_ref: 'points at lore of the wrong type',
  not_ascending: 'numbers of a key must go up', too_large: 'too large',
};
const readable = (detail: string) => detail.replace(/: (wrong_kind|below_min|above_max|not_an_option|broken_ref|wrong_type_ref|not_ascending|too_large)$/, (_, c: string) => `: ${CODE_TEXT[c]}`);

/** The project's failing checks (the first CHECKS_LIMIT), grouped by problem; each names its entry and links to it. */
export function ChecksPanel({ project, checks: result, onClose }: { project: Project; checks: ChecksResult; onClose: () => void }) {
  const checks = result.checks;
  const cut = checksTruncatedText(result);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const groups = useMemo(() => checkGroups(checks), [checks]);
  // A check names its entry by key, or by card id when the source has none (a quest, or a missing card).
  const byKey = useMemo(() => {
    const m = new Map<string, Card>();
    for (const c of campaignLore(cards.values(), project.id, decks)) if (c.entryKey && !m.has(c.entryKey)) m.set(c.entryKey, c);
    return m;
  }, [cards, decks, project.id]);
  const link = (entry: string) => {
    const card = byKey.get(entry) ?? cards.get(entry);
    if (!card) return <code>{entry}</code>;
    // A quest (the source of a works_on link) opens as a quest; lore opens its wiki page.
    const href = card.isDoc ? entryPath(project.seq, card) : cardHref(card, card.deckId ? decks.get(card.deckId) : null);
    return <Link href={href} onClick={onClose}>{titleOf(card.content) || entry}</Link>;
  };
  return (
    <Dialog title={`Checks · ${project.name}`} wide scroll onClose={onClose}
      actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {cut && <p className="muted" data-testid="checks-truncated">{cut}</p>}
      {groups.map((g) => (
        <section key={g.problem} className="wiki-checks-group" aria-label={g.label}>
          <h3 className="sub">{g.label} <span className="muted">{g.items.length}</span></h3>
          <ul className="wiki-checks-list">
            {g.items.map((c, i) => <li key={i}>{link(c.entry)} <span className="muted">{readable(c.detail)}</span></li>)}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
