import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, OWNER, run, snapshot, unique, SHOTS } from './helpers';

const entryPage = (page: Page) => page.getByTestId('entry-page');
const reader = (page: Page) => entryPage(page).getByTestId('card-markdown');
const editor = (page: Page) => entryPage(page).getByRole('textbox', { name: 'Text', exact: true });

/** A campaign (project) with its wiki; returns its id and seq. */
async function campaign(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Ember Coast') });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  return { projectId: project.id, seq };
}

/** A wiki page (no type) with `body` under its title. */
async function page_(page: Page, projectId: string, name: string, body = '') {
  const { id, key } = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId, typeId: null, name });
  if (body) {
    const card = (await snapshot(page)).cards.find((c: any) => c.id === id);
    await run(page, 'cards', 'update', { id, content: `# ${name}\n\n${body}`, contentVersion: card.contentVersion });
  }
  return { id, key };
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/decks$/);
}

test('names become links by themselves: reading, aliases, Mentioned in, the editor, Not a link here', async ({ page }) => {
  const { projectId, seq } = await campaign(page);
  const chronicle = await page_(page, projectId, 'Chronicle', 'The riders reached Ashen Keep at dusk. By dawn the Keep had fallen, and `Ashen Keep` was only a word.');
  // Wide enough for the entry and one side panel next to it (narrower, the entry folds to a strip).
  await page.setViewportSize({ width: 1600, height: 900 });

  await page.goto(`/wiki/${seq}/${chronicle.key}`);
  await expect(reader(page)).toContainText('The riders reached Ashen Keep');
  await expect(reader(page).locator('a.entry-link')).toHaveCount(0);

  // A new entry links the old text at once, nothing edited; never inside code.
  const keep = await page_(page, projectId, 'Ashen Keep', 'A fort on the cliffs.');
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Ashen Keep']);
  await expect(reader(page).locator('a.entry-link')).toHaveAttribute('href', `/wiki/${seq}/${keep.key}`);
  await expect(reader(page).locator('code')).toHaveText('Ashen Keep');

  // Aliases on the entry page: a too-short one gets the server's plain reason, "the Keep" is kept.
  await page.goto(`/wiki/${seq}/${keep.key}`);
  const aliases = entryPage(page).getByTestId('aliases');
  await aliases.getByLabel('New alias').fill('Ox');
  await aliases.getByRole('button', { name: 'Add' }).click();
  await expect(aliases.getByRole('alert')).toHaveText(/at least 3 characters: "Ox" is too short/);
  await aliases.getByLabel('New alias').fill('the Keep');
  await aliases.getByRole('button', { name: 'Add' }).click();
  await expect(aliases.locator('.alias-chip')).toHaveText(['the Keep×']);
  await expect(aliases.getByRole('alert')).toHaveCount(0);
  // Its own page never links its own names; What links here lists the text that names it.
  await expect(reader(page).locator('a.entry-link')).toHaveCount(0);
  const backlinks = entryPage(page).getByRole('region', { name: 'What links here' });
  await expect(backlinks.getByTestId('backlink-group').filter({ hasText: 'Mentioned in' }).getByRole('link')).toHaveText(['Chronicle']);

  // In the wiki a link opens the entry in a panel beside the page (e2e/panels.spec.ts has the rest).
  await backlinks.getByRole('link', { name: 'Chronicle' }).click();
  await expect(page.getByTestId('wiki-panel').locator('.wiki-panel-title')).toHaveText(['Chronicle']);
  // Back on the chronicle: both the name and the alias are links; a click opens the entry beside it.
  await page.goto(`/wiki/${seq}/${chronicle.key}`);
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Ashen Keep', 'the Keep']);
  await page.screenshot({ path: `${SHOTS}/autolink-reading.png` });
  await reader(page).getByRole('link', { name: 'the Keep' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${chronicle.key}\\?panels=${keep.key}$`));
  await page.goBack();
  await expect(page.getByTestId('wiki-panel')).toHaveCount(0);

  // Writing: a name typed in the lore editor is marked while typing.
  await page_(page, projectId, 'Emberfall');
  await entryPage(page).getByRole('button', { name: /Edit text/ }).click();
  await expect(editor(page)).toBeFocused();
  await expect(page.locator('.foot-hint')).toHaveText('Ctrl+Enter saves · Esc cancels · Alt+Enter on a name');
  await page.keyboard.type(' Riders came from Emberfall.');
  const marks = editor(page).locator('.lore-name');
  await expect(marks).toHaveText(['Ashen Keep', 'the Keep', 'Emberfall']);

  // Ctrl/⌘-click opens the entry: in the wiki as a panel beside it (the editor stays open, so the draft stays).
  await marks.filter({ hasText: 'Emberfall' }).click({ modifiers: ['ControlOrMeta'] });
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${chronicle.key}\\?panels=emberfall$`));
  await expect(page.getByTestId('wiki-panel').locator('.wiki-panel-title')).toHaveText(['Emberfall']);
  await expect(editor(page)).toContainText('Riders came from Emberfall.');
  await page.getByRole('button', { name: 'Close Emberfall' }).click();

  // Hovering a name shows its popover; "Not a link here" turns it off in this text only, and Undo brings it back.
  await marks.filter({ hasText: 'Emberfall' }).hover();
  const pop = page.getByTestId('name-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Emberfall');
  await page.screenshot({ path: `${SHOTS}/autolink-popover.png` });
  await pop.getByRole('button', { name: 'Not a link here' }).click();
  await expect(marks).toHaveText(['Ashen Keep', 'the Keep']);
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === chronicle.id).linkIgnores).toEqual(['Emberfall']);
  const toast = page.locator('.toast').filter({ hasText: '"Emberfall" is no longer a link in this text.' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(marks).toHaveText(['Ashen Keep', 'the Keep', 'Emberfall']);
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === chronicle.id).linkIgnores).toEqual([]);

  // From the keyboard: Alt+Enter on a name opens the popover with focus on Open; Esc goes back to the text.
  await page.mouse.move(0, 0);
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Alt+Enter');
  await expect(pop.getByRole('button', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pop.getByRole('button', { name: 'Not a link here' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(marks).toHaveText(['Ashen Keep', 'the Keep']);
  await expect(editor(page)).toBeFocused();

  // Saved text is exactly what was typed (links are never written into it); the ignore shows under the text.
  await page.keyboard.press('Control+Enter');
  await expect(editor(page)).toHaveCount(0);
  const saved = (await snapshot(page)).cards.find((c: any) => c.id === chronicle.id);
  expect(saved.content).toBe('# Chronicle\n\nThe riders reached Ashen Keep at dusk. By dawn the Keep had fallen, and `Ashen Keep` was only a word. Riders came from Emberfall.');
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Ashen Keep', 'the Keep']);
  const ignores = entryPage(page).getByTestId('link-ignores');
  await expect(ignores).toContainText('Emberfall');
  await ignores.getByRole('button', { name: 'Link "Emberfall" again' }).click();
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Ashen Keep', 'the Keep', 'Emberfall']);
  await expect(ignores).toHaveCount(0);

  // An explicit link with its own text: [shown text]($code).
  const code = (await snapshot(page)).cards.find((c: any) => c.id === keep.id);
  const latest = (await snapshot(page)).cards.find((c: any) => c.id === chronicle.id);
  await run(page, 'cards', 'update', { id: chronicle.id, content: `${latest.content}\n\nSee [the old fort]($${cardCode(code.seq)}).`, contentVersion: latest.contentVersion });
  await expect(reader(page).getByRole('link', { name: 'the old fort' })).toHaveAttribute('href', `/wiki/${seq}/${keep.key}`);

  // Aliases: a name it already has is refused here; another entry's name is kept, with a warning on both sides.
  await page.goto(`/wiki/${seq}/${keep.key}`);
  await aliases.getByLabel('New alias').fill('ashen  keep');
  await aliases.getByRole('button', { name: 'Add' }).click();
  await expect(aliases.getByRole('alert')).toHaveText('Already a name of this entry.');
  await aliases.getByLabel('New alias').fill('Emberfall');
  await aliases.getByRole('button', { name: 'Add' }).click();
  await expect(aliases.getByTestId('alias-shared')).toHaveText('"Emberfall" is also the name of Emberfall: neither will link until one changes.');
  await aliases.getByRole('button', { name: 'Remove alias Emberfall' }).click();
  await expect(aliases.getByTestId('alias-shared')).toHaveCount(0);
  await expect(aliases.locator('.alias-chip')).toHaveText(['the Keep×']);
});

test('tasks: names link when reading, with a menu to turn one off; the task preview agrees', async ({ page }) => {
  const { projectId, seq } = await campaign(page);
  const keep = await page_(page, projectId, 'Ashen Keep');
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Quests', projectId });
  const task = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Scout the cliffs\nRide to Ashen Keep and back to\nAshen\nKeep again.' });
  await page.goto(`/card/${cardCode(task.accountSeq)}`);
  const text = page.getByTestId('card-markdown');
  await expect(text.locator('a.entry-link')).toHaveCount(2); // the second one is hard-wrapped over a line break
  await expect(text.locator('a.entry-link').first()).toHaveAttribute('href', `/wiki/${seq}/${keep.key}`);

  // Right-click: Open / Not a link here for this task; the toast's Undo links it again.
  await text.locator('a.entry-link').first().click({ button: 'right' });
  const menu = page.getByTestId('name-menu');
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Not a link here' }).click();
  await expect(text.locator('a.entry-link')).toHaveCount(0);
  await expect(page.getByTestId('link-ignores')).toContainText('Ashen Keep');
  await page.locator('.toast').filter({ hasText: 'no longer a link' }).getByRole('button', { name: 'Undo' }).click();
  await expect(text.locator('a.entry-link')).toHaveCount(2);
  await expect(page.getByTestId('link-ignores')).toHaveCount(0);

  // From the keyboard: Alt+Enter on the focused link opens the menu; Esc returns to the link; Open goes to the entry.
  await text.locator('a.entry-link').first().focus();
  await page.keyboard.press('Alt+Enter');
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  // Outside the wiki: Open, Open in new tab, Copy link, Not a link here (no Open beside).
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Open in new tab', 'Copy link', 'Not a link here']);
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Not a link here' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(text.locator('a.entry-link').first()).toBeFocused();
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(text.locator('a.entry-link')).toHaveCount(0);

  // The task editor's preview uses the task's own ignores; the list under the editor can link it again by keyboard.
  await page.getByTestId('card-page').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.foot-hint')).toHaveText('Ctrl+Enter saves · Esc cancels');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('md-preview')).toContainText('Ride to Ashen Keep');
  await expect(page.getByTestId('md-preview').locator('a.entry-link')).toHaveCount(0);
  const again = page.getByTestId('link-ignores').getByRole('button', { name: 'Link "Ashen Keep" again' });
  await again.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('md-preview').locator('a.entry-link')).toHaveCount(2);
  expect((await snapshot(page)).cards.find((c: any) => c.id === task.id).content).toBe('Scout the cliffs\nRide to Ashen Keep and back to\nAshen\nKeep again.');
});

test("another client's new entry relinks an open page", async ({ page, browser }) => {
  const { projectId, seq } = await campaign(page);
  const notes = await page_(page, projectId, 'Field Notes', 'Smoke rose over Cinder Vale again.');
  await page.goto(`/wiki/${seq}/${notes.key}`);
  await expect(reader(page)).toContainText('Cinder Vale');
  await expect(reader(page).locator('a.entry-link')).toHaveCount(0);

  const other = await newPerson(browser);
  await signIn(other);
  await page_(other, projectId, 'Cinder Vale');
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Cinder Vale']);
  // And an alias added over there links too.
  const vale = (await snapshot(other)).cards.find((c: any) => c.content.startsWith('# Cinder Vale'));
  await run(other, 'wiki', 'setAliases', { cardId: vale.id, aliases: ['Smoke'] });
  await expect(reader(page).locator('a.entry-link')).toHaveText(['Smoke', 'Cinder Vale']);
  await other.context().close();
});

test('timing: typing in a 20 KB lore text with 2 000 names', async ({ page }) => {
  const { projectId, seq } = await campaign(page);
  // 2 000 names: 40 entries with 49 aliases each (+ their titles).
  const names: string[] = [];
  for (let e = 0; e < 40; e++) {
    const aliases = Array.from({ length: 49 }, (_, a) => `Vale ${e}-${a}`);
    const { id } = await page_(page, projectId, `Region ${e}`);
    await run(page, 'wiki', 'setAliases', { cardId: id, aliases });
    names.push(`Region ${e}`, ...aliases);
  }
  expect(names).toHaveLength(2000);
  const words = ['the', 'road', 'to', 'river', 'north', 'of', 'a', 'hill'];
  let body = '';
  for (let i = 0; body.length < 20_000; i++) body += `${words[i % 8]} ${i % 4 === 0 ? names[(i * 37) % names.length] : words[(i + 3) % 8]}${i % 12 === 11 ? '.\n\n' : ' '}`;
  const long = await page_(page, projectId, 'Long Chronicle', body);
  await page.goto(`/wiki/${seq}/${long.key}`);
  await expect(reader(page).locator('a.entry-link').first()).toBeVisible();
  const linked = await reader(page).locator('a.entry-link').count();

  await entryPage(page).getByRole('button', { name: /Edit text/ }).click();
  await expect(editor(page)).toBeFocused();
  await expect(editor(page).locator('.lore-name').first()).toBeVisible();
  // Caret into the middle of the text, then one character at a time: input → decorations → painted frame.
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 40; i++) await page.keyboard.press('PageDown');
  const times = await page.evaluate(async () => {
    const out: number[] = [];
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    await frame();
    for (let k = 0; k < 40; k++) {
      const t0 = performance.now();
      document.execCommand('insertText', false, k % 8 === 7 ? ' ' : 'x');
      await frame();
      out.push(performance.now() - t0);
    }
    return out;
  });
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const report = `20 KB lore, 2 000 names (${linked} links when reading): per keystroke to next frame median ${median.toFixed(1)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`;
  console.log(report);
  test.info().annotations.push({ type: 'timing', description: report });
  await expect(editor(page)).toContainText('xxxxxxx');
  await expect(editor(page).locator('.lore-name').first()).toBeVisible();
  expect(median).toBeLessThan(50);
});
