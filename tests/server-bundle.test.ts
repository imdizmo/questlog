import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const root = join(homedir(), '.cache/gametracker/scratch/bundle-test');
let child: ChildProcess | undefined;

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

describe('server bundle', () => {
  it('bundle runs standalone', async () => {
    const out = join(root, 'out');
    const cwd = join(root, 'empty');
    mkdirSync(cwd, { recursive: true });
    execFileSync('node', [join(__dirname, '../scripts/build-server.mjs'), out], { cwd: join(__dirname, '..') });
    const sqls = readdirSync(join(__dirname, '../server/migrations')).filter((f) => f.endsWith('.sql'));
    expect(readdirSync(join(out, 'migrations')).sort()).toEqual(sqls.sort());
    // Licence comments of the bundled packages go to a file shipped beside the bundle.
    expect(readFileSync(join(out, 'server.mjs.LEGAL.txt'), 'utf8')).toMatch(/license/i);

    const port = await freePort();
    const env = { ...process.env, PORT: String(port), JT_HOST: '127.0.0.1', JT_DB: join(cwd, 'jt.db'), JT_FILES: join(cwd, 'files'), JT_WEB: join(cwd, 'web') };
    child = spawn('node', [join(out, 'server.mjs')], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    const t = Date.now();
    while (!stdout.includes(`QUESTLOG_LISTENING ${port}`)) {
      if (Date.now() - t > 20000) throw new Error(`timeout; stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const h = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(h.status).toBe(200);
    const db = new DatabaseSync(join(cwd, 'jt.db'), { readOnly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n;
    db.close();
    expect(n).toBe(sqls.length);
    child.kill('SIGTERM');
  }, 60000);
});
