import { test, expect, type Page } from '@playwright/test';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

const main = (page: Page) => page.getByTestId('entry-page');
const panels = (page: Page) => page.getByTestId('wiki-panel');
const panel = (page: Page, title: string) => panels(page).filter({ has: page.getByRole('heading', { name: title, exact: true, level: 2 }) });
const strips = (page: Page) => page.getByTestId('wiki-strip');
const panelTitles = (page: Page) => panels(page).locator('.wiki-panel-title');
const panelsParam = (page: Page) => new URL(page.url()).searchParams.get('panels');

/** Every full column lies inside the row: nothing is cut off at either edge, and the row doesn't scroll sideways. */
async function expectWhole(page: Page) {
  const r = await page.getByTestId('wiki-stack').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const cols = [...el.children].map((c) => c.getBoundingClientRect());
    return { scroll: el.scrollWidth - el.clientWidth, inside: cols.every((c) => c.left >= box.left - 1 && c.right <= box.right + 1) };
  });
  expect(r.scroll).toBeLessThanOrEqual(1);
  expect(r.inside).toBe(true);
}

async function campaign(page: Page) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Sample Project') });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  return { projectId: project.id, seq };
}

async function entry(page: Page, projectId: string, name: string, body = '') {
  const { id, key } = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId, typeId: null, name });
  if (body) {
    const card = (await snapshot(page)).cards.find((c: any) => c.id === id);
    await run(page, 'cards', 'update', { id, content: `# ${name}\n\n${body}`, contentVersion: card.contentVersion });
  }
  return { id, key };
}

/** A chain of pages, each naming the next: North Tower → Old Bridge → River Gate → Market Square → Harbour. */
async function chain(page: Page) {
  const { projectId, seq } = await campaign(page);
  const e = {
    harbour: await entry(page, projectId, 'Harbour', 'Ships sail from here to the North Tower.'),
    market: await entry(page, projectId, 'Market Square', 'The road goes on to the Harbour.'),
    gate: await entry(page, projectId, 'River Gate', 'Beyond it lies Market Square.'),
    bridge: await entry(page, projectId, 'Old Bridge', 'It ends at the River Gate.'),
    tower: await entry(page, projectId, 'North Tower', 'Its stair leads down to the Old Bridge. Traders also mention Market Square.'),
  };
  return { projectId, seq, ...e };
}

