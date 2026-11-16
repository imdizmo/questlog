import { test, expect } from '@playwright/test';
import { ensureWorkspace } from './helpers';

// Nothing here reaches Discord or Slack: saving settings makes no outbound call, and "Register commands" isn't clicked.
test('Discord and Slack settings keep secrets hidden: only set / not set', async ({ page }) => {
  await ensureWorkspace(page);
  const token = 'e2e-discord-bot-token-0123456789abcdefghij';
  await page.goto('/decks?show=accountSettings');
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });

  await settings.getByRole('tab', { name: 'Discord' }).click();
  await expect(settings.getByText('Karma roles')).toBeVisible();
  await settings.getByLabel('Application id').fill('123456789012345678');
  await settings.getByLabel(/^Bot token/).fill(token);
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Bot token (Set)')).toBeVisible();
  await expect(settings.getByLabel(/^Bot token/)).toHaveValue('');
  await expect(settings.getByRole('button', { name: 'Register commands with Discord' })).toBeEnabled();

  await settings.getByRole('tab', { name: 'Slack' }).click();
  await settings.getByLabel(/^Signing secret/).fill('abcdef0123456789abcdef0123456789');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Signing secret (Set)')).toBeVisible();

  const body = await page.evaluate(async () => (await fetch('/api/integrations')).text());
  expect(body).not.toContain(token);
  expect(body).not.toContain('abcdef0123456789abcdef0123456789');

  // Clean up for later runs against the same database.
  await settings.getByRole('button', { name: 'Remove' }).click();
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Signing secret (Not set)')).toBeVisible();
});
