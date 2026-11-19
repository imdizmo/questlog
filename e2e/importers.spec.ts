import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

const FIXTURE = readFileSync(new URL('../tests/fixtures/trello-board.json', import.meta.url));

test('import a Trello board export from the settings page', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Trello proj');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  await page.goto('/decks?menu=import/trello');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });

  await settings.getByLabel('Trello export (JSON)').setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: FIXTURE });
  await expect(settings.getByText('2 lists, 3 cards (2 archived, skipped), 3 labels.')).toBeVisible();
  const button = settings.getByRole('button', { name: 'Import 3 cards' });
  await button.click();
  await expect(settings.getByRole('alert')).toHaveText('Choose the project to import into.');
  await settings.getByRole('combobox', { name: 'Import into project' }).selectOption({ label: name });
  await button.click();
  await expect(settings.getByRole('status')).toHaveText('Imported 3 tasks into 2 new lists.');

  const snap = await snapshot(page);
  const decks = snap.decks.filter((d: any) => d.projectId === project.id);
  expect(decks.map((d: any) => d.title).sort()).toEqual(['Backlog', 'Doing']);
  const cards = snap.cards.filter((c: any) => decks.some((d: any) => d.id === c.deckId));
  expect(cards).toHaveLength(3);
  expect(cards.find((c: any) => c.content.startsWith('# Lantern sprite')).content).toContain('- [x] Sketch');

  // The new decks show up in the app without a reload.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByText('Backlog').first()).toBeVisible();
});

test('a file that is not a Trello export is refused in the page', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=import/trello');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });
  await settings.getByLabel('Trello export (JSON)').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(settings.getByRole('alert')).toHaveText("That doesn't look like a Trello board export (no lists or tasks).");
  await expect(settings.getByRole('button', { name: /^Import/ })).toHaveCount(0);
});