test('side-by-side panels: open, chain, replace, fold, reload, Back/Forward, Esc, close, Open full page', async ({ page, context }) => {
  const { seq, tower, bridge, gate, market, harbour } = await chain(page);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(`/wiki/${seq}/${tower.key}`);
  await expect(panels(page)).toHaveCount(0);

  // A name link in the main entry opens a panel on its right.
  await main(page).locator('a.entry-link', { hasText: 'Old Bridge' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge']);
  expect(panelsParam(page)).toBe(bridge.key);
  await expect(main(page)).toContainText('Its stair leads down');
  const mBox = (await main(page).boundingBox())!;
  const pBox = (await panel(page, 'Old Bridge').boundingBox())!;
  expect(pBox.x).toBeGreaterThan(mBox.x + mBox.width - 1);
  // The panel's heading has focus; its menu, Open full page and close come next.
  await expect(panel(page, 'Old Bridge').locator('.wiki-panel-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'More for Old Bridge' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel(page, 'Old Bridge').getByRole('button', { name: 'Open full page' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close Old Bridge' })).toBeFocused();

  // A link inside the panel opens the next one to its right.
  await panel(page, 'Old Bridge').locator('a.entry-link', { hasText: 'River Gate' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'River Gate']);
  expect(panelsParam(page)).toBe(`${bridge.key},${gate.key}`);
  await page.screenshot({ path: `${SHOTS}/panels-two.png` });

  // From the main entry again: the panels to its right are replaced (a column browser).
  await main(page).locator('a.entry-link', { hasText: 'Market Square' }).click();
  await expect(panelTitles(page)).toHaveText(['Market Square']);
  // Each panel is a history step: Back undoes the last one, Forward redoes it.
  await page.goBack();
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'River Gate']);
  await page.goForward();
  await expect(panelTitles(page)).toHaveText(['Market Square']);
  await page.goBack();
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'River Gate']);

  // A third panel doesn't fit beside the main entry here: the main entry folds to a strip with its title. A fourth
  // folds the oldest panel too (three full panels at most, so never more than four entry pages mounted).
  await panel(page, 'River Gate').locator('a.entry-link', { hasText: 'Market Square' }).click();
  await expect(strips(page)).toHaveText(['North Tower']);
  await expect(main(page)).toHaveCount(0);
  await panel(page, 'Market Square').locator('a.entry-link', { hasText: 'Harbour' }).click();
  await expect(panelTitles(page)).toHaveText(['River Gate', 'Market Square', 'Harbour']);
  await expect(strips(page)).toHaveText(['North Tower', 'Old Bridge']);
  expect(panelsParam(page)).toBe(`${bridge.key},${gate.key},${market.key},${harbour.key}`);
  await expect(page.locator('[data-testid="entry-page"], [data-testid="panel-entry"]')).toHaveCount(3);
  await expectWhole(page);
  await page.screenshot({ path: `${SHOTS}/panels-stack.png` });

  // A link to an entry folded into a strip shows it, as its strip does (the panels after it close); Back undoes it.
  await panel(page, 'Harbour').locator('a.entry-link', { hasText: 'North Tower' }).click();
  await expect(panels(page)).toHaveCount(0);
  await expect(main(page)).toContainText('Its stair leads down');
  await page.goBack();
  await expect(panelTitles(page)).toHaveText(['River Gate', 'Market Square', 'Harbour']);

  // Back closes the last panel, Forward reopens it.
  await page.goBack();
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'River Gate', 'Market Square']);
  await expect(strips(page)).toHaveText(['North Tower']);
  await page.goForward();
  await expect(panelTitles(page)).toHaveText(['River Gate', 'Market Square', 'Harbour']);

  // A reload restores the panels from the URL.
  await page.reload();
  await expect(panelTitles(page)).toHaveText(['River Gate', 'Market Square', 'Harbour']);
  await expect(strips(page)).toHaveText(['North Tower', 'Old Bridge']);

  // Esc inside an open menu closes the menu first; then Esc closes the rightmost panel.
  await page.getByRole('button', { name: 'More for Harbour' }).click();
  await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Copy link' })).toHaveCount(0);
  await expect(panels(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'River Gate', 'Market Square']);
  await expect(strips(page)).toHaveText(['North Tower']);

  // Close (×) one in the middle; focus goes to the panel on its left.
  await page.getByRole('button', { name: 'Close River Gate' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge', 'Market Square']);
  expect(panelsParam(page)).toBe(`${bridge.key},${market.key}`);
  await expect(panel(page, 'Old Bridge').locator('.wiki-panel-title')).toBeFocused();
  await expect(strips(page)).toHaveCount(0); // two panels fit beside the main entry again

  // Open full page: the panel becomes the main entry, the others stay open.
  await panel(page, 'Market Square').getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${market.key}\\?panels=${tower.key},${bridge.key}$`));
  await expect(main(page)).toContainText('The road goes on to the Harbour.');
  await expect(panelTitles(page)).toHaveText(['North Tower', 'Old Bridge']);

  // Ctrl/⌘-click still opens a new tab, and leaves the panels alone.
  const opened = context.waitForEvent('page');
  await main(page).locator('a.entry-link', { hasText: 'Harbour' }).click({ modifiers: ['ControlOrMeta'] });
  const tab = await opened;
  await expect(tab).toHaveURL(new RegExp(`/wiki/${seq}/${harbour.key}$`));
  await tab.close();
  await expect(panelTitles(page)).toHaveText(['North Tower', 'Old Bridge']);

  // The sidebar navigates as before (no panels on the new page).
  await page.getByRole('navigation', { name: 'Wiki pages' }).getByRole('link', { name: 'River Gate' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${gate.key}$`));
  await expect(panels(page)).toHaveCount(0);
});

