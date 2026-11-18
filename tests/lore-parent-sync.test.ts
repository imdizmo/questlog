import { describe, it, expect } from 'vitest';
import { MAX_SENT, noteSent, syncFromParent } from '../web/src/lore/parentSync';

describe('syncFromParent', () => {
  it('an echo of the latest report changes nothing and clears the queue', () => {
    expect(syncFromParent('ab', 'ab', ['a', 'ab'])).toEqual({ replace: false, sent: [] });
  });
  it('a late echo, overtaken by typing, neither reverts nor reorders the text', () => {
    // Typed "a", then "b" before the parent showed "a" back.
    expect(syncFromParent('a', 'ab', ['a', 'ab'])).toEqual({ replace: false, sent: ['ab'] });
  });
  it('the editor’s own text changes nothing', () => {
    expect(syncFromParent('x', 'x', [])).toEqual({ replace: false, sent: [] });
  });
  it('a genuinely new text (a "Create another" template) replaces the state', () => {
    expect(syncFromParent('## Template', 'My first card', ['My first car', 'My first card'])).toEqual({ replace: true, sent: [] });
    expect(syncFromParent('', 'typed', [])).toEqual({ replace: true, sent: [] });
  });
});

describe('noteSent', () => {
  it('queues reports once each and keeps at most MAX_SENT', () => {
    expect(noteSent(noteSent(['a'], 'ab'), 'ab')).toEqual(['a', 'ab']);
    let q: string[] = [];
    for (let i = 0; i < MAX_SENT + 10; i++) q = noteSent(q, String(i));
    expect(q.length).toBe(MAX_SENT);
    expect(q[q.length - 1]).toBe(String(MAX_SENT + 9));
  });
});
