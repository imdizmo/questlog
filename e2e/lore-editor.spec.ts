import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/** A project with a deck, a lore card with `content` and a task to reference; opens the lore card. */
async function seed(page: Page, content = 'Valley lore') {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Lighthouse') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Shaders', projectId: project.id });
  const refTitle = unique('Fog shader');
  const ref = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: refTitle });
  const card = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content, isDoc: true });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  await page.goto(`/decks/${seq}-shaders/card/${cardCode(card.accountSeq)}`);
  await expect(cardPage(page).getByRole('heading', { name: content.split(/\r?\n/)[0].replace(/^#+\s*/, '') })).toBeVisible();
  return { cardId: card.id, refTitle, refCode: cardCode(ref.accountSeq) };
}

const cardPage = (page: Page) => page.getByTestId('card-page');
const editor = (page: Page) => cardPage(page).getByRole('textbox', { name: 'Text', exact: true });
const cardOf = async (page: Page, id: string) => ((await snapshot(page)).cards as any[]).find((c) => c.id === id) as { content: string; contentVersion: number };
const contentOf = async (page: Page, id: string) => (await cardOf(page, id)).content;

/** Opens the lore editor; the caret starts at the end of the text. */
async function edit(page: Page) {
  await cardPage(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor(page)).toBeFocused();
}
async function save(page: Page) {
  await page.keyboard.press('Control+Enter');
  await expect(editor(page)).toHaveCount(0);
}

test('lore cards edit in the live editor: headings by typing and toolbar, marks hidden away from the caret', async ({ page }) => {
  const { cardId } = await seed(page);
  await edit(page);
  await expect(editor(page)).toHaveAttribute('aria-multiline', 'true');
  await expect(cardPage(page).locator('textarea')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await page.keyboard.type('## Fog pass');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  await cardPage(page).getByRole('button', { name: 'Heading', exact: true }).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Third');
  await page.keyboard.press('Control+Alt+3');
  await expect(editor(page)).toBeFocused();

  // Caret on the title: no heading shows its marks, each line has its heading style.
  await page.keyboard.press('Control+Home');
  await expect(editor(page)).not.toContainText('#');
  await expect(editor(page).locator('.cm-line.lore-h2')).toHaveCount(2);
  await expect(editor(page).locator('.cm-line.lore-h3')).toHaveText('Third');
  await expect(editor(page).locator('.cm-line.lore-title')).toHaveText('Valley lore');
  // Caret inside a heading: that one shows `## `, the others stay hidden.
  await page.keyboard.press('ArrowDown');
  await expect(editor(page).locator('.cm-line').nth(1)).toHaveText('## Fog pass');
  await expect(editor(page).locator('.cm-line').nth(2)).toHaveText('Second');

  // Heading actions do nothing on line 1, the title.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Alt+2');
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore\n## Fog pass\n## Second\n### Third');
});

test('bold and italic by shortcut and toolbar, links, lists and quotes', async ({ page }) => {
  const { cardId } = await seed(page);
  await edit(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('a ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('End');
  await page.keyboard.type(' and ');
  await page.keyboard.press('Control+i');
  await page.keyboard.type('soft');
  await page.keyboard.press('End');
  // Select "plain" and make it bold from the toolbar.
  await page.keyboard.type(' plain');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await cardPage(page).getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('docs');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await cardPage(page).getByRole('button', { name: 'Link', exact: true }).click();
  await page.keyboard.type('https://example.com');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('item');
  await cardPage(page).getByRole('button', { name: 'List', exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); // continues the list
  await page.keyboard.type('quoted');
  await cardPage(page).getByRole('button', { name: 'List', exact: true }).click();
  await cardPage(page).getByRole('button', { name: 'Quote', exact: true }).click();

  // Bold and italic text is styled, its marks hidden while the caret is elsewhere.
  await page.keyboard.press('Control+Home');
  await expect(editor(page).locator('.lore-bold').first()).toHaveText('bold');
  await expect(editor(page).locator('.lore-italic')).toHaveText('soft');
  await expect(editor(page).locator('.cm-line').nth(1)).toHaveText('a bold and soft plain');
  await expect(editor(page).locator('.lore-bullet')).toHaveCount(1);
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore\na **bold** and *soft* **plain**\n[docs](https://example.com)\n- item\n> quoted');
});

test('checkbox widgets tick the item, swapping only [ ] and [x]', async ({ page }) => {
  const { cardId } = await seed(page, 'Valley lore\n- [ ] Paint fog\n- [x] Rig lamp');
  await edit(page);
  await page.keyboard.press('Control+Home');
  const open = editor(page).getByRole('button', { name: 'Not done: Paint fog' });
  const done = editor(page).getByRole('button', { name: 'Done: Rig lamp' });
  await expect(open).toBeVisible();
  await expect(done).toBeVisible();
  await open.click();
  await expect(editor(page).getByRole('button', { name: 'Done: Paint fog' })).toBeVisible();
  await done.click();
  await expect(editor(page).getByRole('button', { name: 'Not done: Rig lamp' })).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore\n- [x] Paint fog\n- [ ] Rig lamp');
});

test('slash menu and a task reference insert what the task editor inserts', async ({ page }) => {
  const { cardId, refTitle, refCode } = await seed(page);
  await edit(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu).toBeVisible();
  await expect(editor(page)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(editor(page)).toBeVisible(); // Esc in the menu doesn't cancel the edit
  await page.keyboard.press('Backspace');
  await page.keyboard.type('See /');
  await menu.getByRole('option', { name: 'Reference task', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Reference task', exact: true });
  await picker.getByRole('combobox').fill(refTitle);
  await expect(picker.getByRole('option').first()).toContainText(refTitle);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('x /heading 2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/check');
  await expect(menu.getByRole('option', { name: 'Checklist' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await page.keyboard.type('Paint fog');
  await save(page);
  expect(await contentOf(page, cardId)).toBe(`Valley lore\nSee $${refCode} x \n## Notes\n- [ ] Paint fog`);
});

test('Esc cancels, focus mode keeps the draft, Ctrl+Enter saves', async ({ page }) => {
  const { cardId } = await seed(page);
  await edit(page);
  await page.keyboard.type(' draft');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  expect(await contentOf(page, cardId)).toBe('Valley lore');

  await edit(page);
  await cardPage(page).getByRole('button', { name: 'Focus mode' }).click();
  const focus = page.getByRole('dialog', { name: 'Focus mode' });
  await expect(focus).toBeVisible();
  const inFocus = focus.getByRole('textbox', { name: 'Text', exact: true });
  await expect(inFocus).toBeFocused();
  await page.keyboard.type('!');
  await focus.getByRole('button', { name: 'Bold', exact: true }).click(); // the toolbar works there too
  await page.keyboard.type('b');
  await page.keyboard.press('Escape');
  await expect(focus).toBeHidden();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('?');
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore!**b**?');
});

test('Ctrl+Enter in focus mode saves the latest text and closes the editor', async ({ page }) => {
  const { cardId } = await seed(page);
  await edit(page);
  await cardPage(page).getByRole('button', { name: 'Focus mode' }).click();
  const focus = page.getByRole('dialog', { name: 'Focus mode' });
  await expect(focus.getByRole('textbox', { name: 'Text', exact: true })).toBeFocused();
  await page.keyboard.type('\nSaved from focus');
  await page.keyboard.press('Control+Enter');
  await expect(focus).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
  expect(await contentOf(page, cardId)).toBe('Valley lore\nSaved from focus');
});

test('typing an HTML tag adds no closing tag', async ({ page }) => {
  const { cardId } = await seed(page);
  await edit(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('<div>');
  await page.keyboard.press('Enter');
  await page.keyboard.type('<span>x');
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore\n<div>\n<span>x');
});

test('opening and saving without edits keeps the text byte for byte', async ({ page }) => {
  const text = [
    '# Valley lore',
    '',
    '## Fog pass',
    'Volumetric fog, see #design and @ada, **bold**, _soft_ and `code`.',
    '',
    '- [x] Height falloff',
    '- plain item',
    '* star item',
    '1. numbered',
    '',
    '> quoted **mark**',
    '',
    '```',
    '## not a heading',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '<b>html</b>   ',
    '\ttabbed',
    '',
  ].join('\n');
  const { cardId } = await seed(page, text);
  const before = await cardOf(page, cardId);
  await edit(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await save(page);
  const after = await cardOf(page, cardId);
  expect(after.content).toBe(text);
  expect(after.contentVersion).toBe(before.contentVersion);
});

test('CRLF lore keeps CRLF: no edits, and edits at line ends, Enter and Backspace', async ({ page }) => {
  const text = 'Valley lore\r\n## Fog pass\r\n- [ ] Paint fog\r\nlast line\r\n';
  const { cardId } = await seed(page, text);
  expect(await contentOf(page, cardId)).toBe(text);
  const before = await cardOf(page, cardId);

  await edit(page);
  await expect(cardPage(page).locator('.cm-specialChar')).toHaveCount(0);
  await expect(editor(page)).not.toContainText('␍');
  await save(page);
  const unchanged = await cardOf(page, cardId);
  expect(unchanged.content).toBe(text);
  expect(unchanged.contentVersion).toBe(before.contentVersion);

  await edit(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.type('X'); // at a line end: before the break
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('new');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace'); // joins "last line" onto the item line
  await expect(cardPage(page).locator('.cm-specialChar')).toHaveCount(0);
  await save(page);
  const edited = await contentOf(page, cardId);
  expect(edited).toBe('Valley loreX\r\n## Fog pass\r\nnew\r\n- [ ] Paint foglast line\r\n');
  expect(edited).not.toMatch(/\r(?!\n)|(?<!\r)\n/);
});

test('new card panel: Lore switches to the live editor and keeps the text', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  const area = panel.getByLabel('Task text');
  await expect(area).toBeFocused();
  await page.keyboard.type('Rain notes\nwet');
  await panel.getByLabel('Lore').check();
  const lore = panel.getByRole('textbox', { name: 'Text', exact: true });
  await expect(lore).toBeVisible();
  await expect(lore.locator('.cm-line')).toHaveText(['Rain notes', 'wet']);
  await lore.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  // Esc without a menu or focus mode is left to the panel; the menu takes it first.
  await page.keyboard.type(' /');
  await expect(panel.getByRole('listbox', { name: 'Insert' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await panel.getByLabel('Lore').uncheck();
  await expect(area).toHaveValue('Rain notes\nwet!');
  await panel.getByLabel('Lore').check();
  await expect(lore.locator('.cm-line')).toHaveText(['Rain notes', 'wet!']);
  // Esc with a selection closes the panel, as in the textarea.
  await lore.click();
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('"Create another" starts the next card fresh: Ctrl+Z does not bring back the previous text', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Lore').check();
  const lore = panel.getByRole('textbox', { name: 'Text', exact: true });
  await expect(lore).toBeVisible();
  await panel.getByLabel('Create another').check();
  const first = unique('First lore');
  await lore.click();
  await page.keyboard.type(first);
  // Past the history's grouping delay (500 ms), so a reset kept in the history would be its own undo step.
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/^Added /)).toBeVisible();
  // Empty again: only the placeholder shows.
  await expect(lore.locator('.cm-placeholder')).toBeVisible();
  await expect(lore).not.toContainText(first);
  await lore.click();
  await page.keyboard.press('Control+z');
  await expect(lore.locator('.cm-placeholder')).toBeVisible();
  await expect(lore).not.toContainText(first);
  const second = unique('Second lore');
  await page.keyboard.type(second);
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => ((await snapshot(page)).cards as any[]).some((c) => c.content === second)).toBe(true);
  const contents = ((await snapshot(page)).cards as any[]).map((c) => c.content as string);
  expect(contents).toContain(first);
  expect(contents.filter((c) => c.includes(first))).toEqual([first]);
});

test('Enter only touches its own line, a pasted URL stays a URL, the label focuses the editor', async ({ page }) => {
  const { cardId } = await seed(page, 'Valley lore\n1. one\n2. two\n3. three\n- bullet');
  await edit(page);
  await page.keyboard.press('Tab');
  await expect(editor(page)).not.toBeFocused();
  await cardPage(page).locator('.lore-editor .field > span').click();
  await expect(editor(page)).toBeFocused();

  // Continuing a numbered list would renumber the items below: a plain newline instead.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  // Bullets still continue.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await editor(page).evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://example.com');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await save(page);
  expect(await contentOf(page, cardId)).toBe('Valley lore\n1. one\nx\n2. two\n3. three\n- bullet\n- https://example.com');
});

test('when the lore editor cannot load, the plain editor takes over and the next edit tries again', async ({ page }) => {
  const { cardId } = await seed(page);
  await page.route('**/assets/LoreEditor-*.js', (route) => route.abort());
  await cardPage(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(cardPage(page).getByText("The lore editor couldn't load; you're using the plain editor.")).toBeVisible();
  const area = cardPage(page).getByRole('textbox', { name: 'Text', exact: true });
  await expect(area).toHaveValue('Valley lore');
  await area.press('Control+End');
  await page.keyboard.type('\nStill **saved**');
  await page.keyboard.press('Control+Enter');
  await expect(area).toHaveCount(0);
  expect(await contentOf(page, cardId)).toBe('Valley lore\nStill **saved**');

  await page.unroute('**/assets/LoreEditor-*.js');
  await edit(page);
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Escape');
});

test('screenshots of the lore editor', async ({ page }) => {
  const { cardId, refCode } = await seed(page);
  const content = [
    'Valley lore',
    '## The fog',
    `Every dawn the **fog** rolls in from the *northern* pass. See $${refCode} and #design.`,
    '',
    '- Lantern keepers walk the ridge',
    '- [x] Map the old road',
    '- [ ] Name the river',
    '',
    '> Nobody crosses before the bell.',
    '',
    '### Notes',
    'Ask @ada about the `fog_density` value.',
  ].join('\n');
  await run(page, 'cards', 'update', { id: cardId, content, contentVersion: (await cardOf(page, cardId)).contentVersion });
  await expect(cardPage(page).getByRole('heading', { name: 'The fog' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await edit(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Home');
  await expect(editor(page)).not.toContainText('##');
  await cardPage(page).screenshot({ path: `${SHOTS}/lore-editor.png` });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(editor(page).locator('.cm-line').nth(1)).toHaveText('## The fog');
  await cardPage(page).screenshot({ path: `${SHOTS}/lore-editor-caret.png` });
  await page.keyboard.press('Escape');
});
