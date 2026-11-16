import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, SHOTS, unique } from './helpers';

/** Signs in as the owner (setting up the workspace if needed) and creates a project with a mixed deck "Prototype" and a doc deck "Lore". Returns the deck page path. */
async function seed(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Foundry') });
  await run(page, 'projects', 'update', {
    id: project.id,
    spaces: [{ id: 2, name: 'Knowledge', icon: null, defaultDeckType: 'doc' }, { id: 1, name: null, icon: null, defaultDeckType: 'mixed' }],
  });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Prototype', projectId: project.id, spaceId: 1 });
  await run(page, 'decks', 'create', { title: 'Lore', projectId: project.id, spaceId: 2 });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  const deckPath = `/decks/${seq}-prototype`;
  await page.goto(deckPath);
  await expect(page.getByRole('heading', { level: 1, name: 'Prototype' })).toBeVisible();
  return { deckId: deck.id, deckPath };
}

/** Adds a card through the Add card panel; ends on the new card. */
async function addCard(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Task text').fill(text);
  await panel.getByLabel('Task text').press('Control+Enter');
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/card\/[0-9a-z]+-/);
}

const tile = (page: Page, title: string) => page.getByTestId('card-tile').filter({ hasText: title });
const badge = (page: Page) => page.getByTestId('card-page').getByTestId('card-status');
const btn = (page: Page, name: string) => page.getByTestId('card-page').getByRole('button', { name, exact: true });

test('workflow', async ({ page }) => {
  await seed(page);
  await addCard(page, 'Fog shader\nVolumetric fog for the valley.');
  await expect(page.getByTestId('card-page').getByRole('heading', { name: 'Fog shader' })).toBeVisible();
  await expect(badge(page)).toHaveText('Unassigned');

  await btn(page, 'Start').click();
  await expect(badge(page)).toHaveText('Started');
  await expect(tile(page, 'Fog shader').getByTestId('owner')).toHaveText('A');

  await btn(page, 'Block').click();
  const composer = page.getByRole('dialog', { name: 'Block this task' });
  await expect(composer.getByRole('button', { name: 'Send' })).toBeEnabled();  // a block needs no reason
  await composer.getByLabel('Reason (optional)').fill('waiting on art');
  await composer.getByRole('button', { name: 'Send' }).click();
  await expect(composer).toBeHidden();
  await expect(badge(page)).toHaveText('Blocked');
  await expect(btn(page, 'Start')).toBeDisabled();
  const thread = page.getByTestId('thread');
  await expect(thread).toContainText('waiting on art');
  await expect(thread).toContainText('Ada Owner');
  await page.screenshot({ path: `${SHOTS}/card-page-blocked.png`, fullPage: true });

  await thread.getByRole('button', { name: 'Unblock' }).click();
  await expect(badge(page)).toHaveText('Assigned');

  await btn(page, 'Review').click();
  const review = page.getByRole('dialog', { name: 'Ask for review' });
  await review.getByLabel('Message').fill('Look at the density');
  await review.getByRole('button', { name: 'Send' }).click();
  await expect(badge(page)).toHaveText('In review');
  await expect(btn(page, 'Mark as done')).toBeDisabled();

  await page.getByTestId('thread').getByRole('button', { name: 'Close review and mark as done' }).click();
  await expect(badge(page)).toHaveText('Done');
  await btn(page, 'Reopen').click();
  await expect(badge(page)).toHaveText('Assigned');
});

test('archive and delete', async ({ page }) => {
  const { deckId, deckPath } = await seed(page);
  await run(page, 'cards', 'create', { deckId, content: 'Old idea' });
  const scratch = await run<{ accountSeq: number }>(page, 'cards', 'create', { deckId, content: 'Scratch' });

  await tile(page, 'Old idea').getByRole('link').click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(tile(page, 'Old idea')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0); // no confirmation
  await page.getByRole('button', { name: 'More list options' }).click();
  await page.getByLabel('Include archived tasks').check();
  await expect(tile(page, 'Old idea')).toBeVisible();

  await tile(page, 'Scratch').getByRole('link').click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete task?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused(); // destructive: starts on Cancel
  await confirm.getByRole('button', { name: 'Delete task' }).click();
  await expect(confirm).toBeHidden();
  await expect(tile(page, 'Scratch')).toHaveCount(0);

  await page.goto(`/card/${cardCode(scratch.accountSeq)}`);
  await expect(page.getByText('This task is deleted.')).toBeVisible();
  await expect(btn(page, 'Start')).toHaveCount(0);
  await btn(page, 'Restore').click();
  await expect(page.getByText('This task is deleted.')).toHaveCount(0);
  await page.goto(deckPath);
  await expect(tile(page, 'Scratch')).toBeVisible();
});

