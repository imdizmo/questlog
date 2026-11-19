import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

const palette = (page: Page) => page.getByRole('dialog', { name: 'Find or create' });
const input = (page: Page) => palette(page).getByRole('combobox', { name: 'Find or create' });
const options = (page: Page) => palette(page).getByRole('option');
const selected = (page: Page) => palette(page).locator('[role="option"][aria-selected="true"]');
const entryPage = (page: Page) => page.getByTestId('entry-page');
const cardCount = async (page: Page) => (await snapshot(page)).cards.length as number;

/** A campaign with a Place type (template "Keep") and a Character type, a task list, an entry and a task. */
async function campaign(page: Page) {
  await ensureWorkspace(page);
  const { id: projectId } = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Cinder Coast') });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === projectId).seq as number;
  const { id: placeId } = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Place', icon: '🏰' });
  await run(page, 'wiki', 'updateType', { id: placeId, templates: [{ name: 'Keep', fields: {}, links: [] }] });
  const { id: npcId } = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Character', icon: '🧙' });
  const { id: deckId } = await run<{ id: string }>(page, 'decks', 'create', { projectId, title: 'Quests' });
  const name = unique('Emberfall');
  const entry = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId, typeId: npcId, name });
  const task = unique('Forge the bell of');
  await run(page, 'cards', 'create', { deckId, content: task });
  const chronicle = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId, typeId: null, name: unique('Chronicle') });
  return { projectId, seq, placeId, npcId, name, entry, task, chronicle };
}

test('Ctrl+K finds a wiki entry and a task, and makes a new Place without stealing Enter', async ({ page }) => {
  const c = await campaign(page);
  await page.goto(`/wiki/${c.seq}/${c.chronicle.key}`);

  // Opens while typing in the lore editor, takes the key from the editor and the browser.
  await entryPage(page).getByRole('button', { name: /Edit text/ }).click();
  const editor = entryPage(page).getByRole('textbox', { name: 'Text', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Riders');
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(editor).toContainText('Riders');
  await expect(editor).not.toContainText('Riders k');
  // Esc closes and gives focus back to the editor, the draft untouched.
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.type(' came');
  await expect(editor).toContainText('Riders came');

  // A wiki entry: grouped, with its type and project; the first result is highlighted and Enter opens it.
  const before = await cardCount(page);
  await page.keyboard.press('Control+k');
  await input(page).fill(c.name);
  const entries = palette(page).getByRole('group', { name: 'Wiki entries' });
  await expect(entries.getByRole('option')).toHaveText([new RegExp(`🧙${c.name}Character · Cinder Coast`)]);
  await expect(selected(page)).toContainText(c.name);
  // The last row makes a new one, with the type it was given last time or the first type.
  await expect(options(page).last()).toContainText(`called “${c.name}”`);
  await page.screenshot({ path: `${SHOTS}/palette-find.png` });
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/wiki/${c.seq}/${c.entry.key}$`));
  await expect(entryPage(page).getByRole('heading', { level: 2 }).first()).toHaveText(c.name);
  expect(await cardCount(page)).toBe(before);

  // A task: ↓/↑ move the highlight, the mouse too; Enter opens the task.
  await page.keyboard.press('Control+k');
  await input(page).fill(c.task.split(' ').slice(0, 1).join(' ') + ' ' + c.task.split(' ').slice(-1)[0]); // "Forge <n>"
  const tasks = palette(page).getByRole('group', { name: 'Tasks' });
  await expect(tasks.getByRole('option')).toHaveCount(1);
  await expect(tasks.getByRole('option')).toContainText('Quests · Cinder Coast');
  await page.keyboard.press('End');
  await expect(selected(page)).toContainText('New ');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toContainText(c.task);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/decks\/\d+-quests\/card\/[0-9a-z]+-forge-the-bell-of/);
  expect(await cardCount(page)).toBe(before);

  // The recents: what was opened, newest first.
  await page.keyboard.press('Control+k');
  await expect(palette(page).getByRole('group', { name: 'Recent' }).getByRole('option').first()).toContainText(c.task);
  await page.keyboard.press('Escape');

  // A new name: nothing is highlighted, so Enter does nothing; the type is guessed from the Place template "Keep".
  await page.goto(`/wiki/${c.seq}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Wiki · Cinder Coast/ })).toBeVisible();
  const keep = unique('Ashen Keep');
  await page.keyboard.press('Control+k');
  await input(page).fill(keep);
  await expect(options(page)).toHaveCount(1);
  const row = options(page).last();
  await expect(row).toContainText(`New Place called “${keep}”`);
  await expect(row).toContainText(/in Cinder Coast/);
  await expect(selected(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  expect(await cardCount(page)).toBe(before);
  // Tab turns the type (Place → Character → page → task → Place), Shift+Tab back.
  await page.keyboard.press('Tab');
  await expect(row).toContainText(`New Character called “${keep}”`);
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row).toContainText(`New page called “${keep}”`);
  await page.keyboard.press('Tab');
  await expect(row).toContainText(`New task called “${keep}”`);
  await expect(row).toContainText('in Quests · Cinder Coast');
  await page.keyboard.press('Tab');
  await expect(row).toContainText(`New Place called “${keep}”`);
  await page.keyboard.press('Shift+Tab');
  await expect(row).toContainText(`New task called “${keep}”`);
  await page.keyboard.press('Tab');
  // ↓ selects the New row (the hint goes, the footer says create).
  const hint = palette(page).locator('.pal-empty');
  await expect(hint).toHaveText('Nothing found. ↓ then Enter makes it.');
  await expect(input(page)).toHaveAttribute('aria-describedby', (await hint.getAttribute('id'))!);
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toContainText(`New Place called “${keep}”`);
  await expect(hint).toBeHidden();
  await expect(palette(page).locator('.pal-foot')).toContainText('Enter create');
  // A failed create keeps the palette open and says why under the New row; typing clears it.
  await page.route('**/dispatch/wiki/createEntry', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) }), { times: 1 });
  await page.keyboard.press('Enter');
  await expect(palette(page).getByRole('alert')).toHaveText("You don't have permission to do that.");
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  expect(await cardCount(page)).toBe(before);
  await page.keyboard.type('x');
  await expect(palette(page).getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Backspace');
  // Enter makes the entry and opens it.
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toContainText(`New Place called “${keep}”`);
  await page.screenshot({ path: `${SHOTS}/palette-create.png` });
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(entryPage(page).getByRole('heading', { level: 2 }).first()).toHaveText(keep);
  const made = (await snapshot(page)).cards.filter((x: any) => x.content.startsWith(`# ${keep}`));
  expect(made).toHaveLength(1);
  expect(made[0].entryTypeId).toBe(c.placeId);
  await expect(page).toHaveURL(new RegExp(`/wiki/${c.seq}/${made[0].entryKey}$`));

  // The type made last is the next guess when the words say nothing; a task goes to the list.
  const gate = unique('Mend the gate');
  await page.keyboard.press('Control+k');
  await input(page).fill(gate);
  await expect(options(page).last()).toContainText(`New Place called “${gate}”`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('End');
  await expect(selected(page)).toContainText(`New task called “${gate}”`);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/decks\/\d+-quests\/card\/[0-9a-z]+-mend-the-gate/);
  const task = (await snapshot(page)).cards.find((x: any) => x.content === gate);
  expect(task.isDoc).toBe(false);

  // Ctrl+K again closes; the shortcut list has it.
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Ctrl+KFind or create anything');
});
