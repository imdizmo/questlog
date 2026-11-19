import { test, expect, type Locator, type Page } from '@playwright/test';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';

// Home: the welcome, "Recently worked on", and the workspace's Home board, shared and live: the projects, areas, lists
// and quests are nodes of it, each moved on its own, with the lines from the data; Tree View and cards per person; the
// old vision boards open on it from the Boards toolbar.
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Open pages' }).getByRole('tab');
const board = (page: Page) => page.getByRole('region', { name: 'Board' });
const tree = (page: Page) => page.getByRole('region', { name: 'How your work connects' });
const viewRail = (page: Page) => page.getByRole('toolbar', { name: 'View, cards and picture' });
const pane = (page: Page) => page.locator('#home-pane');
const paneTitle = (page: Page) => page.locator('#home-pane-title');
const work = (page: Page, ref: string) => board(page).locator(`[data-node-type="work"][data-ref="${ref}"]`);

/** Starts from Home alone, with Home's choices back to their defaults. */
async function freshHome(page: Page) {
  await page.evaluate(() => sessionStorage.clear()); // this window's own tabs
  await page.goto('about:blank'); // the page sends what it has first, so nothing overwrites the reset below
  for (const key of ['tabs', 'home']) expect((await page.request.put(`/api/prefs/${key}`, { data: { value: null } })).ok()).toBe(true);
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Ada' })).toBeVisible();
}

async function setUp(page: Page) {
  await ensureWorkspace(page);
  const s0 = await snapshot(page);
  await run(page, 'accounts', 'update', { settings: { ...s0.account.settings, dependenciesEnabled: true } });
  const name = unique('Home project');
  const project = await run<{ id: string }>(page, 'projects', 'create', { name });
  const p = (await snapshot(page)).projects.find((x: any) => x.id === project.id);
  await run(page, 'projects', 'update', { id: project.id, spaces: [p.spaces[0], { id: 9, name: 'Combat', icon: null, defaultDeckType: 'task' }] });
  const creatures = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Creatures'), projectId: project.id, spaceId: 9 });
  const forest = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Forest'), projectId: project.id });
  const taming = await run<{ id: string }>(page, 'cards', 'create', { deckId: creatures.id, content: `${unique('Taming')}\n\nPlaceholder body: a ghoul.` });
  const scatter = await run<{ id: string }>(page, 'cards', 'create', { deckId: forest.id, content: unique('Forest scatter') });
  await run(page, 'cards', 'update', { id: taming.id, inDeps: [scatter.id] }); // the scatter locks the taming
  const snap = await snapshot(page);
  const card = (id: string) => snap.cards.find((c: any) => c.id === id);
  const deck = (id: string) => snap.decks.find((d: any) => d.id === id);
  await freshHome(page);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  return { name, projectId: project.id, creatures: deck(creatures.id), forest: deck(forest.id), taming: card(taming.id), scatter: card(scatter.id) };
}
const title = (c: { content: string }) => c.content.split('\n')[0];
const stored = (n: Locator) => n.evaluate((el: HTMLElement) => ({ x: Number(el.dataset.x), y: Number(el.dataset.y), w: Number(el.dataset.w) }));

/** A second person of the workspace, signed in, on Home. */
async function member(page: Page, browser: import('@playwright/test').Browser, role = 'member', projectIds: string[] = []) {
  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role, projectIds });
  const b = await newPerson(browser);
  const name = unique('Mia');
  const res = await b.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  await b.goto('/home');
  await expect(b.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  return b;
}

/** Brings `el` into view: focus pans the board to it, clear of the welcome column; waits until it stays put. */
async function inView(page: Page, el: Locator) {
  await el.focus();
  let b = (await el.boundingBox())!;
  for (let i = 0, same = 0; i < 30 && same < 3; i++) { await page.waitForTimeout(60); const n = (await el.boundingBox())!; same = n.x === b.x && n.y === b.y ? same + 1 : 0; b = n; }
  return b;
}

/** Drags `el` by `by` pixels, after bringing it into view. */
async function drag(page: Page, el: Locator, by: { x: number; y: number }) {
  const b = await inView(page, el);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + by.x / 2, b.y + b.height / 2 + by.y / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2 + by.x, b.y + b.height / 2 + by.y, { steps: 5 });
  await page.mouse.up();
}

