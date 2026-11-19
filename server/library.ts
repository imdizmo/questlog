/**
 * The Assets page's library reads, forwarded by the desktop app's own server (This computer, with the team's address
 * in JATIFY_TEAM), as the Suggestion button's forward is (server/suggestions.ts): the page on 127.0.0.1 is never
 * answered cross-origin by the library service, and the library service knows the person by the machine that calls.
 *
 * - `GET /api/library/<path>` → `GET http://<team>:8781/<path>`, for the read routes of shared/library.ts only (404
 *   for any other path, before anything is sent).
 * - Only a signed-in person on a loopback connection (the socket's address, never a header); anywhere but This
 *   computer these routes are 404 and the page reads the library service directly.
 * - The team host is looked up once, every address must be private or Tailscale, and the connection goes to the
 *   address that was checked.
 * - The answer streams through unchanged when it is JSON or a PNG, JPEG or WebP picture, within the size cap of
 *   shared/library.ts (a longer one is cut off and fails). Other answers are 502 with a sentence; the library
 *   service's own errors keep their status.
 * - Time limits: the first answer must come within FIRST_ANSWER_MS, and then the body may pause at most IDLE_MS at a
 *   time (a big index.json over a slow tailnet takes as long as it keeps coming). When the page goes away mid-answer,
 *   the library service's answer is closed at once.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { directLoopback } from './teamApi';
import { checkedAddress, lookupAll, Refusal, SAY, type SuggestionRouteDeps } from './suggestions';
import { LIBRARY_PORT, suggestionsVia, teamHostname } from '../shared/suggestions';
import { capFor, libraryPath } from '../shared/library';
import type { User } from '../shared/types';

const PASS_TYPES = new Set(['application/json', 'image/png', 'image/jpeg', 'image/webp']);
const SAY_LIB = {
  notHere: 'The library is read from Questlog on this computer only.',
  notAllowed: 'Questlog does not read that from the library.',
  badAnswer: "Your team's server gave an answer Questlog does not show.",
} as const;

export interface LibraryRouteDeps {
  needUser(req: FastifyRequest): User;
  version: string;
  library?: SuggestionRouteDeps['library'];
  /** Test seam: the time limits (default FIRST_ANSWER_MS and IDLE_MS). */
  timeouts?: { firstMs?: number; idleMs?: number };
}

/** Name lookup aside, the library service must start answering within this. */
export const FIRST_ANSWER_MS = 20_000;
/** Once it answers, the body may pause at most this long at a time. */
export const IDLE_MS = 20_000;

/** Fails the stream past `max` bytes. */
class Cap extends Transform {
  private size = 0;
  constructor(private max: number) { super(); }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.size += chunk.length;
    cb(this.size > this.max ? new Error('too long') : null, chunk);
  }
}

/** The answer's head within `firstMs`; after that the socket may be idle at most `idleMs` (then the answer fails). */
function get(ip: string, host: string, port: number, path: string, firstMs: number, idleMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: ip, port, path, method: 'GET', headers: { host: `${host}:${port}` } }, (res) => {
      clearTimeout(first);
      req.setTimeout(idleMs, () => req.destroy(new Error('idle')));
      resolve(res);
    });
    const first = setTimeout(() => req.destroy(new Error('no answer')), firstMs);
    req.on('error', (e) => { clearTimeout(first); reject(e); });
    req.end();
  });
}

export function registerLibraryRoutes(app: FastifyInstance, d: LibraryRouteDeps): void {
  const port = d.library?.port ?? LIBRARY_PORT;
  const look = d.library?.lookup ?? lookupAll;
  const firstMs = d.timeouts?.firstMs ?? FIRST_ANSWER_MS;
  const idleMs = d.timeouts?.idleMs ?? IDLE_MS;

  app.register(async (scope) => {
    scope.setErrorHandler((err: any, _req, reply) => {
      if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message });
      const status = Number(err?.status ?? err?.statusCode) || 500;
      if (status === 401 || status === 403) return reply.code(status).send({ error: 'Sign in again.' });
      console.error('[jt] library read failed', String(err?.message ?? err));
      return reply.code(502).send({ error: SAY.unreachable });
    });
    scope.addHook('onRequest', async (req) => {
      if (suggestionsVia(process.env, d.version)?.via !== 'local') throw new Refusal(404, SAY_LIB.notHere);
      if (!directLoopback(req)) throw new Refusal(403, SAY_LIB.notHere);
      d.needUser(req);
    });

    scope.get('/api/library/*', async (req, reply) => {
      // The raw URL, decoded one segment at a time: an encoded slash or dot can never become a path step.
      const raw = req.url.slice('/api/library/'.length);
      const [path, query] = [raw.split('?')[0], raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''];
      let decoded: string;
      try { decoded = path.split('/').map((s) => { const x = decodeURIComponent(s); if (x.includes('/')) throw new Error('slash'); return x; }).join('/'); } catch { throw new Refusal(404, SAY_LIB.notAllowed); }
      const target = libraryPath(decoded + query);
      if (!target) throw new Refusal(404, SAY_LIB.notAllowed);
      const hostname = teamHostname(process.env.JATIFY_TEAM);
      if (!hostname) throw new Refusal(404, SAY_LIB.notHere);
      const ip = await checkedAddress(hostname, look);
      let res: IncomingMessage;
      try { res = await get(ip, hostname, port, target, firstMs, idleMs); } catch { throw new Refusal(502, SAY.unreachable); }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const status = res.statusCode ?? 502;
      if (status !== 200) {
        res.resume();
        return reply.code(status >= 400 && status < 600 ? status : 502).header('cache-control', 'no-store').send({ error: status === 404 ? 'Not in the library.' : SAY_LIB.badAnswer });
      }
      const max = capFor(decoded);
      const declared = Number(res.headers['content-length']);
      if (!PASS_TYPES.has(type) || (Number.isFinite(declared) && declared > max)) {
        res.destroy();
        throw new Refusal(502, SAY_LIB.badAnswer);
      }
      const cap = new Cap(max);
      // Either end failing or closing early closes the other: the page going away never leaves the answer open.
      pipeline(res, cap).catch(() => {});
      cap.on('close', () => res.destroy());
      reply.code(200).header('content-type', type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-cache');
      if (Number.isFinite(declared)) reply.header('content-length', declared);
      return reply.send(cap);
    });
  });
}
