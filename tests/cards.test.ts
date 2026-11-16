import { describe, expect, it } from 'vitest';
import { allowedActions, cardCode, deckCounts, derivedStatus, seqFromCode, slugOf, titleOf } from '../shared/cards';
import type { Card } from '../shared/types';

type Ctx = 'block' | 'review';
const base = { status: 'not_started', assigneeId: null, isDoc: false, visibility: 'default' } as const;
const none = new Set<Ctx>();

describe('cardCode', () => {
  it('matches observed codes', () => {
    expect(cardCode(5)).toBe('115');
    expect(cardCode(9)).toBe('119');
    expect(cardCode(10)).toBe('11a');
    expect(cardCode(11)).toBe('11c');
    expect(cardCode(12)).toBe('11e');
    expect(cardCode(15)).toBe('11h');
    expect(cardCode(31)).toBe('120');
    expect(cardCode(0)).toBe('110');
  });
  it('is injective and inverted by seqFromCode', () => {
    const seen = new Set<string>();
    for (let seq = 0; seq <= 5000; seq++) {
      const c = cardCode(seq);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
      expect(seqFromCode(c)).toBe(seq);
    }
  });
  it('seqFromCode rejects non-codes', () => {
    expect(seqFromCode('1b1')).toBeNull();
    expect(seqFromCode('')).toBeNull();
    expect(seqFromCode('10')).toBeNull(); // below the offset
    expect(seqFromCode('zzzzzzzzzzzzzzzz')).toBeNull(); // unsafe integer
  });
});

describe('titleOf / slugOf', () => {
  it('titleOf', () => {
    expect(titleOf('# Fog shader\nbody')).toBe('Fog shader');
    expect(titleOf('')).toBe('Untitled');
    expect(titleOf('##   \nx')).toBe('Untitled');
  });
  it('slugOf', () => {
    expect(slugOf('WF-8 Block me!')).toBe('wf-8-block-me');
  });
});

describe('derivedStatus', () => {
  it('cases', () => {
    expect(derivedStatus({ ...base, status: 'started' }, new Set<Ctx>(['block']))).toBe('blocked');
    expect(derivedStatus({ ...base, assigneeId: 'u1' }, none)).toBe('assigned');
    expect(derivedStatus({ ...base, isDoc: true }, none)).toBeNull();
    expect(derivedStatus({ ...base, status: 'done' }, none)).toBe('done');
    expect(derivedStatus({ ...base, status: 'started' }, new Set<Ctx>(['review']))).toBe('review');
    expect(derivedStatus({ ...base, status: 'started' }, none)).toBe('started');
    expect(derivedStatus(base, none)).toBe('unassigned');
  });
});

describe('allowedActions', () => {
  it('open review', () => {
    const a = allowedActions(base, new Set<Ctx>(['review']));
    expect(a.start).toBe(false);
    expect(a.block).toBe(false);
    expect(a.done).toBe(false);
  });
  it('open block', () => {
    expect(allowedActions(base, new Set<Ctx>(['block'])).review).toBe(false);
  });
  it('deleted only restore', () => {
    const a = allowedActions({ ...base, visibility: 'deleted' }, none);
    expect(Object.entries(a).filter(([, v]) => v).map(([k]) => k)).toEqual(['restore']);
  });
  it('not_started can delete, start; not stop/reopen', () => {
    const a = allowedActions(base, none);
    expect(a.delete).toBe(true);
    expect(a.start).toBe(true);
    expect(a.stop).toBe(false);
    expect(a.reopen).toBe(false);
    expect(a.archive).toBe(true);
    expect(a.restore).toBe(false);
  });
  it('started can stop, not start; done reopen', () => {
    expect(allowedActions({ ...base, status: 'started' }, none).stop).toBe(true);
    const d = allowedActions({ ...base, status: 'done' }, none);
    expect(d.reopen).toBe(true);
    expect(d.done).toBe(false);
  });
  it('archived task can be deleted and restored, not archived again', () => {
    const a = allowedActions({ ...base, visibility: 'archived' }, none);
    expect(a.archive).toBe(false);
    expect(a.delete).toBe(true);
    expect(a.restore).toBe(true);
  });
  it('done task offers only reopen (no block/review)', () => {
    const a = allowedActions({ ...base, status: 'done' }, none);
    expect(a.block).toBe(false);
    expect(a.review).toBe(false);
    expect(a.reopen).toBe(true);
  });
  it('doc task', () => {
    const a = allowedActions({ ...base, isDoc: true }, none);
    expect(a.start).toBe(false);
    expect(a.block).toBe(false);
    expect(a.done).toBe(false);
    expect(a.archive).toBe(true);
    expect(a.delete).toBe(true);
    expect(a.toggleDoc).toBe(true);
  });
});

describe('deckCounts', () => {
  it('ignores archived and docs', () => {
    const c = (id: string, o: Partial<Card>) => ({ id, ...base, ...o }) as Card;
    const cards = [
      c('a', {}),
      c('b', { assigneeId: 'u' }),
      c('c', { status: 'started' }),
      c('d', { status: 'started' }),
      c('e', { visibility: 'archived' }),
      c('f', { isDoc: true }),
      c('g', { visibility: 'deleted' }),
    ];
    const r = deckCounts(cards, new Map([['d', new Set<Ctx>(['block'])]]));
    expect(r).toEqual({ unassigned: 1, assigned: 1, started: 1, blocked: 1, review: 0, snoozing: 0, done: 0 });
  });
});

describe('allowedActions hero', () => {
  it('hero cannot block, review or finish', () => {
    const a = allowedActions({ status: 'not_started', isDoc: false, visibility: 'default' }, new Set(), { isHero: true });
    expect(a.block).toBe(false);
    expect(a.review).toBe(false);
    expect(a.done).toBe(false);
    expect(a.start).toBe(true);
  });
});
