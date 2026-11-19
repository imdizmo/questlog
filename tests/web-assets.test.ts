import { describe, expect, it } from 'vitest';
import { parse } from '../web/src/router';

// The Assets page's addresses (web/src/views/assets/).
describe('assets routes', () => {
  it('parses /assets and a project\'s assets by its seq', () => {
    expect(parse('/assets')).toEqual({ name: 'assets' });
    expect(parse('/assets/3')).toEqual({ name: 'assetsProject', projectSeq: 3 });
    expect(parse('/assets/0').name).toBe('notFound');
    expect(parse('/assets/x').name).toBe('notFound');
    expect(parse('/assets/3/more').name).toBe('notFound');
  });
});

describe('the library browsers\' picture cache', async () => {
  const { PictureUrls } = await import('../web/src/pictureUrls');
  const make = (keep: number) => {
    const loads: string[] = [];
    const revoked: string[] = [];
    const cache = new PictureUrls({ keep, atOnce: 4, load: async (p) => { loads.push(p); return `blob:${p}`; }, revoke: (u) => revoked.push(u), changed: () => {} });
    return { cache, loads, revoked };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** One render: every path read once. */
  const render = (cache: InstanceType<typeof PictureUrls>, paths: string[]) => { cache.frame(); return paths.map((p) => cache.get(p)); };
  const until = async (cache: InstanceType<typeof PictureUrls>, paths: string[]) => {
    for (let i = 0; i < 200; i++) { if (render(cache, paths).every((u) => u !== undefined)) return; await settle(); }
    throw new Error('never loaded');
  };

  it('loads each picture once, even with more on screen than it keeps', async () => {
    const { cache, loads } = make(30);
    const paths = Array.from({ length: 50 }, (_, i) => `p${i}`);
    await until(cache, paths);
    for (let i = 0; i < 5; i++) { render(cache, paths); await settle(); }
    expect(loads).toHaveLength(50);
    expect(new Set(loads).size).toBe(50);
  });

  it('drops the least recently read picture that is not on screen', async () => {
    const { cache, loads, revoked } = make(3);
    await until(cache, ['a', 'b', 'c']);
    render(cache, ['a']); // a read again: most recent
    await until(cache, ['d']); // b and c are off screen; b is the oldest
    expect(revoked).toEqual(['blob:b']);
    render(cache, ['a', 'c', 'd']);
    expect(loads).toEqual(['a', 'b', 'c', 'd']);
  });

  it('forgets what was waiting when the pack changes, and revokes everything at the end', async () => {
    const { cache, loads, revoked } = make(10);
    render(cache, Array.from({ length: 8 }, (_, i) => `x${i}`));
    cache.reset();
    await settle(); await settle();
    expect(loads.length).toBeLessThanOrEqual(4); // only those already on their way
    await until(cache, ['y']);
    cache.dispose();
    expect(revoked.sort()).toEqual(loads.map((p) => `blob:${p}`).sort());
  });
});
