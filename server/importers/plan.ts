/** What an importer produces (server/importers/*) and server/commands/imports.ts writes: decks, cards, milestones. */

/** Longest card text an import writes; longer descriptions are cut. */
const MAX_CONTENT = 200_000;

export interface PlanCard {
  key: string;
  deckKey: string;
  content: string;
  /** Tag names as found in the source; normalized on import. */
  tags: string[];
  /** Who should own the card: matched against members by exact email or name, else no owner. */
  owner: { names: string[]; emails: string[] } | null;
  dueDate: string | null;
  priority: 'a' | 'b' | 'c' | null;
  effort: number | null;
  /** Hero card (by key) this card is a sub card of. */
  parentKey: string | null;
  milestoneKey: string | null;
  done: boolean;
}
export interface ImportPlan {
  decks: { key: string; title: string }[];
  cards: PlanCard[];
  milestones: { key: string; name: string; date: string | null }[];
}

/** Card text: `# title`, the description, each checklist as Markdown checkboxes, then links (attachments, covers). */
export function cardContent(o: {
  title: string; description?: string | null;
  checklists?: { name: string; items: { text: string; done: boolean }[] }[];
  links?: { name: string; url: string }[];
}): string {
  const line = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const parts = [`# ${line(o.title) || 'Untitled'}`];
  if (o.description?.trim()) parts.push(o.description.trim());
  for (const c of o.checklists ?? []) {
    if (!c.items.length) continue;
    const items = c.items.map((i) => `- [${i.done ? 'x' : ' '}] ${line(i.text) || '…'}`).join('\n');
    parts.push(c.name.trim() ? `**${line(c.name)}**\n${items}` : items);
  }
  const links = (o.links ?? []).filter((l) => /^https?:\/\//i.test(l.url));
  if (links.length) {
    const esc = (s: string) => line(s).replace(/[[\]]/g, '');
    const href = (u: string) => u.replace(/[\s()<>]/g, (ch) => encodeURIComponent(ch));
    parts.push(['Attachments:', ...links.map((l) => `- [${esc(l.name) || 'link'}](${href(l.url)})`)].join('\n'));
  }
  const text = parts.join('\n\n');
  return text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) : text;
}

/** YYYY-MM-DD from an ISO timestamp or date, else null. */
export function dayOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (!m) return null;
  const t = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== m[1] ? null : m[1];
}
