import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';
import { SECTIONS, visibleSections } from '../web/src/workspaceMenu';

const menu = (page: Page) => page.getByRole('dialog', { name: 'Workspace menu' });
const trigger = (page: Page) => page.getByRole('button', { name: /^Workspace:/ });
/** The workspace switcher's last item opens the menu (the switcher replaced the workspace name button). */
const openMenu = async (page: Page) => {
  await trigger(page).click();
  await page.getByRole('menu', { name: 'Workspaces' }).getByRole('menuitem', { name: 'Workspace settings, people, look…' }).click();
};
const nav = (page: Page) => menu(page).getByRole('tablist', { name: 'Sections' });
const pane = (page: Page) => menu(page).getByTestId('workspace-menu-pane');

/**
 * Overflow check for the open section: neither the pane nor anything in it is wider than it shows (scrollWidth ≤
 * clientWidth), nothing sticks out past the pane's right edge, and the menu itself stays inside the window. Inputs
 * are judged by their box only (a long value scrolling inside its own field is not page overflow).
 */
async function overflowOf(page: Page): Promise<string[]> {
  return page.getByTestId('workspace-menu-pane').evaluate((root) => {
    const bad: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    const paneBox = root.getBoundingClientRect();
    const dlg = root.closest('dialog')!.getBoundingClientRect();
    if (dlg.left < -1 || dlg.top < -1 || dlg.right > window.innerWidth + 1 || dlg.bottom > window.innerHeight + 1) bad.push(`menu outside the window ${JSON.stringify(dlg)}`);
    if (document.scrollingElement && document.scrollingElement.scrollWidth > window.innerWidth + 1) bad.push('page scrolls sideways');
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || el.closest('.sr-only')) continue;
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (!field && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) bad.push(`${name(el)} scrolls ${el.scrollWidth} > ${el.clientWidth}`);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && el.closest('.sr-only') === null && st.position !== 'absolute' && r.right > paneBox.right + 1) bad.push(`${name(el)} sticks out by ${Math.round(r.right - paneBox.right)}px`);
    }
    return bad.slice(0, 10);
  });
}

/** Opens each visible section (and each of its tabs) inside one page load, and checks it fits. */
async function checkAllSections(page: Page, admin: boolean, label: string) {
  const problems: string[] = [];
  await page.goto('/decks?menu=workspace');
  await expect(menu(page)).toBeVisible();
  for (const s of visibleSections({ admin })) {
    await nav(page).getByRole('tab', { name: s.label, exact: true }).click();
    await expect(menu(page).getByRole('heading', { name: s.label, level: 2 })).toBeVisible();
    for (const tab of s.tabs ?? [null]) {
      if (tab) {
        await menu(page).getByRole('tablist', { name: `${s.label} areas` }).getByRole('tab', { name: tab.label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`menu=${s.id}(/|%2F)${tab.id}`));
      }
      // Let async panels (integrations, invites, outbox) fill in before measuring.
      await expect(pane(page).getByText('Loading…')).toHaveCount(0);
      await page.waitForTimeout(150);
      for (const p of await overflowOf(page)) problems.push(`${label} ${s.id}${tab ? `/${tab.id}` : ''}: ${p}`);
    }
  }
  expect(problems).toEqual([]);
}

