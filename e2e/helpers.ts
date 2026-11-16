import { expect, type Browser, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config';

export const SHOTS = `${process.env.HOME}/.cache/gametracker/scratch/shots`;
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
