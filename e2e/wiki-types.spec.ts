import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/** The Wiki's Types: families that fold, search, "+", a type's picture, its tabs, and the families panel. */
test('wiki types: families, search, new type, picture and settings', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Fog Isles');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  await run(page, 'wiki', 'addStarterPack', { projectId: project.id });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;

  // The wiki's column leads to Types.
  await page.goto(`/wiki/${seq}`);
  const col = page.getByRole('navigation', { name: `${name} wiki` });
  for (const part of ['Entries', 'Types', 'Link kinds', 'Graph', 'Places', 'Timeline', 'Storyboard', 'Export game data']) {
    await expect(col.getByRole('link', { name: part, exact: true })).toBeVisible();
  }
  await col.getByRole('link', { name: 'Types', exact: true }).click();
  // The bare Types page opens the first type of the tree.
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/types/npc$`));
  await expect(col.getByRole('link', { name: 'Types', exact: true })).toHaveAttribute('aria-current', 'page');

  const tree = page.getByRole('region', { name: 'Entry types' });
  const fam = (n: string) => tree.getByRole('button', { name: new RegExp(`^${n}\\s*\\d+$`) });
  for (const f of ['Characters', 'Creatures', 'Items', 'Places', 'Story', 'Systems', 'Production']) await expect(fam(f)).toBeVisible();
  await expect(fam('Characters')).toHaveAttribute('aria-expanded', 'true');
  await expect(fam('Items')).toHaveAttribute('aria-expanded', 'false');
  await fam('Items').click();
  await expect(tree.getByRole('link', { name: /Weapon/ })).toBeVisible();
  await expect(tree.getByRole('link', { name: /^Item\s*5 kinds$/ })).toBeVisible();

  // Search opens the family holding a match, with its root.
  await fam('Items').click();
  await tree.getByLabel('Find a type').fill('swo');
  await expect(tree.getByText('No type called swo.')).toBeVisible();
  await tree.getByLabel('Find a type').fill('weap');
  await expect(tree.getByRole('link', { name: /Weapon/ })).toBeVisible();
  await expect(tree.getByRole('link', { name: /^Item/ })).toBeVisible();
  await expect(fam('Characters')).toHaveCount(0);
  await tree.getByLabel('Find a type').fill('');

  // A type with inherited fields: Weapon, a kind of Item.
  await page.goto(`/wiki/${seq}/types/weapon`);
  const detail = page.getByRole('region', { name: 'Weapon' });
  await expect(detail.getByText('Items › Item', { exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { level: 1, name: /Weapon/ })).toBeVisible();
  await expect(detail.getByRole('group', { name: 'Fields from Item' })).toContainText('Rarity');
  await expect(detail.getByRole('heading', { name: 'Starting values' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/p3-types-inherited-dark.png`, animations: 'disabled', fullPage: true });

  // Change picture: a popover with four painted styles, an upload and a picture from Assets.
  await detail.getByRole('button', { name: 'Change picture' }).click();
  const menu = page.getByRole('dialog', { name: 'Change picture' });
  const painted = menu.getByRole('group', { name: 'Painted pictures' }).getByRole('button');
  await expect(painted).toHaveCount(4);
  await expect(menu.getByRole('button', { name: 'Dusk painted picture' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: `${SHOTS}/p3-types-picture-dark.png`, animations: 'disabled' });
  // While a change saves, the styles can't be clicked again.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/dispatch/wiki/updateType', async (route) => { await held; await route.continue(); });
  await menu.getByRole('button', { name: 'Night painted picture' }).click();
  for (const b of await painted.all()) await expect(b).toBeDisabled();
  release();
  await expect(menu).toHaveCount(0);
  await page.unroute('**/dispatch/wiki/updateType');
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.projectId === project.id && t.key === 'weapon').picture)
    .toEqual({ kind: 'painted', style: 'night' });
  // An upload: stored and set in one request.
  await detail.getByRole('button', { name: 'Change picture' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/wiki\/types\/[^/]+\/picture$/.test(r.url()));
  await menu.locator('input[type=file]').setInputFiles({ name: 'w.png', mimeType: 'image/png', buffer: png });
  await sent;
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.projectId === project.id && t.key === 'weapon').picture?.kind).toBe('file');
  // From Assets: an asset's picture becomes the type's own copy.
  const added = await page.request.post(`/api/assets?${new URLSearchParams({ projectId: project.id, title: 'Rusty blade' })}`, { data: png, headers: { 'content-type': 'image/png' } });
  expect(added.status()).toBe(200);
  const before = (await snapshot(page)).entryTypes.find((t: any) => t.projectId === project.id && t.key === 'weapon').picture.fileId;
  await detail.getByRole('button', { name: 'Change picture' }).click();
  await menu.getByRole('button', { name: 'From Assets…' }).click();
  const pick = menu.getByRole('group', { name: 'Pictures in Assets' }).getByRole('button', { name: 'Picture: Rusty blade' });
  await expect(pick).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/p3-types-from-assets-dark.png`, animations: 'disabled' });
  await pick.click();
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.projectId === project.id && t.key === 'weapon').picture?.fileId).not.toBe(before);
  await detail.getByRole('button', { name: 'Change picture' }).click();
  await menu.getByRole('button', { name: 'Back to the painted picture' }).click();
  await expect.poll(async () => (await snapshot(page)).entryTypes.find((t: any) => t.projectId === project.id && t.key === 'weapon').picture).toBeNull();

  // Settings: a kind has its root's family; the key is read-only.
  await detail.getByRole('tab', { name: 'Settings' }).click();
  await expect(detail.getByLabel('Family')).toBeDisabled();
  await expect(detail.getByLabel('Family')).toContainText('Items');
  await expect(detail.getByText("A kind of another type sits in that type's family.")).toBeVisible();
  await expect(detail.getByLabel('Key', { exact: true })).toHaveAttribute('readonly', '');
  await page.screenshot({ path: `${SHOTS}/p3-types-settings-dark.png`, animations: 'disabled' });

  // "+": a new type in Places opens.
  await tree.getByRole('button', { name: 'New type' }).click();
  const form = tree.getByRole('form', { name: 'New type' });
  await form.getByLabel('Name of the new type').fill('Shipwreck');
  await form.getByLabel('Family').selectOption({ label: 'Places' });
  await form.getByRole('button', { name: 'Make type' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/types/shipwreck$`));
  await expect(page.getByRole('region', { name: 'Shipwreck' }).getByText('Places', { exact: true })).toBeVisible();
  await expect(fam('Places')).toHaveAttribute('aria-expanded', 'true');

  // Families: deleting one moves its types to No family.
  await tree.getByRole('button', { name: 'Families' }).click();
  const panel = tree.getByRole('region', { name: 'Families' });
  // Dragging the colour picker changes the swatch only; the colour is saved once, when the picker closes.
  const saves: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/dispatch/wiki/updateFamily')) saves.push(r.postData() ?? ''); });
  await panel.getByLabel('Colour of Places').evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const c of ['#111111', '#222222', '#334455']) { set.call(el, c); el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(async () => (await snapshot(page)).entryFamilies.find((f: any) => f.projectId === project.id && f.name === 'Places').color).toBe('#334455');
  expect(saves).toHaveLength(1);
  await panel.getByRole('button', { name: 'Delete Production' }).click();
  await expect(panel.getByRole('group', { name: 'Confirm delete Production' })).toContainText('Its type moves to No family. No type is deleted.');
  await panel.getByRole('button', { name: 'Delete family' }).click();
  await expect(fam('Production')).toHaveCount(0);
  await expect(fam('No family')).toBeVisible();
  expect((await snapshot(page)).entryTypes.some((t: any) => t.projectId === project.id && t.key === 'asset')).toBe(true);
  await tree.getByRole('button', { name: 'Families' }).click();

  await shots(page, seq);
});

