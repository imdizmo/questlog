import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/**
 * Wiki blocks (redesign phase 4): a type's template edited as a page of blocks beside an example that follows it, a
 * guided start, a Creature entry with Facts and Model side by side and Attacks and Drops tables, and bringing older
 * entries up to the template. Screenshots in both looks.
 */
test.setTimeout(120_000);

const entryPage = (page: Page) => page.getByTestId('entry-page');

/** A .glb added to the project's Assets, with a painted placeholder as its picture. */
async function addModel(page: Page, projectId: string, title: string): Promise<string> {
  return page.evaluate(async ({ projectId, title }) => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 240);
    sky.addColorStop(0, '#5f7a73'); sky.addColorStop(1, '#1c2522');
    g.fillStyle = sky; g.fillRect(0, 0, 320, 240);
    g.fillStyle = '#0f1513';
    g.beginPath(); g.ellipse(160, 160, 52, 78, 0, 0, 7); g.fill();
    g.beginPath(); g.arc(160, 72, 30, 0, 7); g.fill();
    const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    // The smallest valid binary glTF: a header and a JSON chunk naming the version.
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');
    const glb = new DataView(new ArrayBuffer(12 + 8 + json.length));
    glb.setUint32(0, 0x46546c67, true); glb.setUint32(4, 2, true); glb.setUint32(8, glb.byteLength, true);
    glb.setUint32(12, json.length, true); glb.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(glb.buffer).set(json, 20);
    const q = new URLSearchParams({ projectId, title, kind: 'model' });
    const res = await fetch(`/api/assets?${q}`, { method: 'POST', headers: { 'content-type': 'model/gltf-binary' }, body: glb.buffer });
    const id = (await res.json()).id as string;
    await fetch(`/api/assets/${id}/picture`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
    return id;
  }, { projectId, title });
}

const creatureOf = async (page: Page, projectId: string) => (await snapshot(page)).entryTypes.find((t: any) => t.projectId === projectId && t.key === 'creature');

