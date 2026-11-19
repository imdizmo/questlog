import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, OWNER, SHOTS } from './helpers';
import { BASE_URL } from '../playwright.config';

// The workspace switcher's second line (it replaced the badge) and the New project dialog's "Goes to" line. The e2e server runs without the
// desktop app's JT_WORKSPACE_LABEL, so it is a team server named by the address it is reached at.
const host = new URL(BASE_URL).host;
const badge = (page: Page) => page.getByTestId('workspace-badge');

test('the top bar says which workspace this is, and New project says where it goes', async ({ page }) => {
  await ensureWorkspace(page);
  await expect(badge(page)).toHaveText(`Team: ${host}`);
  await expect(page.getByRole('button', { name: /^Workspace:/ })).toHaveAccessibleName(`Workspace: ${OWNER.workspace}, Team: ${host}`);
  await page.locator('header.topbar').screenshot({ path: `${SHOTS}/workspace-badge-team.png` });
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog.getByTestId('new-project-goes-to')).toHaveText(`Goes to: Team ${host}`);
  await dialog.screenshot({ path: `${SHOTS}/new-project-goes-to.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('on the desktop app\'s own server it says This computer', async ({ page }) => {
  // As /api/status answers with JT_WORKSPACE_LABEL set (tests/workspace-kind.test.ts covers the server side).
  await page.route('**/api/status', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace: { kind: 'local', label: 'This computer' } } });
  });
  await ensureWorkspace(page);
  await expect(badge(page)).toHaveText('This computer');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('dialog', { name: 'New project' }).getByTestId('new-project-goes-to')).toHaveText('Goes to: This computer');
  await page.locator('header.topbar').screenshot({ path: `${SHOTS}/workspace-badge-local.png` });
});

test('the switcher does not crowd the top bar in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 640 }); // the desktop window at 900 px, less the strip
  await ensureWorkspace(page);
  await expect(badge(page)).toBeVisible();
  const [b, search] = await Promise.all([page.getByRole('button', { name: /^Workspace:/ }).boundingBox(), page.locator('header.topbar .sbox').boundingBox()]);
  expect(b!.width).toBeLessThanOrEqual(231);
  expect(search!.height).toBeLessThan(60);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('header.topbar').screenshot({ path: `${SHOTS}/workspace-badge-narrow.png` });
});
