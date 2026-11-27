import { tx, type Db } from '../db';
import type { Ctx } from '../dispatch';
import { detectLang, LANGS, textVersion, translateMarkdown, type Lang, type RunFn } from '../../shared/translate';
import type { AccountSettings, Translation } from '../../shared/types';
import type { TranslateEngine } from './engine';
import { protectedNames } from './names';
import { fieldsSource, FIELDS_VERSION_SQL } from './fields';

/** card: its Markdown; entry: a comment; fields: a Lore entry's text fields and lines/steps/table blocks (./fields). */
export type SourceKind = 'card' | 'entry' | 'fields';
export type TranslatePublish = (model: 'translation', op: 'upsert' | 'remove', row: object) => void;
export interface TranslateQueueOptions {
  /** Wait after the last save before translating (typing bursts collapse). */
  debounceMs?: number;
  /** Pause after each background item, so the pass never holds a core flat. */
  backfillGapMs?: number;
  /** Most items held at once (all priorities); past it the oldest background items drop, then the oldest saves. */
  cap?: number;
  /** Clock for stored times (created_at, retry times). Waiting always uses real time. */
  now?: () => number;
  /** How often an idle queue starts another background pass (retries, text saved without a touch). */
  pollMs?: number;
}

/** Blocks per engine call: a long page goes in several calls, with opened items served between them. */
const ENGINE_BATCH = 32;
/** Sources the background pass reads per query. */
const BACKFILL_BATCH = 20;
const MAX_TRIES = 3;
const RETRY_MS = 60_000;
/** After MAX_TRIES failures: the original is shown, and the text is tried once more a day later (or at a restart). */
const GIVE_UP_MS = 86_400_000;

class Stopped extends Error {}

type Source = { text: string; version: number; projectId: string | null; authorId: string; cardId: string };

/** The queue serving each database (commands find it through touchTranslation). */
const queues = new WeakMap<Db, TranslateQueue>();

/** After the command commits, the source's text is (re)translated in the background. Never throws. */
export function touchTranslation(ctx: Ctx, kind: SourceKind, id: string): void {
  const q = queues.get(ctx.db);
  if (q) ctx.afterCommit(() => q.touch(kind, id));
}

/** The queue for `db`, if one runs (the open endpoint, status). */
export const translateQueueOf = (db: Db): TranslateQueue | undefined => queues.get(db);

/** A card going to the trash takes its translations and its comments' translations along; clients are told. */
export function dropCardTranslations(ctx: Ctx, cardId: string): void {
  const { db } = ctx;
  const where = `(kind IN ('card','fields') AND source_id=?) OR (kind='entry' AND source_id IN
    (SELECT e.id FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id WHERE r.card_id=?))`;
  const gone = db.prepare(`SELECT kind, source_id s, lang FROM translations WHERE ${where} ORDER BY kind, source_id, lang`)
    .all(cardId, cardId) as { kind: SourceKind; s: string; lang: Lang }[];
  db.prepare(`DELETE FROM translations WHERE ${where}`).run(cardId, cardId);
  db.prepare(`DELETE FROM translate_failures WHERE ${where}`).run(cardId, cardId);
  for (const g of gone) ctx.emit('translation', 'remove', { kind: g.kind, sourceId: g.s, lang: g.lang, cardId });
}

/**
 * Translates card text and comments into every language they are not written in, one item at a time, so memory
 * stays flat. Opened items (high) go before saves (normal, after a debounce), and the background pass over
 * everything not yet translated (low) runs only when both are empty. A translation is stored only if its source
 * did not change meanwhile; otherwise the source goes round again. Nothing runs while the workspace setting is off
 * or the engine has no language pack.
 */
export class TranslateQueue {
  private readonly high = new Map<string, true>();
  private readonly normal = new Map<string, number>();
  private readonly low = new Map<string, true>();
  private readonly debounceMs: number;
  private readonly gapMs: number;
  private readonly cap: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  /** Rowid cursors of the running background pass; null when no pass runs. */
  private pass: Record<SourceKind, number> | null = null;
  private loopDone: Promise<void> | null = null;
  /** Stale rows appeared while a pass was running: it runs once more when it ends. */
  private again = false;
  private stopped = false;
  private napping = false;
  private wake: ((timedOut: boolean) => void) | null = null;
  /** The item the loop is on (an open of it waits until it is done). */
  private current: string | null = null;
  /** Direction of the last engine call: the background pass starts with items going the same way. */
  private lastFrom: Lang | null = null;

