import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TranslateEngine, packDirFor } from '../server/translate/engine';

const PACK = join(__dirname, 'fixtures', 'translate-pack');
const SCRATCH = join(homedir(), '.cache', 'gametracker', 'scratch', 'translate-engine-test');
let engine: TranslateEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
  delete process.env.JT_TRANSLATE_LOADLOG;
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('TranslateEngine', () => {
  it('is available only with a pack', () => {
    expect(new TranslateEngine({ packDir: join(PACK, 'nope') }).available()).toBe(false);
    expect(new TranslateEngine({ packDir: PACK }).available()).toBe(true);
  });

  it('translates through the pack', async () => {
    engine = new TranslateEngine({ packDir: PACK });
    expect(await engine.translate(['Ciao'], 'it', 'en')).toEqual(['[en] Ciao']);
  });

  it('unloads when idle and reloads on the next call', async () => {
    engine = new TranslateEngine({ packDir: PACK, idleMs: 50 });
    await engine.translate(['a'], 'en', 'it');
    expect(engine.isLoaded()).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.isLoaded()).toBe(false);
    expect(await engine.translate(['b'], 'en', 'it')).toEqual(['[it] b']);
  });

  it('rejects on a pack error and restarts the worker', async () => {
    engine = new TranslateEngine({ packDir: PACK });
    await expect(engine.translate(['THROW'], 'en', 'it')).rejects.toThrow(Error);
    expect(await engine.translate(['a'], 'en', 'it')).toEqual(['[it] a']);
  });

  it('close() leaves no worker', async () => {
    engine = new TranslateEngine({ packDir: PACK });
    await engine.translate(['a'], 'en', 'it');
    await engine.close();
    expect(engine.isLoaded()).toBe(false);
  });

  it('times out a hung call, rejects, and works again afterwards', async () => {
    engine = new TranslateEngine({ packDir: PACK, timeoutMs: 150 });
    await expect(engine.translate(['HANG'], 'en', 'it')).rejects.toThrow(/timed out/);
    expect(engine.isLoaded()).toBe(false);
    expect(await engine.translate(['a'], 'en', 'it')).toEqual(['[it] a']);
  });

  it('close() does not wait on a hung call', async () => {
    engine = new TranslateEngine({ packDir: PACK, timeoutMs: 60_000 });
    const hung = engine.translate(['HANG'], 'en', 'it');
    const settled = hung.catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    await engine.close();
    expect(Date.now() - t).toBeLessThan(2000);
    expect(await settled).toMatch(/closed|exited/);
    expect(engine.isLoaded()).toBe(false);
  });

  it('swaps direction: one pair loaded at a time', async () => {
    mkdirSync(SCRATCH, { recursive: true });
    const log = join(SCRATCH, 'loads.log');
    process.env.JT_TRANSLATE_LOADLOG = log;
    engine = new TranslateEngine({ packDir: PACK });
    expect(await engine.translate(['a', 'WHICH'], 'en', 'it')).toEqual(['[it] a', 'en>it']);
    expect(await engine.translate(['b', 'WHICH'], 'it', 'en')).toEqual(['[en] b', 'it>en']);
    expect(await engine.translate(['c'], 'it', 'en')).toEqual(['[en] c']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['en>it', 'it>en']);
  });

  it('serves concurrent calls one at a time, in order', async () => {
    engine = new TranslateEngine({ packDir: PACK });
    const r = await Promise.all([engine.translate(['a'], 'en', 'it'), engine.translate(['b'], 'it', 'en'), engine.translate(['c'], 'en', 'it')]);
    expect(r).toEqual([['[it] a'], ['[en] b'], ['[it] c']]);
  });
});

describe('TranslateEngine failures', () => {
  it('survives a worker that crashes while idle', async () => {
    engine = new TranslateEngine({ packDir: PACK });
    expect(await engine.translate(['CRASHLATER'], 'en', 'it')).toEqual(['[ok]']);
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.isLoaded()).toBe(false);
    expect(await engine.translate(['a'], 'en', 'it')).toEqual(['[it] a']);
  });

  it('rejects when load() throws, then recovers once the pack is fixed', async () => {
    mkdirSync(SCRATCH, { recursive: true });
    writeFileSync(join(SCRATCH, 'engine.mjs'), "export async function load() { throw new Error('bad pack'); }\nexport async function translate() { return []; }\n");
    engine = new TranslateEngine({ packDir: SCRATCH });
    await expect(engine.translate(['a'], 'en', 'it')).rejects.toThrow(/bad pack/);
    expect(engine.isLoaded()).toBe(false);
    copyFileSync(join(PACK, 'engine.mjs'), join(SCRATCH, 'engine.mjs'));
    expect(await engine.translate(['a'], 'en', 'it')).toEqual(['[it] a']);
  });

  it('rejects when engine.mjs is broken or missing, then recovers', async () => {
    mkdirSync(SCRATCH, { recursive: true });
    engine = new TranslateEngine({ packDir: SCRATCH });
    await expect(engine.translate(['a'], 'en', 'it')).rejects.toThrow(Error); // missing
    writeFileSync(join(SCRATCH, 'engine.mjs'), 'export const = ;');
    await expect(engine.translate(['a'], 'en', 'it')).rejects.toThrow(Error); // syntax error
    copyFileSync(join(PACK, 'engine.mjs'), join(SCRATCH, 'engine.mjs'));
    expect(await engine.translate(['a'], 'en', 'it')).toEqual(['[it] a']);
  });
});

describe('packDirFor', () => {
  it('defaults beside the server and honours JT_TRANSLATE_PACK', () => {
    expect(packDirFor('/x/server')).toBe('/x/models/translate');
    process.env.JT_TRANSLATE_PACK = '/y';
    try { expect(packDirFor('/x/server')).toBe('/y'); } finally { delete process.env.JT_TRANSLATE_PACK; }
  });
});
