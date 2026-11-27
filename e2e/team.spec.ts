import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';

const CONFLICT = /Someone changed this task while you were editing/;

/** Owner side: a project with one deck. Returns ids and the deck page path. */
async function projectWithDeck(page: Page, name: string, deckTitle: string) {
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: deckTitle, projectId: project.id });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  return { projectId: project.id, deckId: deck.id, deckPath: `/decks/${seq}` };
}

/** Owner side: creates an invite through Members → Invite people and returns the link it shows. */
async function inviteLink(page: Page, role: 'Admin' | 'Member' | 'Observer', projects: string[] = []) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Members' }).click();
  const members = page.getByRole('dialog', { name: 'Members' });
  await expect(members).toBeVisible();
  await members.getByRole('button', { name: 'Invite people' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite people' });
  await invite.getByRole('radio', { name: new RegExp(`^${role}`) }).check();
  for (const p of projects) await invite.getByRole('checkbox', { name: p }).check();
  await invite.getByRole('button', { name: 'Create link' }).click();
  const field = invite.getByLabel('Invite link');
  await expect(field).toHaveValue(/\/join\/[A-Za-z0-9_-]+$/);
  const link = await field.inputValue();
  await invite.getByRole('button', { name: 'Done' }).click();
  await expect(invite).toBeHidden();
  // The new link is listed as active.
  await expect(members.getByRole('table', { name: 'Active invite links' }).getByRole('row', { name: new RegExp(role) }).first()).toBeVisible();
  return { link, members };
}

/** Second person: opens the link and creates an account. */
async function join(page: Page, link: string, name: string) {
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(`${name.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await page.getByLabel('Password').fill('another good password');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page).toHaveURL(/\/decks$/);
}

test('live update between two members', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const { deckPath } = await projectWithDeck(page, unique('Lighthouse'), 'Props');
  const { link, members } = await inviteLink(page, 'Member');

  const b = await newPerson(browser);
  const bName = unique('Bea');
  await join(b, link, bName);
  // The owner's member list learns about B without a reload, with a role select and an active switch.
  await expect(members.getByRole('combobox', { name: `Role for ${bName}` })).toHaveValue('member');
  await expect(members.getByRole('switch', { name: `Active: ${bName}` })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}/members.png`, animations: 'disabled' });
  await members.getByRole('button', { name: 'Close' }).first().click();

  await b.goto(deckPath);
  await expect(b.getByRole('heading', { level: 1, name: 'Props' })).toBeVisible();
  await expect(b.getByTestId('card-tile')).toHaveCount(0);

  await page.goto(deckPath);
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Task text').fill('Lantern');
  await panel.getByLabel('Task text').press('Control+Enter');
  await expect(panel).toBeHidden();

  await expect(b.getByTestId('card-tile').filter({ hasText: 'Lantern' })).toBeVisible({ timeout: 2000 });
  await b.context().close();
});

test('observer is read-only and scoped', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const pName = unique('Pier');
  const qName = unique('Quarry');
  const p = await projectWithDeck(page, pName, 'Docks');
  const q = await projectWithDeck(page, qName, 'Pits');
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: p.deckId, content: 'Rope coil' });
  await run(page, 'cards', 'create', { deckId: q.deckId, content: 'Gravel heap' });
  const { link, members } = await inviteLink(page, 'Observer', [pName]);
  await members.getByRole('button', { name: 'Close' }).first().click();

  const c = await newPerson(browser);
  await join(c, link, unique('Cy'));
  // Q has full visibility, but "full" means members, not observers.
  await expect(c.getByRole('region', { name: pName })).toBeVisible();
  await expect(c.getByRole('region', { name: qName })).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'New project' })).toHaveCount(0);
  // Observers get no admin items: their account menu has no Members, their workspace menu no admin sections.
  await c.getByRole('button', { name: 'Account menu' }).click();
  await expect(c.getByRole('menuitem', { name: 'Members' })).toHaveCount(0);
  await c.keyboard.press('Escape');

  await c.goto(p.deckPath);
  await expect(c.getByTestId('card-tile').filter({ hasText: 'Rope coil' })).toBeVisible();
  await expect(c.getByRole('button', { name: 'Add task' })).toHaveCount(0);

  const seq = (await snapshot(page)).cards.find((x: any) => x.id === card.id).seq as number;
  await c.goto(`/card/${cardCode(seq)}`);
  const cp = c.getByTestId('card-page');
  await expect(cp.getByRole('heading', { name: 'Rope coil' })).toBeVisible();
  for (const name of ['Start', 'Stop', 'Block', 'Review', 'Mark as done', 'Reopen', 'Edit']) {
    await expect(cp.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  // Nor can the server be talked into it.
  const r = await c.evaluate(async (id) => (await fetch('/dispatch/cards/update', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status: 'started' }),
  })).status, card.id);
  expect(r).toBe(403);
  await c.context().close();
});

