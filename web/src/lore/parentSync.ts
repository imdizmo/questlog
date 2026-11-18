/** At most this many reported texts wait for the parent to show them back. */
export const MAX_SENT = 50;

/**
 * What the editor does with a `value` from its parent, given the editor's text `doc` and `sent`,
 * the texts it reported through onChange that the parent hasn't shown back yet (oldest first).
 *
 * - An echo of a reported text, even a late one that typing has since overtaken, changes nothing
 *   (replaying it would revert or reorder what was typed); it and the older ones are done.
 * - The editor's own text changes nothing either.
 * - Anything else is a new text from the parent (a template, a restored draft): `replace`.
 *
 * Limit: a parent that resets to a text still in the queue would be ignored; today no caller does this.
 */
export function syncFromParent(value: string, doc: string, sent: readonly string[]): { replace: boolean; sent: string[] } {
  const i = sent.lastIndexOf(value);
  if (i >= 0) return { replace: false, sent: sent.slice(i + 1) };
  if (value === doc) return { replace: false, sent: [...sent] };
  return { replace: true, sent: [] };
}

/** `sent` with `text` reported, keeping at most MAX_SENT. */
export function noteSent(sent: readonly string[], text: string): string[] {
  const next = sent[sent.length - 1] === text ? [...sent] : [...sent, text];
  return next.length > MAX_SENT ? next.slice(next.length - MAX_SENT) : next;
}
