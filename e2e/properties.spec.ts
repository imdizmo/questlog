import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';

/** A project with one deck and one card; opens the card beside its deck. */
async function seed(page: Page, cardText = 'Lantern rig') {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Harbor') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Props', projectId: project.id });
  const card = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: cardText });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  const deckPath = `/decks/${seq}-props`;
  const cardPath = `${deckPath}/card/${cardCode(card.accountSeq)}`;
  await page.goto(cardPath);
  await expect(page.getByTestId('card-page').getByRole('heading', { name: cardText })).toBeVisible();
  return { projectId: project.id, deckId: deck.id, cardId: card.id, deckPath, cardPath };
}

const props = (page: Page) => page.getByRole('tabpanel', { name: 'Properties' });
const openProps = async (page: Page) => {
  await page.getByRole('tab', { name: 'Properties' }).click();
  await expect(props(page)).toBeVisible();
};
const tile = (page: Page, title: string) => page.getByTestId('card-tile').filter({ hasText: title });

function localDay(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('set every property', async ({ page }) => {
  await seed(page);
  // The `z` shortcut opens the Properties tab.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('z');
  await expect(props(page)).toBeVisible();

  const priority = props(page).getByRole('group', { name: 'Priority' });
  await priority.getByRole('button', { name: 'High', exact: true }).click();
  await expect(priority.getByRole('button', { name: 'High', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tile(page, 'Lantern rig').getByTestId('priority')).toHaveAttribute('title', 'Priority: High');

  await props(page).getByRole('group', { name: 'Effort' }).getByRole('button', { name: '5', exact: true }).click();
  await expect(tile(page, 'Lantern rig').getByTestId('effort')).toHaveText('5');

  await props(page).getByRole('button', { name: 'Tag design', exact: true }).click();
  await expect(props(page).getByRole('button', { name: 'Tag design', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await props(page).getByRole('button', { name: 'Tag bug', exact: true }).click();
  const tags = tile(page, 'Lantern rig').getByTestId('tag');
  await expect(tags).toHaveCount(2);
  await expect(tags.filter({ hasText: '#design' })).toBeVisible();
  await expect(tags.filter({ hasText: '🐞' })).toContainText('bug');

  await expect(page.getByTestId('deck-effort')).toHaveText('Effort 0 / 5');
  await expect(page.getByRole('list', { name: 'Tasks by priority' }).getByRole('listitem').filter({ hasText: 'High' })).toContainText('0/1');
  // The deck list groups by priority.
  await expect(page.getByRole('heading', { level: 3, name: 'High' })).toBeVisible();

  // The quick bar mirrors the values.
  const bar = page.getByRole('group', { name: 'Task properties' });
  await expect(bar.getByLabel('Priority')).toHaveValue('a');
  await expect(bar.getByLabel('Effort')).toHaveValue('5');

  // History speaks about the changes.
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('history-label').filter({ hasText: 'Priority set' })).toBeVisible();
  await expect(page.getByTestId('history-label').filter({ hasText: 'Effort set' })).toBeVisible();
  await expect(page.getByTestId('history-label').filter({ hasText: 'Tags changed' }).first()).toBeVisible();

  // The open tab survives a reload.
  await page.getByRole('tab', { name: 'Properties' }).click();
  await page.reload();
  await expect(props(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phase2-properties.png`, fullPage: true });
});

test('priority group headers keep their size', async ({ page }) => {
  const { deckId, deckPath } = await seed(page, 'Unsorted crate');
  await run(page, 'cards', 'create', { deckId, content: 'Signal flare', priority: 'a', effort: 3 });
  await run(page, 'cards', 'create', { deckId, content: 'Spare oars', priority: 'c' });
  await page.goto(deckPath);
  const none = page.getByRole('heading', { level: 3, name: 'No priority' });
  const high = page.getByRole('heading', { level: 3, name: 'High' });
  await expect(none).toBeVisible();
  await expect(high).toBeVisible();
  // The "No priority" header must look like every other group header (not the 12×2 footer dash).
  const [nb, hb] = [await none.boundingBox(), await high.boundingBox()];
  expect(nb!.height).toBeGreaterThanOrEqual(14);
  expect(Math.abs(nb!.height - hb!.height)).toBeLessThan(1);
  expect(nb!.width).toBeGreaterThan(100);
  // The header sits above its own list, not on top of it.
  const list = page.getByRole('list', { name: 'No priority tasks' });
  expect((await list.boundingBox())!.y).toBeGreaterThanOrEqual(nb!.y + nb!.height);
  await page.screenshot({ path: `${SHOTS}/phase2-deck-groups.png`, fullPage: true });
});

test('rapid toggles keep every tag', async ({ page }) => {
  const { cardId } = await seed(page, 'Mast rigging');
  await openProps(page);
  // Both clicks land in the same task, long before the first write's change event comes back.
  await props(page).evaluate((el) => {
    for (const name of ['Tag design', 'Tag bug', 'Tag polish']) (el.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement).click();
  });
  await expect(tile(page, 'Mast rigging').getByTestId('tag')).toHaveCount(3);
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === cardId).masterTags.sort())
    .toEqual(['bug', 'design', 'polish']);

  // Same for personal tags: three in a row without waiting.
  await props(page).evaluate((el) => {
    const input = el.querySelector('input[aria-label="Add a personal tag"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const t of ['soon', 'later', 'maybe']) {
      set.call(input, t);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  });
  await expect(props(page).getByTestId('personal-tag')).toHaveText(['soon', 'later', 'maybe']);
  await expect.poll(async () => (await snapshot(page)).userCardTags.filter((t: any) => t.cardId === cardId).map((t: any) => t.tag).sort())
    .toEqual(['later', 'maybe', 'soon']);
});

test('due date gated', async ({ page }) => {
  await seed(page, 'Harbor lights');
  const settings = (await snapshot(page)).account.settings;
  await run(page, 'accounts', 'update', { settings: { ...settings, dueDateEnabled: false } });
  await openProps(page);
  await expect(props(page).getByLabel('Due date', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Workspace menu' });
  await dlg.getByRole('tab', { name: 'Features' }).click();
  await dlg.getByRole('switch', { name: 'Due dates' }).check();
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await expect(dlg).toBeHidden();

  const due = props(page).getByLabel('Due date', { exact: true });
  await expect(due).toBeVisible();
  await expect(due).toHaveAttribute('min', localDay(0));
  await due.fill(localDay(1));
  const chip = tile(page, 'Harbor lights').getByTestId('due');
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveClass(/past/);
  await props(page).getByRole('button', { name: 'Clear due date' }).click();
  await expect(chip).toHaveCount(0);
});

test('project tags', async ({ page }) => {
  const { cardId } = await seed(page, 'Sail mesh');
  await run(page, 'cards', 'update', { id: cardId, masterTags: ['writing'] });
  await openProps(page);
  await expect(props(page).getByRole('button', { name: 'Tag writing', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await props(page).getByRole('button', { name: 'Edit tags' }).click();
  const dlg = page.getByRole('dialog', { name: 'Project tags' });
  await dlg.getByLabel('Tag name').fill('vfx');
  await dlg.getByLabel('Emoji').fill('🎨');
  await dlg.getByRole('button', { name: 'Add tag' }).click();
  await expect(dlg.getByRole('listitem').filter({ hasText: 'vfx' })).toBeVisible();

  await dlg.getByRole('button', { name: 'Delete tag writing' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete tag?' });
  await expect(confirm).toContainText('1 task uses it');
  await confirm.getByRole('button', { name: 'Delete tag' }).click();
  await expect(confirm).toBeHidden();
  await expect(dlg.getByRole('listitem').filter({ hasText: 'writing' })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();

  const art = props(page).getByRole('button', { name: 'Tag vfx', exact: true });
  await expect(art).toBeVisible();
  await expect(art).toContainText('🎨');
  await expect(props(page).getByRole('button', { name: 'Tag sprint', exact: true })).toHaveCount(0);
  await expect(tile(page, 'Sail mesh').getByTestId('tag')).toHaveCount(0);
});

test('personal tags', async ({ page, browser }) => {
  const { projectId, cardId, cardPath } = await seed(page, 'Rope physics');
  await openProps(page);
  const input = props(page).getByLabel('Add a personal tag');
  await input.fill('later');
  await input.press('Enter');
  await expect(props(page).getByTestId('personal-tag')).toHaveText(['later']);
  await expect(tile(page, 'Rope physics').getByTestId('personal-tag')).toHaveText('later');

  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [projectId] });
  const b = await newPerson(browser);
  const name = unique('Cato');
  const res = await b.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  await b.goto(cardPath);
  await expect(b.getByTestId('card-page').getByRole('heading', { name: 'Rope physics' })).toBeVisible();
  await b.getByRole('tab', { name: 'Properties' }).click();
  await expect(b.getByRole('tabpanel', { name: 'Properties' }).getByLabel('Add a personal tag')).toBeVisible();
  await expect(b.getByTestId('personal-tag')).toHaveCount(0);
  const snap = await snapshot(b);
  expect(snap.userCardTags.filter((t: any) => t.cardId === cardId)).toEqual([]);
  await b.context().close();
});

test('preset', async ({ page }) => {
  const text = 'Crash on save\nSteps:\n1. Open a scene';
  const { cardId } = await seed(page, 'Crash on save');
  const me = (await snapshot(page)).me.id as string;
  await run(page, 'cards', 'update', { id: cardId, priority: 'a', masterTags: ['bug'], assigneeId: me, content: text, contentVersion: 1 });
  await openProps(page);

  // Nothing ticked: priority and tags only. Presets are workspace-wide, so text and owner are opt-in.
  await props(page).getByRole('button', { name: 'Save as preset' }).click();
  let dlg = page.getByRole('dialog', { name: 'Save as preset' });
  await expect(dlg.getByText('Presets are visible to everyone in the workspace')).toBeVisible();
  await expect(dlg.getByRole('checkbox', { name: 'Include text' })).not.toBeChecked();
  await expect(dlg.getByRole('checkbox', { name: 'Include owner' })).not.toBeChecked();
  await dlg.getByLabel('Preset name').fill('Plain bug');
  await dlg.getByRole('button', { name: 'Save preset' }).click();
  await expect(dlg).toBeHidden();
  // Text and owner ticked.
  await props(page).getByRole('button', { name: 'Save as preset' }).click();
  dlg = page.getByRole('dialog', { name: 'Save as preset' });
  await dlg.getByLabel('Preset name').fill('Bug template');
  await dlg.getByRole('checkbox', { name: 'Include text' }).check();
  await dlg.getByRole('checkbox', { name: 'Include owner' }).check();
  await dlg.getByRole('button', { name: 'Save preset' }).click();
  await expect(dlg).toBeHidden();
  const presets = (await snapshot(page)).presets as any[];
  const plain = presets.find((p) => p.name === 'Plain bug').data;
  expect(plain).toMatchObject({ priority: 'a', masterTags: ['bug'] });
  expect(plain.content).toBeUndefined();
  expect(plain.assigneeId).toBeUndefined();
  expect(presets.find((p) => p.name === 'Bug template').data).toMatchObject({ content: text, assigneeId: me });

  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Preset').selectOption({ label: 'Bug template' });
  await expect(panel.getByLabel('Task text')).toHaveValue(text);
  await expect(panel.getByLabel('Owner')).toHaveValue(me);
  await expect(panel.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'High', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: 'Tag bug', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Typed text is never replaced by a preset.
  await panel.getByLabel('Task text').fill('Crash on load');
  await panel.getByLabel('Preset').selectOption({ label: 'Plain bug' });
  await expect(panel.getByLabel('Task text')).toHaveValue('Crash on load');
  await panel.getByLabel('Task text').press('Control+Enter');
  await expect(panel).toBeHidden();

  const t = tile(page, 'Crash on load');
  await expect(t.getByTestId('priority')).toHaveAttribute('title', 'Priority: High');
  await expect(t.getByTestId('tag')).toContainText('bug');
  await expect(t.getByTestId('owner')).toHaveText('A');
});
