import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** The database holds migrations this build does not have: it was written by a newer version. */
export class NewerDatabaseError extends Error {
  constructor(unknown: string[], backupDir?: string) {
    super(
      `This database was last used by a newer version (unknown migrations: ${unknown.join(', ')}). Update the app; ` +
        `do not open it with this version.${backupDir ? ` Backups of earlier states are in ${backupDir}.` : ''}`,
    );
    this.name = 'NewerDatabaseError';
  }
}

const KEEP_BACKUPS = 3;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** `VACUUM INTO` a fresh file in `dir` named after the first pending migration, then keep the newest KEEP_BACKUPS. */
function backupBefore(db: Db, dir: string, firstPending: string): void {
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `jt-${firstPending.replace(/\.sql$/, '')}-${stamp()}.db`);
  db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  const all = readdirSync(dir).filter((f) => /^jt-.*\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(dir, f), { force: true });
}

export function openDb(path: string, opts: { backupDir?: string } = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const known = new Set(files);
  const unknown = [...applied].filter((n) => !known.has(n)).sort();
  if (unknown.length) {
    db.close();
    throw new NewerDatabaseError(unknown, opts.backupDir);
  }
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length && applied.size && opts.backupDir) backupBefore(db, opts.backupDir, pending[0]);
  for (const f of pending) {
    tx(db, () => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
    });
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function newId(): string {
  return randomUUID();
}

const BOOL_KEYS = new Set(['disabled', 'isArchived', 'isDoc', 'isClosed', 'visible', 'hasBlockingDeps', 'isBlockingDep', 'isParticipating', 'isMuted', 'guardiansEnabled', 'handSyncEnabled', 'forceOr', 'userApiTokensEnabled', 'isDisabled']);
/** Plain TEXT columns that hold JSON. */
const JSON_COLS = new Set(['preferred_order', 'public_order', 'tokens', 'plan_overwrites']);

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case row -> camelCase object; `*_json` columns (suffix dropped) and the JSON TEXT columns preferred_order, public_order, tokens and plan_overwrites are parsed, known 0/1 flags become booleans. */
export function toCamel<T = any>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json')) out[camel(k.slice(0, -5))] = typeof v === 'string' ? JSON.parse(v) : v;
    else if (JSON_COLS.has(k)) out[camel(k)] = typeof v === 'string' ? JSON.parse(v) : v;
    else {
      const key = camel(k);
      out[key] = BOOL_KEYS.has(key) && typeof v === 'number' ? v !== 0 : v;
    }
  }
  return out as T;
}
