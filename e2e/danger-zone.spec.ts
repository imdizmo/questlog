import { test, expect } from '@playwright/test';
import { ensureWorkspace, newPerson, OWNER } from './helpers';

test('owner disables the workspace, open tabs are sent to the disabled screen, owner reactivates it', async ({ page, browser }) => {
  await ensureWorkspace(page);
  // A second tab of the workspace, live on its socket.
  const other = await newPerson(browser);
  await ensureWorkspace(other);
  try {
    await page.goto('/decks?show=accountSettings');
    const settings = page.getByRole('dialog', { name: 'Workspace settings' });
    await settings.getByRole('tab', { name: 'Danger Zone' }).click();
    await expect(settings.getByText('Every project, task and file is kept.')).toBeVisible();
    await settings.getByRole('button', { name: 'Disable workspace…' }).click();

    const confirm = page.getByRole('dialog', { name: 'Disable workspace' });
    const submit = confirm.getByRole('button', { name: 'Disable workspace' });
    await expect(submit).toBeDisabled();
    await confirm.getByRole('radio', { name: 'Our project is finished' }).check();
    await confirm.getByLabel(/Is there anything we could have done better/).fill('Shipped it.');
    await expect(submit).toBeDisabled();
    await confirm.getByRole('checkbox').check();
    await submit.click();

    await expect(page.getByRole('heading', { name: 'This workspace is disabled' })).toBeVisible();
    await expect(other.getByRole('heading', { name: 'This workspace is disabled' })).toBeVisible();
    // A fresh load lands there too, and only the owner gets back in.
    await other.goto('/decks');
    await expect(other.getByRole('heading', { name: 'This workspace is disabled' })).toBeVisible();
    await other.getByLabel('Owner email').fill(OWNER.email);
    await other.getByLabel('Password').fill('not the password');
    await other.getByRole('button', { name: 'Reactivate workspace' }).click();
    await expect(other.getByRole('alert')).toHaveText('Wrong email or password.');

    await page.getByLabel('Owner email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Reactivate workspace' }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.getByRole('heading', { name: 'This workspace is disabled' })).toBeHidden();
    expect((await (await page.request.get('/api/status')).json()).disabled).toBe(false);
  } finally {
    // Never leave the shared e2e workspace disabled for the specs that follow.
    if ((await (await page.request.get('/api/status')).json()).disabled) {
      await page.request.post('/api/login', { data: { email: OWNER.email, password: OWNER.password } });
      await page.request.post('/dispatch/dangerZone/reactivate', { data: {} });
    }
    await other.context().close();
  }
});
