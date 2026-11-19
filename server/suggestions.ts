/**
 * The Suggestion button's forward (shared/suggestions.ts), for the desktop app's own server only (This computer, with
 * the team's address in JATIFY_TEAM; anywhere else these routes are 404 and the page sends straight to the library
 * service).
 *
 * - `GET /api/suggestions/whoami` → `GET http://<team>:8781/team/whoami`.
 * - `POST /api/suggestions` (`Content-Type: application/zip`, at most 20 MB) → `POST
 *   http://<team>:8781/team/suggestions?tool=questlog&version=<version>&os=<linux|windows>`, the zip unchanged.
 *
 * Both answer only a signed-in person on a loopback connection (the socket's address, never a header; nothing that
 * came through a proxy): the library service knows the sender by the machine that calls it, so this forward must only
 * ever speak for the person at this computer. The library service's status and JSON body come back as they are; when
 * it cannot be reached, or its address is not on a private network or Tailscale (as for crash reports), the answer is
 * 502 with a sentence. Every `error` here is written for the person, since the dialog shows it as it is.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { directLoopback } from './teamApi';
import { LIBRARY_PORT, SUGGESTION_LIMITS, suggestionsVia, teamHostname } from '../shared/suggestions';
import type { User } from '../shared/types';

/** Name lookup, connect, sending and the answer together. */
export const FORWARD_TIMEOUT_MS = 30_000;
/** The library service's answers are small JSON; anything longer is not one. */
const ANSWER_MAX_BYTES = 64 * 1024;

export const SAY = {
  notHere: "Suggestions are sent from Questlog on this computer only.",
  signIn: 'Sign in again, then send.',
  zipOnly: 'Suggestions are sent as a zip.',
  tooBig: `This is over ${SUGGESTION_LIMITS.zipBytes >> 20} MB. Take some pictures out and try again.`,
  unreachable: "Questlog can't reach your team's server. Check that it is on, then try again.",
  notPrivate: "Your team's server is not on a private network or Tailscale, so nothing was sent.",
  badAnswer: "Your team's server gave an answer Questlog does not understand.",
} as const;

export interface SuggestionRouteDeps {
  needUser(req: FastifyRequest): User;
  version: string;
  /** Test seam: the library service's port (default 8781) and the name lookup (default the system's). */
  library?: { port?: number; lookup?: Lookup };
}

/** The `os` the library service is told: this server runs on the person's own machine. */
export const osName = (p: NodeJS.Platform = process.platform) => (p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux');

/** Loopback, private LAN, link-local or Tailscale (100.64/10, fd7a:115c:a1e0::/48): where a suggestion may go. */
export function privateOrTailnet(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) !== 6) return false;
  const s = ip.toLowerCase();
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s); // fc00::/7 holds Tailscale's fd7a:115c:a1e0::/48
}

export class Refusal extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Every address of a host name (an IP literal is its own). */
export type Lookup = (hostname: string) => Promise<string[]>;
export const lookupAll: Lookup = async (h) => (await lookup(h, { all: true })).map((a) => a.address);

/**
 * The address to connect to: the team host is looked up once, every address it has must be private or Tailscale
 * (else a Refusal, nothing is sent), and the connection goes to the first of those same addresses, so a second
 * lookup can never send it somewhere else.
 */
export async function checkedAddress(hostname: string, look: Lookup): Promise<string> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  try {
    addrs = isIP(bare) ? [bare] : await look(bare);
  } catch {
    throw new Refusal(502, SAY.unreachable);
  }
  if (!addrs.length || !addrs.every(privateOrTailnet)) throw new Refusal(502, SAY.notPrivate);
  return addrs[0];
}

/**
 * One plain http request to `ip` with the team host's name in Host (the library service only answers at its own
 * names). The status and the answer as JSON (null when it is not JSON, or longer than ANSWER_MAX_BYTES).
 */
function send(ip: string, host: string, port: number, path: string, body?: Buffer): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: ip, port, path, method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      headers: { host: `${host}:${port}`, ...(body ? { 'content-type': 'application/zip', 'content-length': body.length } : {}) },
    }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > ANSWER_MAX_BYTES) { res.destroy(); resolve({ status: res.statusCode ?? 502, json: null }); return; }
        parts.push(c);
      });
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 502, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function registerSuggestionRoutes(app: FastifyInstance, d: SuggestionRouteDeps): void {
  const port = d.library?.port ?? LIBRARY_PORT;
  const look = d.library?.lookup ?? lookupAll;
  const cap = SUGGESTION_LIMITS.zipBytes;

  const forward = async (reply: FastifyReply, path: string, body?: Buffer) => {
    const hostname = teamHostname(process.env.JATIFY_TEAM);
    if (!hostname) throw new Refusal(404, SAY.notHere);
    const ip = await checkedAddress(hostname, look);
    let res: { status: number; json: unknown };
    try { res = await send(ip, hostname, port, path, body); } catch { throw new Refusal(502, SAY.unreachable); }
    if (res.json === null || typeof res.json !== 'object') throw new Refusal(502, SAY.badAnswer);
    return reply.code(res.status).header('cache-control', 'no-store').send(res.json);
  };

  app.register(async (scope) => {
    scope.setErrorHandler((err: any, _req, reply) => {
      if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message });
      const status = Number(err?.status ?? err?.statusCode) || 500;
      if (status === 401 || status === 403) return reply.code(status).send({ error: SAY.signIn });
      if (status === 413) return reply.code(413).send({ error: SAY.tooBig });
      if (status === 415) return reply.code(415).send({ error: SAY.zipOnly });
      console.error('[jt] suggestion forward failed', String(err?.message ?? err));
      return reply.code(500).send({ error: SAY.unreachable });
    });

    // Before the body is read: where the request comes from, who sends it and what it is.
    scope.addHook('onRequest', async (req) => {
      if (suggestionsVia(process.env, d.version)?.via !== 'local') throw new Refusal(404, SAY.notHere);
      if (!directLoopback(req)) throw new Refusal(403, SAY.notHere);
      d.needUser(req);
      if (req.method !== 'POST') return;
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/zip') throw new Refusal(415, SAY.zipOnly);
      if (Number(req.headers['content-length'] ?? 0) > cap) throw new Refusal(413, SAY.tooBig);
    });
    // Counted as it arrives: past the cap the rest is never held.
    scope.addContentTypeParser('application/zip', async (_req: FastifyRequest, payload: NodeJS.ReadableStream) => {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > cap) throw new Refusal(413, SAY.tooBig);
        parts.push(chunk);
      }
      return Buffer.concat(parts);
    });

    scope.get('/api/suggestions/whoami', async (_req, reply) => forward(reply, '/team/whoami'));
    scope.post('/api/suggestions', async (req, reply) => {
      const zip = req.body;
      if (!Buffer.isBuffer(zip) || !zip.length) throw new Refusal(400, SAY.zipOnly);
      const q = new URLSearchParams({ tool: 'questlog', version: d.version, os: osName() });
      return forward(reply, `/team/suggestions?${q}`, zip);
    });
  });
}
