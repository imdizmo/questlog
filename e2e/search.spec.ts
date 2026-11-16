import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Search proj') });
  const deckA = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Alpha list'), projectId: project.id, spaceId: 1 });
  const deckB = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Beta list'), projectId: project.id, spaceId: 1 });
  const word = unique('zq').replace(/[^a-z0-9]/gi, '');
  const a1 = await run<{ id: string }>(page, 'cards', 'create', { deckId: deckA.id, content: `WF-2 Gets started ${word}` });
  const a2 = await run<{ id: string }>(page, 'cards', 'create', { deckId: deckA.id, content: `WF-3 Gets stuck ${word}` });
  await run(page, 'cards', 'create', { deckId: deckB.id, content: `WF-9 Gets noticed ${word}` });
  await run(page, 'cards', 'create', { deckId: deckB.id, content: 'Unrelated chore' });
  await run(page, 'resolvables', 'create', { cardId: a2.id, context: 'block', content: 'Waiting on art' });
  const snap = await snapshot(page);
  const info = (id: string) => snap.decks.find((d: any) => d.id === id);
  const seq = info(deckA.id).seq as number;
  const code = snap.cards.find((c: any) => c.id === a1.id).seq as number;
  return { word, deckPath: `/decks/${seq}`, cardSeq: code };
}

const box = (page: Page) => page.getByRole('combobox', { name: 'Search tasks' });

test('search box: quick results, chips, negation, saved searches, all decks, go to card', async ({ page }) => {
  const { word, deckPath, cardSeq } = await seed(page);
  await page.goto(deckPath);
  await expect(page.getByTestId('card-tile')).toHaveCount(2);

  // `/` focuses the box; quick results show matching titles.
  await page.keyboard.press('/');
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveAttribute('placeholder', 'Search tasks…');
  await box(page).fill(word);
  await expect(page.getByRole('group', { name: 'Tasks' }).getByRole('option', { name: /WF-2 Gets started/ })).toBeVisible();
  await expect(page.getByText('Searching 2 tasks in this list')).toBeVisible();

  // Enter with no pick makes a content chip and filters the deck.
  await box(page).fill('started');
  await box(page).press('Enter');
  const chips = page.getByRole('list', { name: 'Search filters' });
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(page).toHaveURL(/search=/);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
  await expect(page.getByTestId('card-tile').getByRole('link', { name: /WF-2 Gets started/ })).toBeVisible();

  // Backspace in an empty box removes the last chip.
  await box(page).press('Backspace');
  await expect(chips.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByTestId('card-tile')).toHaveCount(2);

  // "!" then Blocked: a negated chip, the blocked card disappears.
  await box(page).fill('!');
  await page.getByRole('group', { name: 'Status' }).getByRole('option', { name: 'Blocked' }).click();
  await expect(chips.getByRole('listitem').first()).toContainText('not');
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
  await expect(page.getByTestId('card-tile').getByRole('link', { name: /WF-3 Gets stuck/ })).toHaveCount(0);

  // Save the search, reload, pick it from the saved list.
  await page.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByRole('button', { name: 'Save search' })).toBeDisabled();
  await page.goto(deckPath);
  await expect(page.getByTestId('card-tile')).toHaveCount(2);
  await box(page).click();
  const saved = page.getByRole('group', { name: 'Saved searches' });
  await expect(saved.getByRole('option', { name: 'My tasks' })).toBeVisible();
  await saved.getByRole('option', { name: /Not blocked/i }).click();
  await expect(chips.getByRole('listitem').first()).toContainText('not');
  await expect(page.getByTestId('card-tile')).toHaveCount(1);

  // A saved search can be deleted.
  await box(page).click();
  await page.getByRole('button', { name: /Delete saved search Not blocked/i }).click();
  await expect(saved.getByRole('option', { name: /Not blocked/i })).toHaveCount(0);

  // Chip x removes it; then search all decks moves the chips to /decks.
  await chips.getByRole('button', { name: /Remove/ }).click();
  await box(page).fill(word);
  await box(page).press('Enter');
  await box(page).click();
  await page.getByRole('button', { name: 'Search all lists' }).click();
  await expect(page).toHaveURL(/\/decks\?search=/);
  await expect(page.getByRole('heading', { level: 3, name: /Alpha list/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: /Beta list/ })).toBeVisible();
  await expect(page.getByTestId('card-tile')).toHaveCount(3);
  await expect(page.getByRole('status').filter({ hasText: '3 tasks' })).toBeVisible();

  // Typing a card code offers Go to card.
  await box(page).press('Backspace');
  await box(page).fill(`$${cardCode(cardSeq)}`);
  const go = page.getByRole('group', { name: 'Go to task' }).getByRole('option', { name: /WF-2 Gets started/ });
  await expect(go).toBeVisible();
  await go.click();
  await expect(page).toHaveURL(/\/card\//);
});

test('match any widens the filter; chips are removable', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await box(page).fill('stuck');
  await box(page).press('Enter');
  await box(page).fill('started');
  await box(page).press('Enter');
  const chips = page.getByRole('list', { name: 'Search filters' });
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByTestId('card-tile')).toHaveCount(0); // both words never match one title
  await page.getByRole('button', { name: 'Match any' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(2);
  await chips.getByRole('button', { name: /Remove filter/ }).first().click();
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(box(page)).toBeFocused(); // removing a chip returns focus to the box
});

test('keyboard: arrows pick, Escape closes from anywhere in the box', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await box(page).fill('!');
  await box(page).press('ArrowDown');
  await expect(page.getByRole('option', { selected: true })).toHaveCount(1);
  await box(page).press('Enter');
  const chips = page.getByRole('list', { name: 'Search filters' });
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(chips.getByRole('listitem').first()).toContainText('not');

  // Focus on a button inside the box: Escape closes the menu and focus returns to the input.
  await box(page).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.getByRole('button', { name: 'Match any' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(box(page)).toBeFocused();

  // Removing the chip by keyboard keeps focus in the box.
  await chips.getByRole('button', { name: /Remove filter/ }).focus();
  await page.keyboard.press('Enter');
  await expect(chips.getByRole('listitem')).toHaveCount(0);
  await expect(box(page)).toBeFocused();
});

test('chips survive opening and closing a card inside the deck', async ({ page }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await box(page).fill('started');
  await box(page).press('Enter');
  const chips = page.getByRole('list', { name: 'Search filters' });
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);

  await page.getByTestId('card-tile').getByRole('link', { name: /WF-2 Gets started/ }).click();
  await expect(page).toHaveURL(/\/card\/.*search=/);
  await expect(page.getByRole('complementary', { name: 'Open task' })).toBeVisible();
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);

  await page.getByRole('link', { name: 'Close task' }).click();
  await expect(page).not.toHaveURL(/\/card\//);
  await expect(page).toHaveURL(/search=/);
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);

  // Esc closes the card and keeps the filter too.
  await page.getByTestId('card-tile').getByRole('link', { name: /WF-2 Gets started/ }).click();
  await expect(page.getByRole('complementary', { name: 'Open task' })).toBeVisible();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/card\//);
  await expect(page).toHaveURL(/search=/);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
});
