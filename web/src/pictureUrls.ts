/**
 * The pictures the Asset Shelf and Groundwork browsers show, read from the team's library as object URLs: a few at a
 * time, each once, at most `keep` kept. Reading one makes it the most recent; when there are too many, the least
 * recently read go first, but never one the current render shows (so a screen with more pictures than `keep` never
 * fetches in a loop; the browsers page their grids, so that stays small). Everything is revoked on dispose.
 */
export interface PictureUrlsOptions {
  keep: number;
  atOnce: number;
  /** The picture as an object URL, or null when there is none. */
  load(path: string): Promise<string | null>;
  revoke(url: string): void;
  /** A picture arrived: render again. */
  changed(): void;
}

export class PictureUrls {
  private urls = new Map<string, string | null>(); // oldest read first
  private seen = new Map<string, number>(); // path → the render that last read it
  private queue: string[] = [];
  private waiting = new Set<string>(); // queued or on its way
  private running = 0;
  private gen = 0;
  private gone = false;

  constructor(private o: PictureUrlsOptions) {}

  /** Call once at the start of every render. */
  frame(): void {
    this.gen++;
    // Forget the render marks of pictures that are neither kept nor on their way, so the marks stay bounded too.
    if (this.seen.size > this.o.keep * 4) for (const p of this.seen.keys()) if (!this.urls.has(p) && !this.waiting.has(p)) this.seen.delete(p);
  }

  /** The picture's URL: undefined while it loads, null when there is none. */
  get(path: string): string | null | undefined {
    this.seen.set(path, this.gen);
    if (this.urls.has(path)) {
      const u = this.urls.get(path)!;
      this.urls.delete(path); // most recently read: to the end
      this.urls.set(path, u);
      return u;
    }
    if (!this.waiting.has(path)) {
      this.waiting.add(path);
      this.queue.push(path);
      queueMicrotask(() => this.pump());
    }
    return undefined;
  }

  /** The pack or tab changed: what was waiting is no longer wanted (pictures on their way still land). */
  reset(): void {
    for (const p of this.queue) this.waiting.delete(p);
    this.queue = [];
  }

  dispose(): void {
    this.gone = true;
    this.reset();
    for (const u of this.urls.values()) if (u) this.o.revoke(u);
    this.urls.clear();
    this.seen.clear();
  }

  private pump(): void {
    while (!this.gone && this.running < this.o.atOnce && this.queue.length) {
      const path = this.queue.shift()!;
      this.running++;
      this.o.load(path).catch(() => null).then((u) => {
        this.running--;
        this.waiting.delete(path);
        if (this.gone) { if (u) this.o.revoke(u); return; }
        this.urls.set(path, u);
        this.evict();
        this.o.changed();
        this.pump();
      });
    }
  }

  private evict(): void {
    for (const [path, u] of this.urls) {
      if (this.urls.size <= this.o.keep) return;
      if (this.seen.get(path) === this.gen) continue; // on screen now
      if (u) this.o.revoke(u);
      this.urls.delete(path);
      this.seen.delete(path);
    }
  }
}
