import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { AppError } from '../server/errors';
import { sessionActor } from '../server/permissions';
import { assignableFor, autoMap, buildContent, columnsOf, guessOwner, guessPriority, guessStatus, MAX_PREVIEW_ROWS, normalizeTagName, parseCsv, parseEffort, splitTags } from '../shared/csv';
import type { User } from '../shared/types';

describe('parseCsv', () => {
  it('handles quoted newline, doubled quotes, BOM, semicolons', () => {
    expect(parseCsv('﻿Title,Note\r\n"Line one\nline two","She said ""hi"""\r\nPlain,x\n'))
      .toEqual([['Title', 'Note'], ['Line one\nline two', 'She said "hi"'], ['Plain', 'x']]);
    expect(parseCsv('a;b;c\n1;"2;x";3')).toEqual([['a', 'b', 'c'], ['1', '2;x', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    // A delimiter inside quotes on the header line does not decide the delimiter.
    expect(parseCsv('"a,b,c";d\n1;2')).toEqual([['a,b,c', 'd'], ['1', '2']]);
  });
  it('skips blank lines, keeps a last row without newline', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b\n"x\r\ny",z')).toEqual([['a', 'b'], ['x\ny', 'z']]);
  });
  it('stops after 50,001 rows', () => {
    const rows = parseCsv('h\n' + 'x\n'.repeat(60000));
    expect(rows).toHaveLength(MAX_PREVIEW_ROWS);
    expect(MAX_PREVIEW_ROWS).toBe(50001);
  });
});

describe('columnsOf', () => {
  it('empty column dropped', () => {
    const r = columnsOf([['Title', '', 'Status'], ['A', '', 'done'], ['B', '', ''], ['C']]);
    expect(r.headers).toEqual(['Title', 'Status']);
    expect(r.rows).toEqual([['A', 'done'], ['B', ''], ['C', '']]);
  });
});

describe('autoMap', () => {
  it('maps Title/Status/Priority/Effort/Tags/Content', () => {
    expect(autoMap(['Title', 'Status', 'Priority', 'Effort', 'Tags', 'Content', 'Assignee', 'Other']))
      .toEqual({ title: 0, status: 1, priority: 2, effort: 3, tags: 4, content: 5, owner: 6 });
    expect(autoMap(['x', 'Labels', 'Description'])).toEqual({ title: null, status: null, priority: null, effort: null, tags: 1, content: 2, owner: null });
  });
});

describe('assignableFor', () => {
  const u = (id: string, role: string | null, hasAccess = false, disabled = false) => ({ id, name: id, email: `${id}@x.io`, disabled, role, hasAccess });
  const all = [u('own', 'owner'), u('adm', 'admin'), u('mem', 'member'), u('acc', 'member', true), u('obs', 'observer', true), u('off', 'member', true, true), u('none', null)];
  it('limited project: admins and members with access only; full: all members; no observers or disabled', () => {
    expect(assignableFor(all, 'limited').map((m) => m.id)).toEqual(['own', 'adm', 'acc']);
    expect(assignableFor(all, 'full').map((m) => m.id)).toEqual(['own', 'adm', 'mem', 'acc']);
    expect(assignableFor(all, null).map((m) => m.id)).toEqual(['own', 'adm', 'mem', 'acc']);
    expect(guessOwner('mem', assignableFor(all, 'limited'))).toBeNull();
  });
});

describe('value helpers', () => {
  it('guesses status, priority, effort, tags, owner and content', () => {
    expect(['Done', 'in progress', 'Archived', 'doc', 'weird', ''].map(guessStatus)).toEqual(['done', 'started', 'archived', 'doc', 'default', 'default']);
    expect(['High', 'medium', 'Low', 'none', ''].map(guessPriority)).toEqual(['a', 'b', 'c', null, null]);
    expect(parseEffort('3', 1)).toBe(3);
    expect(parseEffort('2,5', 2)).toBe(5);
    expect(parseEffort('abc', 1)).toBeNull();
    expect(parseEffort('-1', 1)).toBeNull();
    expect(splitTags('Bug, Level Design;  ;ui|x')).toEqual(['Bug', 'Level Design', 'ui', 'x']);
    expect(normalizeTagName(' Level Design!! ')).toBe('level-design');
    expect(normalizeTagName('!!')).toBeNull();
    const members = [{ id: 'u1', name: 'Ada Owner', email: 'ada@example.com' }, { id: 'u2', name: 'Bo Chen', email: 'bo@x.io' }];
    expect(guessOwner('BO@x.io', members)).toBe('u2');
    expect(guessOwner('ada owner', members)).toBe('u1');
    expect(guessOwner('Ada', members)).toBe('u1');
    expect(guessOwner('nobody', members)).toBeNull();
    expect(buildContent('T', 'Body')).toBe('# T\n\nBody');
    expect(buildContent('T', '')).toBe('# T');
    expect(buildContent('T', null)).toBe('T');
    expect(buildContent(null, 'First\nrest')).toBe('First\nrest');
  });
});

let db: Db;
let me: User;
let deck: string;
let pid: string;
const run = (name: string, p: unknown, u: User = me) => dispatch(db, u, name, p);
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};
function mkUser(role: string): User {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,0,0)').run(id, `${id}@x.io`, role, 'x');
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return { id, email: `${id}@x.io`, name: role, timezone: null, disabled: false, createdAt: 0 };
}
const cards = () => db.prepare('SELECT * FROM cards ORDER BY seq').all() as any[];
const tagsOf = () => (JSON.parse((db.prepare('SELECT tags_json t FROM projects WHERE id=?').get(pid) as any).t) as { name: string }[]).map((t) => t.name);

