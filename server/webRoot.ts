import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where the built web app is served from: JT_WEB if set; else the `web` folder beside the server's own folder
 * (`<archive>/web` next to `<archive>/server/server.mjs`) when it holds a build (index.html and assets/; the source
 * web/ folder of a checkout has no assets/); else `dist/web` from the working directory, as in development.
 */
export function resolveWebRoot(
  env: { JT_WEB?: string },
  moduleDir: string,
  exists: (p: string) => boolean = existsSync,
): { root: string; from: 'JT_WEB' | 'beside the server' | 'dist/web' } {
  if (env.JT_WEB) return { root: resolve(env.JT_WEB), from: 'JT_WEB' };
  const beside = resolve(moduleDir, '..', 'web');
  if (exists(join(beside, 'index.html')) && exists(join(beside, 'assets'))) return { root: beside, from: 'beside the server' };
  return { root: resolve('dist/web'), from: 'dist/web' };
}
