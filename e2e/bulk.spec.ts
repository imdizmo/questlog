import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, newPerson, run, snapshot, unique } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const name = unique('Bulk proj');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Bulk list'), projectId: project.id, spaceId: 1 });
  for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await run(page, 'cards', 'create', { deckId: deck.id, content: t });
  const seq = (await snapshot(page)).decks.find((d: any) => d.id === deck.id).seq as number;
  return { name, deckPath: `/decks/${seq}` };
}

const tile = (page: Page, title: string) => page.getByTestId('card-tile').filter({ hasText: title });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Bulk actions' });

test('bulk select, set priority, archive, Esc', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await expect(page.getByTestId('card-tile')).toHaveCount(4);
  await expect(bar(page)).toHaveCount(0);

  await tile(page, 'Alpha').getByRole('button', { name: 'Select Alpha' }).click();
  await expect(bar(page)).toContainText('1 selected');
  await tile(page, 'Charlie').getByRole('button', { name: 'Select Charlie' }).click({ modifiers: ['Shift'] });
  await expect(bar(page)).toContainText('3 selected');
  await expect(tile(page, 'Bravo').getByRole('button', { name: 'Select Bravo' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tile(page, 'Delta').getByRole('button', { name: 'Select Delta' })).toHaveAttribute('aria-pressed', 'false');

  await bar(page).getByRole('button', { name: 'High' }).click();
  const high = page.getByRole('region', { name: 'High' });
  await expect(high.getByTestId('card-tile')).toHaveCount(3);

  await bar(page).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);

  await tile(page, 'Delta').getByRole('button', { name: 'Select Delta' }).click();
  await expect(bar(page)).toContainText('1 selected');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
});

test('group select, bulk delete with confirm, navigating away clears', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  const group = page.getByRole('region', { name: 'No priority' });
  await expect(group.getByRole('button', { name: 'Select group No priority' })).toBeDisabled();
  await tile(page, 'Alpha').getByRole('button', { name: 'Select Alpha' }).click();
  await group.getByRole('button', { name: 'Select group No priority' }).click();
  await expect(bar(page)).toContainText('4 selected');
  await bar(page).getByRole('button', { name: 'Clear' }).click();
  await expect(bar(page)).toHaveCount(0);

  await tile(page, 'Bravo').getByRole('button', { name: 'Select Bravo' }).click();
  await bar(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(3);

  await tile(page, 'Alpha').getByRole('button', { name: 'Select Alpha' }).click();
  await expect(bar(page)).toContainText('1 selected');
  await page.getByRole('link', { name: 'Lists', exact: true }).first().click();
  await expect(bar(page)).toHaveCount(0);
});

test('observer sees no Select buttons', async ({ page, browser }) => {
  const { name, deckPath } = await seed(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Members' }).click();
  const members = page.getByRole('dialog', { name: 'Members' });
  await members.getByRole('button', { name: 'Invite people' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite people' });
  await invite.getByRole('radio', { name: /^Observer/ }).check();
  await invite.getByRole('checkbox', { name }).check();
  await invite.getByRole('button', { name: 'Create link' }).click();
  const link = await invite.getByLabel('Invite link').inputValue();
  await invite.getByRole('button', { name: 'Done' }).click();

  const c = await newPerson(browser);
  const who = unique('Obs');
  await c.goto(link);
  await c.getByLabel('Your name').fill(who);
  await c.getByLabel('Email').fill(`${who.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await c.getByLabel('Password').fill('another good password');
  await c.getByRole('button', { name: 'Join' }).click();
  await expect(c).toHaveURL(/\/decks$/);
  await c.goto(deckPath);
  await expect(c.getByTestId('card-tile')).toHaveCount(4);
  await expect(c.getByRole('button', { name: /^Select/ })).toHaveCount(0);
  await c.context().close();
});
