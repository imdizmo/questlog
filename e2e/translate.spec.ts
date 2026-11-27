import { test, expect, type Browser, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, run, snapshot, unique } from './helpers';

// The e2e server runs with the fake language pack (tests/fixtures/translate-pack): it prefixes "[it] " / "[en] ".

const EN_TITLE = 'Fix the lantern';
const EN = `${EN_TITLE}\n\nThe lantern in the harbour does not light up when the player walks by.`;
const COMMENT = 'The wick is too short for the glass';

const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: /^Workspace:/ }).click();
  await page.getByRole('menu', { name: 'Workspaces' }).getByRole('menuitem', { name: 'Workspace settings, people, look…' }).click();
  return page.getByRole('dialog', { name: 'Workspace menu' });
};

/** A member of the workspace, signed in, on /decks. */
async function member(page: Page, browser: Browser) {
  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [] });
  const b = await newPerson(browser);
  const name = unique('Sifio');
  const res = await b.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  return b;
}

test.afterAll(async ({ browser }) => {
  // Later specs run on the same server: translation goes back off (as new workspaces have it).
  const page = await newPerson(browser);
  await ensureWorkspace(page);
  await run(page, 'accounts', 'update', { settings: { translationEnabled: false } });
  await page.context().close();
});

test('reading a task, its comments and search in your own language', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Harbour') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Lights', projectId: project.id });

  // The owner switches Translation on (the language pack is there).
  const menu = await openMenu(page);
  await menu.getByRole('tab', { name: 'Features' }).click();
  const sw = menu.getByRole('switch', { name: 'Translation' });
  await expect(sw).toBeEnabled();
  await sw.click(); // saved at once; the switch follows the stored setting
  await expect(sw).toBeChecked();
  await page.keyboard.press('Escape');

  // The member's first page load after that asks once which language to read in.
  const b = await member(page, browser);
  await b.goto('/decks');
  const ask = b.getByRole('dialog', { name: 'Read in your language?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Italiano' }).click();
  await expect(ask).toBeHidden();
  await b.reload();
  // The shell (it waits for the person's preferences) is up: the question would be showing by now.
  await expect(b.getByRole('button', { name: /^Workspace:/ })).toBeVisible();
  await b.waitForTimeout(300);
  await expect(b.getByRole('dialog', { name: 'Read in your language?' })).toHaveCount(0);

  // The owner writes an English task and an English comment.
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: EN });
  await run(page, 'resolvables', 'create', { cardId: card.id, context: 'comment', content: COMMENT });
  const seq = (await snapshot(page)).cards.find((c: any) => c.id === card.id).seq as number;

  // The member reads it in Italian, with the line saying where it came from.
  await b.goto(`/card/${cardCode(seq)}`);
  const heading = b.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(`[it] ${EN_TITLE}`, { timeout: 20_000 });
  await expect(b.getByTestId('card-markdown')).toContainText('[it] The lantern in the harbour');
  const line = b.getByTestId('card-page').getByTestId('translated-line').first();
  await expect(line).toHaveText('Translated from English · Show original');
  await b.getByRole('tab', { name: /Conversations/ }).click();
  const entry = b.getByTestId('entry').first();
  await expect(entry.locator('.entry-text')).toHaveText(`[it] ${COMMENT}`, { timeout: 20_000 });
  await expect(entry.getByTestId('translated-line')).toHaveText('Translated from English · Show original');

  // Show original shows the English text; the toggle brings the translation back.
  await line.getByRole('button', { name: 'Show original' }).click();
  await expect(heading).toHaveText(EN_TITLE);
  await expect(line).toHaveText('Show translation');
  await line.getByRole('button', { name: 'Show translation' }).click();
  await expect(heading).toHaveText(`[it] ${EN_TITLE}`);

  // Editing edits the English original, with the Italian beside it to read.
  await b.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(b.getByLabel('Task text')).toHaveValue(EN);
  const ref = b.getByRole('complementary', { name: 'Translation' });
  await expect(ref).toContainText(`[it] ${EN_TITLE}`);
  // Beside the editor on a wide screen, below it on a narrow one.
  await b.setViewportSize({ width: 1400, height: 900 });
  let ed = (await b.getByLabel('Task text').boundingBox())!, rb = (await ref.boundingBox())!;
  expect(rb.x).toBeGreaterThan(ed.x + ed.width - 1);
  await b.setViewportSize({ width: 600, height: 900 });
  ed = (await b.getByLabel('Task text').boundingBox())!; rb = (await ref.boundingBox())!;
  expect(rb.y).toBeGreaterThan(ed.y + ed.height - 1);
  await b.setViewportSize({ width: 1280, height: 720 });
  await b.getByRole('button', { name: 'Cancel' }).click();
  await expect(heading).toHaveText(`[it] ${EN_TITLE}`);

  // Lists show the translated title; search finds the task by it.
  const box = b.getByRole('combobox', { name: 'Search tasks' });
  await box.fill(`[it] ${EN_TITLE}`);
  await expect(b.getByRole('group', { name: 'Tasks' }).getByRole('option', { name: new RegExp(`\\[it\\] ${EN_TITLE}`) })).toBeVisible();
  await box.fill('');
  await b.keyboard.press('Escape');

  // Switching to "As written" (no reload) shows the English text at once.
  const bm = await openMenu(b);
  await bm.getByRole('tab', { name: 'Preferences' }).click();
  await bm.getByRole('tab', { name: 'Sign-in' }).click();
  await bm.getByLabel('Reading language').selectOption({ label: 'As written' });
  await b.keyboard.press('Escape');
  await expect(bm).toBeHidden();
  await expect(heading).toHaveText(EN_TITLE);
  await expect(b.getByTestId('translated-line')).toHaveCount(0);
  await b.context().close();
  // Off again, so the owner's next page load doesn't ask the reading-language question.
  await run(page, 'accounts', 'update', { settings: { translationEnabled: false } });
});