test('panels from the name menu, the graph, What links here and the lore editor', async ({ page }) => {
  const { seq, tower, bridge } = await chain(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/wiki/${seq}/${tower.key}`);

  // The name menu: Open beside, Open in new tab, Copy link (it replaces the browser's own menu).
  await main(page).locator('a.entry-link', { hasText: 'Old Bridge' }).click({ button: 'right' });
  const menu = page.getByTestId('name-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Open beside', 'Open in new tab', 'Copy link', 'Not a link here']);
  await menu.getByRole('menuitem', { name: 'Open beside' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge']);
  // A resize closes an open name menu.
  await main(page).locator('a.entry-link', { hasText: 'Old Bridge' }).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect(menu).toHaveCount(0);

  // Not a link here: focus goes back to the text block the link was in.
  await panel(page, 'Old Bridge').locator('a.entry-link', { hasText: 'River Gate' }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Not a link here' }).click();
  await expect(panel(page, 'Old Bridge').locator('a.entry-link')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('md') ?? false)).toBe(true);
  await page.locator('.toast').filter({ hasText: '"River Gate" is no longer a link' }).getByRole('button', { name: 'Undo' }).click();
  await expect(panel(page, 'Old Bridge').locator('a.entry-link', { hasText: 'River Gate' })).toBeVisible();

  // The graph tile's Open opens a panel beside the main entry.
  const tile = main(page).getByTestId('entry-graph');
  await tile.locator(`[data-node="${bridge.id}"]`).click();
  await tile.getByTestId('graph-preview').getByRole('button', { name: 'Open' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge']);
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${tower.key}\\?panels=${bridge.key}$`));

  // What links here: a link to the main entry itself opens nothing new; another one opens beside its column.
  await panel(page, 'Old Bridge').getByRole('region', { name: 'What links here' }).getByRole('link', { name: 'North Tower' }).click();
  await expect(panelTitles(page)).toHaveText(['Old Bridge']);
  await main(page).getByRole('region', { name: 'What links here' }).getByRole('link', { name: 'Harbour' }).click();
  await expect(panelTitles(page)).toHaveText(['Harbour']);

  // The lore editor: Ctrl/⌘-click on a name opens it as a panel, and the draft stays.
  await main(page).getByRole('button', { name: /Edit text/ }).click();
  const editor = main(page).getByRole('textbox', { name: 'Text', exact: true });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' A path runs to the River Gate.');
  await editor.locator('.lore-name', { hasText: 'River Gate' }).click({ modifiers: ['ControlOrMeta'] });
  await expect(panelTitles(page)).toHaveText(['River Gate']);
  await expect(editor).toContainText('A path runs to the River Gate.');
  await page.screenshot({ path: `${SHOTS}/panels-editor.png` });
});

