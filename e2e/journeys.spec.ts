import { test, expect } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

test('journey: a manager defines steps, applying turns a card into a hero', async ({ page }) => {
  await ensureWorkspace(page);
  const snap = await snapshot(page);
  await run(page, 'accounts', 'update', { settings: { ...snap.account.settings, workflowMode: 'journeys' } });
  try {
    const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Journey proj') });
    const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Journey list'), projectId: project.id, spaceId: 1 });
    const card = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Ship the thing' });
    const deckSeq = (await snapshot(page)).decks.find((d: any) => d.id === deck.id).seq as number;

    await page.goto(`/decks/${deckSeq}`);
    await page.getByRole('button', { name: 'More list options' }).click();
    await page.getByRole('button', { name: 'Task chain', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Task chain' });
    await dialog.getByRole('button', { name: 'Add step' }).click();
    await dialog.getByLabel('Step 1 title').fill('Concept');
    await dialog.getByRole('group', { name: 'Priority' }).first().getByRole('button').first().click();
    await dialog.getByRole('button', { name: 'Add step' }).click();
    await dialog.getByLabel('Step 2 title').fill('Build');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await snapshot(page)).journeys.length).toBe(1);

    await page.goto(`/card/${cardCode(card.accountSeq)}`);
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Apply task chain' }).click();
    await page.getByRole('tab', { name: /Subtasks/ }).click();
    const subs = page.getByRole('list', { name: 'Subtasks' }).getByRole('listitem');
    await expect(subs).toHaveCount(2);
    await expect(subs.nth(0)).toContainText('Concept');
    await expect(subs.nth(1)).toContainText('Build');
  } finally {
    await run(page, 'accounts', 'update', { settings: { ...snap.account.settings, workflowMode: null } });
  }
});
