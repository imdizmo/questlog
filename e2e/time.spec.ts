import { test, expect } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, SHOTS, unique } from './helpers';

test('time', async ({ page }) => {
  await ensureWorkspace(page);
  const snap = await snapshot(page);
  await run(page, 'accounts', 'update', { settings: { ...snap.account.settings, timeTrackingMode: 'strict' } });
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Time proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Time list'), projectId: project.id, spaceId: 1 });
  const title = unique('Tracked task');
  const c = await run<{ accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: title });
  await page.goto(`/card/${cardCode(c.accountSeq)}`);
  const card = page.getByTestId('card-page');
  const widget = page.getByTestId('timer-widget');

  // Start Card and Tracking.
  await card.getByRole('button', { name: 'Start Task and Tracking' }).click();
  await expect(page.getByTestId('card-status')).toHaveText('Started');
  await expect(widget).toContainText(`on ${title}`);
  await expect(widget).toContainText(/TOTAL 0:00:0\d/);
  const read = async () => {
    const m = (await widget.innerText()).match(/TOTAL (\d+):(\d\d):(\d\d)/)!;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  const first = await read();
  await expect.poll(read).toBeGreaterThan(first);

  // Stop.
  await card.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Start Time Tracking' })).toBeVisible();

  // Add Time: 2.5h yesterday.
  await page.getByRole('tab', { name: 'History' }).click();
  const form = page.getByTestId('add-time');
  await form.getByLabel('Duration').fill('abc');
  await expect(form.getByRole('button', { name: 'Add' })).toBeDisabled();
  await form.getByLabel('Duration').fill('2.5h');
  await form.getByRole('button', { name: 'Yesterday' }).click();
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('time-segment').filter({ hasText: '2:30' })).toHaveCount(1);

  // Alt+P toggles the timer on the open card.
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Alt+KeyP');
  await expect(card.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+KeyP');
  await expect(card.getByRole('button', { name: 'Start Time Tracking' })).toBeVisible();

  // Widget Close hides it; the Hand header shows today's total.
  await widget.getByRole('button', { name: 'Close' }).click();
  await expect(widget).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('hand-tracked')).toContainText(/\d+:\d\d h/);
  await page.goto(`/card/${cardCode(c.accountSeq)}`);
  await card.getByRole('button', { name: 'Start Time Tracking' }).click();
  await expect(widget).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phase4-timer.png` });
  await card.getByRole('button', { name: 'Stop', exact: true }).click();
});
