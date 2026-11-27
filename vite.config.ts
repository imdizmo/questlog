import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Writes THIRD-PARTY-WEB.txt: name, version, licence and licence text of every npm package inlined into the bundle. */
function webNotices(): Plugin {
  return {
    name: 'questlog-web-notices',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const roots = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          // The last node_modules/<name> or node_modules/@scope/<name> segment is the package that owns the module.
          const m = id.replace(/\\/g, '/').match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
          if (m) roots.add(m[1]);
        }
      }
      const parts = [...roots].map((dir) => {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f));
        const text = file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file in the package; see its package.json)';
        return { key: `${pkg.name}@${pkg.version}`, body: `${pkg.name} ${pkg.version} (${pkg.license ?? 'see text'})\n\n${text}` };
      }).filter((p, i, all) => all.findIndex((q) => q.key === p.key) === i).sort((a, b) => a.key.localeCompare(b.key));
      this.emitFile({
        type: 'asset', fileName: 'THIRD-PARTY-WEB.txt',
        source: `Third-party npm packages inlined into the Questlog web app.\n\n${parts.map((p) => p.body).join(`\n\n${'-'.repeat(72)}\n\n`)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), webNotices()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8780', ws: true },
      '/dispatch': 'http://localhost:8780',
      '/translate': 'http://localhost:8780',
    },
  },
});
