import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { addDays } from '../shared/schedule';
import { ensureWorkspace, run, snapshot, SHOTS, unique } from './helpers';

const pad = (n: number) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const zone = (page: Page, name: string) => page.getByTestId('zone-column').filter({ has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });

test('milestone page', async ({ page }) => {
  await ensureWorkspace(page);
  const me = (await snapshot(page)).me.id as string;
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Plan') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Plan list', projectId: project.id });
  const mk = (content: string) => run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content, assigneeId: me });
  const a = await mk('Plan alpha');
  const b = await mk('Plan bravo');
  const msName = unique('M1');
  const ms = await run<{ id: string; accountSeq: number }>(page, 'milestones', 'create', {
    name: msName, date: addDays(localToday(), 9), startDate: null, color: 'blue', isGlobal: false, projectIds: [project.id] });
  const runLabel = unique('Wave');
  const cfg = await run<{ id: string; sprints: { id: string }[] }>(page, 'sprints', 'createConfig', {
    name: Array.from({ length: 5 }, () => 'abcdefghij'[Math.floor(Math.random() * 10)]).join(''), runLabelTemplate: `${runLabel} %RUN_NR%`, color: 'orange', upcomingSprints: 2, sprintDurationWeeks: 2,
    sprintStartDate: localToday(), moveOnFinish: [], isGlobal: false, projectIds: [project.id] });
  const runId = cfg.sprints[0].id;

  // Quick buttons in the card's Properties tab.
  for (const c of [a, b]) {
    await page.goto(`/card/${cardCode(c.accountSeq)}`);
    await page.getByRole('tab', { name: 'Properties' }).click();
    const props = page.getByRole('tabpanel', { name: 'Properties' });
    await props.getByRole('button', { name: new RegExp(`^${msName} \\d+d`) }).click();
    await expect(props.getByRole('button', { name: new RegExp(`^${msName} \\d+d`) })).toHaveAttribute('aria-pressed', 'true');
    if (c === a) {
      await props.getByRole('button', { name: new RegExp(`^${runLabel} 1 `) }).click();
      await expect(props.getByRole('button', { name: new RegExp(`^${runLabel} 1 `) })).toHaveAttribute('aria-pressed', 'true');
    }
  }

  // The milestone page.
  await page.goto(`/milestones/${ms.accountSeq}`);
  await expect(page.getByRole('heading', { level: 1, name: msName })).toBeVisible();
  await expect(page.getByTestId('milestone-when')).toContainText(/in \d+ workdays/);
  const def = zone(page, 'Default Zone');
  await expect(def.getByTestId('card-tile')).toHaveCount(2);
  await expect(page.getByRole('img', { name: /burn chart/i })).toBeVisible();

  await page.getByRole('button', { name: 'Add Zone' }).click();
  await page.getByLabel('Zone name').fill('Polish');
  await page.keyboard.press('Enter');
  const polish = zone(page, 'Polish');
  await expect(polish).toBeVisible();
  await def.getByTestId('card-tile').filter({ hasText: 'Plan alpha' }).dragTo(polish);
  await expect(polish.getByTestId('card-tile').filter({ hasText: 'Plan alpha' })).toBeVisible();
  await page.reload();
  await expect(zone(page, 'Polish').getByTestId('card-tile')).toHaveCount(1);
  // Keyboard alternative: a zone select per card.
  await zone(page, 'Polish').getByLabel('Zone for Plan alpha').selectOption({ label: 'Default Zone' });
  await expect(zone(page, 'Default Zone').getByTestId('card-tile')).toHaveCount(2);

  // Edit shows the card count and the Ctrl + Click hint.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit milestone' });
  await expect(dlg.getByText('Ctrl + Click selects target project and deselects all others')).toBeVisible();
  await expect(dlg.getByText('2 tasks')).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  // Pin: shows in the Hand sidebar.
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.goto('/');
  await expect(page.getByTestId('widget-milestones').getByRole('link', { name: new RegExp(msName) })).toBeVisible();
  await expect(page.getByTestId(`widget-run-${runId}`)).toContainText('Sprint 1');
  await expect(page.getByTestId(`widget-run-${runId}`).locator('.tab-count')).toHaveText('1');

  // The run page.
  const runSeq = (await snapshot(page)).sprints.find((s: any) => s.id === runId).accountSeq as number;
  await page.goto(`/milestones/run/${runSeq}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`${runLabel} 1`) })).toBeVisible();
  await expect(page.getByTestId('card-tile').filter({ hasText: 'Plan alpha' })).toBeVisible();
  await expect(page.getByRole('img', { name: /burn chart/i })).toBeVisible();

  await page.goto(`/milestones/${ms.accountSeq}`);
  await page.screenshot({ path: `${SHOTS}/phase4-milestone.png`, fullPage: true });

  // Delete asks first.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /Delete milestone/ });
  await confirm.getByRole('button', { name: 'Delete milestone' }).click();
  await expect(page).toHaveURL(/\/milestones$/);
});

test('renaming a milestone keeps its archived projects', async ({ page }) => {
  await ensureWorkspace(page);
  const live = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Live') });
  const old = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Old') });
  const ms = await run<{ id: string; accountSeq: number }>(page, 'milestones', 'create', {
    name: unique('Keep'), date: addDays(localToday(), 9), startDate: null, color: 'blue', isGlobal: false, projectIds: [live.id, old.id] });
  await run(page, 'projects', 'update', { id: old.id, isArchived: true });
  await page.goto(`/milestones/${ms.accountSeq}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit milestone' });
  const renamed = unique('Renamed');
  await dlg.getByLabel('Title').fill(renamed);
  await dlg.getByRole('button', { name: 'Save Milestone' }).click();
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  const saved = (await snapshot(page)).milestones.find((m: any) => m.id === ms.id);
  expect([...saved.projectIds].sort()).toEqual([live.id, old.id].sort());
});
