import { test, expect } from '@playwright/test';
import { isoWeek } from '../shared/schedule';
import { ensureWorkspace, run, snapshot, SHOTS, unique } from './helpers';

const pad = (n: number) => String(n).padStart(2, '0');

test('timeline', async ({ page }) => {
  await ensureWorkspace(page);
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const mid = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-15`;

  // One project in view: the dialogs pre-check what Decks shows.
  const alpha = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Alpha') });
  const snap = await snapshot(page);
  const others = (snap.projects as any[]).filter((p) => p.id !== alpha.id).map((p) => p.id as string);
  for (const id of others) await run(page, 'missionControl', 'setVisible', { projectId: id, visible: false });
  const alphaName = (snap.projects as any[]).find((p) => p.id === alpha.id).name as string;

  try {
    await page.goto('/milestones');
    await expect(page.getByRole('heading', { name: 'Milestones' })).toBeVisible();
    const strip = page.getByTestId('timeline-strip');
    await expect(strip.getByTestId('today-marker')).toBeVisible();
    await expect(strip.getByText(`W${isoWeek(today)}`, { exact: true }).first()).toBeVisible();

    // Add a milestone from the year calendar in the Add panel.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Click on Date to add Milestone')).toBeVisible();
    await page.getByTestId('year-calendar').getByRole('button', { name: mid, exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'New milestone' });
    await expect(dlg.getByLabel(alphaName)).toBeChecked();
    await dlg.getByLabel('Title').fill('M1 Alpha');
    await expect(dlg.getByLabel('Date')).toHaveValue(mid);
    await dlg.getByLabel('Color').selectOption('green');
    await dlg.getByRole('button', { name: 'Create Milestone' }).click();
    await expect(dlg).toHaveCount(0);

    await expect(strip.getByTestId('milestone-diamond').filter({ hasText: 'M1 Alpha' })).toBeVisible();
    // Runs: a label without a variable is refused, then two runs appear.
    await page.getByRole('button', { name: 'Set up Sprints' }).click();
    const runs = page.getByRole('dialog', { name: 'Set up Sprints' });
    await runs.getByLabel('Name', { exact: true }).fill('Spr');
    await runs.getByLabel('Sprint label').fill('Sprint');
    await runs.getByRole('button', { name: 'Create Sprints' }).click();
    await expect(runs.getByText('Add at least one variable')).toBeVisible();
    await runs.getByLabel('Sprint label').fill('Sprint %RUN_NR%');
    await expect(runs.getByLabel('Duration (weeks)')).toHaveValue('2');
    await expect(runs.getByLabel('Upcoming sprints')).toHaveValue('2');
    await expect(runs.getByLabel('Start date')).toHaveValue(today);
    await runs.getByRole('button', { name: 'Create Sprints' }).click();
    await expect(runs).toHaveCount(0);
    await expect(strip.getByTestId('run-bar')).toHaveCount(2);
    await expect(strip.getByTestId('run-bar').nth(0)).toContainText('Sprint 1');
    await expect(strip.getByTestId('run-bar').nth(1)).toContainText('Sprint 2');

    // Switch the main area with the header buttons; the view survives a reload.
    await page.getByRole('button', { name: 'Milestone Overview' }).click();
    await expect(page).toHaveURL(/view=overview/);
    await expect(strip).toHaveCount(0);
    await page.reload();
    const overview = page.getByTestId('milestone-overview');
    const row = overview.getByTestId('milestone-row').filter({ hasText: 'M1 Alpha' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/workdays?|today/);
    await expect(row).toContainText('0/0 tasks');
    await page.getByRole('button', { name: 'Calendar View' }).click();
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page.getByTestId('calendar-view').locator(`[data-day="${mid}"]`)).toContainText('M1 Alpha');
    await page.getByRole('button', { name: 'Calendar View' }).click(); // toggles back to the strip
    await expect(page.getByTestId('timeline-strip')).toBeVisible();

    // The window moves by 8 weeks.
    const first = await strip.getByTestId('week-label').first().textContent();
    await page.getByRole('button', { name: 'Earlier' }).click();
    expect(await strip.getByTestId('week-label').first().textContent()).not.toBe(first);

    // The Timeline is reachable with Shift+3.
    await page.goto('/decks');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await page.keyboard.press('Shift+Digit3');
    await expect(page).toHaveURL(/\/milestones$/);

    await page.screenshot({ path: `${SHOTS}/phase4-timeline.png`, fullPage: true });
  } finally {
    for (const id of others) await run(page, 'missionControl', 'setVisible', { projectId: id, visible: true });
  }
});
