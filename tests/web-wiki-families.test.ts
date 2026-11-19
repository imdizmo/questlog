// The Wiki's Types page on the client: its routes and the families collection of the store.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store } from '../web/src/store';
import { parse } from '../web/src/router';
import { typesPath } from '../web/src/wiki';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Types routes', () => {
  it('parses the Types page with and without a type', () => {
    expect(parse('/wiki/3/view/types')).toEqual({ name: 'wikiTypes', projectSeq: 3, typeKey: null });
    expect(parse('/wiki/3/types/item')).toEqual({ name: 'wikiTypes', projectSeq: 3, typeKey: 'item' });
    expect(parse('/wiki/3/types/item/x')).toEqual({ name: 'notFound', path: '/wiki/3/types/item/x' });
    // An entry may be keyed "types": /wiki/3/types stays its page.
    expect(parse('/wiki/3/types')).toEqual({ name: 'wikiEntry', projectSeq: 3, entry: 'types' });
    expect(parse('/wiki/3/view/links')).toEqual({ name: 'wikiView', projectSeq: 3, view: 'links' });
    expect(typesPath(3)).toBe('/wiki/3/view/types');
    expect(typesPath(3, 'item')).toBe('/wiki/3/types/item');
  });
});

describe('families in the store', () => {
  it('load, upsert, remove, and go with a project that goes', async () => {
    const project = (id: string, seq: number) => ({ id, seq, name: id, visibility: 'full', isArchived: false, spaces: [], createdAt: 0 });
    const snap = {
      me: { id: 'u1', email: 'a@x', name: 'A', timezone: null, disabled: false, createdAt: 0 },
      account: { id: 'a', name: 'W', settings: {} }, users: [{ id: 'u1' }], accountRoles: [{ userId: 'u1', role: 'owner' }],
      projects: [project('p1', 1), project('p2', 2)],
      entryFamilies: [{ id: 'f1', projectId: 'p1', name: 'Items', color: '#b8862f', sortIndex: 1 }, { id: 'f2', projectId: 'p2', name: 'Story', color: '#8a4fb0', sortIndex: 1 }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snap), { status: 200 })));
    const s = new Store();
    await s.load();
    expect([...s.get().entryFamilies.keys()]).toEqual(['f1', 'f2']);
    s.apply([{ model: 'entryFamily', op: 'upsert', row: { id: 'f1', projectId: 'p1', name: 'Gear', color: '#b8862f', sortIndex: 1 } }]);
    expect(s.get().entryFamilies.get('f1')?.name).toBe('Gear');
    s.apply([{ model: 'entryFamily', op: 'remove', row: { id: 'f2', projectId: 'p2' } }]);
    expect([...s.get().entryFamilies.keys()]).toEqual(['f1']);
    s.apply([{ model: 'project', op: 'remove', row: { id: 'p1' } }]);
    expect(s.get().entryFamilies.size).toBe(0);
  });
});
