import { test, expect } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

test('activity', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Harbor') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Boats', projectId: project.id });
  const snap0 = await snapshot(page);
  const deckSeq = snap0.decks.find((d: any) => d.id === deck.id).seq as number;
  const deckPath = `/decks/${deckSeq}-boats`;
  await page.goto(deckPath);
  await expect(page.getByRole('heading', { name: 'Boats' })).toBeVisible();

  // The page is open while the work happens: the box refreshes from live events.
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Rudder' });
  await run(page, 'cards', 'update', { id: card.id, priority: 'a' });
  await run(page, 'cards', 'update', { id: card.id, effort: 5 });
  await run(page, 'resolvables', 'create', { cardId: card.id, context: 'comment', content: 'Looks <b>solid</b> to me' });

  const box = page.getByRole('region', { name: 'Latest activity' });
  await expect(box).toContainText('Priority set to High and Effort set to 5');
  await expect(box.getByRole('link', { name: 'Rudder' }).first()).toBeVisible();

  await box.getByRole('link', { name: 'See all' }).click();
  await expect(page).toHaveURL(new RegExp(`${deckPath}/activity$`));
  await expect(page.getByRole('heading', { name: 'Activity for Boats' })).toBeVisible();
  const feed = page.getByTestId('activity-list');
  await expect(feed).toContainText('Priority set to High and Effort set to 5');
  await expect(feed).toContainText('wrote Looks <b>solid</b> to me');
  await page.screenshot({ path: `${SHOTS}/phase3-activity.png`, animations: 'disabled' });

  // Only the conversation entries remain under Conversations.
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(feed).toContainText('wrote Looks');
  await expect(feed).not.toContainText('Priority set');
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(feed).toContainText('Priority set');

  await page.getByRole('link', { name: 'Back to Tasks' }).click();
  await expect(page).toHaveURL(new RegExp(`${deckPath}$`));

  // Switching decks must never show the previous deck's activity.
  const deckB = await run<{ id: string }>(page, 'decks', 'create', { title: 'Sails', projectId: project.id });
  await run(page, 'cards', 'create', { deckId: deckB.id, content: 'Mainsail' });
  const seqB = (await snapshot(page)).decks.find((d: any) => d.id === deckB.id).seq as number;
  await page.goto(`/decks/${deckSeq}-boats`);
  await expect(page.getByRole('region', { name: 'Latest activity' })).toContainText('Rudder');
  // Record every text the Latest-activity section ever shows, so a stale flash cannot be waited out.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__seen = seen;
    const rec = () => { const r = document.querySelector('section[aria-label="Latest activity"]'); if (r) seen.push(r.textContent ?? ''); };
    new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.evaluate((to) => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')); }, `/decks/${seqB}-sails`);
  await expect(page.getByRole('heading', { name: 'Sails' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Latest activity' })).toContainText('Mainsail');
  const seen = await page.evaluate(() => (window as any).__seen as string[]);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((t) => t.includes('Rudder'))).toEqual([]);

  // Project-wide feed.
  await page.goto('/decks/activity');
  await expect(page.getByRole('heading', { name: /^Activity for / })).toBeVisible();
  await expect(page.getByTestId('activity-list')).toBeVisible();
});

test('milestone activity', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Dock') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Piers', projectId: project.id });
  const ms = await run<{ id: string; accountSeq: number }>(page, 'milestones', 'create', {
    name: 'Launch', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [project.id],
  });
  const path = `/milestones/${ms.accountSeq}`;
  await page.goto(path);
  await expect(page.getByTestId('milestone-page')).toBeVisible();
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Plank' });
  await run(page, 'cards', 'update', { id: card.id, milestoneId: ms.id });
  await run(page, 'cards', 'update', { id: card.id, priority: 'a' });
  await run(page, 'resolvables', 'create', { cardId: card.id, context: 'comment', content: 'Needs sanding' });

  const box = page.getByRole('region', { name: 'Latest activity' });
  await expect(box).toContainText('added to Launch');
  await box.getByRole('link', { name: 'See all' }).click();
  await expect(page).toHaveURL(new RegExp(`${path}/activity$`));
  await expect(page.getByRole('heading', { name: 'Activity for Launch' })).toBeVisible();
  const feed = page.getByTestId('activity-list');
  await expect(feed).toContainText('Priority set to High');
  await expect(feed).toContainText('wrote Needs sanding');

  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(feed).toContainText('wrote Needs sanding');
  await expect(feed).not.toContainText('Priority set');
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(feed).toContainText('Priority set');

  await page.getByRole('link', { name: 'Back to Tasks' }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
});
