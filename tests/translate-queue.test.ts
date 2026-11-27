import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { buildSnapshot } from '../server/snapshot';
import { TranslateQueue, batched } from '../server/translate/queue';
import { protectedNames } from '../server/translate/names';
import { TranslateEngine } from '../server/translate/engine';
import type { Lang } from '../shared/translate';
import type { Translation, User } from '../shared/types';

const PACK = join(__dirname, 'fixtures', 'translate-pack');
const IT = 'Il cavaliere va al castello con la spada e il suo cavallo.';
const IT2 = 'La regina non vuole che il drago torni nella valle.';
const EN = 'The knight rides to the castle with his sword and his horse.';

let db: Db;
let me: User;
let pid: string;
let deck: string;
let queue: TranslateQueue | null;
let pubs: { op: string; row: any }[];
let clock: number;

const run = (name: string, p: unknown, u: User = me) => dispatch(db, u, name, p);
const mk = (content: string) => (run('cards/create', { content, deckId: deck }).payload as { id: string }).id;
const setEnabled = (on: boolean) =>
  db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.translationEnabled', json(?))").run(on ? 'true' : 'false');
const rowsOf = (id: string) => db.prepare('SELECT * FROM translations WHERE source_id=? ORDER BY lang').all(id) as any[];
const version = (id: string) => (db.prepare('SELECT content_version v FROM cards WHERE id=?').get(id) as { v: number }).v;
const waitFor = async (f: () => boolean) => { for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 2)); expect(f()).toBe(true); };

type Call = { texts: string[]; from: Lang; to: Lang };
function fakeEngine() {
  const e = {
    calls: [] as Call[],
    gate: null as Promise<void> | null,
    fail: false,
    onCall: null as ((n: number) => void) | null,
    available: () => true,
    async translate(texts: string[], from: Lang, to: Lang): Promise<string[]> {
      e.calls.push({ texts, from, to });
      e.onCall?.(e.calls.length);
      if (e.gate) await e.gate;
      if (e.fail) throw new Error('engine down');
      return texts.map((t) => `[${to}] ${t}`);
    },
  };
  return e;
}
let engine: ReturnType<typeof fakeEngine>;

function makeQueue(eng: Pick<TranslateEngine, 'available' | 'translate'> = engine, opts: object = {}) {
  queue = new TranslateQueue(db, eng, (_m, op, row) => { pubs.push({ op, row }); },
    { debounceMs: 10, backfillGapMs: 0, now: () => clock, ...opts });
  return queue;
}

beforeEach(() => {
  db = openDb(':memory:');
  me = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
  pid = (run('projects/create', { name: 'P' }).payload as any).id;
  deck = (run('decks/create', { title: 'D', projectId: pid }).payload as any).id;
  pubs = [];
  clock = 1_800_000_000_000;
  engine = fakeEngine();
  queue = null;
});
afterEach(async () => { await queue?.stop(); });

