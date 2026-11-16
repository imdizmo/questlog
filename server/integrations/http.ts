/**
 * Outbound HTTP: the only way the server calls other hosts (Stripe, Discord, Slack, HacknPlan).
 *
 * - The allow-list (ALLOWED_HOSTS) is fixed in code. A URL is refused unless it is https, on the default port, without
 *   user info, and its host is exactly one of the list (no subdomains, no IP addresses).
 * - No redirects are followed, every request has a timeout, and a response body past `maxBytes` is refused unread.
 * - Tests point an allowed host at a local mock through `mocks` (buildApp's `outbound` option). That seam only accepts
 *   loopback http(s) bases and is never reachable from a request; the allow-list check still runs on the original URL.
 * - Nothing here logs a URL, header or body: webhook URLs and tokens are secrets.
 */
export const ALLOWED_HOSTS = ['api.hacknplan.com', 'api.stripe.com', 'discord.com', 'hooks.slack.com', 'slack.com'] as const;
export type AllowedHost = (typeof ALLOWED_HOSTS)[number];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 'refused': the URL is not allowed (nothing was sent). 'unavailable': no answer. 'too_large': the answer was cut off. */
export class OutboundError extends Error {
  constructor(public kind: 'refused' | 'unavailable' | 'too_large', message: string) { super(message); }
}

export interface OutboundOptions {
  /** Test seam: requests for an allowed host go to this loopback base instead (e.g. http://127.0.0.1:4567). */
  mocks?: Partial<Record<AllowedHost, string>>;
  /** Refuse an allowed host that has no mock (no real call at all). Default: on under Vitest, off otherwise. */
  failClosed?: boolean;
}
export interface OutboundRequest {
  method: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}
/** `bytes`: the size of the body as received. */
export interface OutboundResponse { status: number; ok: boolean; text: string; bytes: number; headers: Headers }

const isAllowedHost = (h: string): h is AllowedHost => (ALLOWED_HOSTS as readonly string[]).includes(h);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The URL when the allow-list takes it, else an OutboundError('refused'). */
export function allowedUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OutboundError('refused', 'invalid URL'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !isAllowedHost(u.hostname)) {
    throw new OutboundError('refused', 'host not allowed');
  }
  return u;
}

export class OutboundClient {
  private mocks = new Map<AllowedHost, URL>();
  private failClosed: boolean;

  constructor(opts: OutboundOptions = {}) {
    this.failClosed = opts.failClosed ?? !!process.env.VITEST;
    for (const [host, base] of Object.entries(opts.mocks ?? {})) {
      if (!base) continue;
      if (!isAllowedHost(host)) throw new Error(`outbound mock for a host outside the allow-list: ${host}`);
      const b = new URL(base);
      if (!LOOPBACK.has(b.hostname) || (b.protocol !== 'http:' && b.protocol !== 'https:')) throw new Error('outbound mocks must be loopback addresses');
      this.mocks.set(host, b);
    }
  }

  async request(url: string, req: OutboundRequest): Promise<OutboundResponse> {
    const u = allowedUrl(url);
    const mock = this.mocks.get(u.hostname as AllowedHost);
    if (!mock && this.failClosed) throw new OutboundError('refused', `no mock for ${u.hostname} (outbound calls are closed in tests)`);
    // The mock's origin plus the path as given (never resolved relative to it: a path like //x must stay on loopback).
    const target = mock ? new URL(`${mock.origin}${u.pathname}${u.search}`) : u;
    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method,
        redirect: 'error',
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: req.headers,
        body: req.body,
      });
    } catch {
      throw new OutboundError('unavailable', 'request failed');
    }
    const { text, bytes } = await readCapped(res, req.maxBytes ?? DEFAULT_MAX_BYTES);
    return { status: res.status, ok: res.ok, text, bytes, headers: res.headers };
  }
}

/** The response body as text; past `max` bytes the rest is not read and OutboundError('too_large') is thrown. */
async function readCapped(res: Response, max: number): Promise<{ text: string; bytes: number }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new OutboundError('too_large', 'response too large');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof OutboundError) throw e;
    throw new OutboundError('unavailable', 'response failed');
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: size };
}
