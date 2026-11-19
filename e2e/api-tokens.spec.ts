import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, newPerson, run, unique } from './helpers';

/** A project with one deck and one card whose text is `content`. */
async function projectWithCard(page: Page, name: string, content: string) {
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('List'), projectId: project.id, spaceId: 1 });
  await run(page, 'cards', 'create', { deckId: deck.id, content });
  return project.id;
}

/** Calls the read API with a bearer token from a context that has no session cookie. */
const queryWith = (page: Page, token: string) =>
  page.evaluate(async (t) => {
    const r = await fetch('/api/query', {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ query: { _root: [{ cards: ['title'] }] } }),
    });
    return { status: r.status, body: await r.json() };
  }, token);

test('admin creates a limited read token, uses it, revokes it; a member sees only personal tokens', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const mine = unique('Tokens in');
  const other = unique('Tokens out');
  const cardIn = unique('Visible task');
  const cardOut = unique('Hidden task');
  await projectWithCard(page, mine, cardIn);
  await projectWithCard(page, other, cardOut);

  await page.goto('/decks?menu=preferences/tokens');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });
  await expect(settings.getByRole('heading', { name: 'Organization tokens' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Personal tokens' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: "Other members' tokens" })).toBeVisible();

  const label = unique('Reader');
  await settings.getByRole('button', { name: 'New organization token' }).click();
  const dlg = page.getByRole('dialog', { name: 'New token' });
  await dlg.getByLabel('Name').fill(label);
  await dlg.getByRole('radio', { name: /^Limited/ }).check();
  await dlg.getByRole('radio', { name: /^Read$/ }).check();
  await dlg.getByRole('checkbox', { name: mine }).check();
  await dlg.getByRole('button', { name: 'Create' }).click();

  await expect(dlg.getByText("You won't see this again")).toBeVisible();
  const token = await dlg.getByLabel('Token').inputValue();
  expect(token).toMatch(/^jtat_/);
  // The reveal moves focus to the (selected) token field.
  await expect(dlg.getByLabel('Token')).toBeFocused();
  await dlg.getByRole('button', { name: 'Copy' }).click();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();

  // The plain token is gone from the page once the dialog is closed: no field value, no markup.
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0);
  const leaked = await page.evaluate((t) =>
    [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].some((e) => e.value.includes(t))
    || document.documentElement.outerHTML.includes(t), token);
  expect(leaked).toBe(false);
  const row = settings.getByRole('row', { name: new RegExp(label) });
  await expect(row).toContainText('Limited');
  await expect(row).toContainText('Read');
  await expect(row).toContainText(mine);

  const ok = await queryWith(page, token);
  expect(ok.status).toBe(200);
  const titles = Object.values<any>(ok.body.cards ?? {}).map((c) => c.title ?? '');
  expect(titles.some((t) => t.includes(cardIn))).toBe(true);
  expect(titles.some((t) => t.includes(cardOut))).toBe(false);

  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog', { name: /Revoke/ }).getByRole('button', { name: 'Revoke' }).click();
  await expect(settings.getByRole('row', { name: new RegExp(label) })).toHaveCount(0);
  expect((await queryWith(page, token)).status).toBe(401);

  // Personal tokens switch (admins).
  const sw = settings.getByRole('switch', { name: 'Allow personal tokens in this workspace' });
  if (!(await sw.isChecked())) await sw.click();
  await expect(sw).toBeChecked();

  // A member sees only the Personal section.
  const invite = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [] });
  const b = await newPerson(browser);
  await b.goto(`/join/${invite.token}`);
  await b.getByLabel('Your name').fill('Tess Member');
  await b.getByLabel('Email').fill(`tess.${Date.now()}@example.com`);
  await b.getByLabel('Password').fill('another good password');
  await b.getByRole('button', { name: 'Join' }).click();
  await expect(b).toHaveURL(/\/decks$/);
  await b.getByRole('button', { name: 'Account menu' }).click();
  await b.getByRole('menuitem', { name: 'API tokens' }).click();
  const mdlg = b.getByRole('dialog', { name: 'API tokens' });
  await expect(mdlg.getByRole('heading', { name: 'Personal tokens' })).toBeVisible();
  await expect(mdlg.getByRole('heading', { name: 'Organization tokens' })).toHaveCount(0);
  await expect(mdlg.getByRole('heading', { name: "Other members' tokens" })).toHaveCount(0);
  await expect(mdlg.getByRole('switch')).toHaveCount(0);
  await b.context().close();
});