test('switching cards while editing never carries the draft over', async ({ page }) => {
  const { deckId } = await seed(page);
  await run(page, 'cards', 'create', { deckId, content: 'Alpha' });
  await run(page, 'cards', 'create', { deckId, content: 'Beta' });
  await tile(page, 'Alpha').getByRole('link').click();
  await btn(page, 'Edit').click();
  const editor = page.getByTestId('card-page').getByLabel('Task text');
  await editor.fill('Alpha draft that must stay on Alpha');

  await tile(page, 'Beta').getByRole('link').click();
  await expect(page.getByTestId('card-page').getByRole('heading', { name: 'Beta' })).toBeVisible();
  await expect(editor).toHaveCount(0); // the editor closed with the switch
  await btn(page, 'Edit').click();
  await expect(editor).toHaveValue('Beta');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);

  const contents = await page.evaluate(async () =>
    ((await (await fetch('/api/snapshot')).json()).cards as any[]).map((c) => c.content));
  expect(contents).toContain('Alpha');
  expect(contents).toContain('Beta');
  expect(contents).not.toContain('Alpha draft that must stay on Alpha');
});

test('doc card', async ({ page }) => {
  await seed(page);
  await addCard(page, 'Fog shader');
  await expect(btn(page, 'Start')).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Turn into lore' }).click();
  await expect(page.getByTestId('card-page').getByText('Words 2')).toBeVisible();
  for (const name of ['Start', 'Block', 'Review', 'Mark as done']) await expect(btn(page, name)).toHaveCount(0);
  await expect(tile(page, 'Fog shader')).toContainText('2w');
});

test('history', async ({ page }) => {
  await seed(page);
  await addCard(page, 'Fog shader');
  await btn(page, 'Start').click();
  await expect(badge(page)).toHaveText('Started');
  await btn(page, 'Block').click();
  await page.getByRole('dialog', { name: 'Block this task' }).getByLabel('Reason (optional)').fill('waiting on art');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(badge(page)).toHaveText('Blocked');

  await page.getByRole('tab', { name: 'History' }).click();
  const labels = page.getByRole('tabpanel', { name: 'History' }).getByTestId('history-label');
  await expect(labels.first()).toBeVisible();
  await expect(labels.filter({ hasText: /^Blocked$/ })).toHaveCount(1);
  const all = await labels.allTextContents();
  const [b, s, c] = ['Blocked', 'Started', 'Created'].map((l) => all.indexOf(l));
  expect(b).toBeGreaterThanOrEqual(0);
  expect(b).toBeLessThan(s);
  expect(s).toBeLessThan(c);
  await expect(page.getByRole('tabpanel', { name: 'History' })).toContainText('waiting on art');
});

test('deck picker', async ({ page }) => {
  const { deckId, deckPath } = await seed(page);
  await addCard(page, 'Fog shader');
  await page.getByRole('button', { name: 'List: Prototype' }).click();
  const list = page.getByRole('listbox', { name: 'Lists' });
  await expect(list.getByRole('option', { name: /Prototype/ }).first()).toBeVisible();
  await expect(list.getByRole('option', { name: /Lore/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  // A doc card may go into the doc deck; search + keyboard pick it. Esc closes only the picker.
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Lore').check();
  await panel.getByRole('button', { name: 'List: Prototype' }).click();
  await panel.getByRole('combobox', { name: 'Search lists' }).fill('lore');
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('listbox', { name: 'Lists' })).toBeHidden();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'List: Prototype' }).press('ArrowDown');
  await panel.getByRole('combobox', { name: 'Search lists' }).fill('lore');
  await expect(panel.getByRole('option', { name: /Lore/ }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'List: Lore' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // A fuller deck for the screenshot: started, done, blocked and a doc.
  const me = (await page.evaluate(async () => (await (await fetch('/api/snapshot')).json()).me.id)) as string;
  const a = await run<{ id: string }>(page, 'cards', 'create', { deckId, content: 'Rig the lantern', assigneeId: me });
  await run(page, 'cards', 'update', { id: a.id, status: 'started' });
  const b = await run<{ id: string }>(page, 'cards', 'create', { deckId, content: 'Water caustics', assigneeId: me });
  await run(page, 'cards', 'update', { id: b.id, status: 'done' });
  const c = await run<{ id: string }>(page, 'cards', 'create', { deckId, content: 'Night sky' });
  await run(page, 'resolvables', 'create', { cardId: c.id, context: 'block', content: 'Needs the new skybox' });
  await run(page, 'cards', 'create', { deckId, content: 'Valley mood notes\nCold, quiet, a little hopeful.', isDoc: true });
  await page.goto(deckPath);
  await expect(tile(page, 'Valley mood notes')).toContainText('8w');
  await expect(page.getByText('25% done')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/deck-page.png`, fullPage: true });
});
