import { test, expect } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

// A card opened beside its deck sits in a scrolling panel; its More options menu must not be cut off by it.
test('card menu in the deck panel is not clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Menu proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Menu list'), projectId: project.id, spaceId: 1 });
  const card = await run<{ accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Menu task' });
  const seq = ((await snapshot(page)).decks as any[]).find((d) => d.id === deck.id).seq as number;

  await page.goto(`/decks/${seq}/card/${cardCode(card.accountSeq)}`);
  await page.getByTestId('card-page').getByRole('button', { name: 'More options' }).click();
  const items = page.getByRole('menu', { name: 'More options' }).getByRole('menuitem');
  await expect(items.first()).toBeVisible();

  const vw = 1400;
  for (const item of await items.all()) {
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    // Both ends of the item are what the user sees, not the panel underneath.
    for (const x of [box.x + 4, box.x + box.width - 4]) {
      const hit = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[role="menuitem"]')?.textContent ?? null,
        [x, box.y + box.height / 2]);
      expect(hit).toBe(await item.textContent());
    }
  }

  // A window too short for the list below the button: the whole menu still fits on screen (scrolling inside).
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 300 });
  await page.getByTestId('card-page').getByRole('button', { name: 'More options' }).click();
  const box = (await page.getByRole('menu', { name: 'More options' }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(300);
  await page.getByRole('menuitem').last().scrollIntoViewIfNeeded();
  await expect(page.getByRole('menuitem').last()).toBeInViewport();

  // Esc closes it and gives focus back to the button.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'More options' })).toHaveCount(0);
  await expect(page.getByTestId('card-page').getByRole('button', { name: 'More options' })).toBeFocused();
});
