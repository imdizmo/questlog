import { describe, expect, it } from 'vitest';
import { MAX_SELECTED, readPeerState } from '../web/src/board/Presence';

describe('readPeerState', () => {
  it('reads a well-formed state', () => {
    expect(readPeerState({ cursor: { id: 'u1', pos: { x: 1, y: 2 } }, selection: { id: 'u1', nodeIds: ['a', 'b'] } }))
      .toEqual({ userId: 'u1', cursor: { x: 1, y: 2 }, nodeIds: ['a', 'b'] });
  });
  it('removes duplicate node ids and caps the list', () => {
    expect(readPeerState({ selection: { id: 'u1', nodeIds: ['a', 'a', 'a', 'b'] } })?.nodeIds).toEqual(['a', 'b']);
    const many = Array.from({ length: 500 }, (_, i) => `n${i}`);
    expect(readPeerState({ selection: { id: 'u1', nodeIds: many } })?.nodeIds).toHaveLength(MAX_SELECTED);
  });
  it('rejects untrusted shapes', () => {
    expect(readPeerState(null)).toBeNull();
    expect(readPeerState({})).toBeNull();
    expect(readPeerState({ cursor: { id: 'u1' }, selection: { id: 'u2', nodeIds: [] } })).toBeNull();
    expect(readPeerState({ cursor: { id: 'u1', pos: { x: NaN, y: 2 } } })).toEqual({ userId: 'u1', cursor: null, nodeIds: [] });
    expect(readPeerState({ cursor: { id: 'u1', pos: { x: 1e12, y: 2 } } })?.cursor).toBeNull();
    expect(readPeerState({ selection: { id: 'u1', nodeIds: ['ok', '<b>', 5, 'x'.repeat(65)] } })?.nodeIds).toEqual(['ok']);
  });
});