test('a project glossary keeps words as written or sets their translation', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Glossary');
  await run(page, 'projects', 'create', { name });
  await page.goto('/decks');
  await page.getByRole('region', { name }).getByRole('button', { name: 'Project settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await expect(settings.getByText('Words here are kept as written, or always translated the way you set.')).toBeVisible();
  await settings.getByRole('button', { name: 'Edit glossary' }).click();

  const dlg = page.getByRole('dialog', { name: 'Translation glossary' });
  await dlg.getByRole('button', { name: 'Add word' }).click();
  await dlg.getByLabel('Word 1', { exact: true }).fill('polena');
  await dlg.getByRole('button', { name: 'Add word' }).click();
  await dlg.getByLabel('Word 2', { exact: true }).fill('Lanterna');
  await dlg.getByLabel('Lanterna in English').fill('Beacon');
  await dlg.getByRole('button', { name: 'Add word' }).click();
  await dlg.getByLabel('Word 3', { exact: true }).fill('POLENA');
  await dlg.getByRole('button', { name: 'Save glossary' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('"POLENA" is in the list twice.');
  await dlg.getByRole('button', { name: 'Remove POLENA', exact: true }).click();
  await dlg.getByRole('button', { name: 'Save glossary' }).click();
  await expect(dlg).toBeHidden();

  const glossary = settings.getByLabel('Glossary words');
  await expect(glossary).toContainText('polena');
  await expect(glossary).toContainText('Lanterna');
  const stored = (await snapshot(page)).projects.find((p: any) => p.name === name).glossary;
  expect(stored).toEqual([{ term: 'polena' }, { term: 'Lanterna', en: 'Beacon' }]);
});

test('a tab opened before its translation lands is relabelled when it does, and on a language switch', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Tabs') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Docks', projectId: project.id });
  const title = unique('Paint the boat');
  // Translation is off: nothing is translated while the member opens the task.
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: `${title}\n\nThe boat in the harbour needs a new coat of paint.` });
  const seq = (await snapshot(page)).cards.find((c: any) => c.id === card.id).seq as number;

  const b = await member(page, browser);
  // Reads Italian already (answered before), so no question pops up.
  for (const [key, value] of [['readLang', 'it'], ['translatePrompted', true]] as const) {
    expect((await b.request.put(`/api/prefs/${key}`, { data: { value } })).ok()).toBeTruthy();
  }
  await b.goto(`/card/${cardCode(seq)}`);
  const tab = b.getByRole('tablist', { name: 'Open pages' }).getByRole('tab', { selected: true });
  await expect(b.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(tab).toContainText(title);
  await expect(tab).not.toContainText('[it]');

  try {
    // Switched on: the background pass translates the task; its tab, open all along, follows without a reload.
    await run(page, 'accounts', 'update', { settings: { translationEnabled: true } });
    await expect(tab).toContainText(`[it] ${title}`, { timeout: 20_000 });
    await expect(b.getByRole('heading', { level: 1 })).toHaveText(`[it] ${title}`);

    // Another reading language relabels it at once.
    const bm = await openMenu(b);
    await bm.getByRole('tab', { name: 'Preferences' }).click();
    await bm.getByRole('tab', { name: 'Sign-in' }).click();
    await bm.getByLabel('Reading language').selectOption({ label: 'As written' });
    await b.keyboard.press('Escape');
    await expect(tab).not.toContainText('[it]');
    await expect(tab).toContainText(title);
  } finally {
    await run(page, 'accounts', 'update', { settings: { translationEnabled: false } });
    await b.context().close();
  }
});

