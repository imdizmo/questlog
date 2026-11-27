import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(__dirname, '..');
const out = join(homedir(), '.cache/gametracker/scratch/package-server-test');
const nodeVer = readFileSync(join(root, 'scripts/node-version.txt'), 'utf8').trim().replace(/^v/, '');
// The build needs a built web app and a cached Node runtime (no downloads in tests).
const ready =
  existsSync(join(root, 'dist/web/index.html')) &&
  existsSync(join(homedir(), `.cache/gametracker/node-dist/v${nodeVer}/node-v${nodeVer}-linux-x64.tar.xz`));

afterEach(() => rmSync(out, { recursive: true, force: true }));

describe('server archive', () => {
  it.skipIf(!ready)('ships the translate worker beside server.mjs', () => {
    execFileSync('bash', [join(root, 'scripts/package-server.sh'), '--dir', '--version-from-package', out, 'linux-x64'], { stdio: 'pipe', timeout: 240_000 });
    const app = join(out, 'questlog-server-linux-x64/server');
    expect(existsSync(join(app, 'server.mjs'))).toBe(true);
    expect(existsSync(join(app, 'translate/worker.mjs'))).toBe(true);
  }, 300_000);
});
