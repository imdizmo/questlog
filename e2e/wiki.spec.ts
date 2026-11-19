import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';

const entryPage = (page: Page) => page.getByTestId('entry-page');

/** New entry from the left column: a type, then a name. */
async function newEntry(page: Page, type: string, name: string) {
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New entry' });
  await dialog.getByLabel('Type').selectOption({ label: type });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(entryPage(page).getByTestId('type-badge')).toHaveText(new RegExp(type));
}

test('wiki entry page', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const campaign = unique('Ashen Isles');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: campaign });
  // A second project, so the wiki offers a project picker.
  await run(page, 'projects', 'create', { name: unique('Spare') });
  await run(page, 'wiki', 'createType', { projectId: project.id, name: 'Item', icon: '⚔', color: '#ec8219', fields: [{ key: 'damage', label: 'damage', kind: 'number' }, { key: 'tint', label: 'tint', kind: 'color' }] });
  // A colour that is not #rrggbb is never put into a style.
  await run(page, 'wiki', 'createType', { projectId: project.id, name: 'Creature', color: 'red;background:url(x)' });
  await run(page, 'wiki', 'createLinkKind', {
    projectId: project.id, key: 'drops', label: 'drops', reverseLabel: 'dropped by', fromTypes: ['creature'], toTypes: ['item'],
    props: [{ key: 'chance', label: 'chance', kind: 'number', unit: '%' }],
  });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;

  // The sidebar has Wiki; it opens a project's wiki.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Wiki', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Wiki', exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/\d+$/);
  await page.getByLabel('Project', { exact: true }).selectOption({ label: campaign });
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}$`));
  await expect(page.getByRole('heading', { level: 1, name: `Wiki · ${campaign}` })).toBeVisible();

  await newEntry(page, 'Item', 'Fire Sword');
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/fire_sword$`));
  const itemBadge = entryPage(page).getByTestId('type-badge');
  await expect(itemBadge).toHaveAttribute('style', /rgb\(236, 130, 25\)/);

  // The Item's damage field, edited inline in the infobox.
  const damage = entryPage(page).getByTestId('infobox').getByLabel('damage');
  await damage.fill('12');
  await damage.press('Enter');
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'fire_sword')?.fields?.damage).toBe(12);

  // An empty colour stays empty when the field is only tabbed through; a picked one saves, and Clear removes it.
  const fields = async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'fire_sword')?.fields;
  const tint = entryPage(page).getByTestId('infobox').getByLabel('tint', { exact: true });
  await tint.focus();
  await tint.press('Tab');
  await expect(entryPage(page).getByTestId('infobox')).toContainText('None');
  expect((await fields()).tint).toBeUndefined();
  await tint.fill('#ff0000');
  await tint.press('Tab');
  await expect.poll(async () => (await fields()).tint).toBe('#ff0000');
  await entryPage(page).getByRole('button', { name: 'Clear tint' }).click();
  await expect.poll(async () => (await fields()).tint).toBeUndefined();

  await newEntry(page, 'Creature', 'Cinder Golem');
  expect(await entryPage(page).getByTestId('type-badge').getAttribute('style')).toBeNull();

  // The tree and the type list show both; search filters by title or key.
  const side = page.getByRole('navigation', { name: 'Wiki pages' });
  await expect(side.getByRole('list', { name: 'Page tree' }).getByRole('link')).toHaveText(['Cinder Golem', 'Fire Sword']);
  await side.getByLabel('Find lore').fill('FIRE_');
  await expect(side.getByRole('list', { name: 'Found lore' }).getByRole('link')).toHaveText(['Fire Sword']);
  await side.getByLabel('Find lore').fill('');

  // On Cinder Golem: a drops link to Fire Sword with chance 15.
  const drops = entryPage(page).getByRole('region', { name: 'drops' });
  await drops.getByRole('button', { name: 'Add drops link' }).click();
  await page.getByPlaceholder('Search lore', { exact: true }).fill('Fire');
  await page.getByRole('option', { name: /Fire Sword/ }).click();
  await drops.getByLabel('chance').fill('15');
  await drops.getByRole('button', { name: 'Add link' }).click();
  await expect(drops.getByTestId('wiki-link')).toHaveText(/Fire Sword \(15%\)/);

  // Fire Sword lists it under "What links here".
  // In the wiki the link opens Fire Sword beside the page; Open full page makes it the main entry.
  await drops.getByRole('link', { name: 'Fire Sword' }).click();
  await page.getByTestId('wiki-panel').getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/fire_sword\\?panels=`));
  await page.getByTestId('wiki-panel').getByRole('button', { name: /^Close / }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name: 'Fire Sword' })).toBeVisible();
  const linksHere = entryPage(page).getByRole('region', { name: 'What links here' });
  await expect(linksHere.getByTestId('backlink-group')).toHaveText('dropped by Cinder Golem (15%)');

  // A quest that mentions the entry's $code shows under Open cards.
  const snap = await snapshot(page);
  const sword = snap.cards.find((c: any) => c.entryKey === 'fire_sword');
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Quests', projectId: project.id });
  await run(page, 'cards', 'create', { deckId: deck.id, content: `Fire Sword VFX\nGlow for $${cardCode(sword.seq)}` });
  const icon = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Fire Sword icon' });
  const openQuests = entryPage(page).getByRole('region', { name: 'Open tasks' });
  await expect(openQuests.getByRole('link', { name: /Fire Sword VFX/ })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/wiki-entry.png`, animations: 'disabled' });

  // From a quest: Works on → Fire Sword, and the entry page lists the quest.
  await page.goto(`/card/${cardCode(icon.accountSeq)}`);
  const worksOn = page.getByTestId('card-page').getByRole('group', { name: 'Works on' });
  await worksOn.getByRole('button', { name: 'Add a wiki entry this task works on' }).click();
  await page.getByPlaceholder('Search lore', { exact: true }).fill('Fire');
  await page.getByRole('option', { name: /Fire Sword/ }).click();
  await expect(worksOn.getByRole('link', { name: 'Fire Sword' })).toBeVisible();
  await worksOn.getByRole('link', { name: 'Fire Sword' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/fire_sword$`));
  await expect(entryPage(page).getByRole('region', { name: 'Open tasks' }).getByRole('link', { name: /Fire Sword icon/ })).toBeVisible();

  // Lore opened from its deck links to the wiki.
  await page.goto(`/card/${cardCode(sword.seq)}`);
  await page.getByTestId('card-page').getByRole('link', { name: 'Open in Wiki' }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name: 'Fire Sword' })).toBeVisible();

  // A hover preview on a $code link in entry text.
  const golem = snap.cards.find((c: any) => c.entryKey === 'cinder_golem');
  await run(page, 'cards', 'update', { id: golem.id, content: `# Cinder Golem\nGuards $${cardCode(sword.seq)}.`, contentVersion: golem.contentVersion });
  await page.goto(`/wiki/${seq}/cinder_golem`);
  // A typed entry is laid out by its blocks: text before the first heading comes first.
  const ref = entryPage(page).getByTestId('block-intro').getByRole('link', { name: 'Fire Sword' });
  await expect(ref).toHaveClass(/card-ref/);
  await ref.hover();
  const preview = page.getByTestId('entry-preview');
  await expect(preview).toContainText('Item');
  await expect(preview).toContainText('damage');
  await expect(preview).toContainText('12');

  // An observer sees the page with no edit controls.
  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'observer', projectIds: [project.id] });
  const o = await newPerson(browser);
  const who = unique('Obs');
  await o.goto(`/join/${token}`);
  await o.getByLabel('Your name').fill(who);
  await o.getByLabel('Email').fill(`${who.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await o.getByLabel('Password').fill('another good password');
  await o.getByRole('button', { name: 'Join' }).click();
  await expect(o).toHaveURL(/\/decks$/);
  await o.goto(`/wiki/${seq}/fire_sword`);
  const op = entryPage(o);
  await expect(op.getByRole('heading', { level: 2, name: 'Fire Sword' })).toBeVisible();
  await expect(op.getByTestId('infobox')).toContainText('12');
  // The golem's text now mentions the sword too.
  await expect(op.getByRole('region', { name: 'What links here' }).getByTestId('backlink-group')).toHaveText(['dropped by Cinder Golem (15%)', 'Mentions Cinder Golem']);
  await expect(o.getByRole('button', { name: 'New entry' })).toHaveCount(0);
  await expect(op.getByRole('button', { name: /Edit text/ })).toHaveCount(0);
  await expect(op.getByLabel('Type')).toHaveCount(0);
  await expect(op.getByTestId('infobox').getByRole('spinbutton')).toHaveCount(0);
  await op.getByRole('tab', { name: 'Attachments' }).click();
  await expect(op.getByRole('button', { name: 'Upload files' })).toHaveCount(0);
  // The quest page shows its Works on entry, without add or remove.
  await o.goto(`/card/${cardCode(icon.accountSeq)}`);
  const oWorks = o.getByTestId('card-page').getByRole('group', { name: 'Works on' });
  await expect(oWorks.getByRole('link', { name: 'Fire Sword' })).toBeVisible();
  await expect(oWorks.getByRole('button')).toHaveCount(0);
  await o.goto(`/wiki/${seq}/cinder_golem`);
  await expect(entryPage(o).getByTestId('wiki-link')).toHaveText(/Fire Sword \(15%\)/);
  await expect(entryPage(o).getByRole('button', { name: /Add drops link|Remove drops/ })).toHaveCount(0);

  // An observer can export the game data: the download parses and holds fire_sword with its damage and the drops link.
  const download = o.waitForEvent('download');
  await o.getByRole('link', { name: 'Export game data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-gamedata\.json$/);
  const data = JSON.parse(readFileSync((await file.path())!, 'utf8'));
  expect(data).toMatchObject({ format: 'questlog-gamedata', version: 1, campaign: { id: project.id, name: campaign } });
  expect(data.entries.find((e: any) => e.key === 'fire_sword')).toMatchObject({ type: 'item', name: 'Fire Sword', fields: { damage: 12 } });
  expect(data.links).toEqual([{ kind: 'drops', from: 'cinder_golem', to: 'fire_sword', props: { chance: 15 }, order: 0 }]);
  await o.context().close();
});

test('wiki type table', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Tables') });
  const item = await run<{ id: string }>(page, 'wiki', 'createType', {
    projectId: project.id, name: 'Item',
    fields: [{ key: 'damage', label: 'damage', kind: 'number', inTable: true }, { key: 'rarity', label: 'rarity', kind: 'enum', options: ['Common', 'Epic'], inTable: true }],
  });
  await run(page, 'wiki', 'createType', { projectId: project.id, name: 'Weapon', parentTypeId: item.id });
  const make = async (typeId: string, name: string, fields: object) => {
    const e = await run<{ id: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId, name });
    await run(page, 'wiki', 'setEntry', { cardId: e.id, fields });
    return e;
  };
  const types = (await snapshot(page)).entryTypes as any[];
  const weapon = types.find((t) => t.projectId === project.id && t.key === 'weapon');
  await make(item.id, 'Potion', { damage: 1, rarity: 'Common' });
  const sword = await make(weapon.id, 'Fire Sword', { damage: 12, rarity: 'Epic' });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;

  await page.goto(`/wiki/${seq}`);
  await page.getByRole('link', { name: 'Item: 2', exact: true }).click();
  await page.getByRole('region', { name: 'Item' }).getByRole('link', { name: 'Table' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/type/item$`));
  const table = page.getByTestId('type-table');
  // The Item table lists the Weapon too, with a Type column.
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('columnheader', { name: 'Type' })).toBeVisible();

  // Filter rarity = Epic: one row, and the filter is in the URL.
  await table.getByLabel('Filter rarity mode').selectOption('eq');
  await table.getByLabel('Filter rarity', { exact: true }).selectOption('Epic');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('link', { name: 'Fire Sword' })).toBeVisible();
  await expect(page).toHaveURL(/f=rarity%3Aeq%3AEpic/);

  // Edit damage inline; the entry page shows the new value.
  const damage = table.getByRole('row', { name: /Fire Sword/ }).getByLabel('damage');
  await damage.fill('30');
  await damage.press('Enter');
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === sword.id)?.fields?.damage).toBe(30);
  await table.getByRole('link', { name: 'Fire Sword' }).click();
  await expect(entryPage(page).getByTestId('infobox').getByLabel('damage')).toHaveValue('30');
  await page.goBack();

  // Clearing a cell removes the field (null), it does not store an empty value.
  await damage.fill('');
  await damage.press('Enter');
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === sword.id)?.fields).not.toHaveProperty('damage');
  await table.getByLabel('Filter damage mode').selectOption('missing');
  await expect(table.getByRole('link', { name: 'Fire Sword' })).toBeVisible();
  await expect(page).toHaveURL(/f=rarity%3Aeq%3AEpic&f=damage%3Amissing/);
  await table.getByLabel('Filter damage mode').selectOption('has');
  await expect(table.getByText('No entries match the filters.')).toBeVisible();
  await table.getByLabel('Filter damage mode').selectOption('');
  await run(page, 'wiki', 'setEntry', { cardId: sword.id, fields: { damage: 30 } });
  await table.getByLabel('Filter rarity mode').selectOption('');

  // Typing in a filter keeps every character and reaches the URL after a pause.
  await table.getByLabel('Filter Title mode').selectOption('contains');
  await table.getByLabel('Filter Title', { exact: true }).pressSequentially('fire sw', { delay: 30 });
  await expect(table.getByLabel('Filter Title', { exact: true })).toHaveValue('fire sw');
  await expect(page).toHaveURL(/f=title%3Acontains%3Afire\+sw/);
  await expect(table.getByRole('link', { name: 'Potion' })).toHaveCount(0);
  await table.getByLabel('Filter Title mode').selectOption('');

  // A linked, filtered table opens filtered; sorting by damage is in the URL too.
  await page.goto(`/wiki/${seq}/type/item?f=rarity:eq:Epic`);
  await expect(page.getByTestId('type-table').getByRole('row')).toHaveCount(3);
  await page.getByTestId('type-table').getByLabel('Filter rarity mode').selectOption('');
  await page.getByTestId('type-table').getByRole('button', { name: 'damage' }).click();
  await expect(page).toHaveURL(/sort=damage%3Aasc/);
  await expect(page.getByTestId('type-table').getByRole('row').nth(3)).toContainText('Fire Sword');

  // New Item adds a row.
  await page.getByRole('button', { name: 'New Item' }).click();
  await page.getByRole('dialog', { name: 'New Item' }).getByLabel('Name').fill('Shield');
  await page.getByRole('dialog', { name: 'New Item' }).getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('type-table').getByRole('link', { name: 'Shield' })).toBeVisible();
});