test('a draft in a panel survives replacing, Back/Forward, folding and Open full page, and saves', async ({ page }) => {
  const { seq, tower, bridge } = await chain(page);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(`/wiki/${seq}/${tower.key}?panels=${bridge.key}`);
  const editorIn = (scope: ReturnType<Page['locator']>) => scope.getByRole('textbox', { name: 'Text', exact: true });
  await panel(page, 'Old Bridge').getByRole('button', { name: /Edit text/ }).click();
  await editorIn(panel(page, 'Old Bridge')).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Draft words here.');
  await expect(editorIn(panel(page, 'Old Bridge'))).toContainText('Draft words here.');

  // (a) A link from the main entry replaces the panel; (b) Back brings it back with the draft, in edit mode.
  await main(page).locator('a.entry-link', { hasText: 'Market Square' }).click();
  await expect(panelTitles(page)).toHaveText(['Market Square']);
  await page.goBack();
  await expect(editorIn(panel(page, 'Old Bridge'))).toContainText('Draft words here.');
  await page.goForward();
  await expect(panelTitles(page)).toHaveText(['Market Square']);
  await page.goBack();
  await expect(editorIn(panel(page, 'Old Bridge'))).toContainText('Draft words here.');

  // Folding: on a narrow window the panel folds; its strip says the text is unsaved, and showing it brings the draft.
  await page.setViewportSize({ width: 1280, height: 900 });
  // (Ctrl/⌘-click on a name in the panel's editor opens it beside the panel.)
  await editorIn(panel(page, 'Old Bridge')).locator('.lore-name', { hasText: 'River Gate' }).click({ modifiers: ['ControlOrMeta'] });
  await panel(page, 'River Gate').locator('a.entry-link', { hasText: 'Market Square' }).click();
  const folded = strips(page).filter({ hasText: 'Old Bridge' });
  await expect(folded).toHaveAttribute('aria-label', /unsaved text/);
  await page.screenshot({ path: `${SHOTS}/panels-draft-strip.png` });
  await folded.click();
  await expect(editorIn(panel(page, 'Old Bridge'))).toContainText('Draft words here.');

  // (c) Open full page: the draft moves with it, and saving works.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await panel(page, 'Old Bridge').getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${bridge.key}\\?panels=${tower.key}$`));
  await expect(editorIn(main(page))).toContainText('Draft words here.');
  await main(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editorIn(main(page))).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === bridge.id).content).toBe('# Old Bridge\n\nIt ends at the River Gate. Draft words here.');
  // Saved: the draft is gone, so the page opens for reading next time.
  await page.reload();
  await expect(main(page).getByTestId('card-markdown')).toContainText('Draft words here.');
  await expect(editorIn(main(page))).toHaveCount(0);
});

test('layout: whole columns at 1280, 1600 and 1920 wide with 1 to 3 panels; tidy URLs; Esc on a missing entry', async ({ page }) => {
  const { seq, tower, bridge, gate, market } = await chain(page);
  const list = [bridge.key, gate.key, market.key];
  const mainFolds: Record<string, boolean> = {};
  for (const width of [1280, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const n of [1, 2, 3]) {
      await page.goto(`/wiki/${seq}/${tower.key}?panels=${list.slice(0, n).join(',')}`);
      await expect(panels(page).last()).toBeVisible();
      await expect(page.locator('[data-testid="panel-entry"]').last()).toBeVisible();
      await expectWhole(page);
      mainFolds[`${width}x${n}`] = (await main(page).count()) === 0;
      await page.screenshot({ path: `${SHOTS}/panels-${width}-${n}.png` });
    }
  }
  // The main entry stays full while it fits beside the panels.
  expect(mainFolds['1920x1']).toBe(false);
  expect(mainFolds['1920x2']).toBe(false);
  expect(mainFolds['1600x1']).toBe(false);
  expect(mainFolds['1280x3']).toBe(true);
  console.log(`[panels] main entry folded: ${JSON.stringify(mainFolds)}`);

  // A `$code`, a repeat and the main entry in ?panels= are tidied in place (no extra history step).
  const code = cardCode((await snapshot(page)).cards.find((c: any) => c.id === bridge.id).seq);
  await page.goto(`/wiki/${seq}/${tower.key}`);
  await page.goto(`/wiki/${seq}/${tower.key}?panels=$${code},${bridge.key},${tower.key}`);
  await expect.poll(() => panelsParam(page)).toBe(bridge.key);
  const steps = await page.evaluate(() => history.length);
  await page.keyboard.press('Escape');
  await expect(panels(page)).toHaveCount(0);
  await page.goBack();
  await expect(panelTitles(page)).toHaveText(['Old Bridge']);
  expect(await page.evaluate(() => history.length)).toBe(steps + 1);

  // Lore that doesn't exist shows no stack: Esc does nothing to the URL.
  await page.goto(`/wiki/${seq}/no_such_entry?panels=${bridge.key}`);
  await expect(page.getByRole('heading', { name: 'Lore not found' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(panelsParam(page)).toBe(bridge.key);
});