test('content conflict toast', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const p = await projectWithDeck(page, unique('Harbor'), 'Boats');
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: p.deckId, content: 'Sail\nOriginal text.' });
  const seq = (await snapshot(page)).cards.find((x: any) => x.id === card.id).seq as number;
  const { link, members } = await inviteLink(page, 'Member');
  await members.getByRole('button', { name: 'Close' }).first().click();

  const b = await newPerson(browser);
  await join(b, link, unique('Bo'));

  const url = `/card/${cardCode(seq)}`;
  await page.goto(url);
  await b.goto(url);
  for (const who of [page, b]) {
    await who.getByTestId('card-page').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(who.getByLabel('Task text')).toBeVisible();
  }

  await b.getByLabel('Task text').fill('Sail\nB was here first.');
  await b.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(b.getByTestId('card-page').getByText('B was here first.')).toBeVisible();

  await page.getByLabel('Task text').fill('Sail\nA wants this instead.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').getByText(CONFLICT)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('B was here first.');
  // A's draft is kept, not lost.
  await expect(page.getByLabel('Task text')).toHaveValue('Sail\nA wants this instead.');
  await b.context().close();
});

test('settings persist', async ({ page }) => {
  await ensureWorkspace(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await expect(page).toHaveURL(/[?&]menu=workspace/);
  let dlg = page.getByRole('dialog', { name: 'Workspace menu' });
  await dlg.getByRole('tab', { name: 'Tasks' }).click();
  const slots = () => dlg.getByLabel('Snooze untouched started tasks after (hours)');

  await page.screenshot({ path: `${SHOTS}/settings-general.png`, animations: 'disabled' });
  await slots().fill('200');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').getByText('Settings saved')).toBeVisible();

  await page.reload();
  dlg = page.getByRole('dialog', { name: 'Workspace menu' });
  await expect(slots()).toHaveValue('200');

  await slots().fill('0');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.toast-error')).toBeVisible();
  await page.reload();
  dlg = page.getByRole('dialog', { name: 'Workspace menu' });
  await expect(slots()).toHaveValue('200');

  // The Features section holds the eight feature switches, plus Translation (saved on its own, with the language pack's state).
  await dlg.getByRole('tab', { name: 'Features' }).click();
  await expect(dlg.getByRole('switch')).toHaveCount(9);
  await expect(dlg.getByRole('switch', { name: 'Milestones' })).toBeChecked();
  // Other specs may switch flags on (shared workspace): the switch must show the saved value, whatever it is.
  const { dueDateEnabled } = (await snapshot(page)).account.settings;
  if (dueDateEnabled) await expect(dlg.getByRole('switch', { name: 'Due dates' })).toBeChecked();
  else await expect(dlg.getByRole('switch', { name: 'Due dates' })).not.toBeChecked();
  await page.screenshot({ path: `${SHOTS}/settings-features.png`, animations: 'disabled' });
});

test('Members page without Tailscale', async ({ page }) => {
  await ensureWorkspace(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Members' }).click();
  const members = page.getByRole('dialog', { name: 'Members' });
  await expect(members.getByRole('table', { name: 'People' })).toBeVisible();
  // Nobody is linked, so no row shows a Tailscale login or an Unlink button; nobody waits to join.
  await expect(members.getByTestId('tailscale-login')).toHaveCount(0);
  await expect(members.getByRole('button', { name: /^Unlink Tailscale/ })).toHaveCount(0);
  await expect(members.getByRole('heading', { name: 'Waiting to join' })).toHaveCount(0);
  await expect(members.getByRole('textbox', { name: /Tailscale/ })).toHaveCount(0);
});

test('no Tailscale button when Tailscale is off', async ({ page }) => {
  await ensureWorkspace(page);
  const state = await page.evaluate(async () => (await fetch('/api/tailscale')).json());
  expect(state.enabled).toBe(false);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Email notifications' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'My account' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/?show=myAccount');
  const dlg = page.getByRole('dialog', { name: 'My account' });
  await expect(dlg.getByText('not turned on')).toBeVisible();
  await expect(dlg.getByRole('button', { name: /Sign in with Tailscale/ })).toHaveCount(0);
  // The log-out button keeps its plain label.
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
});
