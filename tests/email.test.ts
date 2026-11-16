import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadSecret, SECRET_FILE } from '../server/secret';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { runJob, runEmailDigests, runReportEmails, REPORT_EMAILS_PER_DAY } from '../server/jobs';
import { cardCode } from '../shared/cards';
import {
  BACKOFF_MS, buildMessage, dueSlot, enqueueEmail, MAX_ATTEMPTS, OUTBOX_MAX, pruneOutbox, sendPendingEmails, smtpSend,
  unsubscribeUrl, type EmailConfig, type SmtpConfig,
} from '../server/email';
import { TOKEN_DENIED_NAMESPACES } from '../server/tokens';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
const CERT = readFileSync(join(import.meta.dirname, 'fixtures/smtp-test-cert.pem'), 'utf8');
const KEY = readFileSync(join(import.meta.dirname, 'fixtures/smtp-test-key.pem'), 'utf8');
let db: Db;
let app: FastifyInstance;
let owner: string;
let ownerId: string;
let deckId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { host: HOST, cookie, 'content-type': 'application/json' } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const mkUser = async (name: string, timezone: string | null = null) => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,timezone,created_at) VALUES (?,?,?,?,?,0)').run(id, email, name, hashPassword('pw'), timezone);
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'admin')").run(id);
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
  return { id, email, cookie };
};
const outbox = () => db.prepare('SELECT * FROM email_outbox ORDER BY id').all() as any[];
const job = (fn: (ctx: any, now: number) => void, now: number) => runJob(db, new LiveHub(db), (ctx) => fn(ctx, now));
const at = (iso: string) => Date.parse(iso);

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], email: { publicUrl: 'http://tracker.test', secret: 'test-secret-for-email' } });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users WHERE email=?').get('o@x.io') as any).id;
  const projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

// ---- a fake SMTP server on 127.0.0.1 (never a real one) ----
interface Fake { server: Server; port: number; connections: number; messages: { from: string; to: string; raw: string }[]; auth: string[]; tls: boolean[]; failRcpt: number }
async function fakeSmtp(opts: { user?: string; pass?: string; failRcpt?: number } = {}): Promise<Fake> {
  const fake: Fake = { server: null as any, port: 0, connections: 0, messages: [], auth: [], tls: [], failRcpt: opts.failRcpt ?? 0 };
  fake.server = createServer((raw) => {
    fake.connections++;
    let sock: Socket | TLSSocket = raw;
    let buf = '';
    let inData = false;
    let data = '';
    let from = '', to = '';
    let secure = false;
    const say = (s: string) => sock.write(s + '\r\n');
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0 && !buf.startsWith('.\r\n')) return;
          const cut = buf.startsWith('.\r\n') ? 0 : end + 2;
          data += buf.slice(0, cut);
          buf = buf.slice(cut + 3);
          inData = false;
          fake.messages.push({ from, to, raw: data });
          data = '';
          say('250 queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') say(secure ? '250-fake\r\n250-8BITMIME\r\n250 AUTH PLAIN' : '250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN');
        else if (cmd === 'STARTTLS') {
          say('220 go ahead');
          raw.removeListener('data', onData);
          const t = new TLSSocket(raw, { isServer: true, key: KEY, cert: CERT });
          t.on('data', onData);
          t.on('error', () => {});
          sock = t;
          secure = true;
          fake.tls.push(true);
        } else if (cmd === 'AUTH') {
          fake.auth.push(line);
          const [, , b64] = line.split(' ');
          const [, u, p] = Buffer.from(b64 ?? '', 'base64').toString('utf8').split('\0');
          say(u === opts.user && p === opts.pass ? '235 ok' : '535 no');
        } else if (cmd === 'MAIL') { from = line; say('250 ok'); }
        else if (cmd === 'RCPT') {
          to = line;
          if (fake.failRcpt > 0) { fake.failRcpt--; say('451 try later'); } else say('250 ok');
        } else if (cmd === 'DATA') { inData = true; say('354 go'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else if (cmd === 'RSET') say('250 ok');
        else say('502 unknown');
      }
    };
    raw.on('data', onData);
    raw.on('error', () => {});
    say('220 fake ESMTP');
  });
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
  fake.port = (fake.server.address() as any).port;
  return fake;
}
const closeFake = (f: Fake) => new Promise<void>((r) => f.server.close(() => r()));
const smtpCfg = (f: Fake, extra: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1', port: f.port, user: 'mailer', pass: 's3cret', from: 'tracker@jatify.test', starttls: true,
  timeoutMs: 3000, tls: { ca: CERT }, ...extra,
});
/** The decoded body of the text/plain part of a received message. */
function textPart(raw: string): string {
  const unstuffed = raw.split('\r\n').map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n');
  const m = /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)\r\n--/.exec(unstuffed);
  const qp = m![1].replace(/=\r\n/g, '');
  return Buffer.from(qp.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
}