test('opens from the workspace switcher, every section renders, Esc returns focus', async ({ page }) => {
  await ensureWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMenu(page);
  await expect(menu(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]menu=workspace/);
  await expect(menu(page).getByRole('heading', { name: 'Workspace', level: 2 })).toBeVisible();
  // Anchored under the trigger, at the top left.
  const t = (await trigger(page).boundingBox())!;
  const m = (await menu(page).boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(t.y + t.height);
  expect(m.x).toBeLessThan(40);
  await page.screenshot({ path: `${SHOTS}/menu-workspace.png`, animations: 'disabled' });

  for (const s of SECTIONS) {
    await nav(page).getByRole('tab', { name: s.label, exact: true }).click();
    await expect(nav(page).getByRole('tab', { name: s.label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(menu(page).getByRole('heading', { name: s.label, level: 2 })).toBeVisible();
    await expect(menu(page).getByText(s.blurb)).toBeVisible();
  }
  await nav(page).getByRole('tab', { name: 'Entry types' }).click();
  await page.screenshot({ path: `${SHOTS}/menu-types.png`, animations: 'disabled' });
  await nav(page).getByRole('tab', { name: 'Guides' }).click();
  await page.screenshot({ path: `${SHOTS}/menu-guides.png`, animations: 'disabled' });

  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/menu=/);
  await expect(trigger(page)).toBeFocused();
});

test('keyboard: arrows move between sections, Enter goes into the section, focus stays inside', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=workspace');
  const tab = (name: string) => nav(page).getByRole('tab', { name, exact: true });
  await expect(tab('Workspace')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tab('Guides')).toBeFocused();
  await expect(page).toHaveURL(/menu=guides/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(tab('Disable workspace')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(tab('Features')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu(page).getByRole('switch', { name: 'Milestones' })).toBeFocused();
  // Tabbing never leaves the menu (modal): forty presses later focus is still inside.
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="workspace-menu"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
});

test('deep links open the menu at a section and tab', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=connections/discord');
  await expect(menu(page).getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
  await expect(menu(page).getByRole('tab', { name: 'Discord' })).toHaveAttribute('aria-selected', 'true');
  await expect(menu(page).getByText('Karma roles')).toBeVisible();
  // The old Workspace settings link opens the menu at the Workspace section.
  await page.goto('/decks?show=accountSettings');
  await expect(menu(page).getByRole('heading', { name: 'Workspace', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/menu=workspace/);
  await expect(page).not.toHaveURL(/show=/);
  // An unknown section opens the first one.
  await page.goto('/decks?menu=nope');
  await expect(menu(page).getByRole('heading', { name: 'Workspace', level: 2 })).toBeVisible();
  // "Open full page" leaves the menu for the page it came from.
  await page.goto('/decks?menu=members');
  await menu(page).getByRole('button', { name: 'Open full page' }).click();
  await expect(page.getByRole('dialog', { name: 'Members' })).toBeVisible();
  await expect(page).not.toHaveURL(/menu=/);
});

test('a setting saved from the menu persists', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=tasks');
  const stale = menu(page).getByLabel('Snooze untouched started tasks after (hours)');
  await expect(stale).toBeVisible();
  // The explanation is tied to the field.
  await expect(stale).toHaveAccessibleDescription(/nobody has changed for this long/);
  await stale.fill('150');
  // Moving to another section keeps the edit; one Save sends everything.
  await nav(page).getByRole('tab', { name: 'Workspace', exact: true }).click();
  const description = unique('A studio making a small cave game.');
  await menu(page).getByLabel('Description').fill(description);
  await menu(page).getByRole('radio', { name: 'Tide lines' }).click();
  await page.screenshot({ path: `${SHOTS}/menu-unsaved.png`, animations: 'disabled' });
  await menu(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').getByText('Settings saved')).toBeVisible();
  await expect(menu(page).getByRole('button', { name: 'Save changes' })).toHaveCount(0);

  await page.reload();
  await expect(menu(page).getByLabel('Description')).toHaveValue(description);
  await expect(menu(page).getByRole('radio', { name: 'Tide lines' })).toHaveAttribute('aria-checked', 'true');
  await nav(page).getByRole('tab', { name: 'Tasks' }).click();
  await expect(menu(page).getByLabel('Snooze untouched started tasks after (hours)')).toHaveValue('150');
  const s = (await snapshot(page)).account.settings;
  expect(s).toMatchObject({ staleHours: 150, description, coverArt: 3 });

  // A bad number is refused and not saved.
  await menu(page).getByLabel('Snooze untouched started tasks after (hours)').fill('');
  await menu(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Enter a number for the snooze time.')).toBeVisible();
  await menu(page).getByRole('button', { name: 'Discard' }).click();
  await expect(menu(page).getByLabel('Snooze untouched started tasks after (hours)')).toHaveValue('150');
});

test('tutorial pause and resume from Guides; the look switches to light', async ({ page }) => {
  await ensureWorkspace(page);
  await page.goto('/decks?menu=guides');
  await expect(page.getByRole('button', { name: /^Tutorial, part/ })).toBeVisible();
  const pause = menu(page).getByRole('button', { name: 'Pause tutorial' });
  if (await pause.count()) {
    await pause.click();
    await expect(menu(page).getByTestId('tutorial-state')).toContainText('Paused');
    await expect(page.getByRole('button', { name: /^Tutorial, part/ })).toHaveCount(0);
    await menu(page).getByRole('button', { name: 'Resume tutorial' }).click();
    await expect(menu(page).getByTestId('tutorial-state')).toContainText('Active');
    await expect(page.getByRole('button', { name: /^Tutorial, part/ })).toBeVisible();
  }
  await nav(page).getByRole('tab', { name: 'Look' }).click();
  await menu(page).getByRole('radio', { name: /^Light/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-look', 'light');
  await page.screenshot({ path: `${SHOTS}/menu-light.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-look', 'light');
  await menu(page).getByRole('radio', { name: /^Dark/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-look', 'dark');
});

test('Archive lists deleted tasks and brings one back; Files lists attachments', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Trash test') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Things', projectId: project.id });
  const title = unique('Thrown away');
  const card = await run<{ id: string }>(page, 'cards', 'create', { content: title, deckId: deck.id });
  await run(page, 'cards', 'update', { id: card.id, visibility: 'deleted' });
  await page.goto('/decks?menu=archive');
  const deleted = menu(page).getByRole('list', { name: 'Deleted tasks' });
  await expect(deleted.getByText(title)).toBeVisible();
  await deleted.getByRole('button', { name: `Restore ${title}` }).click();
  await expect(deleted.getByText(title)).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === card.id)?.visibility).toBe('default');

  await nav(page).getByRole('tab', { name: 'Files' }).click();
  await expect(menu(page).getByRole('searchbox', { name: 'Search files' })).toBeVisible();
});

test('the menu fits: no sideways scrolling at 1920×1160, 800×600 and 360×640', async ({ page }) => {
  test.setTimeout(480_000);
  await ensureWorkspace(page);
  // Give the wide parts something to show: a type tree, a project with a long name.
  const projectName = unique('A project with a rather long name that keeps going on and on');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: projectName });
  await run(page, 'wiki', 'addStarterPack', { projectId: project.id });
  for (const [w, h] of [[1920, 1160], [800, 600], [360, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await checkAllSections(page, true, `${w}×${h}`);
  }
  // Fuller states: a CSV loaded (its column table); Entry types leading to the Wiki.
  const text = 'Title;Status;Priority;Effort;Tags;Description;A rather long column header that goes on\n'
    + 'Alpha;Open;High;3;"x, y";"Line one";' + 'v'.repeat(120) + '\nBravo;Shipped;Low;2;;;\n';
  for (const [w, h] of [[1920, 1160], [800, 600], [360, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/decks?menu=import/csv');
    await menu(page).getByLabel('CSV file').setInputFiles({ name: 'cards.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await expect(menu(page).getByRole('button', { name: /^Import 2 tasks/ })).toBeVisible({ timeout: 15_000 });
    expect(await overflowOf(page), `${w}×${h} csv loaded`).toEqual([]);
    // Entry types moved into the Wiki: the section leads there.
    await page.goto('/decks?menu=types');
    expect(await overflowOf(page), `${w}×${h} types`).toEqual([]);
    await menu(page).getByRole('button', { name: 'Open Types in the Wiki' }).click();
    await expect(page).toHaveURL(/\/wiki\/\d+\/types\/[a-z_]+$/);
  }

  const shot = async (w: number, h: number, value: string, file: string) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/decks?menu=${value}`);
    await expect(menu(page).getByRole('heading', { level: 2 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${SHOTS}/${file}`, animations: 'disabled' });
  };
  await shot(1920, 1160, 'tasks', 'menu-tasks-1920.png');
  await shot(800, 600, 'tasks', 'menu-tasks-800.png');
  await shot(800, 600, 'members', 'menu-members-800.png');
  await shot(360, 640, 'connections/mcp', 'menu-mcp-360.png');
  await shot(1920, 1160, 'connections/discord', 'menu-discord-1920.png');
});

test('a member sees only their sections, read-only where it is the workspace\'s', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [] });
  const b = await newPerson(browser);
  await b.goto(`/join/${token}`);
  const name = unique('Mo');
  await b.getByLabel('Your name').fill(name);
  await b.getByLabel('Email').fill(`${name.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await b.getByLabel('Password').fill('another good password');
  await b.getByRole('button', { name: 'Join' }).click();
  await expect(b).toHaveURL(/\/decks$/);

  await openMenu(b);
  const tabs = nav(b).getByRole('tab');
  await expect(tabs).toHaveText(visibleSections({ admin: false }).map((s) => s.label));
  await expect(nav(b).getByRole('tab', { name: 'Members' })).toHaveCount(0);
  await expect(menu(b).getByText('Only workspace admins can change these.')).toBeVisible();
  await expect(menu(b).getByLabel('Description')).toHaveCount(0);
  // An admin link sent to a member opens the first section instead.
  await b.goto('/decks?menu=members');
  await expect(menu(b).getByRole('heading', { name: 'Workspace', level: 2 })).toBeVisible();
  await expect(b).toHaveURL(/menu=workspace/);
  await b.setViewportSize({ width: 800, height: 600 });
  await checkAllSections(b, false, 'member 800×600');
  await b.goto('/decks?menu=preferences/tokens');
  await expect(menu(b).getByRole('heading', { name: 'Personal tokens' })).toBeVisible();
  await expect(menu(b).getByRole('heading', { name: 'Organization tokens' })).toHaveCount(0);
  await b.screenshot({ path: `${SHOTS}/menu-member.png`, animations: 'disabled' });
  await b.context().close();
});

