import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

// The redesign's shell: the sidebar (find box, main pages, project trees, quick actions, the folded rail), the tabs
// beside the workspace switcher, and the per-person preferences that bring them back.
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Open pages' }).getByRole('tab');
const activeTab = (page: Page) => page.getByRole('tablist', { name: 'Open pages' }).getByRole('tab', { selected: true });
const tree = (page: Page) => page.getByRole('navigation', { name: 'Projects', exact: true });

/** Starts each test from Home plus the Overview, whatever earlier tests left open. */
async function freshTabs(page: Page) {
  await page.evaluate(() => sessionStorage.clear()); // this window's own tabs
  await page.goto('about:blank'); // the page sends what it has first, so nothing overwrites the reset below
  for (const key of ['tabs', 'sidebar', 'sideFolds']) {
    expect((await page.request.put(`/api/prefs/${key}`, { data: { value: null } })).ok()).toBe(true);
  }
  await page.goto('/decks');
  await expect(tabs(page)).toHaveCount(2);
}

async function setUp(page: Page) {
  await ensureWorkspace(page);
  const name = unique('Shell project');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  const p = (await snapshot(page)).projects.find((x: any) => x.id === project.id);
  await run(page, 'projects', 'update', { id: project.id, spaces: [p.spaces[0], { id: 9, name: 'Combat', icon: null, defaultDeckType: 'task' }] });
  const creatures = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Creatures'), projectId: project.id, spaceId: 9 });
  const forest = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Forest level'), projectId: project.id });
  await run(page, 'cards', 'create', { deckId: creatures.id, content: 'Drowned Man' });
  await freshTabs(page);
  const snap = await snapshot(page);
  const deck = (id: string) => snap.decks.find((d: any) => d.id === id);
  return { name, project, creatures: deck(creatures.id), forest: deck(forest.id) };
}

test('the find box filters the tree, keeps the parents and marks the match', async ({ page }) => {
  const { name, creatures } = await setUp(page);
  await page.getByLabel('Find in the sidebar').fill(creatures.title.slice(0, 12));
  await expect(tree(page).getByRole('button', { name })).toBeVisible();
  await expect(tree(page).getByRole('button', { name: 'Combat' })).toBeVisible();
  await expect(tree(page).getByRole('link', { name: `${creatures.title}, 1 open` })).toBeVisible();
  await expect(tree(page).locator('mark').first()).toBeVisible();
  await page.locator('aside.sidebar').screenshot({ path: `${SHOTS}/shell-find.png` });
  await page.getByLabel('Find in the sidebar').fill('zz-nothing-zz');
  await expect(tree(page)).toContainText('Nothing called zz-nothing-zz in the sidebar');
  // Enter takes the words on to the palette.
  await page.getByLabel('Find in the sidebar').press('Enter');
  await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('zz-nothing-zz');
  await page.keyboard.press('Escape');
  await page.getByLabel('Find in the sidebar').press('Escape');
  await expect(page.getByLabel('Find in the sidebar')).toHaveValue('');
});