/** The Types page in both looks (tree with a type open, inherited fields, picture menu, settings). */
async function shots(page: Page, seq: number) {
  for (const look of ['dark', 'light'] as const) {
    await page.evaluate((l) => localStorage.setItem('ql.look', l), look);
    await page.goto(`/wiki/${seq}/types/weapon`);
    const detail = page.getByRole('region', { name: 'Weapon' });
    await expect(detail.getByRole('heading', { level: 1 })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/p3-types-tree-${look}.png`, animations: 'disabled' });
    await detail.getByRole('button', { name: 'Change picture' }).click();
    await page.screenshot({ path: `${SHOTS}/p3-types-picture-${look}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await detail.getByRole('tab', { name: 'Settings' }).click();
    await page.screenshot({ path: `${SHOTS}/p3-types-settings-${look}.png`, animations: 'disabled' });
  }
  await page.evaluate(() => localStorage.setItem('ql.look', 'dark'));
}

test('old links to entry types open the Wiki\'s Types', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Old links');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  await run(page, 'wiki', 'addStarterPack', { projectId: project.id, core: true });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  // The workspace menu's Entry types.
  await page.goto(`/wiki/${seq}?menu=types`);
  await page.getByRole('button', { name: 'Open Types in the Wiki' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/types/[a-z_]+$`));
  // Project settings' Entity types tab: picked inside the dialog it keeps the dialog (and unsaved edits) and offers
  // a button; arrow keys pass through it too.
  await page.goto('/decks');
  await page.getByRole('region', { name }).getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByLabel('Project name').fill(`${name} renamed`);
  await dialog.getByRole('tab', { name: 'General' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Entity types' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/decks$/);
  await dialog.getByRole('tab', { name: 'General' }).click();
  await expect(dialog.getByLabel('Project name')).toHaveValue(`${name} renamed`);
  await dialog.getByRole('tab', { name: 'Entity types' }).click();
  await dialog.getByRole('button', { name: 'Open Types in the Wiki' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/types/[a-z_]+$`));
  await expect(page.getByRole('region', { name: 'Entry types' })).toBeVisible();
});
