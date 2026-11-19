import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../server/db';
import { setFilesDir } from '../server/files';
import { AppError } from '../server/errors';
import { downloadAsset } from '../server/assetFetch';

vi.setConfig({ testTimeout: 30_000 });

// "From a URL" (server/assetFetch.ts): the server downloads a picture or a .glb for the Assets library. A trust
// boundary: the address comes from the person, so private and loopback targets are refused at every hop, and the
// bytes are checked before they are kept.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
let db: Db;
let dir: string;
let stub: Server;
let base: string;
let hits: string[];
let handle: (req: IncomingMessage, res: ServerResponse) => void;
const tooLarge = () => new AppError(413, 'file_too_large');
const loopbackOnly = { allowAddress: (ip: string) => ip === '127.0.0.1' };
const blobs = () => (existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')) : []);
const code = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return (e as AppError).status; } };

beforeEach(async () => {
  dir = join(homedir(), '.cache/gametracker/scratch', `asset-fetch-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  setFilesDir(db, dir);
  hits = [];
  handle = (_q, res) => res.writeHead(404).end();
  stub = createServer((req, res) => { hits.push(req.url!); handle(req, res); });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterEach(async () => {
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('downloading an asset', () => {
  it('keeps a picture, with the address it ended at', async () => {
    handle = (q, res) => (q.url === '/old' ? res.writeHead(302, { location: '/pic.png' }).end() : res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
    const got = await downloadAsset(db, `${base}/old`, 1024, tooLarge, loopbackOnly);
    expect(got).toMatchObject({ mime: 'image/png', size: PNG.length, finalUrl: `${base}/pic.png` });
    expect(readFileSync(join(dir, 'assets', got.id)).equals(PNG)).toBe(true);
  });

  it('keeps a .glb sent as octet-stream', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(GLB);
    expect((await downloadAsset(db, `${base}/deer.glb`, 1024, tooLarge, loopbackOnly)).mime).toBe('model/gltf-binary');
  });

  it('refuses bytes that are not what they say', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'image/png' }).end('<!doctype html><p>hi</p>');
    expect(await code(downloadAsset(db, `${base}/x.png`, 1024, tooLarge, loopbackOnly))).toBe(415);
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG); // a picture must say so
    expect(await code(downloadAsset(db, `${base}/x`, 1024, tooLarge, loopbackOnly))).toBe(415);
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PNG);
    expect(await code(downloadAsset(db, `${base}/x`, 1024, tooLarge, loopbackOnly))).toBe(415);
    handle = (_q, res) => res.writeHead(404, { 'content-type': 'image/png' }).end(PNG);
    expect(await code(downloadAsset(db, `${base}/x`, 1024, tooLarge, loopbackOnly))).toBe(400);
    expect(blobs()).toEqual([]);
  });

  it('refuses too much before keeping it', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length + 5000) }).end(Buffer.concat([PNG, Buffer.alloc(5000)]));
    expect(await code(downloadAsset(db, `${base}/x`, 1024, tooLarge, loopbackOnly))).toBe(413);
    // Without a length, counted as it arrives.
    handle = (_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.write(PNG); res.end(Buffer.alloc(5000)); };
    expect(await code(downloadAsset(db, `${base}/x`, 1024, tooLarge, loopbackOnly))).toBe(413);
    expect(blobs()).toEqual([]);
  });

  it('never follows a redirect to an address the guard refuses', async () => {
    handle = (q, res) => (q.url === '/a' ? res.writeHead(302, { location: 'http://10.0.0.1/secret' }).end() : res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
    expect(await code(downloadAsset(db, `${base}/a`, 1024, tooLarge, loopbackOnly))).toBe(400);
    handle = (q, res) => res.writeHead(302, { location: q.url + 'x' }).end(); // endless
    expect(await code(downloadAsset(db, `${base}/b`, 1024, tooLarge, loopbackOnly))).toBe(400);
    expect(hits.filter((h) => h.startsWith('/b'))).toHaveLength(4); // the first and three redirects
  });

  it('refuses private and loopback targets with the real guard, and odd addresses', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    for (const u of [`${base}/x`, `http://localhost:${new URL(base).port}/x`, 'http://[::1]/x', 'http://169.254.169.254/latest', 'ftp://example.com/x.png',
      'http://u:p@example.com/x.png', 'file:///etc/passwd', 'not a url']) {
      expect(await code(downloadAsset(db, u, 1024, tooLarge)), u).toBe(400);
    }
    expect(hits).toEqual([]);
  });
});

describe('the title a downloaded asset gets', () => {
  it('is the last path segment without its extension, decoded when it can be', async () => {
    const { titleFromUrl } = await import('../server/assets');
    expect(titleFromUrl('https://example.com/art/Fog%20over%20the%20Strand.png?w=2#x')).toBe('Fog over the Strand');
    expect(titleFromUrl('https://example.com/a%ZZ.png')).toBe('a%ZZ'); // a malformed escape: the raw segment, never a 500
    expect(titleFromUrl('https://example.com/%E0%A4%A.jpg')).toBe('%E0%A4%A');
    expect(titleFromUrl('https://example.com/')).toBe('');
  });
});
