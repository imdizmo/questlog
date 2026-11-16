import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, SHOTS, unique } from './helpers';

async function seed(page: Page) {
  await ensureWorkspace(page);
  const snap0 = await snapshot(page);
  const me = snap0.me.id as string;
  // Start from an empty Hand (other specs leave cards in it).
  const mine = (snap0.handCards as any[]).filter((h) => h.userId === me).map((h) => h.cardId);
  if (mine.length) await run(page, 'handQueue', 'removeCards', { cardIds: mine, userId: me });
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Hand proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Hand list'), projectId: project.id, spaceId: 1 });
  return { me, deckId: deck.id };
}

const mk = async (page: Page, deckId: string, content: string, extra: object = {}) => {
  const c = await run<{ accountSeq: number }>(page, 'cards', 'create', { deckId, content, ...extra });
  return cardCode(c.accountSeq);
};

const slotTitles = (page: Page) => page.getByTestId('hand-card').locator('.hand-title');

test('nav shortcuts and timezone', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
  await page.keyboard.press('Shift+Digit2');
  await expect(page).toHaveURL(/\/decks$/);
  await page.keyboard.press('Shift+Digit3');
  await expect(page).toHaveURL(/\/milestones$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Milestones' })).toBeVisible();
  await page.keyboard.press('Shift+Digit1');
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(async () => (await snapshot(page)).me.timezone).toBeTruthy();
});

test('timezone is sent only when it differs', async ({ browser }) => {
  const sent = async (zone: string) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:8781', timezoneId: zone });
    const page = await ctx.newPage();
    const posts: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/dispatch/users/update')) posts.push(r.postData() ?? ''); });
    await ensureWorkspace(page);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.waitForTimeout(800);
    const tz = (await snapshot(page)).me.timezone;
    await ctx.close();
    return { posts, tz };
  };
  const first = await sent('Europe/Paris');
  expect(first.tz).toBe('Europe/Paris');
  const same = await sent('Europe/Paris');
  expect(same.posts).toHaveLength(0);
  const other = await sent('Asia/Tokyo');
  expect(other.posts).toHaveLength(1);
  expect(other.tz).toBe('Asia/Tokyo');
});