test('wiki starter pack, types editor and checks', async ({ page }) => {
  await ensureWorkspace(page);
  const campaign = unique('Starter');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: campaign });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  await page.goto(`/wiki/${seq}`);

  // 1. An empty project offers the pack; the type list then shows its types.
  await expect(page.getByRole('button', { name: 'Start empty' })).toBeVisible();
  await page.getByRole('button', { name: 'Add the game starter pack' }).click();
  for (const t of ['Item', 'Creature', 'Place']) await expect(page.getByRole('link', { name: `${t}: 0`, exact: true })).toBeVisible();
  // The small set has no recipes or weapons; the extras bring them.
  await expect(page.getByRole('link', { name: 'Recipe: 0', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add the RPG extras' }).click();
  await expect(page.getByRole('link', { name: 'Recipe: 0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add the game starter pack' })).toHaveCount(0);

  const types = (await snapshot(page)).entryTypes.filter((t: any) => t.projectId === project.id);
  const typeId = (key: string) => types.find((t: any) => t.key === key).id;
  for (const name of ['Rope', 'Lantern']) await run(page, 'wiki', 'createEntry', { projectId: project.id, typeId: typeId('item'), name });
  const blade = await run<{ id: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId: typeId('weapon'), name: 'Old Blade' });
  await run(page, 'wiki', 'setEntry', { cardId: blade.id, fields: { damage: { min: 1, max: 3 } } });
  const badge = page.getByRole('button', { name: /checks?$/ });
  await expect(page.getByRole('link', { name: 'Item: 3', exact: true })).toBeVisible();
  await expect(badge).toHaveCount(0);

  // 2. In settings, Item gets a required number field `heft`.
  // The Wiki's Types: a type from the tree, on its Template (fields) or Settings tab.
  const openTypes = async (name: string, tab: 'Template' | 'Settings' = 'Template') => {
    await page.getByRole('navigation', { name: `${campaign} wiki` }).getByRole('link', { name: 'Types', exact: true }).click();
    // Families start folded: find the type, open it, clear the search.
    const tree = page.getByRole('region', { name: 'Entry types' });
    await tree.getByLabel('Find a type').fill(name);
    await tree.getByRole('link', { name, exact: true }).click();
    await tree.getByLabel('Find a type').fill('');
    const editor = page.getByRole('region', { name });
    await editor.getByRole('tab', { name: tab }).click();
    return { editor };
  };
  let { editor } = await openTypes('Item', 'Settings');
  await expect(editor.getByLabel('Key', { exact: true })).toHaveValue('item');
  await editor.getByRole('tab', { name: 'Template' }).click();
  await editor.getByRole('button', { name: 'Add field' }).click();
  const row = editor.getByRole('list', { name: 'Fields' }).getByRole('group').last();
  await row.getByLabel('Label').fill('heft');
  await expect(row.getByLabel('Key')).toHaveValue('heft');
  await row.getByLabel('Kind').selectOption('number');
  await row.getByLabel('Required').check();
  await editor.getByRole('button', { name: 'Save fields' }).click();
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.id === typeId('item')).fields.find((f: any) => f.key === 'heft'))
    .toMatchObject({ kind: 'number', required: true });
  // The saved field's key is read-only now.
  await expect(editor.getByRole('group', { name: 'heft' }).getByLabel('Key')).toHaveAttribute('readonly', '');
  await page.screenshot({ path: `${SHOTS}/wiki-types.png`, animations: 'disabled' });

  // 3. The badge counts the Item entries (Weapons included) missing heft.
  await expect(badge).toHaveText('⚠ 3 checks');
  await badge.click();
  const panel = page.getByRole('dialog', { name: /^Checks/ });
  const missing = panel.getByRole('region', { name: 'Missing required values' });
  await expect.poll(async () => (await missing.getByRole('link').allInnerTexts()).sort()).toEqual(['Lantern', 'Old Blade', 'Rope']);
  await panel.getByRole('button', { name: 'Close' }).last().click();

  // 4. Weapon damage goes from range to number: the stored range shows as invalid.
  ({ editor } = await openTypes('Weapon'));
  const damage = editor.getByRole('group', { name: 'Damage' });
  await damage.getByLabel('Kind').selectOption('number');
  await editor.getByRole('button', { name: 'Save fields' }).click();
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.id === typeId('weapon')).fields.find((f: any) => f.key === 'damage').kind).toBe('number');
  await expect(badge).toHaveText('⚠ 4 checks');
  // A strict export is blocked by the checks.
  const strict = await page.request.get(`/api/wiki/${project.id}/export?strict=1`);
  expect(strict.status()).toBe(422);
  expect((await strict.json()).checks).toHaveLength(4);
  await badge.click();
  const invalid = page.getByRole('dialog', { name: /^Checks/ }).getByRole('region', { name: 'Invalid values' });
  await expect(invalid.getByRole('listitem')).toHaveText([/Old Blade damage: not the right kind of value/]);
  await invalid.getByRole('link', { name: 'Old Blade' }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name: 'Old Blade' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/wiki-checks.png`, animations: 'disabled' });

  // 5. Delete type asks first. A used type can't be confirmed; an unused one goes only on Delete forever.
  ({ editor } = await openTypes('Item', 'Settings'));
  await editor.getByRole('button', { name: 'Delete type' }).click();
  const box = editor.getByRole('group', { name: 'Confirm delete type' });
  await expect(box).toContainText("Item can't be deleted while it is used by 2 entries, 5 child types");
  await expect(box.getByRole('button', { name: 'Delete forever' })).toBeDisabled();
  await box.getByRole('button', { name: 'Keep type' }).click();
  const tree = page.getByRole('region', { name: 'Entry types' });
  await tree.getByRole('button', { name: 'New type' }).click();
  await tree.getByLabel('Name of the new type').fill('Scratch');
  await tree.getByRole('button', { name: 'Make type' }).click();
  const scratch = page.getByRole('region', { name: 'Scratch' });
  await scratch.getByRole('tab', { name: 'Settings' }).click();
  await scratch.getByRole('button', { name: 'Delete type' }).click();
  const scratchBox = scratch.getByRole('group', { name: 'Confirm delete type' });
  await expect(scratchBox).toContainText('Delete the type Scratch with its 0 field definitions? Trashed entries of this type come back as untyped lore');
  const hasScratch = async () => (await snapshot(page)).entryTypes.some((t: any) => t.projectId === project.id && t.name === 'Scratch');
  expect(await hasScratch()).toBe(true);
  await scratchBox.getByRole('button', { name: 'Delete forever' }).click();
  await expect.poll(hasScratch).toBe(false);
  await expect(scratch).toHaveCount(0);
});

test('wiki builder: template, gallery, places, timeline and storyboard', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('World') });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  await run(page, 'wiki', 'addStarterPack', { projectId: project.id });
  const types = (await snapshot(page)).entryTypes.filter((t: any) => t.projectId === project.id);
  const typeId = (key: string) => types.find((t: any) => t.key === key).id;
  const mk = (key: string, name: string) => run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId: typeId(key), name });
  const coast = await mk('location', 'North Coast');
  const shore = await mk('location', 'Shore');
  await run(page, 'wiki', 'addLink', { kindKey: 'located_in', fromCardId: shore.id, toCardId: coast.id });
  await mk('item', 'Deer hide');
  const flood = await mk('history', 'Old town floods');
  await run(page, 'wiki', 'setEntry', { cardId: flood.id, fields: { era: 'The drowning', year: 12 } });
  const lit = await mk('history', 'Beacon is lit');
  await run(page, 'wiki', 'setEntry', { cardId: lit.id, fields: { era: 'Now', year: 40 } });

  // 1. Build a creature: values by clicking, a drop picked from the items, saved as a template.
  await page.goto(`/wiki/${seq}`);
  await page.getByText(/^More entity types/).click();
  await page.getByRole('link', { name: 'Creature: 0', exact: true }).click();
  await page.getByRole('group', { name: 'New Creature' }).getByRole('link', { name: 'New creature' }).click();
  const build = page.getByRole('region', { name: 'New Creature' });
  await build.getByLabel('Name').fill('Red Deer');
  await build.getByLabel('Health').fill('120');
  await build.getByRole('group', { name: 'Damage kind' }).getByRole('button', { name: 'slash' }).click();
  await build.getByRole('group', { name: 'drops' }).getByRole('button', { name: /Deer hide/ }).click();
  await build.getByRole('group', { name: 'found in' }).getByRole('button', { name: /Shore/ }).click();
  const preview = build.getByRole('complementary', { name: 'Preview' });
  await expect(preview).toContainText('Red Deer');
  await expect(preview).toContainText('slash');
  await expect(preview).toContainText('Deer hide');
  await build.getByRole('button', { name: 'Save these values as a template' }).click();
  await expect(build.getByRole('group', { name: 'Start from' }).getByRole('link', { name: 'Red Deer' })).toBeVisible();
  await build.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name: 'Red Deer' })).toBeVisible();
  // The page starts with its entity type's headings.
  await expect(entryPage(page).getByRole('heading', { name: 'Behaviour' })).toBeVisible();
  await expect(entryPage(page).getByRole('region', { name: 'drops' }).getByTestId('wiki-link')).toContainText('Deer hide');

  // 2. A second one from the template: only the name is typed.
  await entryPage(page).getByRole('link', { name: 'Make a variant' }).click();
  await expect(page.getByRole('complementary', { name: 'Preview' })).toContainText('Copy of Red Deer');
  await page.goto(`/wiki/${seq}/kind/creature`);
  await page.getByRole('group', { name: 'New Creature' }).getByRole('link', { name: 'Red Deer' }).click();
  await page.getByRole('region', { name: 'New Creature' }).getByLabel('Name').fill('Roe Deer');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(entryPage(page).getByRole('heading', { level: 2, name: 'Roe Deer' })).toBeVisible();
  const roe = (await snapshot(page)).cards.find((c: any) => c.entryKey === 'roe_deer');
  expect(roe.fields).toMatchObject({ health: 120, damage_kind: 'slash' });
  await page.goto(`/wiki/${seq}/kind/creature`);
  await expect(page.getByRole('region', { name: 'Creature' }).getByRole('link', { name: /Deer/ })).toHaveCount(3); // two creatures and the template

  // 3. Places as a tree with what is found there; history in order by era.
  await page.goto(`/wiki/${seq}`);
  await page.getByRole('navigation', { name: /wiki$/ }).getByRole('link', { name: 'Places', exact: true }).click();
  const tree = page.getByRole('list', { name: 'Place tree' });
  await expect(tree.getByRole('listitem').filter({ hasText: 'North Coast' }).first().getByRole('list').getByRole('link', { name: /Shore/ })).toContainText('Red Deer');
  await page.goto(`/wiki/${seq}/view/timeline`);
  await expect(page.getByRole('region', { name: 'Timeline' }).getByRole('link')).toContainText(['Old town floods', 'Beacon is lit']);
  await expect(page.getByRole('region', { name: 'The drowning' })).toContainText('Year 12');

  // 4. A storyline's frames: added by name, reordered, kept in the links' order.
  const story = await mk('storyline', 'Arrival');
  await page.goto(`/wiki/${seq}/${story.key}`);
  const board = entryPage(page).getByRole('region', { name: 'Storyboard' });
  for (const n of ['Wake up', 'Find food', 'First night']) {
    await board.getByLabel('New frame').fill(n);
    await board.getByRole('button', { name: 'Add frame' }).click();
    await expect(board.getByTestId('frame').filter({ hasText: n })).toBeVisible();
  }
  await board.getByRole('button', { name: 'Move First night earlier' }).click();
  await expect(board.getByTestId('frame').getByRole('strong')).toHaveText(['Wake up', 'First night', 'Find food']);
  await board.getByRole('button', { name: 'Remove Wake up from the storyboard' }).click();
  await expect(board.getByTestId('frame')).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/wiki-storyboard.png` });

  // 5. The same frames as a flow on the canvas: a picture card each, joined in order; a frame made there joins the storyline.
  await board.getByRole('button', { name: 'Open as a flow' }).click();
  await expect(page).toHaveURL(/\/home\?board=\d+$/);
  const scenes = page.locator('[data-node-type="card"]');
  await expect(scenes).toHaveCount(2);
  await expect(scenes.first()).toContainText('First night');
  await expect(page.locator('[data-edge-id]')).toHaveCount(1);
  await expect(scenes.first()).toContainText('Start');
  await expect(scenes.nth(1)).not.toContainText('Start');
  // Play walks it: the first frame, then the frame its line leads to, then the end.
  await page.getByRole('button', { name: 'Play' }).click();
  const play = page.getByTestId('story-play');
  await expect(play.getByRole('heading', { name: 'First night' })).toBeVisible();
  await play.getByRole('button', { name: 'Find food' }).click();
  await expect(play.getByRole('heading', { name: 'Find food' })).toBeVisible();
  await expect(play).toContainText('The end');
  await page.getByRole('dialog').getByRole('button', { name: 'Restart' }).click();
  await expect(play.getByRole('heading', { name: 'First night' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/wiki-story-flow.png` });
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  // Variables are kept with the board and shown while playing.
  await page.getByRole('button', { name: 'Variables' }).click();
  const varsDialog = page.getByRole('dialog', { name: 'Story variables' });
  await varsDialog.getByRole('textbox').fill('gold = 10');
  await varsDialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(play.getByLabel('Variables')).toContainText('gold = 10');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  // An entry dragged from the cast onto a frame is linked to it and shows on the card.
  await page.getByRole('complementary', { name: 'Cast' }).getByText('Cast', { exact: true }).click();
  await page.getByRole('complementary', { name: 'Cast' }).getByText('Red Deer').dragTo(scenes.first());
  await expect(scenes.first()).toContainText('Red Deer');
  const deer = (await snapshot(page)).cards.find((c: any) => c.entryKey === 'red_deer');
  expect((await snapshot(page)).entryLinks.filter((l: any) => l.toCardId === deer.id && l.kindKey === 'features')).toHaveLength(1);
  // The mouse: a left drag on the empty board draws a selection box, the picked cards move together, and a right
  // click offers what can be added.
  const vp = (await page.getByTestId('board-viewport').boundingBox())!;
  const xs = async () => scenes.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.x)));
  const [x0, x1] = await xs();
  await page.mouse.move(vp.x + 60, vp.y + vp.height - 40);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width - 240, vp.y + 20, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-node-type="card"].is-selected')).toHaveCount(2);
  const grab = (await scenes.first().boundingBox())!;
  await page.mouse.move(grab.x + 30, grab.y + grab.height - 12);
  await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y + grab.height + 108, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => scenes.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.y)))).toEqual([160, 160]);
  expect(await xs()).toEqual([x0, x1]);
  await page.mouse.click(vp.x + 80, vp.y + vp.height - 30, { button: 'right' });
  await expect(page.getByRole('menu', { name: 'Add to the board' }).getByRole('menuitem')).toHaveText(['Add text', 'Add image', 'Add video', 'Add task', 'Add smart node', 'Add container']);
  await page.keyboard.press('Escape');
  await page.mouse.click(vp.x + 80, vp.y + vp.height - 30);
  await expect(page.getByRole('menu', { name: 'Add to the board' })).toHaveCount(0);

  await page.goto(`/wiki/${seq}/${story.key}`);
  await expect(entryPage(page).getByRole('region', { name: 'Storyboard' }).getByTestId('frame')).toHaveCount(2);
  await entryPage(page).getByRole('button', { name: 'Open as a flow' }).click();
  await expect(scenes).toHaveCount(2); // opening it again adds nothing
});