test('a project folds, and the fold comes back after a reload', async ({ page }) => {
  const { name, forest } = await setUp(page);
  const proj = tree(page).getByRole('button', { name });
  await expect(proj).toHaveAttribute('aria-expanded', 'true');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/prefs/sideFolds') && r.request().method() === 'PUT');
  await proj.click();
  await expect(tree(page).getByRole('link', { name: new RegExp(`^${forest.title}`) })).toHaveCount(0);
  await saved;
  await page.reload();
  await expect(tree(page).getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
  await tree(page).getByRole('button', { name }).click();
  await expect(tree(page).getByRole('link', { name: new RegExp(`^${forest.title}`) })).toBeVisible();
});

test('tabs: Ctrl+click and ↗ open in the background, double-click pins, Home stays home, reload brings them back', async ({ page }) => {
  const { creatures, forest } = await setUp(page);
  await expect(tabs(page).first()).toContainText('Home');
  await expect(activeTab(page)).toContainText('Overview');

  // A plain click opens in the current tab, with its own back.
  await tree(page).getByRole('link', { name: new RegExp(`^${creatures.title}`) }).click();
  await expect(activeTab(page)).toContainText(creatures.title);
  await expect(tabs(page)).toHaveCount(2);

  // Ctrl+click and the ↗ button open behind; the page stays.
  await tree(page).getByRole('link', { name: new RegExp(`^${forest.title}`) }).click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(3);
  await expect(activeTab(page)).toContainText(creatures.title);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Milestones' }).hover();
  await page.getByRole('navigation', { name: 'Main' }).locator('.side-item', { hasText: 'Milestones' }).getByRole('button', { name: 'Open in a new tab' }).click();
  await expect(tabs(page)).toHaveCount(4);
  await expect(page).toHaveURL(new RegExp(`/decks/${creatures.seq}-`));

  // Browser back goes back in this tab only.
  await page.goBack();
  await expect(page).toHaveURL(/\/decks$/);
  await expect(activeTab(page)).toContainText('Overview');
  await page.goForward();
  await expect(activeTab(page)).toContainText(creatures.title);

  // Double-click pins (no ×), again unpins.
  const forestTab = tabs(page).filter({ hasText: forest.title });
  await forestTab.dblclick();
  await expect(forestTab.getByRole('button', { name: /^Close/ })).toHaveCount(0);
  await expect(forestTab).toHaveAttribute('title', /pinned/);

  // Home stays home: a page opened from it gets its own tab.
  await tabs(page).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(tabs(page)).toHaveCount(5);
  await expect(tabs(page).first()).toContainText('Home');
  await expect(activeTab(page)).toContainText('Inbox');

  // Alt+2 shows the second tab.
  await page.keyboard.press('Alt+2');
  await expect(activeTab(page)).toContainText(creatures.title);

  // Everything comes back after a reload (pinned too).
  await page.screenshot({ path: `${SHOTS}/shell-tabs.png` });
  await page.reload();
  await expect(tabs(page)).toHaveCount(5);
  await expect(activeTab(page)).toContainText(creatures.title);
  await expect(tabs(page).filter({ hasText: forest.title })).toHaveAttribute('title', /pinned/);

  // × closes; the tab to its right takes over.
  await activeTab(page).getByRole('button', { name: /^Close/ }).click();
  await expect(tabs(page)).toHaveCount(4);
});

test(`at most 12 tabs: the oldest unpinned one closes and a note says which`, async ({ page }) => {
  await setUp(page);
  // Home and the Overview are open; ten more fill it up.
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs(page)).toHaveCount(12);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs(page)).toHaveCount(12);
  await expect(page.getByText('12 tabs is the most: closed the oldest, Overview')).toBeVisible();
  await expect(tabs(page).first()).toContainText('Home');
  // The New tab page offers places to start.
  await expect(page.getByRole('heading', { level: 1, name: 'Open something' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Places to start' }).getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/decks$/);
  await freshTabs(page);
});

test('quick actions say where the new thing goes and make it there', async ({ page }) => {
  const { name, creatures } = await setUp(page);
  await tree(page).getByRole('link', { name: new RegExp(`^${creatures.title}`) }).click();
  await page.getByRole('toolbar', { name: 'Quick actions' }).getByRole('button', { name: 'New list' }).click();
  const box = page.getByRole('dialog', { name: 'New list' });
  await expect(box.getByTestId('quick-where')).toHaveText(`Goes to: ${name}, area Combat`);
  const title = unique('Quick list');
  await box.getByRole('textbox').fill(title);
  await box.getByRole('textbox').press('Enter');
  await expect(tree(page).getByRole('link', { name: `${title}, 0 open` })).toBeVisible();
  const made = (await snapshot(page)).decks.find((d: any) => d.title === title);
  expect(made.spaceId).toBe(9);

  await page.getByRole('toolbar', { name: 'Quick actions' }).getByRole('button', { name: 'New task' }).click();
  await expect(page.getByRole('dialog', { name: 'New task' }).getByTestId('quick-where')).toHaveText(`Goes to: ${creatures.title} (${name})`);
  await page.getByRole('dialog', { name: 'New task' }).getByRole('textbox').fill('Wreckling');
  await page.getByRole('dialog', { name: 'New task' }).getByRole('button', { name: 'Create' }).click();
  await expect.poll(async () => (await snapshot(page)).cards.some((c: any) => c.deckId === creatures.id && c.content.startsWith('Wreckling'))).toBe(true);
});

test('folded: a rail of icons, a project tile opens its lists beside it', async ({ page }) => {
  const { name, creatures } = await setUp(page);
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
  const rail = page.getByRole('toolbar', { name: 'Folded sidebar' });
  await expect(rail.getByRole('link', { name: 'Inbox' })).toBeVisible();
  await rail.getByRole('button', { name }).click();
  const fly = page.getByRole('navigation', { name: `${name} lists` });
  await expect(fly.getByText('Combat')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/shell-rail.png` });
  await fly.getByRole('link', { name: `${creatures.title}, 1 open` }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${creatures.seq}-`));
  await expect(fly).toHaveCount(0);
  // Wait until the server has it: later specs (the wiki's panels) measure with the sidebar open.
  const reopened = page.waitForResponse((r) => r.url().endsWith('/api/prefs/sidebar') && r.request().method() === 'PUT');
  await rail.getByRole('button', { name: 'Open the sidebar' }).click();
  await reopened;
  await expect(page.getByLabel('Find in the sidebar')).toBeVisible();
});

test('the workspace switcher shows where you are and opens Workspace settings', async ({ page }) => {
  await ensureWorkspace(page);
  await page.getByRole('button', { name: /^Workspace:/ }).click();
  const menu = page.getByRole('menu', { name: 'Workspaces' });
  await expect(menu.getByRole('menuitemradio', { checked: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/shell-switcher.png` });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: /^Workspace:/ }).click();
  await menu.getByRole('menuitem', { name: 'Workspace settings, people, look…' }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace menu' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a malformed address shows the page, not a blank screen', async ({ page }) => {
  await setUp(page);
  // The server refuses such an address itself; inside the app it can still arrive (a saved tab, a script).
  await page.evaluate(() => { history.pushState(null, '', '/wiki/1/%E0'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page).toHaveURL(/%E0$/);
  await expect(page.getByLabel('Find in the sidebar')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Open pages' })).toBeVisible();
});

test('Back and Forward buttons; Back on a new tab\'s first page returns to the tab it came from', async ({ page }) => {
  const { creatures } = await setUp(page);
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const forward = page.getByRole('button', { name: 'Forward', exact: true });
  await expect(back).toBeDisabled();
  await tree(page).getByRole('link', { name: new RegExp(`^${creatures.title}`) }).click();
  await back.click();
  await expect(page).toHaveURL(/\/decks$/);
  await forward.click();
  await expect(activeTab(page)).toContainText(creatures.title);
  // A new tab in front: Back on its first page goes back to the tab it was opened from.
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(activeTab(page)).toContainText('New tab');
  await back.click();
  await expect(activeTab(page)).toContainText(creatures.title);
  // The browser's Back on a tab with nowhere to go leaves the page as it is.
  await tabs(page).first().click();
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
});

test('tabs by keyboard: arrows move, Shift+P pins, Delete closes and focus moves on', async ({ page }) => {
  await setUp(page);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs(page)).toHaveCount(4);
  await activeTab(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs(page).nth(2)).toBeFocused();
  await page.keyboard.press('Shift+P');
  await expect(tabs(page).nth(2)).toHaveAttribute('title', /pinned/);
  await page.keyboard.press('Shift+P');
  await page.keyboard.press('Delete');
  await expect(tabs(page)).toHaveCount(3);
  await expect(tabs(page).nth(2)).toBeFocused();
  // The × buttons are not extra Tab stops.
  await expect(activeTab(page).getByRole('button', { name: /^Close/ })).toHaveAttribute('tabindex', '-1');
});

test('Esc on the rail flyout and on a quick box puts focus back on what opened them', async ({ page }) => {
  const { name } = await setUp(page);
  await page.getByRole('toolbar', { name: 'Quick actions' }).getByRole('button', { name: 'New list' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Quick actions' }).getByRole('button', { name: 'New list' })).toBeFocused();
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
  const tile = page.getByRole('toolbar', { name: 'Folded sidebar' }).getByRole('button', { name });
  await tile.click();
  await expect(page.getByRole('navigation', { name: `${name} lists` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: `${name} lists` })).toHaveCount(0);
  await expect(tile).toBeFocused();
  // Wait until the server has it: later specs (the wiki's panels) measure with the sidebar open.
  const reopened = page.waitForResponse((r) => r.url().endsWith('/api/prefs/sidebar') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Open the sidebar' }).click();
  await reopened;
});

test('two windows keep their own tabs; a new window starts from the saved ones', async ({ page, context }) => {
  await setUp(page);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs(page)).toHaveCount(3);
  await page.waitForResponse((r) => r.url().endsWith('/api/prefs/tabs') && r.request().method() === 'PUT');
  const other = await context.newPage();
  await other.goto('/decks');
  await expect(tabs(other)).toHaveCount(3);
  await other.getByRole('button', { name: 'New tab', exact: true }).click();
  await other.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs(other)).toHaveCount(5);
  await page.reload();
  await expect(tabs(page)).toHaveCount(3);
  await other.close();
});