  constructor(
    private readonly db: Db,
    private readonly engine: Pick<TranslateEngine, 'available' | 'translate'> & { version?(): string | null },
    private readonly publish: TranslatePublish,
    opts: TranslateQueueOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000;
    this.gapMs = opts.backfillGapMs ?? 2000;
    this.cap = opts.cap ?? 500;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 5 * 60_000;
    db.function('jt_text_version', { deterministic: true }, (t) => textVersion(String(t)));
    // A restart (often a new language pack) gives everything that failed a fresh try.
    db.prepare('DELETE FROM translate_failures').run();
    queues.set(db, this);
  }

  /** A save: translate after the debounce (again if it is already waiting). Never throws. */
  touch(kind: SourceKind, id: string): void {
    try {
      if (this.stopped || !this.enabled()) return;
      const key = `${kind}:${id}`;
      // New text gets fresh tries.
      this.db.prepare('DELETE FROM translate_failures WHERE kind=? AND source_id=?').run(kind, id);
      if (this.high.has(key)) return;
      this.low.delete(key);
      this.normal.delete(key);
      this.normal.set(key, Date.now() + this.debounceMs);
      this.trim();
      this.nudge();
    } catch (e) {
      console.error('[jt] translate touch failed', String((e as Error)?.message ?? e));
    }
  }

  /** Someone opened an item with no current translation: it goes first. Never throws. */
  open(kind: SourceKind, id: string): void {
    try {
      if (this.stopped || !this.enabled()) return;
      const src = this.source(kind, id);
      if (!src || this.blocked(kind, id) || this.isCurrent(kind, id, src.version)) return;
      const key = `${kind}:${id}`;
      this.normal.delete(key);
      this.low.delete(key);
      this.high.delete(key);
      this.high.set(key, true);
      this.trim();
      this.nudge();
    } catch (e) {
      console.error('[jt] translate open failed', String((e as Error)?.message ?? e));
    }
  }

  /** Runs the worker loop and starts a background pass over everything (again, when already running). */
  start(): void {
    if (this.stopped) return;
    this.pass = { card: 0, entry: 0, fields: 0 };
    if (!this.loopDone) this.loopDone = this.loop();
    else this.nudge();
  }

  /**
   * After any command: when rows went stale (glossary or names changed; migration 042's triggers), the background
   * pass redoes them. Cheap (one indexed lookup). Never throws.
   */
  wakeStale(): void {
    try {
      if (this.stopped) return;
      // Any stale row a pass would pick up (its source is one the pass reads, and it is not waiting out a retry). A
      // pass that is running may already be past it (rows it finished can go stale again), so it runs once more when
      // it ends; that rerun is cheap when empty. Rows no pass reads (comments of closed threads, untyped entries'
      // fields) must not count, or every command would start a pass.
      const due = this.db.prepare(`SELECT 1 FROM translations x WHERE x.stale=1
        AND NOT EXISTS (SELECT 1 FROM translate_failures f WHERE f.kind=x.kind AND f.source_id=x.source_id AND f.next_at>?)
        AND CASE x.kind
          WHEN 'card' THEN EXISTS (SELECT 1 FROM cards c WHERE c.id=x.source_id AND c.visibility!='deleted')
          WHEN 'entry' THEN EXISTS (SELECT 1 FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id JOIN cards c ON c.id=v.card_id
            WHERE e.id=x.source_id AND v.is_closed=0 AND c.visibility!='deleted')
          ELSE EXISTS (SELECT 1 FROM cards c WHERE c.id=x.source_id AND c.visibility!='deleted' AND c.is_doc=1 AND c.entry_type_id IS NOT NULL)
        END LIMIT 1`).get(this.now());
      if (!due) return;
      if (this.pass === null) this.start();
      else this.again = true;
    } catch (e) {
      console.error('[jt] translate wake failed', String((e as Error)?.message ?? e));
    }
  }

