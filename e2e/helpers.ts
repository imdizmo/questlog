import { expect, type Browser, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';

/** E2E_SHOTS picks another folder for screenshots (two checkouts on one machine). */
export const SHOTS = process.env.E2E_SHOTS ?? `${process.env.HOME}/.cache/gametracker/scratch/shots`;
export const OWNER = { workspace: 'Jatify', name: 'Ada Owner', email: 'ada@example.com', password: 'correct horse battery' };

/**
 * Leaves `page` signed in as the owner. On an empty database it runs first-run setup through the
 * UI; otherwise it logs in. Every spec starts with this, so no spec depends on another one's order.
 * Returns true when this call created the workspace.
 */
export async function ensureWorkspace(page: Page): Promise<boolean> {
  page.on('dialog', (d) => { throw new Error(`unexpected native dialog: ${d.message()}`); });
  // These specs were written against the grouped tiles; the board has its own spec (board.spec.ts).
  await page.addInitScript(() => { try { localStorage.setItem('ql.listShape', 'groups'); } catch { /* no storage */ } });
  const { setup } = await (await page.request.get('/api/status')).json();
  if (!setup) {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel('Workspace name').fill(OWNER.workspace);
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/decks$/);
    // Effort points and sprints are off for new workspaces; the older specs cover them, so they run with the switch on.
    await run(page, 'accounts', 'update', { settings: { effortEnabled: true, sprintsEnabled: true } });
  } else {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Log in' }).click();
  }
  await expect(page).toHaveURL(/\/decks$/);
  return !setup;
}

/** A fresh browser context (own cookies, own socket) for a second or third person. */
export async function newPerson(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('ql.listShape', 'groups'); } catch { /* no storage */ } });
  page.on('dialog', (d) => { throw new Error(`unexpected native dialog: ${d.message()}`); });
  return page;
}

/** Runs a command from inside the page (same origin, same session cookie). */
export const run = <T = any>(page: Page, ns: string, action: string, payload: object) =>
  page.evaluate(async ([ns, action, payload]) => {
    const r = await fetch(`/dispatch/${ns}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`${ns}/${action}: ${r.status} ${await r.text()}`);
    return (await r.json()).payload;
  }, [ns, action, payload] as const) as Promise<T>;

export const snapshot = (page: Page) => page.evaluate(async () => (await fetch('/api/snapshot')).json());

let n = 0;
/** A name no other test in this run uses. */
export const unique = (base: string) => `${base} ${++n}-${Date.now() % 100000}`;

/**
 * Writes into a board's document as another client of the same person (the page's session cookie), the way an older
 * version of the app would have: syncs, runs `write` in one transaction, waits until the server has it, closes.
 */
export async function writeBoard(page: Page, boardId: string, write: (doc: Y.Doc) => void): Promise<void> {
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const doc = new Y.Doc();
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/rooms/vision-board/${encodeURIComponent(boardId)}`, { headers: { Cookie: cookie, Origin: BASE_URL } });
  const frame = (fill: (e: encoding.Encoder) => void) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); fill(e); return encoding.toUint8Array(e); };
  // The socket closing or failing at any point fails the write at once, instead of waiting out the poll below.
  let done = false;
  const closed = new Promise<never>((_, reject) => {
    ws.on('error', (err) => { if (!done) reject(err); });
    ws.on('close', (code) => { if (!done) reject(new Error(`board socket closed: ${code}`)); });
  });
  closed.catch(() => {}); // raced below; never left unhandled
  try {
    await Promise.race([closed, new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(frame((e) => syncProtocol.writeSyncStep1(e, doc))));
      ws.on('message', (data: Buffer) => {
        const d = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(d) !== 0) return;
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        if (syncProtocol.readSyncMessage(d, reply, doc, 'remote') === syncProtocol.messageYjsSyncStep2) resolve();
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
      });
      ws.on('error', reject);
      ws.on('close', (code) => reject(new Error(`board socket closed: ${code}`)));
    })]);
    doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') ws.send(frame((e) => syncProtocol.writeUpdate(e, u))); });
    doc.transact(() => write(doc));
    // A second client sees the write once the server has applied it.
    await Promise.race([closed, expect.poll(async () => {
      const other = new Y.Doc();
      const probe = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/rooms/vision-board/${encodeURIComponent(boardId)}`, { headers: { Cookie: cookie, Origin: BASE_URL } });
      try {
        await new Promise<void>((resolve, reject) => {
          probe.on('open', () => probe.send(frame((e) => syncProtocol.writeSyncStep1(e, other))));
          probe.on('message', (data: Buffer) => {
            const d = decoding.createDecoder(new Uint8Array(data));
            if (decoding.readVarUint(d) === 0 && syncProtocol.readSyncMessage(d, encoding.createEncoder(), other, 'remote') === syncProtocol.messageYjsSyncStep2) resolve();
          });
          probe.on('error', reject);
          probe.on('close', (code) => reject(new Error(`board probe socket closed: ${code}`)));
        });
        return Y.decodeStateVector(Y.encodeStateVector(other)).get(doc.clientID) === Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID);
      } finally { probe.close(); other.destroy(); }
    }).toBe(true)]);
  } finally {
    done = true;
    ws.close();
    doc.destroy();
  }
}
