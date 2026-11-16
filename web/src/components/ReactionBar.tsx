import { useState } from 'react';
import type { Reaction, User } from '../../../shared/types';
import { dispatch } from '../api';

const QUICK = ['👍', '🎉', '✅'];

/** Emoji reactions on one message: quick picks, anything already used, and a box for any other emoji. */
export function ReactionBar({ entryId, reactions, meId, users, disabled }: {
  entryId: string; reactions: Reaction[]; meId: string | undefined; users: Map<string, User>; disabled: boolean;
}) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const emojis = [...QUICK, ...new Set(reactions.map((r) => r.emoji).filter((e) => !QUICK.includes(e)))];

  const toggle = async (emoji: string) => {
    if (busy || disabled) return;
    const mine = reactions.find((r) => r.emoji === emoji && r.userId === meId);
    setBusy(true);
    try {
      if (mine) await dispatch('resolvables', 'removeReaction', { id: mine.id });
      else await dispatch('resolvables', 'addReaction', { entryId, value: { type: 'emoji', value: emoji } });
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const addCustom = () => {
    const v = custom.trim();
    if (!v) return;
    setCustom('');
    void toggle(v);
  };

  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {emojis.map((emoji) => {
        const list = reactions.filter((r) => r.emoji === emoji);
        const mine = list.some((r) => r.userId === meId);
        if (disabled && !list.length) return null;
        const who = list.map((r) => users.get(r.userId)?.name ?? 'Someone').join(', ');
        return (
          <button key={emoji} type="button" className={mine ? 'reaction mine' : 'reaction'} aria-pressed={mine}
            disabled={disabled} title={who || undefined} onClick={() => void toggle(emoji)}>
            {emoji}{list.length > 0 && ` ${list.length}`}
          </button>
        );
      })}
      {!disabled && (
        <input className="reaction-input" aria-label="Add reaction" placeholder="+ 😀" maxLength={8} value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addCustom(); } }} />
      )}
    </div>
  );
}
