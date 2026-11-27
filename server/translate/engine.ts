import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Lang } from '../../shared/translate';

/** The language pack folder: JT_TRANSLATE_PACK, else `models/translate` beside the server's own folder. */
export const packDirFor = (serverDir: string): string => process.env.JT_TRANSLATE_PACK || resolve(serverDir, '..', 'models', 'translate');

/** In the bundle build-server copies the worker to translate/worker.mjs; from source it sits beside this file. */
function defaultWorkerUrl(): URL {
  const bundled = new URL('./translate/worker.mjs', import.meta.url);
  return existsSync(bundled) ? bundled : new URL('./worker.mjs', import.meta.url);
}

type Pending = { resolve: (v: string[]) => void; reject: (e: Error) => void };

/**
 * Runs the language pack (`engine.mjs` in packDir) in a worker thread. Only one direction is loaded at a time:
 * a request for the other direction restarts the worker. Calls are served one at a time; the worker is
 * terminated after `idleMs` without calls, or after an error. A call that
 * takes longer than `timeoutMs` (a hung pack) is rejected and its worker terminated, so the next call starts fresh.
 */
export class TranslateEngine {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private pair = '';
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly packDir: string;
  private readonly workerUrl: URL;

  constructor(opts: { packDir: string; idleMs?: number; timeoutMs?: number; workerUrl?: URL }) {
    this.packDir = opts.packDir;
    this.idleMs = opts.idleMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.workerUrl = opts.workerUrl ?? defaultWorkerUrl();
  }

  available(): boolean {
    return existsSync(join(this.packDir, 'engine.mjs')) && existsSync(join(this.packDir, 'pack.json'));
  }

  /** The pack's version from pack.json, or null when there is none (or it is unreadable). */
  version(): string | null {
    try {
      const v = (JSON.parse(readFileSync(join(this.packDir, 'pack.json'), 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' ? v : null;
    } catch { return null; }
  }

  isLoaded(): boolean {
    return this.worker !== null;
  }

  translate(texts: string[], from: Lang, to: Lang): Promise<string[]> {
    const run = this.tail.then(() => this.run(texts, from, to));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Stops the worker now (a call in flight is rejected, a hung one cannot hold shutdown), then waits for the calls to settle. */
  async close(): Promise<void> {
    await this.stop();
    await this.tail;
    await this.stop();
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async stop() {
    this.clearIdle();
    const w = this.worker;
    this.worker = null;
    this.pair = '';
    if (w) await w.terminate();
  }

  /** Persistent listeners: an idle worker that dies must not crash the server or leave a dead worker behind. */
  private async start(from: Lang, to: Lang): Promise<Worker> {
    const w = new Worker(this.workerUrl, { workerData: { dir: this.packDir, from, to } });
    let ready!: () => void;
    let failLoad!: (e: Error) => void;
    const loaded = new Promise<void>((ok, fail) => { ready = ok; failLoad = fail; });
    const died = (e: Error) => {
      if (this.worker === w) { this.worker = null; this.pair = ''; this.clearIdle(); }
      failLoad(e);
      const p = this.pending;
      this.pending = null;
      p?.reject(e);
    };
    w.on('message', (m: { ready?: boolean; id?: number; out?: string[]; error?: string }) => {
      if (m.ready) return ready();
      const p = this.pending;
      if (!p || m.id !== 1) return;
      this.pending = null;
      m.error !== undefined ? p.reject(new Error(m.error)) : p.resolve(m.out ?? []);
    });
    w.on('error', (e) => died(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => died(new Error('translate worker exited')));
    try {
      await loaded;
    } catch (e) {
      await w.terminate();
      throw e;
    }
    return w;
  }

  private async run(texts: string[], from: Lang, to: Lang): Promise<string[]> {
    this.clearIdle();
    const want = `${from}>${to}`;
    if (this.worker && this.pair !== want) await this.stop();
    if (!this.worker) {
      const w = await this.start(from, to);
      this.worker = w;
      this.pair = want;
    }
    const w = this.worker;
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`translate call timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
        this.pending = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
        w.postMessage({ id: 1, texts, from, to });
      });
    } catch (e) {
      this.pending = null;
      await this.stop(); // restart fresh on the next call
      throw e;
    } finally {
      if (this.worker === w) this.idleTimer = setTimeout(() => { void this.stop(); }, this.idleMs).unref();
    }
  }
}
