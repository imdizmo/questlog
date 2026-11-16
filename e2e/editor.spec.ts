import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/** A project with a deck, a card to edit and a card to reference; opens the first one. */
async function seed(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Lighthouse') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Shaders', projectId: project.id });
  const refTitle = unique('Fog shader');
  const ref = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: refTitle });
  const card = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Valley pass' });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  const cardPath = `/decks/${seq}-shaders/card/${cardCode(card.accountSeq)}`;
  await page.goto(cardPath);
  await expect(cardPage(page).getByRole('heading', { name: 'Valley pass' })).toBeVisible();
  return { cardId: card.id, refTitle, refCode: cardCode(ref.accountSeq) };
}

const cardPage = (page: Page) => page.getByTestId('card-page');
const editor = (page: Page) => cardPage(page).getByLabel('Task text');
const contentOf = async (page: Page, id: string) =>
  ((await snapshot(page)).cards as any[]).find((c) => c.id === id).content as string;

/** Opens the editor with the caret at the end of the text. */
async function edit(page: Page) {
  await cardPage(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor(page)).toBeFocused();
  await editor(page).press('Control+End');
}

test('slash menu, checklist, card reference, preview and focus mode', async ({ page }) => {
  const { cardId, refTitle, refCode } = await seed(page);

  // `/` at the start of a line opens the command menu; Esc closes it again.
  await edit(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu).toBeVisible();
  for (const g of ['Task properties', 'References', 'Headings', 'Lists', 'Formatting', 'Links']) {
    await expect(menu.getByRole('group', { name: g })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(editor(page)).toBeVisible(); // Esc in the menu doesn't cancel the edit

  // Once closed, the slash is plain text; a new `/` opens it again. Typing filters; Enter picks.
  await page.keyboard.type('x');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/check');
  await expect(menu.getByRole('option', { name: 'Checklist' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(editor(page)).toHaveValue('Valley pass\n- [ ] ');
  await page.keyboard.type('Paint fog');
  await page.keyboard.press('Control+Enter');
  await expect(editor(page)).toHaveCount(0);

  // Ticking the box in the view saves `- [x]`.
  const box = cardPage(page).getByRole('checkbox', { name: 'Paint fog' });
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await expect.poll(() => contentOf(page, cardId)).toBe('Valley pass\n- [x] Paint fog');

  // Reference card: the picker searches cards, Enter inserts the code, the view shows its title.
  await edit(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('See /');
  await expect(menu).toBeVisible();
  await menu.getByRole('option', { name: 'Reference task', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Reference task', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('combobox').fill(refTitle);
  await expect(picker.getByRole('option').first()).toContainText(refTitle);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(editor(page)).toHaveValue(`Valley pass\n- [x] Paint fog\nSee $${refCode} `);
  await expect(editor(page)).toBeFocused();

  // Preview toggles between the rendered text and the textarea.
  const preview = cardPage(page).getByRole('button', { name: 'Preview' });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(editor(page)).toBeHidden();
  await expect(cardPage(page).getByTestId('md-preview').getByRole('link', { name: refTitle })).toBeVisible();
  await preview.click();
  await expect(editor(page)).toBeVisible();

  // Focus mode is a full-screen editor; Esc leaves it and keeps the draft.
  await cardPage(page).getByRole('button', { name: 'Focus mode' }).click();
  const focus = page.getByRole('dialog', { name: 'Focus mode' });
  await expect(focus).toBeVisible();
  await expect(focus.getByLabel('Task text')).toBeFocused();
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(focus).toBeHidden();
  await expect(editor(page)).toHaveValue(`Valley pass\n- [x] Paint fog\nSee $${refCode} !`);

  await page.keyboard.press('Control+Enter');
  await expect(editor(page)).toHaveCount(0);
  const chip = cardPage(page).getByRole('link', { name: refTitle });
  await expect(chip).toHaveClass(/card-ref/);
  await chip.click();
  await expect(cardPage(page).getByRole('heading', { name: refTitle })).toBeVisible();
});

test('slash menu works from the keyboard and inserts headings on their own line', async ({ page }) => {
  await seed(page);
  await edit(page);
  await page.keyboard.type(' /');
  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu).toBeVisible();
  // ArrowDown moves the highlight; the first command starts highlighted.
  const first = menu.getByRole('option').first();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.type('heading 2');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveValue('Valley pass \n## ');
  // A slash inside a word is just a slash.
  await page.keyboard.type('and/or');
  await expect(menu).toBeHidden();
});

test('rendered markdown: heading, checklist, card and tag chips', async ({ page }) => {
  const { cardId, refTitle, refCode } = await seed(page);
  const card = ((await snapshot(page)).cards as any[]).find((c) => c.id === cardId);
  const content = [
    'Valley pass',
    '',
    '## Fog pass',
    'Volumetric fog for the valley, see $' + refCode + ' and #design.',
    '',
    '- [x] Height falloff',
    '- [ ] Wind noise',
    '',
    '> Keep it under **1 ms** on the List.',
    '',
    '`#notatag` stays code. [Reference](https://example.com)',
  ].join('\n');
  await run(page, 'cards', 'update', { id: cardId, content, contentVersion: card.contentVersion });
  const body = cardPage(page).getByTestId('card-markdown');
  await expect(body.getByRole('heading', { level: 2, name: 'Fog pass' })).toBeVisible();
  await expect(body.getByRole('link', { name: refTitle })).toHaveAttribute('href', new RegExp(`^/card/${refCode}-`));
  await expect(body.locator('.md-tag')).toHaveText('#design');
  await expect(body.locator('code')).toHaveText('#notatag');
  await expect(body.getByRole('checkbox')).toHaveCount(2);
  await expect(body.getByRole('link', { name: 'Reference' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOTS}/phase2-markdown.png` });
});

test('new card panel: the editor menu takes Esc before the panel does', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  const text = panel.getByLabel('Task text');
  await expect(text).toBeFocused();
  await page.keyboard.type('Rain pass\n/');
  const menu = panel.getByRole('listbox', { name: 'Insert' });
  await expect(menu.getByRole('option', { name: 'Set properties' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('a queued tick never lands on a different item after the lines move', async ({ page }) => {
  const { cardId } = await seed(page);
  const v = ((await snapshot(page)).cards as any[]).find((c) => c.id === cardId).contentVersion;
  await run(page, 'cards', 'update', { id: cardId, content: 'Valley pass\n- [ ] a\n- [ ] b', contentVersion: v });
  const body = cardPage(page).getByTestId('card-markdown');
  const a = body.getByRole('checkbox', { name: 'a', exact: true });
  const b = body.getByRole('checkbox', { name: 'b', exact: true });
  await expect(b).toBeVisible();

  // Hold the first tick's save in flight so the second one queues behind it.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/dispatch/cards/update', async (route) => {
    if (route.request().postData()?.includes('- [x] a')) await held;
    await route.continue();
  });
  await a.click();
  await b.click();
  // Meanwhile someone inserts a line above, so line 2 now holds "a".
  const now = ((await (await page.request.get('/api/snapshot')).json()).cards as any[]).find((c) => c.id === cardId);
  const moved = await page.request.post('/dispatch/cards/update', {
    data: { id: cardId, content: 'Valley pass\n- [ ] new\n- [ ] a\n- [ ] b', contentVersion: now.contentVersion },
  });
  expect(moved.ok()).toBe(true);
  release();

  // The held tick hits a conflict; the queued one finds another item on its line and gives up.
  await expect.poll(() => contentOf(page, cardId)).toBe('Valley pass\n- [ ] new\n- [ ] a\n- [ ] b');
  await expect(body.getByRole('checkbox')).toHaveCount(3);
  for (const name of ['new', 'a', 'b']) await expect(body.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  await page.unroute('**/dispatch/cards/update');
});
