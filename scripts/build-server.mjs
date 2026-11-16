// Bundles server/main.ts into <outDir>/server.mjs and copies server/migrations beside it.
// Also writes <outDir>/server.mjs.LEGAL.txt (licence comments of the bundled packages).
// db.ts finds the migrations through import.meta.url, so they must stay next to the bundle.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/build-server.mjs <outDir>');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(root, 'server/main.ts')],
  outfile: join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  external: ['node:*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Licence comments of the inlined packages go to server.mjs.LEGAL.txt, which ships beside the bundle.
  legalComments: 'external',
  logLevel: 'warning',
});
rmSync(join(outDir, 'migrations'), { recursive: true, force: true });
cpSync(join(root, 'server/migrations'), join(outDir, 'migrations'), { recursive: true });