  /** Stops after the engine call in flight; queued items are dropped (the next start's pass finds them). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.nudge();
    await this.loopDone;
    this.high.clear();
    this.normal.clear();
    this.low.clear();
    if (queues.get(this.db) === this) queues.delete(this.db);
  }

  /** Items waiting, all priorities. */
  queued(): number {
    return this.high.size + this.normal.size + this.low.size;
  }

  /** Whether a language pack is installed. */
  packAvailable(): boolean { return this.engine.available(); }

  /** The installed pack's version, or null. */
  packVersion(): string | null { return this.engine.available() ? this.engine.version?.() ?? null : null; }

  /** Resolves once nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (!this.stopped && this.loopDone && !(this.napping && this.queued() === 0 && (this.pass === null || !this.enabled()))) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  private enabled(): boolean {
    const r = this.db.prepare('SELECT settings_json s FROM account').get() as { s: string } | undefined;
    if (!r || (JSON.parse(r.s) as Partial<AccountSettings>).translationEnabled !== true) return false;
    return this.engine.available();
  }

  private nudge(): void {
    const w = this.wake;
    this.wake = null;
    w?.(false);
  }

  /** Waits `ms` or until nudged; true when the time ran out. */
  private nap(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.wake === done) this.wake = null; resolve(true); }, ms);
      t.unref?.();
      const done = (timedOut: boolean) => { clearTimeout(t); resolve(timedOut); };
      this.wake = done;
    });
  }

  private trim(): void {
    while (this.queued() > this.cap) {
      const from = this.low.size ? this.low : this.normal.size ? this.normal : this.high;
      from.delete(from.keys().next().value!);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let wait = this.pollMs;
      try {
        if (this.enabled()) {
          const job = this.next();
          if (job) {
            await this.process(job.key, true);
            if (job.low && this.gapMs > 0 && !this.stopped) await this.nap(this.gapMs);
            continue;
          }
          const due = Math.min(...this.normal.values());
          if (Number.isFinite(due)) wait = Math.max(0, due - Date.now());
        }
      } catch (e) {
        if (e instanceof Stopped) break;
        // Something outside the engine broke (the database?): wait a poll before trying again, never spin.
        console.error('[jt] translate failed', String((e as Error)?.message ?? e));
      }
      if (this.stopped) break;
      this.napping = true;
      const timedOut = await this.nap(wait);
      this.napping = false;
      if (timedOut && wait === this.pollMs && this.pass === null) this.pass = { card: 0, entry: 0, fields: 0 };
    }
  }

  private next(): { key: string; low: boolean } | null {
    for (const key of this.high.keys()) { this.high.delete(key); return { key, low: false }; }
    const t = Date.now();
    for (const [key, at] of this.normal) if (at <= t) { this.normal.delete(key); return { key, low: false }; }
    if (this.normal.size) return null;
    if (!this.low.size) this.refill();
    for (const key of this.low.keys()) { this.low.delete(key); return { key, low: true }; }
    return null;
  }

  /** The next few sources of the background pass that have no current translation and are not waiting for a retry. */
  private refill(): void {
    const pass = this.pass;
    if (!pass) return;
    const failed = (kind: SourceKind, col: string) => `NOT EXISTS (SELECT 1 FROM translate_failures f WHERE f.kind='${kind}'
      AND f.source_id=${col} AND f.next_at>?)`;
    // Not current: no fresh row at this version, or one written when tries ran out (a failure row is kept with it).
    const current = (kind: SourceKind, col: string, version: string) =>
      `(NOT EXISTS (SELECT 1 FROM translations x WHERE x.kind='${kind}' AND x.source_id=${col} AND x.source_version=${version} AND x.stale=0)
        OR EXISTS (SELECT 1 FROM translate_failures g WHERE g.kind='${kind}' AND g.source_id=${col}))`;
    const queries: Record<SourceKind, string> = {
      card: `SELECT c.rowid r, c.id, c.content t FROM cards c WHERE c.rowid>? AND c.visibility!='deleted'
         AND ${current('card', 'c.id', 'c.content_version')} AND ${failed('card', 'c.id')}`,
      // Comments of open threads only (what clients load); closed ones are translated when opened.
      entry: `SELECT e.rowid r, e.id, e.content t FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id
           JOIN cards c ON c.id=v.card_id
         WHERE e.rowid>? AND v.is_closed=0 AND c.visibility!='deleted'
           AND ${current('entry', 'e.id', 'jt_text_version(e.content)')} AND ${failed('entry', 'e.id')}`,
      fields: `SELECT c.rowid r, c.id, c.fields_json t FROM cards c WHERE c.rowid>? AND c.visibility!='deleted' AND c.is_doc=1
         AND c.entry_type_id IS NOT NULL AND ${current('fields', 'c.id', FIELDS_VERSION_SQL)} AND ${failed('fields', 'c.id')}`,
    };
    for (const kind of ['card', 'entry', 'fields'] as const) {
      const rows = this.db.prepare(`${queries[kind]} ORDER BY 1 LIMIT ${BACKFILL_BATCH}`).all(pass[kind], this.now()) as { r: number; id: string; t: string }[];
      if (!rows.length) continue;
      pass[kind] = rows[rows.length - 1].r;
      // The engine holds one direction at a time: items written in the language it last read from go first.
      const rank = (t: string) => { const l = detectLang(t); return l === null ? 3 : l === this.lastFrom ? 0 : l === 'it' ? 1 : 2; };
      const order = rows.map((x) => ({ id: x.id, rank: rank(x.t) })).sort((a, b) => a.rank - b.rank);
      for (const x of order) {
        const key = `${kind}:${x.id}`;
        if (!this.high.has(key) && !this.normal.has(key)) this.low.set(key, true);
      }
      this.trim();
      return;
    }
    // Asked to run again: start over now (not at the next poll).
    this.pass = this.again ? { card: 0, entry: 0, fields: 0 } : null;
    if (!this.again) return;
    this.again = false;
    return this.refill();
  }

  private source(kind: SourceKind, id: string): Source | null {
    if (kind === 'fields') return fieldsSource(this.db, id);
    if (kind === 'card') {
      const r = this.db.prepare(`SELECT c.content t, c.content_version v, c.creator_id a, d.project_id p FROM cards c
        LEFT JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.visibility!='deleted'`).get(id) as { t: string; v: number; a: string; p: string | null } | undefined;
      return r ? { text: r.t, version: r.v, projectId: r.p, authorId: r.a, cardId: id } : null;
    }
    const r = this.db.prepare(`SELECT e.content t, e.author_id a, c.id c, d.project_id p FROM resolvable_entries e
      JOIN resolvables v ON v.id=e.resolvable_id JOIN cards c ON c.id=v.card_id LEFT JOIN decks d ON d.id=c.deck_id
      WHERE e.id=? AND c.visibility!='deleted'`).get(id) as { t: string; a: string; c: string; p: string | null } | undefined;
    return r ? { text: r.t, version: textVersion(r.t), projectId: r.p, authorId: r.a, cardId: r.c } : null;
  }

  private isCurrent(kind: SourceKind, id: string, version: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM translations WHERE kind=? AND source_id=? AND source_version=? AND stale=0
      AND NOT EXISTS (SELECT 1 FROM translate_failures WHERE kind=? AND source_id=?) LIMIT 1`).get(kind, id, version, kind, id);
  }

  private blocked(kind: SourceKind, id: string): boolean {
    const f = this.db.prepare('SELECT next_at n FROM translate_failures WHERE kind=? AND source_id=?').get(kind, id) as { n: number } | undefined;
    return !!f && f.n > this.now();
  }

  /** The author's reading language: assumed for blocks too short to tell. */
  private readLangOf(userId: string): Lang | null {
    const r = this.db.prepare("SELECT value_json v FROM user_prefs WHERE user_id=? AND key='readLang'").get(userId) as { v: string } | undefined;
    const l = r ? JSON.parse(r.v) : null;
    return (LANGS as readonly unknown[]).includes(l) ? l as Lang : null;
  }

  /** Engine calls of at most ENGINE_BATCH texts; between them the top-level item lets opened items go first. */
  private runFn(top: boolean): RunFn {
    return async (texts, from, to) => {
      const out: string[] = [];
      for (let i = 0; i < texts.length; i += ENGINE_BATCH) {
        if (this.stopped) throw new Stopped();
        if (i > 0 && top) await this.serveOpened();
        if (this.stopped) throw new Stopped();
        const part = texts.slice(i, i + ENGINE_BATCH);
        this.lastFrom = from;
        const got = await this.engine.translate(part, from, to);
        if (!Array.isArray(got) || got.length !== part.length) return []; // the whole group keeps its original text
        out.push(...got);
      }
      return out;
    };
  }

  private async serveOpened(): Promise<void> {
    for (;;) {
      const key = [...this.high.keys()].find((k) => k !== this.current);
      if (!key || this.stopped || !this.enabled()) return;
      this.high.delete(key);
      await this.process(key, false);
    }
  }

  private async process(key: string, top: boolean): Promise<void> {
    const at = key.indexOf(':');
    const kind = key.slice(0, at) as SourceKind, id = key.slice(at + 1);
    if (top) this.current = key;
    try {
      const src = this.source(kind, id);
      if (!src) return this.drop(kind, id);
      if (this.blocked(kind, id) || this.isCurrent(kind, id, src.version)) return;
      const opts = { glossary: protectedNames(this.db, src.projectId), fallback: this.readLangOf(src.authorId), run: this.runFn(top) };
      const made: { lang: Lang; from: Lang | null; text: string }[] = [];
      try {
        for (const to of LANGS) {
          const r = kind === 'fields' ? await translatePieces(src.text, to, opts) : await translateMarkdown(src.text, to, opts);
          if (r.from) made.push({ lang: to, from: r.from, text: r.text });
        }
      } catch (e) {
        if (e instanceof Stopped) throw e;
        console.error('[jt] translate engine failed', kind, String((e as Error)?.message ?? e));
        return this.failed(kind, id, src);
      }
      const after = this.source(kind, id);
      if (!after) return this.drop(kind, id);
      if (after.version !== src.version) {
        // Edited meanwhile: this translation is of old text. The new text goes round again.
        if (!this.high.has(key) && !this.normal.has(key)) { this.normal.set(key, Date.now()); this.trim(); }
        return;
      }
      // Nothing to translate into any language: one row per language records that this version was looked at.
      if (!made.length) for (const lang of LANGS) made.push({ lang, from: null, text: src.text });
      this.write(kind, id, src, made);
    } finally {
      if (top) this.current = null;
    }
  }

  private write(kind: SourceKind, id: string, src: Source, made: { lang: Lang; from: Lang | null; text: string }[]): void {
    const createdAt = this.now();
    const rows: Translation[] = made.map((m) => ({ kind, sourceId: id, lang: m.lang, sourceVersion: src.version, fromLang: m.from, text: m.text, createdAt }));
    const keep = new Set(made.map((m) => m.lang));
    const old = (this.db.prepare('SELECT lang FROM translations WHERE kind=? AND source_id=?').all(kind, id) as { lang: Lang }[])
      .map((r) => r.lang).filter((l) => !keep.has(l));
    tx(this.db, () => {
      for (const l of old) this.db.prepare('DELETE FROM translations WHERE kind=? AND source_id=? AND lang=?').run(kind, id, l);
      for (const r of rows) {
        this.db.prepare(`INSERT INTO translations (kind,source_id,lang,source_version,from_lang,text,created_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT (kind,source_id,lang) DO UPDATE SET source_version=excluded.source_version, from_lang=excluded.from_lang,
          text=excluded.text, created_at=excluded.created_at, stale=0`).run(kind, id, r.lang, r.sourceVersion, r.fromLang, r.text, r.createdAt);
      }
      this.db.prepare('DELETE FROM translate_failures WHERE kind=? AND source_id=?').run(kind, id);
    });
    for (const l of old) this.send('remove', { kind, sourceId: id, lang: l, cardId: src.cardId });
    for (const r of rows) this.send('upsert', r);
  }

  /** The source is gone (or in the trash): so are its translations. */
  private drop(kind: SourceKind, id: string): void {
    const gone = this.db.prepare('SELECT lang FROM translations WHERE kind=? AND source_id=?').all(kind, id) as { lang: Lang }[];
    this.db.prepare('DELETE FROM translations WHERE kind=? AND source_id=?').run(kind, id);
    this.db.prepare('DELETE FROM translate_failures WHERE kind=? AND source_id=?').run(kind, id);
    for (const g of gone) this.send('remove', { kind, sourceId: id, lang: g.lang });
  }

  private failed(kind: SourceKind, id: string, src: Source): void {
    const f = this.db.prepare('SELECT tries FROM translate_failures WHERE kind=? AND source_id=?').get(kind, id) as { tries: number } | undefined;
    const tries = (f?.tries ?? 0) + 1;
    const giveUp = tries >= MAX_TRIES;
    // Given up: readers see the original instead of "Translating…". A row at this version (a stale translation after
    // a glossary change) stays as it is; otherwise marker rows (the original, no source language) are written. The
    // failure row kept with them makes the pass try once more a day later. An edit is a new version: translated
    // afresh, with its own tries.
    if (giveUp && !this.db.prepare('SELECT 1 FROM translations WHERE kind=? AND source_id=? AND source_version=?').get(kind, id, src.version)) {
      this.write(kind, id, src, LANGS.map((lang) => ({ lang, from: null, text: src.text })));
    }
    this.db.prepare(`INSERT INTO translate_failures (kind,source_id,tries,next_at) VALUES (?,?,?,?)
      ON CONFLICT (kind,source_id) DO UPDATE SET tries=excluded.tries, next_at=excluded.next_at`)
      .run(kind, id, Math.min(tries, MAX_TRIES), this.now() + (giveUp ? GIVE_UP_MS : RETRY_MS * 4 ** (tries - 1)));
  }

  private send(op: 'upsert' | 'remove', row: object): void {
    try {
      this.publish('translation', op, row);
    } catch (e) {
      console.error('[jt] translation publish failed', String((e as Error)?.message ?? e));
    }
  }
}

/**
 * A fields source (JSON of pieceKey -> text) into `to`: JSON of pieceKey -> [source, translation] for the pieces that
 * needed it, so readers use a piece only while it still reads the same. from: the first piece's source language.
 * The pieces are translated side by side and their engine calls joined into one per direction (batched).
 */
async function translatePieces(text: string, to: Lang, opts: Parameters<typeof translateMarkdown>[2]): Promise<{ from: Lang | null; text: string }> {
  const pieces = Object.entries(JSON.parse(text) as Record<string, string>);
  const run = batched(opts.run);
  const done = await Promise.all(pieces.map(([, v]) => translateMarkdown(v, to, { ...opts, run })));
  const out: Record<string, [string, string]> = {};
  let from: Lang | null = null;
  done.forEach((r, i) => { if (r.from) { from ??= r.from; out[pieces[i][0]] = [pieces[i][1], r.text]; } });
  return { from, text: JSON.stringify(out) };
}

/**
 * Calls made in the same turn of the event loop go to `run` as one call per direction; each caller gets its own
 * slice back ([] when the engine's answer does not fit, so that caller keeps its original). A failure fails them all.
 */
export function batched(run: RunFn): RunFn {
  let waiting: { texts: string[]; from: Lang; to: Lang; ok: (r: string[]) => void; fail: (e: unknown) => void }[] = [];
  const flush = async () => {
    const jobs = waiting;
    waiting = [];
    const groups = new Map<string, typeof jobs>();
    for (const j of jobs) groups.set(`${j.from}>${j.to}`, [...(groups.get(`${j.from}>${j.to}`) ?? []), j]);
    for (const group of groups.values()) {
      try {
        const all = group.flatMap((j) => j.texts);
        const got = await run(all, group[0].from, group[0].to);
        let at = 0;
        for (const j of group) { j.ok(Array.isArray(got) && got.length === all.length ? got.slice(at, at + j.texts.length) : []); at += j.texts.length; }
      } catch (e) {
        for (const j of group) j.fail(e);
      }
    }
  };
  return (texts, from, to) => new Promise((ok, fail) => {
    if (!waiting.length) setImmediate(() => void flush());
    waiting.push({ texts, from, to, ok, fail });
  });
}
