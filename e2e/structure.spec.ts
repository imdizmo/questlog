import { test, expect } from '@playwright/test';
import { ensureWorkspace, run, snapshot, SHOTS } from './helpers';

// The second test uses the Ember Isles project the first one created.
test.describe.configure({ mode: 'serial' });

test('owner sets up structure', async ({ page }) => {
  // On an empty database this is first-run setup, which lands on an empty Decks page.
  if (await ensureWorkspace(page)) await expect(page.getByText('No projects yet')).toBeVisible();

  // New project → one unnamed section.
  await page.getByRole('button', { name: 'New project' }).click();
  const newProject = page.getByRole('dialog', { name: 'New project' });
  await newProject.getByLabel('Project name').fill('Ember Isles');
  await newProject.getByRole('button', { name: 'Next' }).click();
  await expect(newProject.getByRole('radio', { name: /Start without template/ })).toBeChecked();
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await expect(newProject).toBeHidden();
  const project = page.getByRole('region', { name: 'Ember Isles' });
  const sections = project.getByTestId('section');
  await expect(sections).toHaveCount(1);
  await expect(sections.nth(0).getByRole('heading')).toHaveText('General');

  // New Knowledge section goes above the default one.
  await project.getByRole('button', { name: 'New area' }).click();
  const spaceDialog = page.getByRole('dialog', { name: 'New area' });
  await spaceDialog.getByRole('radio', { name: /Knowledge/ }).check();
  await spaceDialog.getByRole('button', { name: 'Add area' }).click();
  await expect(spaceDialog).toBeHidden();
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0).getByRole('heading')).toHaveText('Knowledge');
  await expect(sections.nth(1).getByRole('heading')).toHaveText('General');

  // New deck with no section chosen lands in the first section (Knowledge) as a doc deck.
  await project.getByRole('button', { name: 'New list' }).click();
  const deckDialog = page.getByRole('dialog', { name: 'New list' });
  await deckDialog.getByLabel('List name').fill('Lore');
  await deckDialog.getByRole('button', { name: 'Create list' }).click();
  await expect(deckDialog).toBeHidden();
  const knowledge = sections.nth(0);
  await expect(knowledge.getByRole('link', { name: /Lore/ })).toBeVisible();
  await expect(knowledge.getByTestId('deck-icon-doc')).toBeVisible();

  // A section with decks can't be deleted; an empty one goes at once, no confirmation.
  const knowledgeDelete = knowledge.getByRole('button', { name: 'Delete area Knowledge' });
  await expect(knowledgeDelete).toBeDisabled();
  await expect(knowledgeDelete).toHaveAccessibleDescription('Move or delete its lists first.');
  await expect(knowledge.getByRole('link', { name: 'Lore, lore list, empty', exact: true })).toBeVisible();
  await sections.nth(1).getByRole('button', { name: 'Delete area' }).click();
  await expect(sections).toHaveCount(1);
  await expect(sections.nth(0).getByRole('heading')).toHaveText('Knowledge');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/decks-page.png`, fullPage: true });
});

test('owner edits sections, reorders, hides a project and sees deck counts', async ({ page }) => {
  await ensureWorkspace(page);

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Skyward');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.getByRole('region', { name: 'Skyward' });
  const sections = project.getByTestId('section');
  await expect(sections).toHaveCount(1);

  // A Tasks section; its decks are task decks.
  await project.getByRole('button', { name: 'New area' }).click();
  await page.getByRole('radio', { name: /Tasks/ }).check();
  await page.getByRole('button', { name: 'Add area' }).click();
  await expect(sections.nth(0).getByRole('heading')).toHaveText('Tasks');
  await project.getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('List name').fill('Sprint 1');
  await page.getByRole('button', { name: 'Create list' }).click();
  await expect(sections.nth(0).getByTestId('deck-icon-task')).toBeVisible();

  // Cards arriving over the live socket update the tile counts.
  const snap = await snapshot(page);
  const deck = snap.decks.find((d: any) => d.title === 'Sprint 1');
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Rig the hero' });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Block out level 1', assigneeId: snap.me.id });
  const c3 = await run(page, 'cards', 'create', { deckId: deck.id, content: 'Fix jump', assigneeId: snap.me.id }) as { id: string };
  await run(page, 'cards', 'update', { id: c3.id, status: 'started' });
  const c4 = await run(page, 'cards', 'create', { deckId: deck.id, content: 'Sound pass' }) as { id: string };
  await run(page, 'resolvables', 'create', { cardId: c4.id, context: 'block', content: 'Waiting on audio' });
  const tile = sections.nth(0).getByTestId('deck-tile');
  await expect(tile.getByRole('link', { name: 'Sprint 1, task list, 1 unassigned, 1 assigned, 1 started, 1 blocked', exact: true })).toBeVisible();

  // Edit the default section into a custom one.
  await sections.nth(1).getByRole('button', { name: 'Edit area' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit area' });
  await edit.getByRole('radio', { name: /Custom/ }).check();
  await edit.getByLabel('Area name').fill('Art');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect(sections.nth(1).getByRole('heading')).toHaveText('Art');

  // Reorder with the keyboard-reachable arrows.
  await project.getByRole('button', { name: 'Reorder areas' }).click();
  await project.getByRole('button', { name: 'Move Art up' }).click();
  await expect(sections.nth(0).getByRole('heading')).toHaveText('Art');
  await project.getByRole('button', { name: 'Done reordering' }).click();

  // Project settings show the access table.
  await project.getByRole('button', { name: 'Project settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await expect(settings.getByRole('row', { name: /Ada Owner/ })).toContainText('Always');
  await settings.getByRole('button', { name: 'Close' }).first().click();
  await expect(settings).toBeHidden();

  // Hide a project for me only.
  const strip = page.getByRole('navigation', { name: 'Projects in view' });
  await strip.getByRole('button', { name: 'Ember Isles' }).click();
  await expect(page.getByRole('region', { name: 'Ember Isles' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/decks-page-2.png`, fullPage: true });
  await page.reload();
  await expect(project).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ember Isles' })).toHaveCount(0);
  await strip.getByRole('button', { name: 'Ember Isles' }).click();
  await expect(page.getByRole('region', { name: 'Ember Isles' })).toBeVisible();
});
