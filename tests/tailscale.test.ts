import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inTailscaleRange, peerAddress, whois } from '../server/tailscale';

describe('tailscale ranges', () => {
  it('accepts addresses inside the tailnet ranges', () => {
    for (const ip of ['100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1']) expect(inTailscaleRange(ip), ip).toBe(true);
  });
  it('rejects addresses outside them', () => {
    for (const ip of ['100.63.255.255', '100.128.0.0', '127.0.0.1', '10.0.0.5', 'fd7a:115c:a1e1::1', 'nonsense']) {
      expect(inTailscaleRange(ip), ip).toBe(false);
    }
  });
  it('peerAddress strips the IPv4-mapped prefix and returns null for empty', () => {
    expect(peerAddress('::ffff:100.90.1.2')).toBe('100.90.1.2');
    expect(peerAddress('100.90.1.2')).toBe('100.90.1.2');
    expect(peerAddress(undefined)).toBeNull();
    expect(peerAddress('')).toBeNull();
  });
});

describe('whois', () => {
  let dir: string;
  let sock: string;
  let server: Server;
  let seenPath = '';
  let seenHost = '';
  let reply: (res: import('node:http').ServerResponse) => void = () => {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ql-ts-'));
    sock = join(dir, 'ts.sock');
    server = createServer((req, res) => {
      seenPath = req.url ?? '';
      seenHost = req.headers.host ?? '';
      reply(res);
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const json = (body: unknown, status = 200) => (res: import('node:http').ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('returns the person and queries the right path', async () => {
    reply = json({ Node: { Tags: null }, UserProfile: { LoginName: 'ada@example.com', DisplayName: 'Ada', ID: 7 } });
    expect(await whois('100.101.1.2', 5555, sock)).toEqual({ login: 'ada@example.com', displayName: 'Ada' });
    expect(seenPath).toBe('/localapi/v0/whois?addr=100.101.1.2:5555');
    expect(seenHost).toBe('local-tailscaled.sock');
  });
  it('treats a tagged node as not a person', async () => {
    reply = json({ Node: { Tags: ['tag:ci'] }, UserProfile: { LoginName: 'tagged-devices', DisplayName: 'Tagged' } });
    expect(await whois('100.101.1.2', 5555, sock)).toBeNull();
  });
  it('returns null without a LoginName', async () => {
    reply = json({ Node: {}, UserProfile: { DisplayName: 'X' } });
    expect(await whois('100.101.1.2', 5555, sock)).toBeNull();
  });
  it('returns null on 404 and on invalid JSON', async () => {
    reply = json({ error: 'no match' }, 404);
    expect(await whois('100.101.1.2', 5555, sock)).toBeNull();
    reply = (res) => { res.writeHead(200); res.end('not json'); };
    expect(await whois('100.101.1.2', 5555, sock)).toBeNull();
  });
  it('whois times out to null', async () => {
    reply = () => {};
    const t = Date.now();
    expect(await whois('100.101.1.2', 5555, sock)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2500);
  });
  it('returns null when the socket file is missing', async () => {
    expect(await whois('100.101.1.2', 5555, join(dir, 'missing.sock'))).toBeNull();
  });
});