test('a personal token can be given "May delete"; MCP then deletes with it, a plain token cannot', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Deletes') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('List'), projectId: project.id, spaceId: 1 });
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: unique('Doomed task') });
  await page.goto('/decks?menu=preferences/tokens');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });
  const sw = settings.getByRole('switch', { name: 'Allow personal tokens in this workspace' });
  if (!(await sw.isChecked())) await sw.click();
  await expect(sw).toBeChecked();

  const make = async (label: string, mayDelete: boolean) => {
    await settings.getByRole('button', { name: 'New personal token' }).click();
    const dlg = page.getByRole('dialog', { name: 'New token' });
    await dlg.getByLabel('Name').fill(label);
    await dlg.getByRole('radio', { name: /^Admin/ }).check();
    const box = dlg.getByRole('checkbox', { name: /^May delete/ });
    await expect(dlg.getByText('Lets this token delete through the API and MCP', { exact: false })).toBeVisible();
    // Off by default, and only for Read & write.
    await expect(box).not.toBeChecked();
    await dlg.getByRole('radio', { name: /^Read$/ }).check();
    await expect(box).toBeDisabled();
    await dlg.getByRole('radio', { name: /^Read & write$/ }).check();
    await expect(box).toBeEnabled();
    if (mayDelete) await box.check();
    await dlg.getByRole('button', { name: 'Create' }).click();
    const token = await dlg.getByLabel('Token', { exact: true }).inputValue();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeHidden();
    return token;
  };
  const delLabel = unique('Deleter');
  const plainLabel = unique('Plain');
  const del = await make(delLabel, true);
  const plain = await make(plainLabel, false);
  await expect(settings.getByRole('row', { name: new RegExp(delLabel) })).toContainText('May delete');
  await expect(settings.getByRole('row', { name: new RegExp(plainLabel) })).not.toContainText('May delete');

  const deleteCard = async (token: string) => (await (await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_cards', arguments: { cardIds: [card.id] } } },
  })).json()).result;
  const refused = await deleteCard(plain);
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('delete_not_allowed');
  expect((await deleteCard(del)).isError).toBeFalsy();

  // The command API asks for the same: a plain token can't delete there either, the may-delete token can.
  const other = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: unique('Second doomed task') });
  const viaApi = (token: string) => page.request.post('/dispatch/cards/update', {
    headers: { authorization: `Bearer ${token}` }, data: { id: other.id, visibility: 'deleted' },
  });
  const no = await viaApi(plain);
  expect(no.status()).toBe(403);
  expect((await no.json()).error).toBe('token_cannot_delete');
  expect((await viaApi(del)).status()).toBe(200);
});

test('MCP page shows the switch and connection instructions', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=connections/mcp');
  const settings = page.getByRole('dialog', { name: 'Workspace menu' });
  const sw = settings.getByRole('switch', { name: 'Enabled' });
  await expect(sw).toBeChecked();
  await expect(settings.getByText('How to connect')).toBeVisible();
  await expect(settings.getByLabel('MCP endpoint')).toHaveValue(`${new URL(page.url()).origin}/mcp`);
  // The switch follows the server's answer, so it flips a moment after the click.
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get('/api/snapshot')).json()).account.settings.mcpEnabled).toBe(false);
  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(async () => (await (await page.request.get('/api/snapshot')).json()).account.settings.mcpEnabled).toBe(true);

  // A tool call with a personal token shows up in the usage numbers and the connections table.
  const created = await page.request.post('/dispatch/apiTokens/create', { data: { kind: 'user', label: 'MCP e2e', role: 'admin', access: 'read', projectIds: [] } });
  expect(created.ok()).toBe(true);
  const token = (await created.json()).payload.token as string;
  const call = await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } },
  });
  expect((await call.json()).result.isError).toBeFalsy();
  await settings.getByRole('tab', { name: 'Discord' }).click();
  await settings.getByRole('tab', { name: 'AI assistants (MCP)' }).click();
  await expect(settings.getByText(/Tool calls today/)).toBeVisible();
  await expect(settings.getByRole('heading', { name: "Members' connections" })).toBeVisible();
});
