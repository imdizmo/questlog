import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { ensureWorkspace, run, snapshot, unique } from './helpers';
import { cardCode } from '../shared/cards';

// Nothing leaves the machine: the test posts a signed push to its own server (localhost), as a git host would.
test('a signed GitHub push adds the commit to the history of the card it names', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Forge') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Anvils', projectId: project.id });
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Sharpen the horn' });
  const seq = (await snapshot(page)).cards.find((c: any) => c.id === card.id).seq as number;

  await page.goto('/decks?show=accountSettings');
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await settings.getByRole('tab', { name: 'GitHub' }).click();
  // Opening a git tab completes the onboarding step.
  await expect.poll(async () => (await snapshot(page)).onboarding.some((o: any) => o.step === 'applySCMIntegration')).toBe(true);
  await settings.getByRole('button', { name: 'Generate webhook URL' }).click();
  const url = await settings.getByLabel('Payload URL').inputValue();
  const secret = await settings.getByLabel('Secret', { exact: true }).inputValue();
  expect(url).toMatch(/\/integrations\/github\/[\w-]+$/);

  const body = JSON.stringify({ commits: [{ id: 'abcdef0123456789abcdef0123456789abcdef01', message: `Hone the horn $${cardCode(seq)}`, url: 'https://git.example/c/abcdef0', author: { name: 'Dev One' } }] });
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const path = new URL(url).pathname;
  const bad = await page.request.post(path, { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
  expect(bad.status()).toBe(401);
  const good = await page.request.post(path, { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': signature } });
  expect(good.status()).toBe(200);

  const rows = await (await page.request.get(`/api/cards/${card.id}/history`)).json();
  expect(JSON.stringify(rows)).toContain('abcdef0123456789abcdef0123456789abcdef01');

  // The webhook list shows the delivery; clean up for later runs.
  await settings.getByRole('tab', { name: 'Steam' }).click();
  await expect(settings.getByText('Steam reviews are not connected')).toBeVisible();
  await settings.getByRole('tab', { name: 'GitHub' }).click();
  await expect(settings.getByText(/last delivery \d/)).toBeVisible();
  await settings.getByRole('button', { name: 'Delete' }).first().click();
  await expect(settings.getByText('None yet.')).toBeVisible();
});
