import { useState } from 'react';
import type { ResolvableContext } from '../../../shared/types';
import { dispatch } from '../api';
import { Dialog } from './Dialog';

const COPY: Record<ResolvableContext, { title: string; hint: string }> = {
  block: { title: 'Block this task', hint: 'Say what the task is waiting for, if you want. Work stops until someone unblocks it.' },
  review: { title: 'Ask for review', hint: 'Say what should be looked at. The task waits until the review is closed.' },
  comment: { title: 'New comment thread', hint: 'Mention people with @ to add them' },
};

/** Opens a block or review thread with its first message. Send stays off until there is text, except for a block: its reason is optional. */
export function ThreadComposer({ cardId, context, onClose }: { cardId: string; context: ResolvableContext; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const empty = text.trim() === '' && context !== 'block';
  const send = async () => {
    if (empty || busy) return;
    setBusy(true);
    try { await dispatch('resolvables', 'create', { cardId, context, content: text.trim() || 'Blocked.' }); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title={COPY[context].title} onClose={onClose} onSubmit={send} actions={<>
      <span className="hint foot-hint">Ctrl+Enter sends</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={empty || busy}>Send</button>
    </>}>
      <p className="hint">{COPY[context].hint}</p>
      <label className="field">
        <span>{context === 'block' ? 'Reason (optional)' : 'Message'}</span>
        <textarea
          autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
        />
      </label>
    </Dialog>
  );
}
