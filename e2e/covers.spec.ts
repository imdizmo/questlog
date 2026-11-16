import { test, expect } from '@playwright/test';
import { ensureWorkspace, run, unique, SHOTS } from './helpers';

/** A 1×1 PNG, built in the test so no binary fixture is committed. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = { name: 'cover.png', mimeType: 'image/png', buffer: PNG };

test('covers', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Covered');
  await run(page, 'projects', 'create', { name });
  await page.goto('/decks');
  const project = page.getByRole('region', { name });
  const tile = (t: string) => project.getByTestId('deck-tile').filter({ hasText: t });

  // New deck with built-in artwork 3.
  await project.getByRole('button', { name: 'New list', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'New list' });
  await dlg.getByLabel('List name').fill('Boards');
  await dlg.getByRole('tab', { name: 'Artwork' }).click();
  await dlg.getByRole('radio', { name: /Artwork 3/ }).click();
  await dlg.getByRole('button', { name: 'Create list' }).click();
  await expect(tile('Boards').getByTestId('deck-cover')).toBeVisible();
  await expect(tile('Boards').getByTestId('deck-cover').locator('svg')).toHaveCount(1);

  // A deck without a cover offers an Add cover slot.
  await run(page, 'decks', 'create', { title: 'Plain', projectId: (await (await page.request.get('/api/snapshot')).json()).projects.find((p: any) => p.name === name).id });
  await page.goto('/decks');
  await expect(tile('Plain').getByRole('button', { name: 'Add cover' })).toBeVisible();

  // Edit deck: upload a PNG.
  await tile('Boards').getByRole('button', { name: 'List actions for Boards' }).click();
  await page.getByRole('menuitem', { name: 'Edit list' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit list' });
  await edit.getByRole('tab', { name: 'Upload' }).click();
  await edit.getByLabel('Cover image').setInputFiles(png);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(tile('Boards').getByTestId('deck-cover').locator('img')).toHaveAttribute('src', /^\/api\/covers\//);

  // A few artworks side by side for the screenshot.
  const pid = (await (await page.request.get('/api/snapshot')).json()).projects.find((p: any) => p.name === name).id;
  for (const id of [1, 2, 5, 8, 11, 13]) await run(page, 'decks', 'create', { title: `Art ${id}`, projectId: pid, cover: { kind: 'art', id } });
  await expect(tile('Art 13').getByTestId('deck-cover')).toBeVisible();
  await project.screenshot({ path: `${SHOTS}/phase3-covers.png` });

  // Wrong type shows a toast.
  await tile('Boards').getByRole('button', { name: 'List actions for Boards' }).click();
  await page.getByRole('menuitem', { name: 'Edit list' }).click();
  const edit2 = page.getByRole('dialog', { name: 'Edit list' });
  await edit2.getByRole('tab', { name: 'Upload' }).click();
  await edit2.getByLabel('Cover image').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByRole('status').getByText(/image/i)).toBeVisible();
  await edit2.getByRole('button', { name: 'Cancel' }).click();

  // Project settings: upload a cover, shown beside the project name.
  await project.getByRole('button', { name: 'Project settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await settings.getByRole('tab', { name: 'Upload' }).click();
  await settings.getByLabel('Cover image').setInputFiles(png);
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(project.getByTestId('project-cover').locator('img')).toHaveAttribute('src', /^\/api\/covers\//);
  await settings.getByRole('button', { name: 'Close', exact: true }).first().click();

  // None clears both.
  await tile('Boards').getByRole('button', { name: 'List actions for Boards' }).click();
  await page.getByRole('menuitem', { name: 'Edit list' }).click();
  const edit3 = page.getByRole('dialog', { name: 'Edit list' });
  await edit3.getByRole('tab', { name: 'None' }).click();
  await edit3.getByRole('button', { name: 'Save' }).click();
  await expect(tile('Boards').getByTestId('deck-cover')).toHaveCount(0);

  await project.getByRole('button', { name: 'Project settings' }).click();
  const s2 = page.getByRole('dialog', { name: 'Project settings' });
  await s2.getByRole('tab', { name: 'None' }).click();
  await s2.getByRole('button', { name: 'Save changes' }).click();
  await expect(project.getByTestId('project-cover')).toHaveCount(0);
});