describe('TranslateQueue', () => {
  it('stores nothing while the setting is off', async () => {
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    queue!.touch('card', id);
    await queue!.idle();
    expect(rowsOf(id)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it('translates an Italian card into English only, at its content version, and publishes it', async () => {
    setEnabled(true);
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    await queue!.idle();
    const rows = rowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'card', lang: 'en', from_lang: 'it', source_version: version(id), text: `Titolo\n[en] ${IT}` });
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toEqual({ op: 'upsert', row: { kind: 'card', sourceId: id, lang: 'en', sourceVersion: version(id), fromLang: 'it', text: `Titolo\n[en] ${IT}`, createdAt: clock } satisfies Translation });
  });

  it('collapses touches within the debounce into one engine call', async () => {
    setEnabled(true);
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    queue!.touch('card', id);
    queue!.touch('card', id);
    await queue!.idle();
    expect(engine.calls).toHaveLength(1);
  });

  it('does not store a translation of text that changed while it was being translated', async () => {
    setEnabled(true);
    makeQueue().start();
    let release!: () => void;
    engine.gate = new Promise((r) => { release = r; });
    const id = mk(`Titolo\n${IT}`);
    await waitFor(() => engine.calls.length === 1);
    run('cards/update', { id, content: `Titolo\n${IT2}`, contentVersion: 1 });
    expect(version(id)).toBe(2);
    engine.gate = null;
    release();
    await queue!.idle();
    expect(pubs.every((p) => p.row.sourceVersion === 2)).toBe(true);
    expect(rowsOf(id)).toEqual([expect.objectContaining({ source_version: 2, text: `Titolo\n[en] ${IT2}` })]);
  });

  it('translates comments as entries', async () => {
    setEnabled(true);
    const id = mk(EN);
    makeQueue().start();
    const r = run('resolvables/create', { cardId: id, context: 'comment', content: IT }).payload as { entryId: string };
    await queue!.idle();
    expect(rowsOf(r.entryId)).toEqual([expect.objectContaining({ kind: 'entry', lang: 'en', from_lang: 'it', text: `[en] ${IT}` })]);
    // An edit is a new version: translated again.
    run('resolvables/editEntry', { entryId: r.entryId, content: IT2 });
    await queue!.idle();
    expect(rowsOf(r.entryId)).toEqual([expect.objectContaining({ kind: 'entry', text: `[en] ${IT2}` })]);
  });

  it('serves an opened card ahead of the background pass', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => mk(`Carta ${i}\n${IT}`));
    const opened = mk(`Aperta\n${IT2}`);
    setEnabled(true);
    let release!: () => void;
    engine.gate = new Promise((r) => { release = r; });
    makeQueue().start();
    await waitFor(() => engine.calls.length === 1);
    queue!.open('card', opened);
    engine.gate = null;
    release();
    await queue!.idle();
    const order = pubs.map((p) => p.row.sourceId);
    expect(order).toHaveLength(11);
    expect(order[1]).toBe(opened);
    expect(new Set(order)).toEqual(new Set([...ids, opened]));
  });

  it('translates existing text in the background without any touch', async () => {
    const ids = [mk(`A\n${IT}`), mk(`B\n${EN}`), mk(`C\n${IT2}`)];
    setEnabled(true);
    makeQueue().start();
    await queue!.idle();
    expect(ids.map((id) => rowsOf(id).map((r) => `${r.lang}<${r.from_lang}`))).toEqual([['en<it'], ['it<en'], ['en<it']]);
    // Grouped by direction: the Italian ones first, then the English one.
    expect(engine.calls.map((c) => `${c.from}>${c.to}`)).toEqual(['it>en', 'it>en', 'en>it']);
  });

  it('a glossary change redoes the project translations in the background, readers keep the old text meanwhile', async () => {
    const id = mk(`Titolo\n${IT}`);
    setEnabled(true);
    makeQueue().start();
    await queue!.idle();
    const before = rowsOf(id)[0].text;
    expect(rowsOf(id)[0].stale).toBe(0);
    const calls = engine.calls.length;
    let release!: () => void;
    engine.gate = new Promise<void>((r) => { release = r; });
    run('projects/update', { id: pid, glossary: [{ term: 'cavaliere', en: 'paladin' }] });
    // Stale, but the old row is still there for readers (no flash to the original).
    expect(rowsOf(id).map((r) => [r.text, r.stale])).toEqual([[before, 1]]);
    await waitFor(() => engine.calls.length > calls);
    expect(rowsOf(id)[0].text).toBe(before);
    release();
    await waitFor(() => rowsOf(id)[0].stale === 0);
    expect(engine.calls.length).toBeGreaterThan(calls);
  });

  it('a glossary save during a running pass redoes text the pass already finished', async () => {
    const a = mk(`Alfa\n${IT}`);
    const b = mk(`Beta\n${IT2}`);
    setEnabled(true);
    makeQueue().start();
    await queue!.idle();
    let release!: () => void;
    const hold = () => { engine.gate = new Promise<void>((r) => { release = r; }); };
    hold();
    const calls = engine.calls.length;
    run('projects/update', { id: pid, glossary: [{ term: 'cavaliere', en: 'paladin' }] });
    await waitFor(() => engine.calls.length === calls + 1); // the pass is on A
    const prev = release;
    hold();
    prev();
    await waitFor(() => engine.calls.length === calls + 2 && rowsOf(a)[0].stale === 0); // A done, now on B
    run('projects/update', { id: pid, glossary: [{ term: 'cavaliere', en: 'knight' }] });
    expect(rowsOf(a)[0].stale).toBe(1);
    engine.gate = null;
    release();
    await waitFor(() => rowsOf(a)[0].stale === 0 && rowsOf(b)[0].stale === 0);
    await queue!.idle();
    expect(rowsOf(a)[0].stale).toBe(0);
    expect(engine.calls.length).toBeGreaterThanOrEqual(calls + 3);
  });

  it('a new name-kind Lore entry or alias makes the project translations stale; other Lore does not', async () => {
    const id = mk(`Titolo\n${IT}`);
    setEnabled(true);
    makeQueue().start();
    await queue!.idle();
    const stale = () => rowsOf(id)[0].stale;
    const typeId = (run('wiki/createType', { projectId: pid, name: 'Character' }).payload as { id: string }).id;
    run('wiki/createEntry', { projectId: pid, typeId: null, name: 'Storia del mondo' });
    await queue!.idle();
    expect(stale()).toBe(0);
    const calls = engine.calls.length;
    const c = (run('wiki/createEntry', { projectId: pid, typeId, name: 'Corvino' }).payload as { id: string }).id;
    await waitFor(() => engine.calls.length > calls);
    await queue!.idle();
    expect(stale()).toBe(0);
    const calls2 = engine.calls.length;
    run('wiki/setAliases', { cardId: c, aliases: ['Corvo Nero'] });
    await waitFor(() => engine.calls.length > calls2);
  });

  it("translates a Lore entry's text fields and its lines and table blocks, each piece with its source", async () => {
    setEnabled(true);
    makeQueue().start();
    const typeId = (run('wiki/createType', { projectId: pid, name: 'Arma', fields: [
      { key: 'desc', label: 'Descrizione', kind: 'longtext' }, { key: 'dmg', label: 'Danno', kind: 'integer' },
    ] }).payload as { id: string }).id;
    run('wiki/setPage', { typeId, page: { guided: false, blocks: [
      { id: 'a', kind: 'table', title: 'Attacchi', width: 'full', cols: ['Nome', 'Danno'] },
      { id: 'b', kind: 'lines', title: 'Battute', width: 'full' }] } });
    const id = (run('wiki/createEntry', { projectId: pid, typeId, name: 'Spada' }).payload as { id: string }).id;
    run('wiki/setEntry', { cardId: id, fields: { desc: IT, dmg: 8 } });
    run('wiki/setBlock', { cardId: id, blockId: 'a', data: { rows: [[IT2, '8']] } });
    run('wiki/setBlock', { cardId: id, blockId: 'b', data: { items: [IT] } });
    await queue!.idle();
    const row = rowsOf(id).find((r) => r.kind === 'fields');
    expect(row).toMatchObject({ lang: 'en', from_lang: 'it' });
    expect(JSON.parse(row.text)).toEqual({ 'f:desc': [IT, `[en] ${IT}`], 'b:a:0:0': [IT2, `[en] ${IT2}`], 'b:b:0': [IT, `[en] ${IT}`] });
    // In the snapshot, and gone with the entry when it goes to the trash.
    expect(buildSnapshot(db, me).translations.some((t: Translation) => t.kind === 'fields' && t.sourceId === id)).toBe(true);
    run('cards/update', { id, visibility: 'deleted' });
    expect(rowsOf(id).filter((r) => r.kind === 'fields')).toEqual([]);
  });

  it("an entry's field pieces go to the engine together, and a type's field changes redo them", async () => {
    setEnabled(true);
    makeQueue().start();
    const typeId = (run('wiki/createType', { projectId: pid, name: 'Arma', fields: [
      { key: 'a', label: 'A', kind: 'text' }, { key: 'b', label: 'B', kind: 'text' }, { key: 'c', label: 'C', kind: 'enum', options: [IT2] },
    ] }).payload as { id: string }).id;
    const id = (run('wiki/createEntry', { projectId: pid, typeId, name: 'Spada' }).payload as { id: string }).id;
    await queue!.idle();
    run('wiki/setEntry', { cardId: id, fields: { a: IT, b: IT2, c: IT2 } });
    await queue!.idle();
    const fieldsRow = () => rowsOf(id).find((r) => r.kind === 'fields');
    expect(Object.keys(JSON.parse(fieldsRow().text))).toEqual(['f:a', 'f:b']);
    expect(engine.calls.filter((c) => c.texts.includes(IT) || c.texts.includes(IT2)).map((c) => c.texts.length)).toContain(2);
    // C becomes a text field on the type: the entry's fields are translated again, now with C.
    const calls = engine.calls.length;
    run('wiki/updateType', { id: typeId, fields: [
      { key: 'a', label: 'A', kind: 'text' }, { key: 'b', label: 'B', kind: 'text' }, { key: 'c', label: 'C', kind: 'text' },
    ] });
    await waitFor(() => engine.calls.length > calls);
    await queue!.idle();
    expect(Object.keys(JSON.parse(fieldsRow().text)).sort()).toEqual(['f:a', 'f:b', 'f:c']);
  });

  it('marks text with nothing to translate so the background pass does not repeat it', async () => {
    const id = mk('ok');
    setEnabled(true);
    makeQueue().start();
    await queue!.idle();
    expect(rowsOf(id).map((r) => [r.lang, r.from_lang, r.text])).toEqual([['en', null, 'ok'], ['it', null, 'ok']]);
    pubs.length = 0;
    queue!.start();
    await queue!.idle();
    expect(pubs).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it('counts engine failures, retries later and gives up after three tries', async () => {
    setEnabled(true);
    engine.fail = true;
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    await queue!.idle();
    const fail = () => db.prepare('SELECT tries, next_at FROM translate_failures WHERE kind=? AND source_id=?').get('card', id) as any;
    expect(fail().tries).toBe(1);
    expect(fail().next_at).toBeGreaterThan(clock);
    // Not yet due: the next pass leaves it alone.
    queue!.start();
    await queue!.idle();
    expect(engine.calls).toHaveLength(1);
    clock = fail().next_at;
    queue!.start();
    await queue!.idle();
    expect(fail().tries).toBe(2);
    clock = fail().next_at;
    queue!.start();
    await queue!.idle();
    // The third failure gives up for a day: marker rows (the original, no source language), so readers stop seeing
    // "Translating…".
    expect(engine.calls).toHaveLength(3);
    expect(rowsOf(id).map((r) => r.from_lang)).toEqual([null, null]);
    expect(fail().next_at).toBe(clock + 86400e3);
    queue!.start();
    queue!.open('card', id);
    await queue!.idle();
    expect(engine.calls).toHaveLength(3);
    // A day later it is tried again; the engine works now, so the markers make way for the translation.
    clock = fail().next_at;
    engine.fail = false;
    queue!.start();
    await queue!.idle();
    expect(engine.calls).toHaveLength(4);
    expect(rowsOf(id).map((r) => [r.from_lang, r.stale])).toEqual([['it', 0]]);
    expect(fail()).toBeUndefined();
    expect(db.prepare('SELECT content FROM cards WHERE id=?').get(id)).toEqual({ content: `Titolo\n${IT}` });
  });

  it('stale rows no pass reads (a closed thread\'s comments) do not start a pass on every command', async () => {
    const id = mk(EN);
    setEnabled(true);
    makeQueue().start();
    const r = run('resolvables/create', { cardId: id, context: 'comment', content: IT }).payload as { id: string; entryId: string };
    await queue!.idle();
    run('resolvables/close', { id: r.id });
    run('projects/update', { id: pid, glossary: [{ term: 'cavaliere' }] });
    await queue!.idle();
    expect(rowsOf(r.entryId)[0].stale).toBe(1);
    const calls = engine.calls.length;
    const passes = () => (queue as any).pass;
    run('cards/update', { id, priority: 'a' });
    expect(passes()).toBeNull();
    await queue!.idle();
    expect(engine.calls.length).toBe(calls);
  });

  it('a restart (a new language pack, say) tries given-up text again at once', async () => {
    setEnabled(true);
    engine.fail = true;
    const id = mk(`Titolo\n${IT}`);
    db.prepare('INSERT INTO translate_failures (kind,source_id,tries,next_at) VALUES (?,?,?,?)').run('card', id, 3, clock + 86400e3);
    engine.fail = false;
    makeQueue().start();
    await queue!.idle();
    expect(rowsOf(id).map((r) => r.from_lang)).toEqual(['it']);
  });

  it('a source whose translation fails for good gets marker rows at its version, published', async () => {
    setEnabled(true);
    engine.fail = true;
    makeQueue().start();
    const text = `Titolo\n${IT}`;
    const id = mk(text);
    await queue!.idle();
    const fail = () => db.prepare('SELECT tries, next_at FROM translate_failures WHERE kind=? AND source_id=?').get('card', id) as any;
    for (let i = 0; i < 2; i++) {
      expect(rowsOf(id)).toEqual([]); // not before the last try
      clock = fail().next_at;
      queue!.start();
      await queue!.idle();
    }
    expect(fail().tries).toBe(3); // waits a day before the next try
    const rows = rowsOf(id);
    expect(rows.map((r) => [r.lang, r.from_lang, r.text, r.source_version])).toEqual([['en', null, text, version(id)], ['it', null, text, version(id)]]);
    expect(pubs.map((p) => [p.op, p.row.lang, p.row.fromLang, p.row.text])).toEqual([['upsert', 'en', null, text], ['upsert', 'it', null, text]]);
    // An edit is new text: it gets its own tries.
    engine.fail = false;
    run('cards/update', { id, content: `Titolo\n${IT2}`, contentVersion: version(id) });
    await waitFor(() => rowsOf(id).some((r) => r.from_lang === 'it'));
  });

  it('removes the translations of a deleted card, and of its comments, and says so', async () => {
    setEnabled(true);
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    const { entryId } = run('resolvables/create', { cardId: id, context: 'comment', content: IT2 }).payload as { entryId: string };
    await queue!.idle();
    expect(rowsOf(id)).toHaveLength(1);
    expect(rowsOf(entryId)).toHaveLength(1);
    const { events } = run('cards/update', { id, visibility: 'deleted' });
    expect(rowsOf(id)).toEqual([]);
    expect(rowsOf(entryId)).toEqual([]);
    const removed = events.filter((e) => e.model === 'translation');
    expect(removed.map((e) => [e.op, (e.row as any).kind, (e.row as any).sourceId])).toEqual([['remove', 'card', id], ['remove', 'entry', entryId]]);
    // The background pass skips trashed cards.
    queue!.start();
    await queue!.idle();
    expect(rowsOf(id)).toEqual([]);
  });

  it('drops the rows of hard-deleted cards with their project', async () => {
    setEnabled(true);
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    const { entryId } = run('resolvables/create', { cardId: id, context: 'comment', content: IT2 }).payload as { entryId: string };
    await queue!.idle();
    run('projects/delete', { id: pid });
    expect(db.prepare('SELECT COUNT(*) n FROM translations').get()).toEqual({ n: 0 });
    expect(rowsOf(entryId)).toEqual([]);
  });

  it('puts the translations of visible cards and their open comments in the snapshot', async () => {
    setEnabled(true);
    makeQueue().start();
    const id = mk(`Titolo\n${IT}`);
    const { entryId } = run('resolvables/create', { cardId: id, context: 'comment', content: IT2 }).payload as { entryId: string };
    await queue!.idle();
    const mine = buildSnapshot(db, me).translations as Translation[];
    expect(mine.map((t) => [t.kind, t.sourceId, t.lang]).sort()).toEqual([['card', id, 'en'], ['entry', entryId, 'en']]);
    expect(mine[0]).toHaveProperty('sourceVersion');
    const uid = newId();
    db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,0,0)').run(uid, 'm@x.io', 'M', 'x');
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(uid);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(pid);
    const other = { id: uid, email: 'm@x.io', name: 'M', timezone: null, disabled: false, createdAt: 0 } as User;
    expect(buildSnapshot(db, other).translations).toEqual([]);
  });

  it('translates a long page in batches and serves an open between them', async () => {
    const other = mk(`Altra\n${IT2}`);
    const paras = Array.from({ length: 200 }, (_, i) => `Paragrafo ${i}: ${IT} ${IT2} ${IT}`);
    const page = (run('cards/create', { content: `Storia\n\n${paras.join('\n\n')}`, deckId: deck }).payload as { id: string }).id;
    expect(paras.join('\n\n').length).toBeGreaterThan(30_000);
    setEnabled(true);
    makeQueue(engine, { debounceMs: 0 });
    // The page is due before the background pass would pick either card.
    queue!.touch('card', page);
    engine.onCall = (n) => { if (n === 3) queue!.open('card', other); };
    queue!.start();
    await queue!.idle();
    expect(rowsOf(page)).toHaveLength(1);
    expect(engine.calls.every((c) => c.texts.length <= 32)).toBe(true);
    expect(engine.calls.map((c) => c.texts.length)).toEqual([32, 32, 32, 1, 32, 32, 32, 8]);
    expect(engine.calls[3].texts).toEqual([IT2]);
    const order = pubs.map((p) => p.row.sourceId);
    expect(order).toEqual([other, page]);
  });

  it('keeps its size within the cap', () => {
    setEnabled(true);
    makeQueue(engine, { cap: 3, debounceMs: 60_000 });
    for (let i = 0; i < 6; i++) queue!.touch('card', `c${i}`);
    expect(queue!.queued()).toBe(3);
  });

  it('never throws into the save path', () => {
    setEnabled(true);
    makeQueue({ available: () => { throw new Error('x'); }, translate: async () => [] });
    expect(() => queue!.touch('card', 'x')).not.toThrow();
    expect(() => mk(`Titolo\n${IT}`)).not.toThrow();
  });

  it('works with the real engine and the fixture pack', async () => {
    const real = new TranslateEngine({ packDir: PACK });
    try {
      setEnabled(true);
      makeQueue(real).start();
      const id = mk(`Titolo\n${IT}`);
      await queue!.idle();
      expect(rowsOf(id)).toEqual([expect.objectContaining({ lang: 'en', text: `Titolo\n[en] ${IT}` })]);
    } finally {
      await queue!.stop();
      await real.close();
    }
  });
});

