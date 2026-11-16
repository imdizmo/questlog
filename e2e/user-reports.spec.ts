import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, unique } from './helpers';

/** Sends a report the way a game build would: no cookie. */
const sendReport = (page: Page, token: string, content: string) =>
  page.evaluate(async ([t, c]) => {
    const r = await fetch(`/user-report/v1/create-report?token=${encodeURIComponent(t)}`, {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: c, severity: 'high' }),
    });
    return { status: r.status, body: await r.json() };
  }, [token, content] as const);

test('admin sets up user reports, a report arrives as a card, a switched-off token is refused', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Reports') });
  const deckTitle = unique('Inbox');
  await run(page, 'decks', 'create', { title: deckTitle, projectId: project.id, spaceId: 1 });

  await page.goto('/decks?show=accountSettings');
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings.getByRole('tab', { name: 'User reports (Unity)' }).click();
  await settings.getByLabel('Name of the game or app').fill('Star Cave');
  await settings.getByLabel('Create tasks in').selectOption({ label: deckTitle });
  await settings.getByRole('button', { name: 'Continue' }).click();

  const reveal = page.getByRole('dialog', { name: 'User reports are ready' });
  await expect(reveal.getByText("You won't see this again")).toBeVisible();
  const token = await reveal.getByLabel('Default report token').inputValue();
  expect(token).toMatch(/^jtrt_/);
  expect(await reveal.getByLabel('Access key').inputValue()).toMatch(/^jtrk_/);
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(reveal).toBeHidden();

  await expect(settings.getByRole('heading', { name: 'Unity plugin' })).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Severity sets priority' })).toBeChecked();
  const content = unique('Falls through the floor');
  const sent = await sendReport(page, token, content);
  expect(sent.status).toBe(200);
  expect(sent.body.ok).toBe(true);

  // The other tab shows the same app, with the HTTP how-to.
  await settings.getByRole('tab', { name: 'User reports via API' }).click();
  await expect(settings.getByRole('heading', { name: 'Send reports over HTTP' })).toBeVisible();
  const enabled = settings.getByRole('switch', { name: 'default enabled' });
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await expect.poll(async () => (await sendReport(page, token, 'refused')).status).toBe(403);

  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.goto('/decks');
  await page.getByText(deckTitle).first().click();
  await expect(page.getByTestId('card-tile').filter({ hasText: content })).toBeVisible();
});
