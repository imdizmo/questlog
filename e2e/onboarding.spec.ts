import { test, expect } from '@playwright/test';
import { ensureWorkspace, snapshot, unique } from './helpers';

test('a project from the RPG template shows its decks; the card menu tracks first steps', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Template RPG');

  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Project name').fill(name);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('radio', { name: /Start without template/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /^RPG/ }).check();
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();

  const project = page.getByRole('region', { name });
  await expect(project.getByRole('link', { name: /^World and rules/ })).toBeVisible();
  await expect(project.getByRole('link', { name: /^Core systems/ })).toBeVisible();
  await expect(project.getByRole('link', { name: /^First town/ })).toBeVisible();
  const snap = await snapshot(page);
  const pid = snap.projects.find((p: any) => p.name === name).id;
  const decks = snap.decks.filter((d: any) => d.projectId === pid);
  expect(decks.map((d: any) => d.title).sort()).toEqual(['Core systems', 'First town', 'World and rules']);
  expect(snap.cards.filter((c: any) => decks.some((d: any) => d.id === c.deckId)).length).toBe(10);

  // The card menu shows sprint I with its steps; creating a card ticks the first one.
  const quests = page.getByRole('button', { name: /^Tutorial, part/ });
  await expect(quests).toHaveText(/^Tutorial \d+\/\d+$/);
  await quests.click();
  const pop = page.getByRole('dialog', { name: 'Tutorial' });
  await expect(pop.getByText('Create a task')).toBeVisible();
  await expect(pop.locator('[data-step="useSorting"]')).toBeVisible();
  await expect(pop.locator('[data-step="applySCMIntegration"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Adding a card in the UI completes the first step (it may already be done by an earlier spec; either way it ends up ticked).
  await project.getByRole('link', { name: /^Core systems/ }).click();
  await page.getByRole('button', { name: 'Add task' }).click();
  const panel = page.getByRole('dialog', { name: 'New task' });
  await panel.getByLabel('Task text').fill('Task task');
  await panel.getByLabel('Task text').press('Control+Enter');
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await snapshot(page)).onboarding.map((r: any) => r.step)).toContain('createCard');
  await page.getByRole('button', { name: /^Tutorial, part/ }).click();
  await expect(page.getByRole('dialog', { name: 'Tutorial' }).locator('[data-step="createCard"]')).toHaveClass(/done/);
});
