import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tx, newId, toCamel } from '../server/db';

describe('db', () => {
  it('migrates once', () => {
    const dir = join(homedir(), '.cache/gametracker/scratch');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `migrate-${newId()}.db`);
    try {
      openDb(p).close();
      const db = openDb(p);
      const n = db.prepare('SELECT COUNT(*) c FROM migrations').get() as { c: number };
      expect(n.c).toBe(readdirSync(join(__dirname, '../server/migrations')).filter((f) => f.endsWith('.sql')).length);
      db.close();
    } finally {
      for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
    }
  });

  it('003 adds property columns and tables', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('cards')).toEqual(expect.arrayContaining(['priority', 'effort', 'due_date', 'parent_card_id', 'master_tags_json', 'tags_json', 'mentioned_user_ids_json', 'checkbox_stats_json', 'cover_file_id']));
    expect(cols('decks')).toEqual(expect.arrayContaining(['auto_tag', 'default_card_id']));
    for (const t of ['card_deps', 'files', 'user_card_tags', 'card_presets']) expect(cols(t).length).toBeGreaterThan(0);
  });

  it('003 backfills 7 tags on existing projects', () => {
    const dir = join(homedir(), '.cache/gametracker/scratch');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `bf-${newId()}.db`);
    try {
      const raw = new DatabaseSync(p);
      raw.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const f of ['001_init.sql', '002_known_devices.sql']) {
        raw.exec(readFileSync(join(__dirname, '../server/migrations', f), 'utf8'));
        raw.prepare('INSERT INTO migrations VALUES (?,0)').run(f);
      }
      raw.exec("INSERT INTO projects (id,seq,name,spaces_json,created_at) VALUES ('p',1,'P','[]',0)");
      raw.close();
      const db = openDb(p);
      const row = toCamel<{ tags: { name: string; emoji: string | null }[] }>(
        db.prepare("SELECT * FROM projects WHERE id='p'").get() as Record<string, unknown>,
      );
      expect(row.tags.map((t) => t.name)).toEqual(['backend', 'bug', 'debt', 'design', 'discuss', 'outsource', 'sprint']);
      expect(row.tags[1].emoji).toBe('🐞');
      db.close();
    } finally {
      for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
    }
  });

  it('foreign keys on', () => {
    const db = openDb(':memory:');
    expect(() =>
      db
        .prepare(
          "INSERT INTO decks (id, seq, project_id, space_id, title, deck_type, sort_index, created_at) VALUES ('d',1,'nope',1,'t','task',0,0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('tx rolls back', () => {
    const db = openDb(':memory:');
    expect(() =>
      tx(db, () => {
        db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES ('a','n','{}',0)").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect((db.prepare('SELECT COUNT(*) c FROM account').get() as { c: number }).c).toBe(0);
  });

  it('toCamel maps keys, json and flags', () => {
    expect(toCamel({ is_doc: 1, spaces_json: '[1]', created_at: 5 })).toEqual({ isDoc: true, spaces: [1], createdAt: 5 });
  });
});