describe('protectedNames', () => {
  it('protects names and aliases of name-kind Lore entries, plus the project glossary and "lore"', () => {
    const typeId = (run('wiki/createType', { projectId: pid, name: 'Character' }).payload as { id: string }).id;
    const asdis = (run('wiki/createEntry', { projectId: pid, typeId, name: 'Asdis' }).payload as { id: string }).id;
    run('wiki/setAliases', { cardId: asdis, aliases: ['Ozzac Ots'] });
    run('wiki/createEntry', { projectId: pid, typeId: null, name: 'Storia del mondo' });
    const terms = protectedNames(db, pid).map((g) => g.term);
    expect(terms).toEqual(expect.arrayContaining(['Asdis', 'Ozzac Ots', 'lore']));
    expect(terms).not.toContain('Storia del mondo');

    db.prepare('UPDATE projects SET keep_names_json=? WHERE id=?').run(JSON.stringify([{ term: 'asdis', it: 'Asdì' }, { term: 'LORE', it: 'lore' }]), pid);
    const g = protectedNames(db, pid);
    expect(g.filter((x) => x.term.toLowerCase() === 'asdis')).toEqual([{ term: 'asdis', it: 'Asdì' }]);
    expect(g.filter((x) => x.term.toLowerCase() === 'lore')).toEqual([{ term: 'LORE', it: 'lore' }]);
  });

  it('counts types whose parent is a name kind', () => {
    const parent = (run('wiki/createType', { projectId: pid, name: 'Location' }).payload as { id: string }).id;
    const child = (run('wiki/createType', { projectId: pid, name: 'Harbour', parentTypeId: parent }).payload as { id: string }).id;
    run('wiki/createEntry', { projectId: pid, typeId: child, name: 'Porto Grigio' });
    expect(protectedNames(db, pid).map((g) => g.term)).toContain('Porto Grigio');
  });
});