test('wiki blocks: template editor, guided start, a creature page, bring up to date', async ({ page }) => {
  await ensureWorkspace(page);
  await page.evaluate(() => localStorage.setItem('ql.look', 'dark'));
  const name = unique('Fog Coast');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  await run(page, 'wiki', 'addStarterPack', { projectId: project.id });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  const model = await addModel(page, project.id, 'Drowned Man (placeholder)');

  // ---- The template: the starter Creature page of blocks, an example beside it that follows edits.
  await page.goto(`/wiki/${seq}/types/creature`);
  const detail = page.getByRole('region', { name: 'Creature' });
  const banner = detail.getByRole('region', { name: 'Template', exact: true });
  await expect(banner).toContainText('Editing the Creature template.');
  const blocks = detail.getByRole('region', { name: 'Template blocks' });
  for (const b of ['Facts', 'Model', 'Attacks', 'Drops', 'Behaviour']) await expect(blocks.getByRole('group', { name: `Block ${b}` })).toBeVisible();
  await expect(blocks.getByRole('group', { name: 'Block Attacks' }).getByLabel('Columns of Attacks')).toHaveValue('Attack, Damage, Wind-up (s)');
  const example = detail.getByRole('region', { name: 'Example entry' });
  await expect(example).toContainText('example');
  await expect(example).toContainText('Drowned Man');
  // A prompt edit shows in the example at once.
  await blocks.getByLabel('Writing prompt for Behaviour').fill('Idle until it hears you; then it wades straight at you.');
  await expect(example).toContainText('Idle until it hears you; then it wades straight at you.');
  // + Add block: Lines, renamed, moved up, made half width.
  await blocks.getByRole('button', { name: '+ Add block' }).click();
  await blocks.getByRole('menuitem', { name: 'Lines (barks)' }).click();
  const lines = blocks.getByRole('group', { name: 'Block Lines' });
  await lines.getByLabel('Block title').fill('Moans');
  const moans = blocks.getByRole('group', { name: 'Block Moans' });
  await moans.getByLabel('Writing prompt for Moans').fill('What the player hears before they see it.');
  await moans.getByRole('button', { name: 'Move up' }).click();
  await expect(example.getByRole('region', { name: 'Moans' })).toBeVisible();
  await banner.getByLabel('Guided start').check();
  await page.screenshot({ path: `${SHOTS}/p4-template-editing-dark.png`, animations: 'disabled', fullPage: true });
  await banner.getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await creatureOf(page, project.id)).page?.version).toBe(2);
  const saved = (await creatureOf(page, project.id)).page;
  expect(saved.guided).toBe(true);
  expect(saved.blocks.map((b: any) => b.title)).toEqual(['Facts', 'Model', 'Attacks', 'Drops', 'Moans', 'Behaviour']);

  // ---- Guided start from the Wiki's New entry: the name, then each Text/Lines/Steps block.
  await page.goto(`/wiki/${seq}`);
  await page.getByRole('button', { name: 'New entry' }).click();
  const form = page.getByRole('dialog', { name: 'New entry' });
  await form.getByLabel('Type').selectOption({ label: 'Creature' });
  await form.getByLabel('Name').fill('Gull');
  await form.getByRole('button', { name: 'Create' }).click();
  const guide = page.getByRole('dialog', { name: 'New Creature' });
  await expect(guide.getByRole('heading', { name: 'What is the Creature called?' })).toBeVisible();
  await expect(guide.getByLabel('Name')).toHaveValue('Gull');
  await guide.getByRole('button', { name: 'Next' }).click();
  await expect(guide.getByRole('heading', { name: 'Moans' })).toBeVisible();
  await guide.getByLabel('Moans').fill('Kree!\nKree kree!');
  await page.screenshot({ path: `${SHOTS}/p4-guided-dark.png`, animations: 'disabled' });
  await guide.getByRole('button', { name: 'Next' }).click();
  await expect(guide.getByRole('heading', { name: 'Behaviour' })).toBeVisible();
  await guide.getByRole('button', { name: 'Back' }).click();
  await expect(guide.getByLabel('Moans')).toHaveValue('Kree!\nKree kree!');
  await guide.getByRole('button', { name: 'Next' }).click();
  await guide.getByLabel('Behaviour').fill('Steals fish from an open pack.');
  await guide.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/gull$`));
  await expect(entryPage(page).getByRole('region', { name: 'Behaviour' })).toContainText('Steals fish from an open pack.');
  await expect(entryPage(page).getByRole('region', { name: 'Moans' }).getByRole('listitem')).toHaveText(['Kree!', 'Kree kree!']);

  // ---- A Creature page: Facts and Model side by side, Attacks and Drops tables, Behaviour text.
  const dm = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId: (await creatureOf(page, project.id)).id, name: 'Drowned Man' });
  await run(page, 'wiki', 'setEntry', { cardId: dm.id, fields: { health: 120, damage_kind: 'blunt', speed: 2.5, notices_at: 18, tameable: false, zone_tier: 1 } });
  const card = (await snapshot(page)).cards.find((c: any) => c.id === dm.id);
  const text = '# Drowned Man\n\n## Behaviour\n\nStands still in the shallows until someone wades in, then **grabs** and drags.';
  await run(page, 'cards', 'update', { id: dm.id, content: text, contentVersion: card.contentVersion });
  await page.goto(`/wiki/${seq}/${dm.key}`);
  const ep = entryPage(page);
  const modelBlock = ep.getByRole('region', { name: 'Model' });
  await modelBlock.getByRole('button', { name: 'Pick' }).click();
  await page.getByRole('dialog', { name: 'Pick for Model' }).getByRole('button', { name: 'Drowned Man (placeholder)' }).click();
  await expect(modelBlock).toContainText('Drowned Man (placeholder)');
  const attacks = ep.getByRole('region', { name: 'Attacks' });
  await attacks.getByRole('button', { name: 'Add rows' }).click();
  await attacks.getByLabel('Attack, row 1').fill('Grab');
  await attacks.getByLabel('Damage, row 1').fill('12');
  await attacks.getByLabel('Wind-up (s), row 1').fill('0.8');
  await attacks.getByRole('button', { name: '+ Row' }).click();
  await attacks.getByLabel('Attack, row 2').fill('Drag under');
  await attacks.getByLabel('Damage, row 2').fill('25');
  await attacks.getByLabel('Wind-up (s), row 2').fill('2.0');
  await attacks.getByRole('button', { name: 'Save' }).click();
  await expect(attacks.getByRole('row')).toHaveCount(3);
  const drops = ep.getByRole('region', { name: 'Drops' });
  await drops.getByRole('button', { name: 'Add rows' }).click();
  await drops.getByLabel('Item, row 1').fill('Wet rag');
  await drops.getByLabel('Chance %, row 1').fill('60');
  await drops.getByLabel('Amount, row 1').fill('1');
  await drops.getByRole('button', { name: 'Save' }).click();
  await expect(drops.getByRole('cell', { name: 'Wet rag' })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === dm.id).layout?.data).toMatchObject({
    model1: { assetId: model }, table2: { rows: [['Grab', '12', '0.8'], ['Drag under', '25', '2.0']] }, table3: { rows: [['Wet rag', '60', '1']] },
  });
  // Facts and Model sit side by side (half width); the tables span the page.
  const box = async (n: string) => (await ep.getByRole('region', { name: n }).boundingBox())!;
  const [facts, mdl, atk] = [await box('Facts'), await box('Model'), await box('Attacks')];
  expect(Math.abs(facts.y - mdl.y)).toBeLessThan(4);
  expect(mdl.x).toBeGreaterThan(facts.x + facts.width - 4);
  expect(atk.width).toBeGreaterThan(facts.width * 1.8);
  // The text is the markdown's own: byte for byte.
  expect((await snapshot(page)).cards.find((c: any) => c.id === dm.id).content).toBe(text);
  await page.screenshot({ path: `${SHOTS}/p4-creature-dark.png`, animations: 'disabled', fullPage: true });

  // ---- Bring entries up to date: a newer template, then the older entries take it.
  await page.goto(`/wiki/${seq}/types/creature`);
  await blocks.getByRole('button', { name: '+ Add block' }).click();
  await blocks.getByRole('menuitem', { name: 'Steps' }).click();
  await blocks.getByRole('group', { name: 'Block Steps' }).getByLabel('Block title').fill('How to beat it');
  await banner.getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await creatureOf(page, project.id)).page?.version).toBe(3);
  await banner.getByRole('button', { name: 'Bring entries up to date…' }).click();
  const up = page.getByRole('dialog', { name: 'Bring entries up to the template' });
  await expect(up).toContainText('2 entries were made before this version of the template.');
  await expect(up.getByRole('listitem').filter({ hasText: 'Drowned Man' })).toContainText('adds How to beat it');
  await page.screenshot({ path: `${SHOTS}/p4-bring-up-to-date-dark.png`, animations: 'disabled' });
  await up.getByRole('button', { name: 'Bring up to date' }).click();
  await expect(up.getByRole('status')).toHaveText('2 entries brought up to date.');
  await up.getByRole('button', { name: 'Close' }).last().click();
  const after = (await snapshot(page)).cards.find((c: any) => c.id === dm.id);
  expect(after.layout.version).toBe(3);
  expect(after.layout.blocks.map((b: any) => b.title)).toEqual(['Facts', 'Model', 'Attacks', 'Drops', 'Moans', 'Behaviour', 'How to beat it']);
  expect(after.layout.data.table2.rows).toHaveLength(2);
  expect(after.content).toBe(text);

  await shots(page, seq, dm.key, project.id);
});

/** The four screens in both looks. A newer template first, so "Bring entries up to date" has entries to list. */
async function shots(page: Page, seq: number, key: string, projectId: string) {
  const t = await creatureOf(page, projectId);
  await run(page, 'wiki', 'setPage', { typeId: t.id, page: { guided: t.page.guided, blocks: t.page.blocks } });
  for (const look of ['dark', 'light'] as const) {
    await page.evaluate((l) => localStorage.setItem('ql.look', l), look);
    await page.goto(`/wiki/${seq}/types/creature`);
    const detail = page.getByRole('region', { name: 'Creature' });
    await expect(detail.getByRole('region', { name: 'Example entry' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/p4-template-${look}.png`, animations: 'disabled', fullPage: true });
    await detail.getByRole('button', { name: 'Bring entries up to date…' }).click();
    await expect(page.getByRole('dialog', { name: 'Bring entries up to the template' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/p4-bring-up-to-date-${look}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await detail.getByRole('button', { name: 'Try a new Creature' }).click();
    const guide = page.getByRole('dialog', { name: 'Try a new Creature' });
    await guide.getByLabel('Name').fill('Sea Giant');
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.getByLabel('Moans').fill('A low horn from the fog.');
    await page.screenshot({ path: `${SHOTS}/p4-guided-${look}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.goto(`/wiki/${seq}/${key}`);
    await expect(page.getByTestId('entry-page').getByRole('region', { name: 'Attacks' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/p4-creature-${look}.png`, animations: 'disabled', fullPage: true });
  }
  await page.evaluate(() => localStorage.setItem('ql.look', 'dark'));
}