test('the welcome and what I worked on lately; a row opens beside Home, Ctrl+click in its own tab', async ({ page }) => {
  const { taming, creatures } = await setUp(page);
  const recent = page.getByRole('navigation', { name: 'Recently worked on' });
  const row = recent.getByRole('link', { name: new RegExp(title(taming)) });
  await expect(row).toContainText(creatures.title);
  await expect(tabs(page)).toHaveCount(1);
  await row.click();
  // Home stays home: the task opens beside it, in the same tab
  await expect(pane(page)).toBeVisible();
  await expect(paneTitle(page)).toHaveText(title(taming));
  await expect(paneTitle(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-.*/card/`));
  await expect(tabs(page)).toHaveCount(1);
  // Ctrl+click: a tab of its own (behind)
  await row.click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).first()).toContainText('Home');
  await expect(page).toHaveURL(/\/home\?side=/);
  await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(row).toBeFocused(); // back where it was opened from

  // Folded away, it is a clock, and stays folded after a reload
  await page.getByRole('button', { name: 'Fold away recently worked on' }).click();
  await expect(recent).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show recently worked on' })).toBeVisible();
  // ... in the top left corner of Home, in line with the Add toolbar
  const main = (await page.locator('main').first().boundingBox())!;
  const fold = (await page.getByRole('button', { name: 'Show recently worked on' }).boundingBox())!;
  expect(fold.x - main.x).toBeLessThan(24);
  expect(fold.y - main.y).toBeLessThan(24);
  await page.screenshot({ path: `${SHOTS}/home-folded.png` });
  await page.getByRole('button', { name: 'Show recently worked on' }).click();
  await expect(recent).toBeVisible();
});

test('the board: the work with its counts and lines from the data, quests from the sliders, cards and Tree View per person', async ({ page }) => {
  const { name, projectId, creatures, forest, taming, scatter } = await setUp(page);
  await expect(board(page).getByRole('group', { name: `${name}, project` })).toBeVisible();
  await expect(work(page, `l${creatures.id}`)).toHaveAccessibleName(`${creatures.title}, list, 1 open`);
  await expect(work(page, `p${projectId}`)).toBeVisible();
  // quests are hidden until asked for; the lock shows between the two lists meanwhile
  await expect(work(page, `q${taming.id}`)).toHaveCount(0);
  await expect(board(page).locator(`.ln.dep[data-a="l${forest.id}"][data-b="l${creatures.id}"]`)).toHaveCount(1);
  await expect(board(page).locator(`.ln[data-a="p${projectId}"]`).first()).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/home-board-pills.png` });

  await page.getByRole('button', { name: 'What to show' }).click();
  await page.getByRole('group', { name: 'What to show' }).getByLabel('Quests').check();
  await expect(work(page, `q${taming.id}`)).toHaveAccessibleName(`${title(taming)}, Blocked`); // the scatter locks it
  await expect(board(page).locator(`.ln.dep[data-a="q${scatter.id}"][data-b="q${taming.id}"]`)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'What to show' })).toHaveCount(0);

  // Lists as cards: drawn as a scene card for this person, the stored place unchanged
  const list = work(page, `l${forest.id}`);
  const pill = (await list.boundingBox())!;
  await viewRail(page).getByRole('button', { name: 'Lists as cards' }).click();
  await expect(list.locator('.card2.list')).toContainText('1 quest, 0 done.');
  const card = (await list.boundingBox())!;
  expect(card.width).toBeGreaterThan(pill.width);
  expect(Math.abs(card.x + card.width / 2 - (pill.x + pill.width / 2))).toBeLessThan(card.width); // about where the pill was
  await page.screenshot({ path: `${SHOTS}/home-board-cards.png` });
  await viewRail(page).getByRole('button', { name: 'Everything as pills' }).click();

  // Tree View with quests as cards: the card shows the quest's own words and its list
  await viewRail(page).getByRole('button', { name: 'Tree View' }).click();
  await viewRail(page).getByRole('button', { name: 'Quests as cards' }).click();
  const qcard = tree(page).locator('.card2.quest', { hasText: title(taming) });
  await expect(qcard).toContainText('Placeholder body: a ghoul.');
  await expect(qcard).toContainText(creatures.title);
  await expect(board(page)).toHaveCount(0); // read only: not the board
  await page.screenshot({ path: `${SHOTS}/home-tree-cards.png` });

  // the choices are the person's: they come back after a reload
  await page.reload();
  await expect(viewRail(page).getByRole('button', { name: 'Tree View' })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewRail(page).getByRole('button', { name: 'Quests as cards' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tree(page).locator('.card2.quest', { hasText: title(taming) })).toHaveCount(1);
  const prefs = (await (await page.request.get('/api/prefs')).json()).prefs.home;
  expect(prefs).toMatchObject({ layout: 'tree', cards: ['quest'], show: { quest: true } });
  expect(prefs).not.toHaveProperty('moved');

  // a click on a node opens it beside Home, in the same tab; on the board too, where another click replaces it
  const before = await tabs(page).count();
  await tree(page).getByRole('link', { name: `${forest.title}, list, 1 open` }).dispatchEvent('click');
  await expect(paneTitle(page)).toHaveText(forest.title);
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${forest.seq}-`));
  await viewRail(page).getByRole('button', { name: 'Web view' }).click();
  await inView(page, work(page, `l${creatures.id}`));
  await work(page, `l${creatures.id}`).click();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-`));
  await expect(tabs(page)).toHaveCount(before);
});

