import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('CSV proj') });
  const title = unique('CSV list');
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title, projectId: project.id, spaceId: 1 });
  const seq = (await snapshot(page)).decks.find((d: any) => d.id === deck.id).seq as number;
  return { title, deckPath: `/decks/${seq}`, deckId: deck.id, projectId: project.id };
}

const csv = (text: string) => ({ name: 'cards.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
const open = async (page: Page) => {
  await page.goto('/decks?show=accountSettings');
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings.getByRole('tab', { name: 'CSV import' }).click();
  return settings;
};

test('upload a CSV, map a status value, import into a deck, see the cards', async ({ page }) => {
  const { title, deckPath, deckId, projectId } = await seed(page);
  const a = unique('Alpha'), b = unique('Bravo'), c = unique('Charlie');
  const tag = `t${Date.now() % 100000}`;
  const text = `﻿Title;Unused;Status;Priority;Effort;Tags;Description\n`
    + `${a};;Open;High;3;"${tag}, skipme";"Line one\nline two"\n`
    + `${b};;Shipped;Low;2;;\n`
    + `${c};;Doing;;;;\n`;
  const settings = await open(page);
  await settings.getByLabel('CSV file').setInputFiles(csv(text));

  // Empty column dropped; headers auto-mapped.
  await expect(settings.getByRole('columnheader', { name: 'Unused' })).toHaveCount(0);
  await expect(settings.getByRole('combobox', { name: 'Title', exact: true })).toHaveValue('0');
  await expect(settings.getByLabel('Status for Doing')).toHaveValue('started');
  await settings.getByLabel('Status for Shipped').selectOption('done');
  await settings.getByLabel('Priority for High').selectOption('b');
  await settings.getByLabel('Scale factor').fill('2');
  await expect(settings.getByText('3 becomes 6')).toBeVisible();
  await settings.getByRole('button', { name: 'skipme', exact: true }).click(); // skip this tag
  const button = settings.getByRole('button', { name: 'Import 3 tasks' });
  await button.click();
  await expect(settings.getByRole('alert')).toHaveText('Choose the list to import into.');
  await settings.getByRole('combobox', { name: 'List', exact: true }).selectOption({ label: title });
  await button.click();
  await expect(settings.getByRole('status')).toHaveText('Imported 3 tasks.');

  const snap = await snapshot(page);
  const byContent = (s: string) => snap.cards.find((x: any) => x.content.includes(s));
  expect(byContent(a)).toMatchObject({ deckId, status: 'not_started', priority: 'b', effort: 6, masterTags: [tag] });
  expect(byContent(a).content).toBe(`# ${a}\n\nLine one\nline two`);
  expect(byContent(b)).toMatchObject({ status: 'done', priority: 'c', effort: 4 });
  expect(byContent(c)).toMatchObject({ status: 'started' });
  expect(snap.projects.find((p: any) => p.id === projectId).tags.map((t: any) => t.name)).toContain(tag);
  expect(snap.projects.find((p: any) => p.id === projectId).tags.map((t: any) => t.name)).not.toContain('skipme');

  await page.goto(deckPath);
  await expect(page.getByTestId('card-tile').filter({ hasText: a })).toBeVisible();
  await expect(page.getByTestId('card-tile').filter({ hasText: c })).toBeVisible();
});

test('a file with more than 2,000 cards is refused with a message; nothing is imported', async ({ page }) => {
  const { title, deckId } = await seed(page);
  const settings = await open(page);
  await settings.getByLabel('CSV file').setInputFiles(csv('Title\n' + Array.from({ length: 2001 }, (_, i) => `Row ${i}`).join('\n')));
  await settings.getByRole('combobox', { name: 'List', exact: true }).selectOption({ label: title });
  await settings.getByRole('button', { name: 'Import 2,001 tasks' }).click();
  await expect(settings.getByRole('alert')).toContainText('at most 2,000 tasks');
  const snap = await snapshot(page);
  expect(snap.cards.filter((c: any) => c.deckId === deckId)).toHaveLength(0);
});