describe('outbox and transports', () => {
  it('log transport sends nothing and marks rows', async () => {
    const fake = await fakeSmtp();
    try {
      enqueueEmail(db, { to: 'a@x.io', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', kind: 'notifications' });
      enqueueEmail(db, { to: 'b@x.io', subject: 'Hi', text: 'Hello', kind: 'notifications' });
      const cfg: EmailConfig = { transport: 'log', smtp: smtpCfg(fake), publicUrl: 'http://tracker.test' };
      const r = await sendPendingEmails(db, cfg, Date.now());
      expect(r).toEqual({ sent: 0, failed: 0, logged: 2 });
      expect(fake.connections).toBe(0);
      expect(outbox().map((o) => [o.status, o.sent_at, o.last_error])).toEqual([
        ['log', null, 'not sent (log mode)'], ['log', null, 'not sent (log mode)'],
      ]);
      // Nothing left to pick up.
      expect(await sendPendingEmails(db, cfg, Date.now())).toEqual({ sent: 0, failed: 0, logged: 0 });
    } finally { await closeFake(fake); }
  });

  it('SMTP client against a local fake server: STARTTLS, AUTH, dot-stuffing, retries with backoff, 5 attempts max', async () => {
    const fake = await fakeSmtp({ user: 'mailer', pass: 's3cret' });
    try {
      const text = 'Line one\n.starts with a dot\n.\nlast line ünïcode';
      await smtpSend(smtpCfg(fake), { to: 'player@x.io', subject: 'Grüße from the tracker', text, html: '<p>hi</p>' });
      expect(fake.tls).toEqual([true]);
      expect(fake.auth).toEqual([`AUTH PLAIN ${Buffer.from('\0mailer\0s3cret').toString('base64')}`]);
      expect(fake.messages).toHaveLength(1);
      const msg = fake.messages[0];
      expect(msg.from).toBe('MAIL FROM:<tracker@jatify.test>');
      expect(msg.to).toBe('RCPT TO:<player@x.io>');
      expect(msg.raw).toContain('\r\n..starts with a dot\r\n');
      expect(msg.raw).toContain('\r\n..\r\n');
      expect(msg.raw).toMatch(/\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
      expect(msg.raw).toContain('Content-Type: multipart/alternative; boundary=');
      expect(msg.raw).not.toMatch(/(^|[^\r])\n/); // CRLF only
      expect(textPart(msg.raw)).toBe(text.replace(/\n/g, '\r\n'));

      // No STARTTLS on offer while one is required: refused, nothing sent in the clear.
      const plain = createServer((s) => { s.write('220 x\r\n'); s.on('data', (d) => { if (/^EHLO/i.test(d.toString())) s.write('250 plain\r\n'); else s.write('221 bye\r\n'); }); s.on('error', () => {}); });
      await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
      await expect(smtpSend({ ...smtpCfg(fake), port: (plain.address() as any).port }, { to: 'p@x.io', subject: 's', text: 't' })).rejects.toThrow(/STARTTLS/);
      await new Promise<void>((r) => plain.close(() => r()));

      // A server that never answers: the step times out.
      const mute = createServer((s) => { s.on('error', () => {}); });
      await new Promise<void>((r) => mute.listen(0, '127.0.0.1', () => r()));
      await expect(smtpSend({ ...smtpCfg(fake), port: (mute.address() as any).port, timeoutMs: 100 }, { to: 'p@x.io', subject: 's', text: 't' })).rejects.toThrow(/timeout/i);
      await new Promise<void>((r) => { mute.close(() => r()); });

      // Header injection: CR/LF never reach a header.
      expect(() => buildMessage({ from: 'a@x.io', to: 'b@x.io\r\nBcc: c@x.io', subject: 's', text: 't' })).toThrow();
      expect(() => buildMessage({ from: 'a@x.io', to: 'b@x.io', subject: 's\r\nBcc: c@x.io', text: 't' })).toThrow();
      const id = enqueueEmail(db, { to: 'b@x.io', subject: 'two\r\nBcc: c@x.io', text: 't', kind: 'notifications' })!;
      expect((db.prepare('SELECT subject FROM email_outbox WHERE id=?').get(id) as any).subject).toBe('two Bcc: c@x.io');
      expect(enqueueEmail(db, { to: 'b@x.io>\r\nRCPT TO:<c@x.io', subject: 's', text: 't', kind: 'notifications' })).toBeNull();
      db.prepare('DELETE FROM email_outbox').run();

      // Retries with backoff: 451 on every RCPT; 5 attempts at most.
      fake.failRcpt = 99;
      const cfg: EmailConfig = { transport: 'smtp', smtp: smtpCfg(fake), publicUrl: 'http://tracker.test' };
      enqueueEmail(db, { to: 'retry@x.io', subject: 'Retry', text: 'x', kind: 'notifications' });
      let t = 1_800_000_000_000;
      const before = fake.connections;
      expect(await sendPendingEmails(db, cfg, t)).toEqual({ sent: 0, failed: 1, logged: 0 });
      let row = outbox()[0];
      expect([row.status, row.attempts, row.next_attempt_at]).toEqual(['pending', 1, t + BACKOFF_MS[0]]);
      expect(row.last_error).toMatch(/451/);
      // Not due yet: no connection.
      await sendPendingEmails(db, cfg, t + BACKOFF_MS[0] - 1);
      expect(fake.connections).toBe(before + 1);
      for (let n = 2; n <= MAX_ATTEMPTS; n++) {
        t = outbox()[0].next_attempt_at;
        await sendPendingEmails(db, cfg, t);
        row = outbox()[0];
        expect(row.attempts).toBe(n);
        if (n < MAX_ATTEMPTS) expect(row.next_attempt_at).toBe(t + BACKOFF_MS[n - 1]);
      }
      expect(row.status).toBe('failed');
      expect(fake.connections).toBe(before + MAX_ATTEMPTS);
      await sendPendingEmails(db, cfg, t + 365 * 86400e3);
      expect(fake.connections).toBe(before + MAX_ATTEMPTS);

      // A retry that succeeds is marked sent.
      fake.failRcpt = 1;
      enqueueEmail(db, { to: 'later@x.io', subject: 'Later', text: 'x', kind: 'notifications' });
      await sendPendingEmails(db, cfg, t);
      await sendPendingEmails(db, cfg, t + BACKOFF_MS[0]);
      const later = outbox().find((o) => o.to_addr === 'later@x.io');
      expect([later.status, later.attempts, later.sent_at]).toEqual(['sent', 2, t + BACKOFF_MS[0]]);
    } finally { await closeFake(fake); }
  });

  it('an untrusted certificate fails (no fallback); a refused sign-in is retried; AUTH PLAIN must be offered', async () => {
    const fake = await fakeSmtp({ user: 'mailer', pass: 's3cret' });
    try {
      const { tls: _drop, ...noCa } = smtpCfg(fake);
      void _drop;
      await expect(smtpSend(noCa, { to: 'p@x.io', subject: 's', text: 't' })).rejects.toThrow(/certificate/i);
      expect(fake.messages).toHaveLength(0);
      expect(fake.auth).toHaveLength(0);
      // 535 at AUTH: a setup problem, kept for a retry.
      const wrong: EmailConfig = { transport: 'smtp', smtp: smtpCfg(fake, { pass: 'wrong' }), publicUrl: 'http://tracker.test' };
      enqueueEmail(db, { to: 'p@x.io', subject: 'S', text: 'x', kind: 'notifications' });
      await sendPendingEmails(db, wrong, Date.now());
      expect(outbox()[0]).toMatchObject({ status: 'pending', attempts: 1 });
      expect(outbox()[0].last_error).toMatch(/AUTH: 535/);
      // A server without AUTH PLAIN: a clear error before any password is sent.
      await expect(smtpSend(smtpCfg(fake, { user: undefined }), { to: 'p@x.io', subject: 's', text: 't' })).resolves.toBeUndefined();
    } finally { await closeFake(fake); }
    const noAuth = createServer((sk) => {
      sk.write('220 x\r\n');
      sk.on('data', (d) => { const l = d.toString(); sk.write(/^EHLO/i.test(l) ? '250 plain\r\n' : /^QUIT/i.test(l) ? '221 bye\r\n' : '250 ok\r\n'); });
      sk.on('error', () => {});
    });
    await new Promise<void>((r) => noAuth.listen(0, '127.0.0.1', () => r()));
    try {
      await expect(smtpSend({ host: '127.0.0.1', port: (noAuth.address() as any).port, from: 'a@x.io', starttls: false, user: 'u', pass: 'p', timeoutMs: 2000 }, { to: 'p@x.io', subject: 's', text: 't' }))
        .rejects.toThrow(/AUTH PLAIN/);
    } finally { await new Promise<void>((r) => noAuth.close(() => r())); }
  });

  it('one email has an overall deadline', async () => {
    // Answers every step, slowly: each reply within the step timeout, the whole over the deadline.
    const slow = createServer((sk) => {
      const later = (t: string) => setTimeout(() => { if (!sk.destroyed) sk.write(t); }, 80);
      later('220 x\r\n');
      sk.on('data', (d) => { const l = d.toString(); later(/^EHLO/i.test(l) ? '250 slow\r\n' : '250 ok\r\n'); });
      sk.on('error', () => {});
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    try {
      await expect(smtpSend({ host: '127.0.0.1', port: (slow.address() as any).port, from: 'a@x.io', starttls: false, timeoutMs: 1000, deadlineMs: 200 }, { to: 'p@x.io', subject: 's', text: 't' }))
        .rejects.toThrow(/longer than/);
    } finally { await new Promise<void>((r) => slow.close(() => r())); }
  });

  it('sends at most 20 per tick, and nothing while the workspace is disabled', async () => {
    const fake = await fakeSmtp({ user: 'mailer', pass: 's3cret' });
    try {
      const cfg: EmailConfig = { transport: 'smtp', smtp: smtpCfg(fake), publicUrl: 'http://tracker.test' };
      for (let i = 0; i < 25; i++) enqueueEmail(db, { to: `p${i}@x.io`, subject: 'S', text: 'x', kind: 'notifications' });
      db.prepare('UPDATE account SET is_disabled=1').run();
      expect(await sendPendingEmails(db, cfg, Date.now())).toEqual({ sent: 0, failed: 0, logged: 0 });
      expect(fake.connections).toBe(0);
      db.prepare('UPDATE account SET is_disabled=0').run();
      expect((await sendPendingEmails(db, cfg, Date.now())).sent).toBe(20);
      expect((await sendPendingEmails(db, cfg, Date.now())).sent).toBe(5);
      expect(fake.messages).toHaveLength(25);
    } finally { await closeFake(fake); }
  });

  it('outbox pruned above 10000', () => {
    const ins = db.prepare("INSERT INTO email_outbox (to_addr, subject, text, kind, created_at, next_attempt_at, status) VALUES ('a@x.io','s','t','notifications',?,0,'sent')");
    db.exec('BEGIN');
    for (let i = 0; i < OUTBOX_MAX + 5; i++) ins.run(i);
    db.exec('COMMIT');
    pruneOutbox(db);
    const r = db.prepare('SELECT COUNT(*) c, MIN(created_at) lo, MAX(created_at) hi FROM email_outbox').get() as any;
    expect(r).toEqual({ c: OUTBOX_MAX, lo: 5, hi: OUTBOX_MAX + 4 });
  });

  it('outbox prune drops finished rows before pending ones', () => {
    const ins = db.prepare("INSERT INTO email_outbox (to_addr, subject, text, kind, created_at, next_attempt_at, status) VALUES ('a@x.io','s','t','notifications',?,0,?)");
    db.exec('BEGIN');
    for (let i = 0; i < 5; i++) ins.run(i, 'pending'); // the oldest rows are still unsent
    for (let i = 5; i < OUTBOX_MAX + 5; i++) ins.run(i, 'sent');
    db.exec('COMMIT');
    pruneOutbox(db);
    const r = db.prepare("SELECT COUNT(*) c, SUM(status='pending') p FROM email_outbox").get() as any;
    expect(r).toEqual({ c: OUTBOX_MAX, p: 5 });
  });
});

describe('notification emails', () => {
  it('daily digest batches unseen notifications per user in their timezone', async () => {
    const tokyo = await mkUser('tokyo', 'Asia/Tokyo');
    const nyc = await mkUser('nyc', 'America/New_York');
    const quiet = await mkUser('quiet', 'UTC');
    await ok('emailPrefs/update', { notifications: 'off' }, quiet.cookie);
    const c1 = (await ok('cards/create', { content: 'Milestone tuning', deckId })).id;
    const c2 = (await ok('cards/create', { content: 'Save system', deckId })).id;
    await ok('resolvables/create', { cardId: c1, context: 'comment', content: '@tokyo @nyc @quiet look' });
    await ok('resolvables/create', { cardId: c2, context: 'comment', content: '@tokyo and this one' });
    db.prepare('UPDATE resolvable_notifications SET last_updated_at=?').run(at('2026-11-16T01:00:00Z'));
    // 12:00 UTC = 21:00 in Tokyo (due), 07:00 in New York (not yet).
    job(runEmailDigests, at('2026-11-16T12:00:00Z'));
    let mails = outbox();
    expect(mails.map((m) => m.to_addr)).toEqual(['tokyo@x.io']);
    expect(mails[0].kind).toBe('notifications');
    expect(mails[0].user_id).toBe(tokyo.id);
    expect(mails[0].text).toContain('Milestone tuning');
    expect(mails[0].text).toContain('Save system');
    expect(mails[0].text).toContain('http://tracker.test/email/unsubscribe?t=');
    expect(mails[0].html).toContain('Milestone tuning');
    // Again the same day: nothing new.
    job(runEmailDigests, at('2026-11-16T12:30:00Z'));
    expect(outbox()).toHaveLength(1);
    // 13:05 UTC = 08:05 in New York.
    job(runEmailDigests, at('2026-11-16T13:05:00Z'));
    mails = outbox();
    expect(mails.map((m) => m.to_addr)).toEqual(['tokyo@x.io', 'nyc@x.io']);
    expect(mails[1].text).toContain('Milestone tuning');
    expect(mails[1].text).not.toContain('Save system');
    // Next day in Tokyo: the same threads were already in the last digest, nothing unseen is newer.
    job(runEmailDigests, at('2026-11-17T00:00:00Z'));
    expect(outbox()).toHaveLength(2);
    // Read threads drop out; a newer entry comes back.
    db.prepare('UPDATE resolvable_notifications SET last_updated_at=? WHERE user_id=?').run(at('2026-11-17T05:00:00Z'), tokyo.id);
    db.prepare('UPDATE resolvable_notifications SET unseen_entry_count=0 WHERE user_id=? AND resolvable_id IN (SELECT id FROM resolvables WHERE card_id=?)').run(tokyo.id, c2);
    job(runEmailDigests, at('2026-11-17T23:30:00Z')); // 08:30 on the 18th in Tokyo
    mails = outbox();
    expect(mails).toHaveLength(3);
    expect(mails[2].text).toContain('Milestone tuning');
    expect(mails[2].text).not.toContain('Save system');
    // The workspace is disabled: no digests at all.
    db.prepare('UPDATE resolvable_notifications SET last_updated_at=? WHERE user_id=?').run(at('2026-11-18T05:00:00Z'), tokyo.id);
    db.prepare('UPDATE account SET is_disabled=1').run();
    job(runEmailDigests, at('2026-11-18T23:30:00Z'));
    expect(outbox()).toHaveLength(3);
  });

  it('a thread whose project the person can no longer see is left out', async () => {
    const pid = (await ok('projects/create', { name: 'Secret' })).id;
    const secretDeck = (await ok('decks/create', { title: 'S', projectId: pid })).id;
    const id = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,timezone,created_at) VALUES (?,'mem@x.io','mem',?,'UTC',0)").run(id, hashPassword('pw'));
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
    db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(pid, id);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(pid);
    const c = (await ok('cards/create', { content: 'Hidden plans', deckId: secretDeck })).id;
    await ok('resolvables/create', { cardId: c, context: 'comment', content: '@mem see this' });
    expect(db.prepare('SELECT unseen_entry_count n FROM resolvable_notifications WHERE user_id=?').get(id)).toEqual({ n: 1 });
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(id);
    job(runEmailDigests, at('2099-01-01T09:00:00Z'));
    expect(outbox().filter((m) => m.to_addr === 'mem@x.io')).toEqual([]);
  });

  it('instant preference mails new unseen threads on the next tick', async () => {
    const u = await mkUser('fast', 'UTC');
    await ok('emailPrefs/update', { notifications: 'instant' }, u.cookie);
    expect((await app.inject({ method: 'GET', url: '/api/email/prefs', headers: { host: HOST, cookie: u.cookie } })).json()).toEqual({ notifications: 'instant' });
    const c = (await ok('cards/create', { content: 'Hotfix', deckId })).id;
    await ok('resolvables/create', { cardId: c, context: 'comment', content: '@fast now' });
    job(runEmailDigests, Date.now() + 1000);
    expect(outbox().map((m) => m.to_addr)).toEqual(['fast@x.io']);
    job(runEmailDigests, Date.now() + 2000);
    expect(outbox()).toHaveLength(1);
  });

  it('dueSlot: daily from 08:00 local, weekly on Monday 08:00', () => {
    expect(dueSlot('Asia/Tokyo', at('2026-11-15T22:59:00Z'), 'daily')).toBeNull(); // 07:59 on the 16th
    expect(dueSlot('Asia/Tokyo', at('2026-11-15T23:00:00Z'), 'daily')).toBe('2026-11-16');
    expect(dueSlot('Asia/Tokyo', at('2026-11-15T23:00:00Z'), 'weekly')).toBe('2026-W47'); // Monday 16 Nov
    expect(dueSlot('Asia/Tokyo', at('2026-11-16T23:00:00Z'), 'weekly')).toBeNull(); // Tuesday
    expect(dueSlot('Not/AZone', at('2026-11-16T08:00:00Z'), 'daily')).toBe('2026-11-16'); // falls back to UTC
  });
});

describe('report done emails', () => {
  const mkReport = async (title: string, email: string) => {
    const id = (await ok('cards/create', { content: title, deckId })).id as string;
    db.prepare('INSERT INTO report_emails (card_id, email) VALUES (?,?)').run(id, email);
    return id;
  };
  const codeOf = (id: string) => cardCode((db.prepare('SELECT seq FROM cards WHERE id=?').get(id) as any).seq);

  it('report done email batched once per day per email', async () => {
    db.prepare("UPDATE users SET timezone='UTC' WHERE id=?").run(ownerId);
    const a1 = await mkReport('Crash on load', 'player@x.io');
    const a2 = await mkReport('Typo in menu', 'player@x.io');
    const b1 = await mkReport('Sound glitch', 'other@x.io');
    const open = await mkReport('Still open', 'other@x.io');
    for (const id of [a1, a2, b1]) await ok('cards/update', { id, status: 'done' });
    job(runReportEmails, at('2026-11-16T07:59:00Z'));
    expect(outbox()).toHaveLength(0);
    job(runReportEmails, at('2026-11-16T08:01:00Z'));
    let mails = outbox();
    expect(mails.map((m) => [m.to_addr, m.kind])).toEqual([['player@x.io', 'reportDone'], ['other@x.io', 'reportDone']]);
    expect(mails[0].text).toContain(codeOf(a1));
    expect(mails[0].text).toContain(codeOf(a2));
    expect(mails[1].text).toContain(codeOf(b1));
    expect(mails[1].text).not.toContain(codeOf(open));
    // No app set up: the workspace name stands in.
    expect(mails[0].subject).toBe('W: 2 of your reports were resolved');
    const notified = db.prepare('SELECT card_id, notified_at FROM report_emails ORDER BY card_id').all() as any[];
    expect(notified.filter((r) => r.notified_at !== null).map((r) => r.card_id).sort()).toEqual([a1, a2, b1].sort());
    // Another one done the same day waits for tomorrow's batch.
    const a3 = await mkReport('Wrong colour', 'player@x.io');
    await ok('cards/update', { id: a3, status: 'done' });
    job(runReportEmails, at('2026-11-16T15:00:00Z'));
    expect(outbox()).toHaveLength(2);
    job(runReportEmails, at('2026-11-17T08:00:00Z'));
    mails = outbox();
    expect(mails).toHaveLength(3);
    expect(mails[2].to_addr).toBe('player@x.io');
    expect(mails[2].subject).toBe(`W: your report ${codeOf(a3)} was resolved`);
    expect(mails[2].text).not.toContain(codeOf(a1));
  });

  it('carries no reporter content: fixed text, the app name and task codes only', async () => {
    db.prepare("UPDATE users SET timezone='UTC' WHERE id=?").run(ownerId);
    db.prepare("INSERT INTO report_apps (id, name, access_key_hash, created_at) VALUES ('app1', 'Hollow Keep', 'h', 0)").run();
    const spam = 'CHEAP PILLS at http://spam.example click now';
    const id = await mkReport(`${spam}\n\nmore ${spam}`, 'victim@x.io');
    await ok('cards/update', { id, status: 'done' });
    job(runReportEmails, at('2026-11-16T09:00:00Z'));
    const [m] = outbox();
    expect(m.subject).toBe(`Hollow Keep: your report ${codeOf(id)} was resolved`);
    for (const field of [m.subject, m.text, m.html]) {
      expect(field).not.toContain('PILLS');
      expect(field).not.toContain('spam.example');
    }
    expect(m.text).toContain('/email/unsubscribe?t=');
  });

  it('the workspace sends at most REPORT_EMAILS_PER_DAY a day', async () => {
    db.prepare("UPDATE users SET timezone='UTC' WHERE id=?").run(ownerId);
    const ins = db.prepare("INSERT INTO email_outbox (to_addr, subject, text, kind, created_at, next_attempt_at, status) VALUES ('x@x.io','s','t','reportDone',?,0,'log')");
    for (let i = 0; i < REPORT_EMAILS_PER_DAY - 1; i++) ins.run(at('2026-11-16T08:30:00Z'));
    for (const n of [1, 2]) await ok('cards/update', { id: await mkReport('R', `p${n}@x.io`), status: 'done' });
    job(runReportEmails, at('2026-11-16T09:00:00Z'));
    expect(outbox().filter((m) => m.to_addr !== 'x@x.io').map((m) => m.to_addr)).toEqual(['p1@x.io']);
    job(runReportEmails, at('2026-11-17T09:00:00Z'));
    expect(outbox().filter((m) => m.to_addr !== 'x@x.io').map((m) => m.to_addr)).toEqual(['p1@x.io', 'p2@x.io']);
  });
});

describe('unsubscribe', () => {
  const get = (tok: string) => app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(tok)}`, headers: { host: HOST } });
  /** Our confirm page's form: same origin, urlencoded `t`. */
  const confirm = (tok: string) => app.inject({
    method: 'POST', url: '/email/unsubscribe', payload: `t=${encodeURIComponent(tok)}`,
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const prefOf = (id: string) => (db.prepare('SELECT notifications FROM email_prefs WHERE user_id=?').get(id) as any)?.notifications;

  it('unsubscribe link with a bad signature → 400; good one turns off that kind', async () => {
    const u = await mkUser('leaver', 'UTC');
    const url = new URL(unsubscribeUrl(db, u.email, 'notifications'));
    expect(url.origin).toBe('http://tracker.test');
    const t = url.searchParams.get('t')!;
    const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
    for (const bad of [tampered, '', 'garbage']) {
      expect((await get(bad)).statusCode).toBe(400);
      expect((await confirm(bad)).statusCode).toBe(400);
    }
    // A token for another address does not fit this one.
    const other = new URL(unsubscribeUrl(db, 'someone@x.io', 'notifications')).searchParams.get('t')!;
    expect((await confirm(other.replace(/^[^.]+/, Buffer.from(u.email).toString('base64url')))).statusCode).toBe(400);
    // GET only asks: a link scanner opening it changes nothing.
    const page = await get(t);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toBeTruthy();
    expect(page.body).toContain('<form method="post" action="/email/unsubscribe">');
    expect(page.body).not.toContain('<script');
    expect(prefOf(u.id)).toBeUndefined();
    // The form's POST does it.
    const res = await confirm(t);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You are unsubscribed');
    expect(prefOf(u.id)).toBe('off');
    // No digest for them any more.
    const c = (await ok('cards/create', { content: 'Ping', deckId })).id;
    await ok('resolvables/create', { cardId: c, context: 'comment', content: '@leaver hi' });
    job(runEmailDigests, at('2099-01-01T09:00:00Z'));
    expect(outbox().filter((m) => m.to_addr === u.email)).toEqual([]);
    // Other kinds still go out; an unsubscribed (address, kind) is dropped at enqueue.
    const rt = new URL(unsubscribeUrl(db, 'Player@X.io', 'reportDone')).searchParams.get('t')!;
    expect((await confirm(rt)).statusCode).toBe(200);
    expect(enqueueEmail(db, { to: 'player@x.io', subject: 's', text: 't', kind: 'reportDone' })).toBeNull();
    expect(enqueueEmail(db, { to: 'player@x.io', subject: 's', text: 't', kind: 'notifications' })).toBeTypeOf('number');
    // Unsubscribing keeps working while the workspace is disabled.
    db.prepare('UPDATE account SET is_disabled=1').run();
    expect((await get(t)).statusCode).toBe(200);
    expect((await confirm(t)).statusCode).toBe(200);
    expect((await confirm('nope')).statusCode).toBe(400);
  });

  it('one-click POST from a mail provider (RFC 8058): no or a foreign Origin, token in the URL', async () => {
    const a = await mkUser('clicker', 'UTC');
    const b = await mkUser('clacker', 'UTC');
    const urlA = new URL(unsubscribeUrl(db, a.email, 'notifications'));
    const urlB = new URL(unsubscribeUrl(db, b.email, 'notifications'));
    const viaPath = (u: URL) => `${u.pathname}${u.search}`;
    const r1 = await app.inject({ method: 'POST', url: viaPath(urlA), payload: 'List-Unsubscribe=One-Click', headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(prefOf(a.id)).toBe('off');
    const boundary = 'xyz';
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`;
    const r2 = await app.inject({ method: 'POST', url: viaPath(urlB), payload: multipart, headers: { host: HOST, origin: 'https://mail.provider.example', 'sec-fetch-site': 'cross-site', 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(prefOf(b.id)).toBe('off');
    // The exemption is for this path only, and the token is still required.
    expect((await app.inject({ method: 'POST', url: '/email/unsubscribe?t=bad', payload: 'List-Unsubscribe=One-Click', headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/logout', payload: {}, headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' } })).statusCode).toBe(403);
    // The Host check still applies.
    expect((await app.inject({ method: 'POST', url: viaPath(urlA), payload: 'List-Unsubscribe=One-Click', headers: { host: 'evil.example', 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(421);
    // Built messages carry both headers.
    const msg = buildMessage({ from: 'a@x.io', to: 'b@x.io', subject: 's', text: 't', listUnsubscribe: urlA.href });
    expect(msg).toContain(`\r\nList-Unsubscribe: <${urlA.href}>\r\n`);
    expect(msg).toContain('\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n');
  });
});

describe('settings, invites and tokens', () => {
  it('admin sees the transport and the outbox; members do not', async () => {
    enqueueEmail(db, { to: 'a@x.io', subject: 'Hello there', text: 'secret body', kind: 'notifications' });
    const r = await app.inject({ method: 'GET', url: '/api/email/status', headers: { host: HOST, cookie: owner } });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.transport).toBe('log');
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({ toAddr: 'a@x.io', subject: 'Hello there', kind: 'notifications', status: 'pending' });
    expect(JSON.stringify(s)).not.toContain('secret body');
    const id = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'m@x.io','M',?,0)").run(id, hashPassword('pw'));
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
    const m = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'm@x.io', password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
    expect((await app.inject({ method: 'GET', url: '/api/email/status', headers: { host: HOST, cookie: m } })).statusCode).toBe(403);
    // Everyone has their own preferences.
    expect((await app.inject({ method: 'GET', url: '/api/email/prefs', headers: { host: HOST, cookie: m } })).json()).toEqual({ notifications: 'daily' });
    await ok('emailPrefs/update', { notifications: 'off' }, m);
    expect((await app.inject({ method: 'GET', url: '/api/email/prefs', headers: { host: HOST, cookie: m } })).json()).toEqual({ notifications: 'off' });
    const bad = await app.inject({ method: 'POST', url: '/dispatch/emailPrefs/update', payload: { notifications: 'hourly' }, headers: { host: HOST, cookie: m, 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
  });

  it('an invite with an address enqueues the link; without one, nothing', async () => {
    const { token } = await ok('invites/create', { role: 'member', projectIds: [], email: 'newbie@x.io' });
    let mails = outbox();
    expect(mails.map((m) => [m.to_addr, m.kind])).toEqual([['newbie@x.io', 'invite']]);
    expect(mails[0].text).toContain(`http://tracker.test/join/${token}`);
    expect(mails[0].text).toContain('Ann');
    await ok('invites/create', { role: 'member', projectIds: [] });
    mails = outbox();
    expect(mails).toHaveLength(1);
    // The link is a credential: it leaves the outbox once handled.
    await sendPendingEmails(db, { transport: 'log', smtp: null, publicUrl: 'http://tracker.test' }, Date.now());
    expect(outbox()[0].text).not.toContain(token);
  });

  it('emailPrefs is token-denied', () => {
    expect(TOKEN_DENIED_NAMESPACES.has('emailPrefs')).toBe(true);
  });
});

describe('server secret', () => {
  it('JT_SECRET wins; otherwise a key file is made once in the data dir (owner-only) and reused', () => {
    const base = join(homedir(), '.cache/gametracker/scratch');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'secret-'));
    try {
      expect(loadSecret(dir, { JT_SECRET: 'a-long-enough-secret' })).toBe('a-long-enough-secret');
      expect(() => loadSecret(dir, { JT_SECRET: 'short' })).toThrow(/16/);
      const s = loadSecret(dir, {});
      expect(s.length).toBeGreaterThanOrEqual(32);
      expect(statSync(join(dir, SECRET_FILE)).mode & 0o777).toBe(0o600);
      expect(loadSecret(dir, {})).toBe(s);
      // Too open: narrowed to the owner (with a warning), same secret.
      chmodSync(join(dir, SECRET_FILE), 0o644);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(loadSecret(dir, {})).toBe(s);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      expect(statSync(join(dir, SECRET_FILE)).mode & 0o777).toBe(0o600);
      // A short or damaged file is an error, never silently replaced (that would break every link already sent).
      writeFileSync(join(dir, SECRET_FILE), 'short\n');
      expect(() => loadSecret(dir, {})).toThrow(/16/);
      expect(readFileSync(join(dir, SECRET_FILE), 'utf8')).toBe('short\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
