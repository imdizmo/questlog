import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword } from '../server/auth';

const HOST = 'localhost:8780';
const SECRET = 'a'.repeat(20) + 'b'.repeat(44);
let db: Db;

function mkUser(email: string, role: string, disabled = false): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,disabled) VALUES (?,?,?,?,0,?)')
    .run(id, email, email.split('@')[0], hashPassword('pw'), disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const app = (secret = SECRET) => buildApp({ db, hosts: [HOST], desktopSignin: secret });
const go = (a: ReturnType<typeof buildApp>, t: string, ip = '127.0.0.1', headers: Record<string, string> = {}) =>
  a.inject({ method: 'GET', url: `/desktop-sign-in?t=${encodeURIComponent(t)}`, headers: { host: HOST, ...headers }, remoteAddress: ip });
const session = (res: any) => res.cookies.find((c: any) => c.name === 'jt_session');

beforeEach(() => { db = openDb(':memory:'); });

describe('desktop sign-in', () => {
  it('signs the owner in with the secret from loopback, and the session works', async () => {
    mkUser('member@x', 'member');
    const owner = mkUser('owner@x', 'owner');
    const a = app();
    const res = await go(a, SECRET);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(session(res)).toBeTruthy();
    expect(db.prepare('SELECT user_id, via FROM sessions').all()).toEqual([{ user_id: owner, via: 'desktop' }]);
    const me = await a.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie: `jt_session=${session(res).value}` }, remoteAddress: '127.0.0.1' });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a wrong secret, another machine, a proxy, and a server started without a secret', async () => {
    mkUser('owner@x', 'owner');
    for (const res of [
      await go(app(), SECRET.slice(0, -1) + 'c'),
      await go(app(), ''),
      await go(app(), SECRET, '100.101.1.2'),
      await go(app(), SECRET, '127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }),
      await go(app(''), ''),
      await go(app('short'), 'short'),
    ]) {
      expect(res.headers.location).toBe('/login');
      expect(session(res)).toBeUndefined();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('sends a fresh install to setup and skips a disabled owner', async () => {
    let res = await go(app(), SECRET);
    expect(res.headers.location).toBe('/');
    expect(session(res)).toBeUndefined();
    mkUser('gone@x', 'owner', true);
    res = await go(app(), SECRET);
    expect(session(res)).toBeUndefined();
  });
});
