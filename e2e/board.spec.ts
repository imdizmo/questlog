import { test, expect } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique } from './helpers';

test('a list opens as a four-step board; the sidebar lists it; My tasks shows what I own', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run(page, 'projects', 'create', { name: unique('Board project') });
  const title = unique('Board list');
  const deck = await run(page, 'decks', 'create', { title, projectId: project.id });
  const mk = async (content: string) => (await run(page, 'cards', 'create', { deckId: deck.id, content })).id as string;
  const [, started, review, blocked, done] = [await mk('Waiting'), await mk('Under way'), await mk('To check'), await mk('Stuck'), await mk('Finished')];
  await run(page, 'cards', 'update', { id: started, status: 'started' });
  await run(page, 'cards', 'update', { id: done, status: 'done' });
  await run(page, 'resolvables', 'create', { cardId: review, context: 'review', content: 'Please check.' });
  await run(page, 'resolvables', 'create', { cardId: blocked, context: 'block', content: 'Waiting on art.' });
  const snap = await snapshot(page);
  const me = snap.me.id as string;
  await run(page, 'cards', 'update', { id: started, assigneeId: me });

  // The sidebar lists it with its open count (4 of 5 are not done), and takes us there.
  await page.goto('/decks');
  const side = page.getByRole('navigation', { name: 'Projects', exact: true });
  await side.getByRole('link', { name: `${title}, 4 open` }).click();
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Board' }).click();
  const col = (name: string) => page.getByTestId('step-board').getByRole('region', { name });
  await expect(col('To do').getByTestId('card-tile')).toHaveCount(2); // Waiting, and Stuck: blocked stays in its step
  await expect(col('To do')).toContainText('Stuck');
  await expect(col('Started')).toContainText('Under way');
  await expect(col('Review')).toContainText('To check');
  await expect(col('Done')).toContainText('Finished');
  await expect(col('Done').getByTestId('step-count')).toHaveText('1');

  // Table is one switch away, and Board comes back.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Table' }).click();
  await expect(page.getByTestId('step-board')).toHaveCount(0);
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Board' }).click();
  await expect(page.getByTestId('step-board')).toBeVisible();

  // My tasks: only what I own and have not finished.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My tasks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
  const mine = page.getByRole('region', { name: title });
  await expect(mine.getByTestId('card-tile')).toHaveCount(1);
  await expect(mine).toContainText('Under way');

  // The sidebar folds to a rail and remembers it (per person, on the server).
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/prefs/sidebar') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Open the sidebar' })).toBeVisible();
  await saved;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open the sidebar' })).toBeVisible();
  // Wait until the server has it: later specs (the wiki's panels) measure with the sidebar open.
  const reopened = page.waitForResponse((r) => r.url().endsWith('/api/prefs/sidebar') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Open the sidebar' }).click();
  await reopened;
  await expect(page.getByLabel('Find in the sidebar')).toBeVisible();
});
