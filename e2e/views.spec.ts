import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, newPerson, run, snapshot, unique, OWNER } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const me = (await snapshot(page)).me.id as string;
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Views proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Views list'), projectId: project.id, spaceId: 1 });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Mine high', priority: 'a', assigneeId: me });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Nobody low', priority: 'c' });
  const seq = (await snapshot(page)).decks.find((d: any) => d.id === deck.id).seq as number;
  return { deckPath: `/decks/${seq}` };
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Order' });
const head = (page: Page, name: string) => page.getByRole('heading', { level: 3, name, exact: true });

test('deck order panel: grouping, persistence, table, multi sort, default view', async ({ page, browser }) => {
  const { deckPath } = await seed(page);
  await page.goto(deckPath);
  await expect(head(page, 'High')).toBeVisible();

  await page.getByRole('button', { name: 'Order' }).click();
  await expect(page).toHaveURL(/panel=sort/);
  await expect(panel(page).getByRole('heading', { name: 'Order' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Owner', exact: true }).click();
  await expect(head(page, OWNER.name)).toBeVisible();
  await expect(head(page, 'No owner')).toBeVisible();
  await expect(head(page, 'High')).toHaveCount(0);
  // Group summary: done / total (count).
  await expect(page.getByTestId('group-stats').first()).toHaveText('1 task · 0 of 1 effort done');

  // The view survives a reload.
  await page.reload();
  await expect(head(page, OWNER.name)).toBeVisible();

  // Table mode.
  await panel(page).getByRole('checkbox', { name: 'Table' }).check();
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('link', { name: 'Mine high' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Nobody low' })).toBeVisible();
  await panel(page).getByRole('checkbox', { name: 'Table' }).uncheck();
  await expect(table).toHaveCount(0);

  // Multi sort: Priority then Owner; Owner gets badge 2, Manual is disabled.
  await panel(page).getByRole('button', { name: 'Priority descending' }).click();
  await panel(page).getByRole('checkbox', { name: 'Multi Sort' }).check();
  await expect(panel(page).getByRole('button', { name: 'Manual' })).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Owner', exact: true }).click();
  await expect(panel(page).getByTestId('sort-badge-assignee')).toHaveText('2');
  await expect(panel(page).getByTestId('sort-badge-priority')).toHaveText('1');

  // Group header filter writes ?search=.
  await page.getByRole('button', { name: 'Filter by High' }).click();
  await expect(page).toHaveURL(/search=/);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
  await page.goto(`${deckPath}?panel=sort`);

  // Save Owner grouping as the default view, then a second person sees it.
  await panel(page).getByRole('checkbox', { name: 'Multi Sort' }).uncheck();
  await panel(page).getByRole('button', { name: 'Owner', exact: true }).click();
  await expect(head(page, OWNER.name)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.evaluate(() => localStorage.clear());

  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'admin', projectIds: [] });
  const b = await newPerson(browser);
  await b.goto(`/join/${token}`);
  await b.getByLabel('Your name').fill('Bea Viewer');
  await b.getByLabel('Email').fill(`bea${Date.now() % 100000}@example.com`);
  await b.getByLabel('Password').fill('another good password');
  await b.getByRole('button', { name: 'Join' }).click();
  await expect(b).toHaveURL(/\/decks$/);
  await b.goto(deckPath);
  await expect(head(b, OWNER.name)).toBeVisible();
  await expect(head(b, 'No owner')).toBeVisible();
  await b.context().close();
});

test('tag panel, hidden-cards note and the global archived filter', async ({ page }) => {
  const { deckPath } = await seed(page);
  const snap = await snapshot(page);
  const deckId = snap.decks.find((d: any) => `/decks/${d.seq}` === deckPath).id as string;
  const projectId = snap.decks.find((d: any) => d.id === deckId).projectId as string;
  await run(page, 'cards', 'create', { deckId, content: 'Tagged A one #a' });
  await run(page, 'cards', 'create', { deckId, content: 'Tagged A two #a' });
  await run(page, 'cards', 'create', { deckId, content: 'Tagged B #b' });
  const other = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Other list'), projectId, spaceId: 1 });
  const otherSeq = (await snapshot(page)).decks.find((d: any) => d.id === other.id).seq as number;
  await run(page, 'cards', 'create', { deckId: other.id, content: 'Gone task' });
  const gone = (await snapshot(page)).cards.find((c: any) => c.deckId === other.id).id as string;
  await run(page, 'cards', 'update', { id: gone, visibility: 'archived' });

  await page.goto(`${deckPath}?panel=tags`);
  const tags = page.getByRole('complementary', { name: 'Tags' });
  await expect(tags.getByRole('heading', { name: 'Tags' })).toBeVisible();
  await expect(page.getByTestId('card-tile')).toHaveCount(5);
  await expect(tags.getByRole('button', { name: 'Tag #a, 2 tasks' })).toBeVisible();
  await expect(tags.getByRole('button', { name: 'Not tagged, 2 tasks' })).toBeVisible();

  await tags.getByRole('button', { name: 'Tag #a, 2 tasks' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(2);
  await expect(page.getByText('Your filters hide 3 tasks')).toBeVisible();

  await tags.locator('label', { hasText: 'or' }).click();
  await expect(tags.getByRole('radio', { name: 'or' })).toBeChecked();
  await tags.getByRole('button', { name: 'Tag #b, 1 task' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(3);
  await expect(page.getByText('Your filters hide 2 tasks')).toBeVisible();

  await tags.getByRole('button', { name: 'Tag #a, 2 tasks' }).click();
  await tags.getByRole('button', { name: 'Tag #b, 1 task' }).click();
  await tags.getByRole('button', { name: 'Not tagged, 2 tasks' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(2);
  await expect(page.getByTestId('card-tile').filter({ hasText: 'Mine high' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByTestId('card-tile')).toHaveCount(5);
  await expect(page.getByText(/Your filters hide/)).toHaveCount(0);

  // The archived toggle is in the More row, and global across decks.
  await page.getByRole('button', { name: 'More list options' }).click();
  await expect(page.getByLabel('Include archived tasks')).not.toBeChecked();
  await page.getByLabel('Include archived tasks').check();
  await page.goto(`/decks/${otherSeq}`);
  await page.getByRole('button', { name: 'More list options' }).click();
  await expect(page.getByLabel('Include archived tasks')).toBeChecked();
  await expect(page.getByTestId('card-tile').filter({ hasText: 'Gone task' })).toHaveCount(1);
  await page.getByLabel('Include archived tasks').uncheck();
});
