import { test, expect } from '@playwright/test';
import { ensureWorkspace, unique } from './helpers';

test('invite by email lands in the outbox (log mode); my notification emails can be switched', async ({ page }) => {
  await ensureWorkspace(page);
  const addr = `${unique('guest').replace(/\W+/g, '-')}@example.com`;
  await page.goto('/decks?show=members');
  await page.getByRole('button', { name: 'Invite people' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite people' });
  await invite.getByLabel('Also email the link to (optional)').fill(addr);
  await invite.getByRole('button', { name: 'Create link' }).click();
  await expect(invite.getByText(`An email with this link to ${addr} is in the outbox.`)).toBeVisible();
  await invite.getByRole('button', { name: 'Done' }).click();

  await page.goto('/decks?menu=connections/email');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });
  await expect(settings.getByText('Log mode.')).toBeVisible();
  const row = settings.getByRole('table', { name: 'Outbox' }).getByRole('row').filter({ hasText: addr });
  await expect(row).toContainText('Invite');
  // The scheduler marks it within a minute; either state is fine here.
  await expect(row).toContainText(/Waiting|Not sent \(log mode\)/);

  await page.goto('/decks');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Email notifications' }).click();
  const prefs = page.getByRole('dialog', { name: 'Email notifications' });
  await prefs.getByLabel('No emails').check();
  await expect(prefs.getByLabel('No emails')).toBeChecked();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Email notifications' }).getByLabel('No emails')).toBeChecked();
  await page.getByRole('dialog', { name: 'Email notifications' }).getByLabel('Daily round-up').check();
  await expect(page.getByRole('dialog', { name: 'Email notifications' }).getByLabel('Daily round-up')).toBeChecked();
});