test('the split view: the pane keeps its links, Back and reload; Ctrl+click opens a tab; the divider; narrow; focus', async ({ page }) => {
  const { creatures, forest, taming } = await setUp(page);
  const list = work(page, `l${creatures.id}`);
  const homeW = (await page.locator('main.home').boundingBox())!.width;
  await inView(page, list);
  await list.click();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await expect(paneTitle(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-`));
  // Home is on the left, narrower; one main, one h1 (the page's are not landmarks or level 1 there, as the browser tells)
  expect((await page.locator('main.home').boundingBox())!.width).toBeLessThan(homeW - 400);
  await expect(page.locator('#main')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(pane(page).locator('h1')).toHaveAttribute('aria-level', '2');
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: { role?: { value: string }; properties?: { name: string; value: { value: unknown } }[] }[] };
  const levels = nodes.filter((n) => n.role?.value === 'heading').map((n) => n.properties?.find((p) => p.name === 'level')?.value.value);
  expect(levels.filter((l) => l === 1)).toHaveLength(1); // Home's welcome (folded away beside a page: for screen readers)
  await cdp.detach();
  await page.screenshot({ path: `${SHOTS}/home-split.png` });

  // a link in the pane changes the pane's page, not the tab
  await pane(page).getByRole('link', { name: title(taming) }).first().click();
  await expect(paneTitle(page)).toHaveText(title(taming));
  await expect(paneTitle(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-[^&]*/card/`));
  await expect(tabs(page)).toHaveCount(1);
  // the tab's Back and Forward step through it; a reload keeps it
  await page.goBack();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await page.goForward();
  await expect(paneTitle(page)).toHaveText(title(taming));
  await page.goBack();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await page.reload();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await expect(tabs(page)).toHaveCount(1);

  // Ctrl+click on a node: a tab of its own, the pane as it was
  await inView(page, work(page, `l${forest.id}`));
  await work(page, `l${forest.id}`).click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(2);
  await expect(paneTitle(page)).toHaveText(creatures.title);

  // the divider: keys move it, the width is the person's
  const divider = page.getByRole('separator', { name: 'Width of the page beside Home' });
  await expect(divider).toHaveAttribute('aria-valuenow', '560');
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '584');
  await expect.poll(async () => (await (await page.request.get('/api/prefs')).json()).prefs.home?.pane).toBe(584);
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '360');
  const most = Number(await divider.getAttribute('aria-valuemax'));
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', String(most));
  expect((await page.locator('main.home').boundingBox())!.width).toBeGreaterThanOrEqual(350);
  await page.keyboard.press('Shift+ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', String(most - 120));

  // Close returns the focus to the node that opened it (after the reload: the one clicked now)
  await inView(page, list);
  await list.click();
  await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/);
  await expect(list).toBeFocused();

  // "Open in its own tab" moves the page to a tab
  await inView(page, list);
  await list.click();
  await pane(page).getByRole('button', { name: 'Open in its own tab' }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${creatures.seq}-`));
  await expect(tabs(page)).toHaveCount(3);
  await tabs(page).first().click();
  await expect(pane(page)).toHaveCount(0);

  // narrow: the pane covers Home, with Back to Home
  await page.setViewportSize({ width: 820, height: 760 });
  await list.focus();
  await page.keyboard.press('Enter');
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await expect(paneTitle(page)).toBeFocused();
  await expect(divider).toHaveCount(0);
  const pb = (await pane(page).boundingBox())!, hb = (await page.locator('main.home').boundingBox())!;
  expect(Math.abs(pb.x - hb.x)).toBeLessThan(2);
  expect(Math.abs(pb.width - hb.width)).toBeLessThan(2);
  await page.screenshot({ path: `${SHOTS}/home-split-narrow.png` });
  await pane(page).getByRole('button', { name: 'Back to Home' }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(list).toBeFocused();
});

test('the split view keeps Home safe: keys on the pane never reach the board; odd addresses, Esc, boards, deletes', async ({ page }) => {
  test.setTimeout(60_000); // a long walk on a shared machine
  const { creatures, taming } = await setUp(page);
  // A note on Home, picked; a page opened beside it from "Recently worked on"
  await page.getByRole('toolbar', { name: 'Add to the board' }).getByRole('button', { name: 'Text' }).click();
  const vb = (await page.getByTestId('board-viewport').boundingBox())!;
  await page.mouse.click(vb.x + vb.width - 200, vb.y + vb.height - 140);
  const words = unique('Keep me');
  await page.getByRole('textbox', { name: 'Text' }).fill(words);
  await page.keyboard.press('Enter');
  const note = board(page).locator('[data-node-type="text"]', { hasText: words });
  await expect(note).toBeVisible();
  await note.focus();
  await page.keyboard.press(' '); // picked
  await expect(note).toHaveClass(/is-selected/);
  await page.getByRole('navigation', { name: 'Recently worked on' }).getByRole('link', { name: new RegExp(title(taming)) }).click();
  await expect(paneTitle(page)).toHaveText(title(taming));
  // a click on plain text in the pane, then Delete and Esc: the note stays, for everyone
  const pb = (await pane(page).boundingBox())!;
  await page.mouse.click(pb.x + 12, pb.y + pb.height - 12); // the pane's margin: nothing that takes the focus but the pane
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await expect(note).toHaveCount(1);

  // Esc on a task beside Home goes back to its list, there
  await page.keyboard.press('Escape');
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-[^/&]*$`));
  // Back: the focus goes to the pane's heading, not to nothing
  await page.goBack();
  await expect(paneTitle(page)).toHaveText(title(taming));
  await expect(paneTitle(page)).toBeFocused();
  await page.goForward();
  await expect(paneTitle(page)).toHaveText(creatures.title);

  // Switching boards keeps the page beside Home
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: taming.id });
  const boards = page.getByRole('toolbar', { name: 'Boards' });
  await boards.getByRole('button', { name: title(taming) }).click();
  await expect(page).toHaveURL(new RegExp(`board=${accountSeq}`));
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await boards.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(new RegExp(`/home\\?side=/decks/${creatures.seq}-[^&]*$`));
  await expect(paneTitle(page)).toHaveText(creatures.title);

  // Unfolding "Recently worked on" beside a page is for this visit: the saved choice stays folded
  await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Fold away recently worked on' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/prefs')).json()).prefs.home?.recent).toBe(false);
  await inView(page, work(page, `l${creatures.id}`));
  await work(page, `l${creatures.id}`).click();
  await expect(paneTitle(page)).toHaveText(creatures.title);
  await page.getByRole('button', { name: 'Show recently worked on' }).click();
  await expect(page.getByRole('navigation', { name: 'Recently worked on' })).toBeVisible();
  await page.waitForTimeout(300);
  expect((await (await page.request.get('/api/prefs')).json()).prefs.home?.recent).toBe(false);

  // A list deleted beside Home: the Overview shows there, in the same tab
  const before = await tabs(page).count();
  await pane(page).getByRole('button', { name: 'More' }).click();
  await pane(page).getByRole('button', { name: 'Delete list' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete list' }).click();
  await expect(paneTitle(page)).toHaveText('Overview');
  await expect(page).toHaveURL(/\/home\?side=\/decks$/);
  await expect(tabs(page)).toHaveCount(before);

  // An address that resolves to another site is no page beside Home: no pane, no tab
  await page.goto('/home?side=/.//example.com/x');
  await expect(page.getByRole('heading', { level: 1, name: /Welcome back/ })).toBeAttached();
  await expect(pane(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/home\?side=/);
});

test('two people on Home see each other\'s move and note at once; an observer only looks', async ({ page, browser }) => {
  const { creatures, projectId } = await setUp(page);
  const b = await member(page, browser, 'member', [projectId]);
  const mine = work(page, `l${creatures.id}`), theirs = work(b, `l${creatures.id}`);
  await expect(theirs).toBeVisible();
  const s0 = await stored(theirs);
  await expect.poll(() => stored(mine)).toEqual(s0); // one place for everyone

  // A drag moves just that node, for everyone; a drag is not a click.
  const others = await board(page).locator('[data-node-type="work"]').evaluateAll((els) => els.slice(0, 8).map((e) => (e as HTMLElement).dataset.x));

  await drag(page, mine, { x: -140, y: 100 });
  await expect(page).toHaveURL(/\/home$/);
  await expect.poll(async () => (await stored(theirs)).x).not.toBe(s0.x);
  const s1 = await stored(theirs);
  expect(Math.abs(s1.y - s0.y)).toBeGreaterThan(40);
  expect(await stored(mine)).toEqual(s1);
  const othersAfter = await board(page).locator('[data-node-type="work"]').evaluateAll((els) => els.slice(0, 8).map((e) => (e as HTMLElement).dataset.x));
  expect(othersAfter.filter((x, i) => x !== others[i]).length).toBeLessThanOrEqual(1);

  // A note added by the member shows up for the owner.
  await b.getByRole('toolbar', { name: 'Add to the board' }).getByRole('button', { name: 'Text' }).click();
  const vb = (await b.getByTestId('board-viewport').boundingBox())!;
  await b.mouse.click(vb.x + vb.width - 260, vb.y + vb.height - 160);
  const note = unique('Remember the beach');
  await b.getByRole('textbox', { name: 'Text' }).fill(note);
  await b.keyboard.press('Enter');
  await expect(board(page).locator('[data-node-type="text"]', { hasText: note })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/home-board-live.png` });

  // A work node can't be deleted by hand: it leaves with its list.
  await mine.focus();
  await page.keyboard.press('Delete');
  await expect(mine).toHaveCount(1);
  await run(page, 'decks', 'delete', { id: creatures.id });
  await expect(theirs).toHaveCount(0);
  await b.context().close();

  // An observer sees the board and its notes, without the Add tools, and can't move anything.
  const o = await member(page, browser, 'observer', [projectId]);
  await expect(o.getByText(note)).toBeVisible();
  await expect(o.getByRole('toolbar', { name: 'Add to the board' })).toHaveCount(0);
  const pnode = work(o, `p${projectId}`);
  const p0 = await stored(pnode);
  await drag(o, pnode, { x: 120, y: 60 });
  await o.waitForTimeout(300);
  expect(await stored(pnode)).toEqual(p0);
  await o.context().close();
});

test("when Home's room can't be joined, the work is still drawn, read only", async ({ page }) => {
  const { creatures, name } = await setUp(page);
  // the room is full: every attempt to join it is turned away
  await page.routeWebSocket(/\/api\/rooms\//, (ws) => { ws.close({ code: 4503, reason: 'room_full' }); });
  await page.reload();
  await expect(page.getByText("Home's board can't be joined right now")).toBeVisible();
  await expect(board(page).getByRole('group', { name: `${name}, project` })).toBeVisible();
  await expect(work(page, `l${creatures.id}`)).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Add to the board' })).toHaveCount(0);
  const list = work(page, `l${creatures.id}`), s0 = await stored(list);
  await drag(page, list, { x: 100, y: 60 });
  await page.waitForTimeout(300);
  expect(await stored(list)).toEqual(s0);
});

test('the picture is the person\'s own', async ({ page }) => {
  await setUp(page);
  await expect(page.getByText('Ember', { exact: true })).toBeVisible(); // the first gradient by default
  await page.getByRole('button', { name: 'Picture and layout' }).click();
  await page.getByRole('button', { name: 'Sea fog' }).click();
  await expect(page.getByText('Sea fog', { exact: true }).last()).toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/prefs')).json()).prefs.home?.pic).toBe('fog');
});

test('three toolbars in their places, one tab stop each; Shift+arrows move the node in focus', async ({ page }) => {
  const { creatures } = await setUp(page);
  const main = (await page.locator('main.home').boundingBox())!;
  const boxOf = async (name: string) => (await page.getByRole('toolbar', { name }).boundingBox())!;
  const top = await boxOf('Boards'), add = await boxOf('Add to the board'), view = await boxOf('View, cards and picture');
  expect(top.y - main.y).toBeLessThan(40);
  expect(Math.abs(top.x + top.width / 2 - (main.x + main.width / 2))).toBeLessThan(main.width * 0.2);
  expect(add.x - main.x).toBeLessThan(40);
  expect(view.x + view.width).toBeGreaterThan(main.x + main.width - 40);
  expect(Math.abs(add.y + add.height / 2 - (main.y + main.height / 2))).toBeLessThan(main.height * 0.2);
  await expect(page.getByRole('toolbar', { name: 'Boards' }).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'true');

  // one tab stop per toolbar: Tab from the first button of a toolbar leaves it; the arrows move inside it
  for (const name of ['Boards', 'View, cards and picture', 'Add to the board']) {
    const bar = page.getByRole('toolbar', { name });
    await expect(bar.locator('button[tabindex="0"], a[tabindex="0"]')).toHaveCount(1);
    await bar.locator('button[tabindex="0"], a[tabindex="0"]').focus();
    const firstFocused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    await page.keyboard.press(name === 'Boards' ? 'ArrowRight' : 'ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.closest('[role="toolbar"]')?.getAttribute('aria-label'))).toBe(name);
    expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).not.toBe(firstFocused);
    await expect(bar.locator('button[tabindex="0"], a[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[role="toolbar"]')?.getAttribute('aria-label') ?? null)).not.toBe(name);
  }

  // Shift+arrow moves the focused node (for everyone: it is the board's place)
  const list = work(page, `l${creatures.id}`);
  await list.focus();
  const s0 = await stored(list);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await stored(list)).x).toBeGreaterThan(s0.x + 10);
  await page.reload();
  await expect.poll(async () => (await stored(work(page, `l${creatures.id}`))).x).toBeGreaterThan(s0.x + 10);
});

test('a story board opens from the Boards toolbar with its scenes, arrows and Play; old /vision links lead there', async ({ page }) => {
  await setUp(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Story proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Story list'), projectId: project.id, spaceId: 1 });
  const host = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: unique('Beach board') });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: host.id });
  const hostTitle = (await snapshot(page)).cards.find((c: any) => c.id === host.id).content;
  // the old address of the board leads to Home with it picked
  await page.goto(`/vision/${accountSeq}`);
  await expect(page).toHaveURL(new RegExp(`/home\\?board=${accountSeq}$`));
  const boards = page.getByRole('toolbar', { name: 'Boards' });
  await expect(boards.getByRole('button', { name: hostTitle })).toHaveAttribute('aria-pressed', 'true');
  await expect(boards.getByRole('link', { name: 'Open task' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'View, cards and picture' })).toHaveCount(0); // Home only
  // Two notes and an arrow, as on the vision board.
  const add = page.getByRole('toolbar', { name: 'Add to the board' });
  const vb = (await page.getByTestId('board-viewport').boundingBox())!;
  for (const [i, t] of ['From the beach', 'To the first boss'].entries()) {
    await add.getByRole('button', { name: 'Text' }).click();
    await page.mouse.click(vb.x + 300 + i * 300, vb.y + 260);
    await page.getByRole('textbox', { name: 'Text' }).fill(t);
    await page.keyboard.press('Enter');
  }
  const notes = page.locator('[data-node-type="text"]');
  await expect(notes).toHaveCount(2);
  await notes.first().hover();
  const handle = page.getByRole('button', { name: 'Connect from right' });
  const hb = (await handle.boundingBox())!, tb = (await notes.nth(1).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-edge-id]')).toHaveCount(1);

  // Back to Home and to the board again from the toolbar: everything is still there.
  await boards.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('[data-node-type="work"]').first()).toBeVisible();
  await boards.getByRole('button', { name: hostTitle }).click();
  await expect(page).toHaveURL(new RegExp(`/home\\?board=${accountSeq}$`));
  await expect(notes).toHaveCount(2);
  await expect(page.locator('[data-edge-id]')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/home-story-board.png` });
  // /vision opens the last board opened
  await page.goto('/vision');
  await expect(page).toHaveURL(new RegExp(`/home\\?board=${accountSeq}$`));
});