describe('cards/bulkImport', () => {
  beforeEach(() => {
    db = openDb(':memory:');
    me = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
    pid = (run('projects/create', { name: 'P' }).payload as any).id;
    deck = (run('decks/create', { title: 'D', projectId: pid }).payload as any).id;
  });
  const row = (content: string, extra: object = {}) => ({ content, priority: null, effort: null, assigneeId: null, masterTags: [] as string[], ...extra });

  it('creates N tasks with tags created in the project', () => {
    const { events, payload } = run('cards/bulkImport', {
      deckId: deck,
      cards: [
        row('# One', { priority: 'a', effort: 3, masterTags: ['Bug', 'Level Design'] }),
        row('Two', { status: 'started', assigneeId: me.id, masterTags: ['bug'] }),
        row('Three', { status: 'done' }),
        row('Four', { status: 'doc' }),
        row('Five', { status: 'archived' }),
      ],
    });
    expect((payload as any).count).toBe(5);
    const cs = cards();
    expect(cs.map((c) => [c.status, c.is_doc, c.visibility])).toEqual([
      ['not_started', 0, 'default'], ['started', 0, 'default'], ['done', 0, 'default'], ['not_started', 1, 'default'], ['not_started', 0, 'archived'],
    ]);
    expect(cs[0]).toMatchObject({ priority: 'a', effort: 3, deck_id: deck });
    expect(JSON.parse(cs[0].master_tags_json)).toEqual(['bug', 'level-design']);
    expect(tagsOf()).toEqual(expect.arrayContaining(['bug', 'level-design']));
    expect(tagsOf().filter((t) => t === 'bug')).toHaveLength(1);
    // History as for cards/create, and live events for every card.
    expect((db.prepare("SELECT COUNT(*) n FROM card_history WHERE changes_json LIKE '%created%'").get() as any).n).toBe(5);
    expect(events.filter((e) => e.model === 'card')).not.toHaveLength(0);
    expect(events.some((e) => e.model === 'project' && e.op === 'upsert')).toBe(true);
  });
  it('applies the list auto tag like tasks/create', () => {
    run('projects/update', { id: pid, tags: [{ name: 'auto', emoji: null }] });
    run('decks/update', { id: deck, autoTag: 'auto' });
    run('cards/bulkImport', { deckId: deck, cards: [row('A')] });
    expect(JSON.parse(cards()[0].master_tags_json)).toEqual(['auto']);
  });
  it('is all or nothing', () => {
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: [row('ok', { masterTags: ['newtag'] }), row('bad', { assigneeId: 'nobody' })] }))).toBe('400:invalid_assignee');
    expect(cards()).toHaveLength(0);
    expect(tagsOf()).not.toContain('newtag');
  });
  it('2001 tasks → 400', () => {
    const many = Array.from({ length: 2001 }, (_, i) => row(`c${i}`));
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: many }))).toBe('400:invalid_payload');
    expect(cards()).toHaveLength(0);
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: [] }))).toBe('400:invalid_payload');
    run('cards/bulkImport', { deckId: deck, cards: many.slice(0, 2000) });
    expect(cards()).toHaveLength(2000);
  });
  it('observer → 403', () => {
    const o = mkUser('observer');
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: [row('x')] }, o))).toBe('403:forbidden');
    expect(cards()).toHaveLength(0);
  });
  it('a token confined to another project → 403', () => {
    const other = (run('projects/create', { name: 'Q' }).payload as any).id;
    const actor = { ...sessionActor(me), via: 'token' as const, scopes: ['read', 'write'], projectIds: [other], tokenRole: 'producer' } as any;
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: [row('x')] }, actor))).toBe('403:forbidden');
  });
  it('unknown list → 404; invalid status → 400', () => {
    expect(code(() => run('cards/bulkImport', { deckId: 'nope', cards: [row('x')] }))).toBe('404:not_found');
    expect(code(() => run('cards/bulkImport', { deckId: deck, cards: [row('x', { status: 'weird' })] }))).toBe('400:invalid_payload');
  });
});
