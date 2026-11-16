import { describe, it, expect, afterEach } from 'vitest';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openDb, newId, NewerDatabaseError } from '../server/db';

const root = join(homedir(), '.cache/gametracker/scratch');
const made: string[] = [];
const children: ChildProcess[] = [];

/** A fresh scratch folder whose name has a space and a non-ASCII letter. */
function scratch(): string {
  const d = join(root, `with space ë`, newId());
  mkdirSync(d, { recursive: true });
  made.push(d);
  return d;
}

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const backups = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^jt-.*\.db$/.test(f)).sort() : []);

/** A database with every migration but the last applied. Returns the path and the pending migration's name. */
function dbWithPending(dir: string): { path: string; last: string } {
  const mdir = join(__dirname, '../server/migrations');
  const files = readdirSync(mdir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const path = join(dir, 'jt.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const f of files.slice(0, -1)) {
    raw.exec(readFileSync(join(mdir, f), 'utf8'));
    raw.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
  }
  raw.close();
  return { path, last: files[files.length - 1] };
}

describe('openDb backups', () => {
  it('copies the db before a pending migration', () => {
    const dir = scratch();
    const { path, last } = dbWithPending(dir);
    const backupDir = join(dir, 'backups');
    openDb(path, { backupDir }).close();
    const files = backups(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^jt-${last.replace(/\.sql$/, '')}-\\d{8}-\\d{6}\\.db$`));
    const copy = new DatabaseSync(join(backupDir, files[0]));
    copy.close();
  });

  it('keeps only the newest 3 backups', () => {
    const dir = scratch();
    const { path } = dbWithPending(dir);
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir);
    const old = ['jt-001_a-20200101-000000.db', 'jt-001_a-20200102-000000.db', 'jt-001_a-20200103-000000.db', 'jt-001_a-20200104-000000.db'];
    for (const f of old) writeFileSync(join(backupDir, f), '');
    openDb(path, { backupDir }).close();
    const files = backups(backupDir);
    expect(files).toHaveLength(3);
    expect(files).toContain(old[3]);
    expect(files).toContain(old[2]);
    expect(files.filter((f) => !old.includes(f))).toHaveLength(1);
  });

  it('makes no backup when nothing is pending', () => {
    const dir = scratch();
    const path = join(dir, 'jt.db');
    openDb(path).close();
    const backupDir = join(dir, 'backups');
    openDb(path, { backupDir }).close();
    expect(backups(backupDir)).toEqual([]);
  });

  it('makes no backup for a brand-new db', () => {
    const dir = scratch();
    const backupDir = join(dir, 'backups');
    openDb(join(dir, 'jt.db'), { backupDir }).close();
    expect(backups(backupDir)).toEqual([]);
  });

  it('refuses a database with unknown migrations', () => {
    const dir = scratch();
    const path = join(dir, 'jt.db');
    const db = openDb(path);
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run('999_future.sql', Date.now());
    db.close();
    const backupDir = join(dir, 'backups');
    let err: unknown;
    try { openDb(path, { backupDir }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NewerDatabaseError);
    expect((err as Error).message).toContain(backupDir);
  });
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

type Run = { child: ChildProcess; out: () => string; err: () => string; port: number; dir: string; exited: Promise<number | null> };

function startOn(extra: Record<string, string>, port: number): Run {
  const dir = scratch();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), JT_DB: join(dir, 'jt.db'), JT_FILES: join(dir, 'files'), ...extra };
  for (const k of ['JT_HOST', 'JT_WEB', 'JT_EXIT_ON_STDIN_CLOSE', 'JT_BACKUP_BEFORE_MIGRATE']) if (!(k in extra)) delete env[k];
  const child = spawn('node', ['--import', 'tsx', 'server/main.ts'], { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: join(__dirname, '..') });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  return { child, out: () => out, err: () => err, port, dir, exited };
}

async function until(fn: () => boolean, ms = 20000): Promise<void> {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function refused(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port, timeout: 2000 });
    s.once('connect', () => { s.destroy(); res(false); });
    s.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'ECONNREFUSED'));
    s.once('timeout', () => { s.destroy(); res(false); });
  });
}

describe('main.ts', () => {
  it('honours JT_HOST, JT_WEB and prints the listening line', async () => {
    const port = await freePort();
    const web = scratch();
    writeFileSync(join(web, 'index.html'), '<html>hello</html>');
    const r = startOn({ JT_HOST: '127.0.0.1', JT_WEB: web }, port);
    await until(() => r.out().includes(`QUESTLOG_LISTENING ${port}`));
    const h = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('ok');
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('hello');
    // With JT_HOST set, the only address printed is that one.
    expect(r.out().match(/http:\/\/\S+/g)).toEqual([`http://127.0.0.1:${port}`]);
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) expect(await refused(lan.address, port)).toBe(true);
    r.child.kill('SIGTERM');
    await r.exited;
  }, 30000);

  it('JT_EXIT_ON_STDIN_CLOSE=1 exits cleanly when stdin closes', async () => {
    const port = await freePort();
    const r = startOn({ JT_HOST: '127.0.0.1', JT_EXIT_ON_STDIN_CLOSE: '1' }, port);
    await until(() => r.out().includes('QUESTLOG_LISTENING'));
    r.child.stdin!.end();
    const code = await Promise.race([r.exited, new Promise<string>((res) => setTimeout(() => res('timeout'), 10000))]);
    expect(code).toBe(0);
  }, 30000);

  it('defaults are unchanged', async () => {
    const port = await freePort();
    const r = startOn({}, port);
    await until(() => r.out().includes(`listening on port ${port}`));
    expect(r.out()).toContain(`listening on port ${port}`);
    expect(r.err()).toBe('');
    r.child.kill('SIGTERM');
    await r.exited;
  }, 30000);

  it('exits 3 with a message on a database from a newer version', async () => {
    const port = await freePort();
    const dir = scratch();
    const db = openDb(join(dir, 'jt.db'));
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run('999_future.sql', Date.now());
    db.close();
    const r = startOn({ JT_DB: join(dir, 'jt.db'), JT_BACKUP_BEFORE_MIGRATE: '1' }, port);
    expect(await r.exited).toBe(3);
    expect(r.err()).toContain(join(dir, 'backups'));
  }, 30000);
});
