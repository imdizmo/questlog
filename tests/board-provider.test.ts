import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import { backoff, connectBoard, FINAL_CLOSE, HEALTHY_MS } from '../web/src/board/provider';

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: Uint8Array) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  /** The server accepts: it sends sync step 1 (type 0, sub 0, empty state vector). */
  accept() {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint8Array(e, new Uint8Array([0]));
    const u = encoding.toUint8Array(e);
    this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer });
  }
  closeWith(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'x.test' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('board provider reconnects', () => {
  it('backoff doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 5, 6, 20].map(backoff)).toEqual([1000, 2000, 4000, 30_000, 30_000, 30_000]);
  });

  it('keeps growing the delay while the server accepts and then rejects', () => {
    const c = connectBoard('b1');
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = FakeSocket.all.at(-1)!;
      s.open();
      s.accept();
      expect(c.status()).toBe('online');
      s.closeWith(1007);
      const before = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === before) { vi.advanceTimersByTime(100); waited += 100; }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    c.destroy();
  });

  it('starts over after a connection stayed healthy', () => {
    const c = connectBoard('b1');
    for (let i = 0; i < 2; i++) {
      const s = FakeSocket.all.at(-1)!;
      s.open(); s.accept(); s.closeWith(1013);
      vi.advanceTimersByTime(backoff(i));
    }
    const s = FakeSocket.all.at(-1)!;
    s.open(); s.accept();
    vi.advanceTimersByTime(HEALTHY_MS);
    s.closeWith(1006);
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(n + 1);
    c.destroy();
  });

  it('does not reconnect after 4413 and shows the reason', () => {
    const c = connectBoard('b1');
    const s = FakeSocket.all[0];
    s.open(); s.accept(); s.closeWith(4413);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(c.status()).toBe('offline');
    expect(c.reason()).toBe(FINAL_CLOSE[4413]);
    expect(c.reason()).toMatch(/too large/);
    c.destroy();
  });

  it('does not resend an oversize frame forever: 1009 is final with a reload hint', () => {
    const c = connectBoard('b1');
    const s = FakeSocket.all[0];
    s.open(); s.accept(); s.closeWith(1009);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(c.status()).toBe('offline');
    expect(c.reason()).toMatch(/reload/);
    c.destroy();
  });
});