describe('the app', () => {
  it('runs a queue whose rows go out as live events to the card\'s viewers, and stops it on close', async () => {
    const { buildApp } = await import('../server/app');
    let closed = false;
    const eng = { ...fakeEngine(), close: async () => { closed = true; } };
    const app = buildApp({ db, hosts: ['localhost:8780'], translate: { engine: eng, queue: { debounceMs: 10, backfillGapMs: 0 } } });
    try {
      setEnabled(true);
      const sent: any[] = [];
      const publish = app.hub.publish.bind(app.hub);
      app.hub.publish = (actionId, events) => { sent.push(...events); publish(actionId, events); };
      const id = mk(`Titolo\n${IT}`);
      const { entryId } = run('resolvables/create', { cardId: id, context: 'comment', content: IT2 }).payload as { entryId: string };
      await app.translate.idle();
      const ev = sent.filter((e) => e.model === 'translation');
      expect(ev.map((e) => [e.op, e.row.sourceId]).sort()).toEqual([['upsert', entryId], ['upsert', id]].sort());
      for (const e of ev) expect((app.hub as any).route(e)).toMatchObject({ to: 'card', projectId: pid });
      // A remove of a comment whose card was deleted for good routes nowhere (the project's removal reloads clients).
      expect((app.hub as any).route({ model: 'translation', op: 'remove', row: { kind: 'entry', sourceId: 'gone', lang: 'en' } })).toBeNull();
    } finally {
      await app.close();
    }
    expect(closed).toBe(true);
  });
});

describe('batched', () => {
  it('joins calls of one turn per direction and hands each its slice; an answer that does not fit leaves all as written', async () => {
    const seen: string[][] = [];
    const run = batched(async (texts) => { seen.push(texts); return texts.map((t) => t.toUpperCase()); });
    expect(await Promise.all([run(['a'], 'it', 'en'), run(['b', 'c'], 'it', 'en'), run(['d'], 'en', 'it')])).toEqual([['A'], ['B', 'C'], ['D']]);
    expect(seen).toEqual([['a', 'b', 'c'], ['d']]);
    const short = batched(async () => ['x']);
    expect(await Promise.all([short(['a'], 'it', 'en'), short(['b'], 'it', 'en')])).toEqual([[], []]);
  });
});
