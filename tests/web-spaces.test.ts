import { describe, it, expect } from 'vitest';
import { addSpace, fieldsFor, kindOf, moveSpace, removeSpace, spaceLabel, updateSpace } from '../web/src/spaces';
import type { Space } from '../shared/types';

const base: Space[] = [{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }];

describe('web area helpers', () => {
  it('prepends new areas with id max+1 and the type list type', () => {
    const a = addSpace(base, { kind: 'Knowledge', customName: '' });
    expect(a[0]).toEqual({ id: 2, name: 'Knowledge', icon: null, defaultDeckType: 'doc' });
    const b = addSpace(a, { kind: 'Custom', customName: ' Art ' });
    expect(b.map((s) => s.id)).toEqual([3, 2, 1]);
    expect(b[0]).toMatchObject({ name: 'Art', defaultDeckType: 'mixed' });
    expect(addSpace(b, { kind: 'GDD', customName: '' })[0].defaultDeckType).toBe('asset');
    expect(fieldsFor({ kind: 'QA', customName: 'x' })).toEqual({ name: 'QA', defaultDeckType: 'task' });
  });

  it('labels and kinds', () => {
    expect(spaceLabel(base[0])).toBe('General');
    expect(kindOf({ name: 'Tasks' })).toBe('Tasks');
    expect(kindOf({ name: 'Art' })).toBe('Custom');
    expect(kindOf({ name: null })).toBe('Custom');
  });

  it('updates, removes and moves', () => {
    const s = addSpace(addSpace(base, { kind: 'Tasks', customName: '' }), { kind: 'QA', customName: '' }); // [3,2,1]
    expect(updateSpace(s, 1, { kind: 'GDD', customName: '' })[2]).toMatchObject({ id: 1, name: 'GDD', defaultDeckType: 'asset' });
    expect(removeSpace(s, 2).map((x) => x.id)).toEqual([3, 1]);
    expect(moveSpace(s, 3, 2).map((x) => x.id)).toEqual([2, 1, 3]);
    expect(moveSpace(s, 1, 0).map((x) => x.id)).toEqual([1, 3, 2]);
    expect(moveSpace(s, 9, 0)).toBe(s);
  });
});
