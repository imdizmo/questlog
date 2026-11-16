import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Keys proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Keys list'), projectId: project.id, spaceId: 1 });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Alpha task' });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Bravo task' });
  const seq = (await snapshot(page)).decks.find((d: any) => d.id === deck.id).seq as number;
  return { deckPath: `/decks/${seq}` };
}

const panel = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

test('? opens the shortcut panel, Esc closes it, / focuses search, ? in the box types', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await expect(page.getByTestId('card-tile')).toHaveCount(2);

  await page.keyboard.press('Shift+?');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('Alt+P');
  await expect(panel(page).getByText('/', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Coming later')).toHaveCount(1);
  await page.keyboard.press('Shift+?');
  await expect(panel(page)).toHaveCount(0);

  await page.keyboard.press('Shift+?');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);

  await page.keyboard.press('/');
  const box = page.getByRole('combobox', { name: 'Search tasks' });
  await expect(box).toBeFocused();
  await page.keyboard.press('Shift+?');
  await expect(panel(page)).toHaveCount(0);
  await expect(box).toHaveValue('?');

  await page.getByRole('button', { name: 'See shortcuts' }).first().click();
  await expect(panel(page)).toBeVisible();
});

test('Esc closes only the innermost thing; o and t toggle deck panels', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(`${deckPath}?panel=sort`);
  const tiles = page.getByTestId('card-tile');
  await expect(tiles).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Order', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Order', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(tiles).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(`${deckPath}`));

  await page.keyboard.press('o');
  await expect(page.getByRole('button', { name: 'Order', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Tags', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Tags', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Order', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // selection, then side panel, then the open card panel, one Esc each
  await tiles.filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Select Alpha task' }).click();
  await tiles.filter({ hasText: 'Alpha' }).getByRole('link').click();
  await expect(page.getByRole('complementary', { name: 'Open task' })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Open task' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Open task' })).toHaveCount(0);
});
