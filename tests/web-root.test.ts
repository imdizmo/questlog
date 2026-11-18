import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveWebRoot } from '../server/webRoot';

const built = (dir: string) => (p: string) => p === resolve(dir, 'index.html') || p === resolve(dir, 'assets');

describe('resolveWebRoot', () => {
  it('JT_WEB wins, even when a build sits beside the server', () => {
    const r = resolveWebRoot({ JT_WEB: 'custom/web' }, '/opt/q/server', built('/opt/q/web'));
    expect(r).toEqual({ root: resolve('custom/web'), from: 'JT_WEB' });
  });
  it('uses the web folder beside the server folder when it holds a build', () => {
    expect(resolveWebRoot({}, '/opt/q/server', built('/opt/q/web'))).toEqual({ root: resolve('/opt/q/web'), from: 'beside the server' });
  });
  it('ignores a web folder without a build (a source checkout) and falls back to dist/web', () => {
    const onlyIndex = (p: string) => p === resolve('/repo/web/index.html');
    expect(resolveWebRoot({}, '/repo/server', onlyIndex)).toEqual({ root: resolve('dist/web'), from: 'dist/web' });
  });
  it('an empty JT_WEB counts as unset', () => {
    expect(resolveWebRoot({ JT_WEB: '' }, '/x/server', () => false).from).toBe('dist/web');
  });
});