test("a Lore entry's text fields, lines and table cells are read in your language", async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Lore') });
  const type = await run<{ id: string }>(page, 'wiki', 'createType', { projectId: project.id, name: unique('Creature'), fields: [
    { key: 'desc', label: 'Description', kind: 'longtext' },
  ] });
  await run(page, 'wiki', 'setPage', { typeId: type.id, page: { guided: false, blocks: [
    { id: 'f', kind: 'facts', title: 'Facts', width: 'half' },
    { id: 'a', kind: 'table', title: 'Attacks', width: 'full', cols: ['Attack', 'Damage'] },
    { id: 'b', kind: 'lines', title: 'Barks', width: 'full' }] } });
  const entry = await run<{ id: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId: type.id, name: unique('Sea wolf') });
  await run(page, 'wiki', 'setEntry', { cardId: entry.id, fields: { desc: 'A grey wolf that swims between the islands.' } });
  await run(page, 'wiki', 'setBlock', { cardId: entry.id, blockId: 'a', data: { rows: [['Bite from below', '8']] } });
  await run(page, 'wiki', 'setBlock', { cardId: entry.id, blockId: 'b', data: { items: ['The tide is coming for you'] } });
  const seq = (await snapshot(page)).cards.find((c: any) => c.id === entry.id).seq as number;

  const b = await member(page, browser);
  for (const [key, value] of [['readLang', 'it'], ['translatePrompted', true]] as const) {
    expect((await b.request.put(`/api/prefs/${key}`, { data: { value } })).ok()).toBeTruthy();
  }
  try {
    await run(page, 'accounts', 'update', { settings: { translationEnabled: true } });
    await b.goto(`/card/${cardCode(seq)}`);
    await b.getByRole('link', { name: 'Open in Wiki' }).click();
    await expect(b.getByTestId('infobox')).toContainText('[it] A grey wolf that swims between the islands.', { timeout: 20_000 });
    await expect(b.getByRole('region', { name: 'Attacks' }).getByRole('cell').first()).toHaveText('[it] Bite from below');
    await expect(b.getByRole('region', { name: 'Attacks' }).getByRole('cell').nth(1)).toHaveText('8');
    await expect(b.getByRole('region', { name: 'Barks' }).getByRole('listitem')).toHaveText('[it] The tide is coming for you');
  } finally {
    await run(page, 'accounts', 'update', { settings: { translationEnabled: false } });
    await b.context().close();
  }
});
