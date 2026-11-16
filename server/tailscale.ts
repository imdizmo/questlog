/**
 * Tailscale peer lookup: who is on the other end of a connection that arrived over the tailnet.
 * The local tailscaled answers `whois` on its unix socket with the node and the user behind an address.
 */
import { request } from 'node:http';
import { BlockList, isIP } from 'node:net';

export type TailscalePerson = { login: string; displayName: string };

const RANGES = new BlockList();
RANGES.addSubnet('100.64.0.0', 10, 'ipv4');
RANGES.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** The peer address as a plain IP: `::ffff:` prefix stripped, null when empty. */
export function peerAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const ip = raw.replace(/^::ffff:/i, '');
  return ip || null;
}

/** True when `ip` lies in a range Tailscale hands out (100.64.0.0/10 or fd7a:115c:a1e0::/48). */
export function inTailscaleRange(ip: string): boolean {
  const kind = isIP(ip);
  if (!kind) return false;
  return RANGES.check(ip, kind === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Asks tailscaled (unix socket `socketPath`) who owns `ip:port`. Null on any error, timeout, non-200 answer,
 * tagged node (a machine, not a person), or missing login name.
 */
export function whois(ip: string, port: number, socketPath: string, timeoutMs = 2000): Promise<TailscalePerson | null> {
  const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: TailscalePerson | null) => { if (!done) { done = true; resolve(v); } };
    const req = request(
      { socketPath, path: `/localapi/v0/whois?addr=${addr}`, method: 'GET', headers: { host: 'local-tailscaled.sock' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => finish(null));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const tags = body?.Node?.Tags;
            const login = body?.UserProfile?.LoginName;
            if ((Array.isArray(tags) && tags.length > 0) || typeof login !== 'string' || !login) return finish(null);
            const name = body.UserProfile.DisplayName;
            finish({ login, displayName: typeof name === 'string' ? name : '' });
          } catch { finish(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
    req.end();
  });
}

/** Default tailscaled socket on Linux. */
export const DEFAULT_TAILSCALE_SOCKET = '/var/run/tailscale/tailscaled.sock';

/** The sign-in switch: on only with env JT_TAILSCALE_AUTH=1; socket from JT_TAILSCALE_SOCKET. */
export function tailscaleSettings(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; socketPath: string } {
  return { enabled: env.JT_TAILSCALE_AUTH === '1', socketPath: env.JT_TAILSCALE_SOCKET?.trim() || DEFAULT_TAILSCALE_SOCKET };
}

/** Headers a proxy adds. With any of them the socket peer is the proxy, not the person: no Tailscale identity. */
export const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'via'] as const;
export const viaProxy = (headers: Record<string, unknown>): boolean => PROXY_HEADERS.some((h) => headers[h] !== undefined);

const EXEMPT_EXACT = ['/login', '/setup', '/healthz'];
const EXEMPT_PREFIX = ['/join', '/assets', '/fonts', '/api', '/dispatch', '/open', '/email', '/integrations', '/team'];

/**
 * Paths a page load never signs in on: the login and setup screens, invite links, static files, the API and the other
 * machine-facing prefixes. `path` is the decoded request path without its query.
 */
export function signInExempt(path: string): boolean {
  const p = path.toLowerCase();
  if (EXEMPT_EXACT.includes(p) || p.startsWith('/mcp')) return true;
  return EXEMPT_PREFIX.some((x) => p === x || p.startsWith(`${x}/`));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The page a Tailscale peer who is not on the team gets (no scripts; the app's CSP applies). */
export function askOwnerPage(person: TailscalePerson): string {
  const who = person.displayName && person.displayName !== person.login
    ? `${esc(person.displayName)} (${esc(person.login)})` : esc(person.login);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Ask the owner to add you · Questlog</title></head>'
    + '<body style="font-family:system-ui,sans-serif;background:#f4f2ee;color:#22201c;margin:0;padding:48px 16px">'
    + '<main style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;padding:24px 28px">'
    + '<h1 style="font-size:20px;margin:0 0 12px">Ask the owner to add you</h1>'
    + `<p>You're signed in to Tailscale as ${who}, but you're not on this team yet. Ask the owner to add you.</p>`
    + '<p style="margin:20px 0 0"><a href="/login" style="color:#b4472b">Log in with a password instead</a></p>'
    + '</main></body></html>';
}
