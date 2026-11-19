import { test, expect, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

const entryPage = (page: Page) => page.getByTestId('entry-page');

async function campaign(page: Page, name = 'Ember Coast') {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique(name) });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  return { projectId: project.id, seq };
}

async function entry(page: Page, projectId: string, typeId: string | null, name: string, body = '') {
  const { id, key } = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId, typeId, name });
  if (body) {
    const card = (await snapshot(page)).cards.find((c: any) => c.id === id);
    await run(page, 'cards', 'update', { id, content: `# ${name}\n\n${body}`, contentVersion: card.contentVersion });
  }
  return { id, key };
}

const node = (scope: ReturnType<Page['locator']>, id: string) => scope.locator(`[data-node="${id}"]`);
const focusedNode = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-node') ?? null);

test('the graph beside an entry: neighbours, preview, Open, steps, keyboard, live updates', async ({ page }) => {
  const { projectId, seq } = await campaign(page);
  const place = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Place', icon: '🏰', color: '#4f8cff' });
  const npc = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Character', icon: '🧙' });
  await run(page, 'wiki', 'createLinkKind', { projectId, key: 'lives_in', label: 'lives in', reverseLabel: 'home of', fromTypes: [], toTypes: [] });
  const ember = await entry(page, projectId, place.id, 'Emberfall', 'A town under the ash.');
  const keep = await entry(page, projectId, place.id, 'Ashen Keep', 'A fort above Emberfall.');
  const mira = await entry(page, projectId, npc.id, 'Mira', 'Keeper of the north gate.');
  const roads = await entry(page, projectId, null, 'Old Roads', 'They lead up to Ashen Keep.');
  const vale = await entry(page, projectId, place.id, 'Cinder Vale');
  await run(page, 'wiki', 'addLink', { kindKey: 'lives_in', fromCardId: mira.id, toCardId: ember.id });

  // An entry with nothing around it says so.
  await page.goto(`/wiki/${seq}/${vale.key}`);
  const tile = entryPage(page).getByTestId('entry-graph');
  await expect(tile).toContainText('No connections yet');

  // Emberfall: Mira lives there (a link), Ashen Keep names it (a mention). Old Roads is two steps away.
  await page.goto(`/wiki/${seq}/${ember.key}`);
  await page.getByRole('button', { name: '1 step' }).click();
  await expect(tile.locator('.gn')).toHaveCount(3);
  await expect(node(tile, mira.id)).toHaveAttribute('aria-label', 'Mira, Character, 1 connection');
  await expect(node(tile, ember.id)).toHaveAttribute('aria-label', /^Emberfall, Place, 2 connections, this entry$/);
  await expect(node(tile, keep.id)).toBeVisible();
  // Coloured by type: Place has its own colour.
  await expect(node(tile, ember.id).locator('.gn-dot')).toHaveAttribute('style', /rgb\(79, 140, 255\)|#4f8cff/);
  await expect(tile).toContainText('2 neighbours');

  // Hover lights the node's edges.
  await node(tile, mira.id).hover();
  await expect(tile.locator('.ge.on')).toHaveCount(1);
  await page.mouse.move(0, 0);

  // Click selects and previews; Open goes to the entry.
  await node(tile, mira.id).click();
  const preview = tile.getByTestId('graph-preview');
  await expect(preview).toContainText('Mira');
  await expect(preview).toContainText('Character');
  await expect(preview).toContainText('Keeper of the north gate.');
  await expect(preview).toContainText('lives in');
  await expect(node(tile, mira.id)).toHaveAttribute('aria-pressed', 'true');
  // The preview sits under the picture: the centre stays visible.
  const tileBox = (await tile.locator('.graph-canvas').boundingBox())!;
  expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(tileBox.y + tileBox.height - 1);
  await page.screenshot({ path: `${SHOTS}/graph-entry.png` });
  // A click on the empty background clears the selection.
  await page.mouse.click(tileBox.x + 4, tileBox.y + 4);
  await expect(preview).toHaveCount(0);
  await node(tile, mira.id).click();
  // In the wiki, Open puts the entry in a panel beside this one; Back closes it.
  await preview.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${ember.key}\\?panels=${mira.key}$`));
  await expect(page.getByTestId('wiki-panel').locator('.wiki-panel-title')).toHaveText(['Mira']);
  await page.goBack();
  await expect(page.getByTestId('wiki-panel')).toHaveCount(0);

  // Two steps reach Old Roads; the choice is remembered.
  await tile.getByRole('button', { name: '2 steps' }).click();
  await expect(tile.locator('.gn')).toHaveCount(4);
  await expect(node(tile, roads.id)).toHaveAttribute('aria-label', 'Old Roads, Page, 1 connection');
  await page.reload();
  await expect(entryPage(page).getByTestId('entry-graph').locator('.gn')).toHaveCount(4);

  // Keyboard: one tab stop (the centre), arrows to a neighbour, Space previews, Esc clears then leaves, Enter opens.
  const steps = tile.getByRole('button', { name: '2 steps' });
  await steps.focus();
  await page.keyboard.press('Tab');
  expect(await focusedNode(page)).toBe(ember.id);
  const box = async (id: string) => (await node(tile, id).locator('.gn-dot').boundingBox())!;
  const c = await box(ember.id), m = await box(mira.id);
  const ex = m.x - c.x, ey = m.y - c.y;
  await page.keyboard.press(Math.abs(ex) > Math.abs(ey) ? (ex > 0 ? 'ArrowRight' : 'ArrowLeft') : (ey > 0 ? 'ArrowDown' : 'ArrowUp'));
  await expect.poll(() => focusedNode(page)).not.toBe(ember.id);
  const moved = await focusedNode(page);
  expect([mira.id, keep.id]).toContain(moved);
  await page.keyboard.press(' ');
  await expect(tile.getByTestId('graph-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tile.getByTestId('graph-preview')).toHaveCount(0);
  expect(await focusedNode(page)).toBe(moved);
  await page.keyboard.press('Escape');
  await expect(steps).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Home');
  await expect.poll(() => focusedNode(page)).toBe(ember.id);

  // Live: a link made elsewhere shows up without a reload.
  await run(page, 'wiki', 'addLink', { kindKey: 'lives_in', fromCardId: vale.id, toCardId: ember.id });
  await expect(tile.locator('.gn')).toHaveCount(5);
  await expect(node(tile, vale.id)).toBeVisible();

  // Enter on a node opens that entry (beside this one).
  await node(tile, roads.id).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${ember.key}\\?panels=${roads.key.replace('$', '\\$')}$`));
  await expect(page.getByTestId('panel-entry').getByRole('heading', { name: 'Old Roads' })).toBeVisible();
});

test('the campaign graph: filters, clusters above 50, pan and zoom', async ({ page }) => {
  const { projectId, seq } = await campaign(page, 'Ashlands');
  const place = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Place', icon: '🏰' });
  const npc = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Character', icon: '🧙' });
  await run(page, 'wiki', 'createLinkKind', { projectId, key: 'lives_in', label: 'lives in', reverseLabel: 'home of', fromTypes: [], toTypes: [] });
  const ember = await entry(page, projectId, place.id, 'Emberfall');
  const mira = await entry(page, projectId, npc.id, 'Mira');
  await entry(page, projectId, null, 'Old Roads', 'From Emberfall to the sea.');
  await run(page, 'wiki', 'addLink', { kindKey: 'lives_in', fromCardId: mira.id, toCardId: ember.id });

  // From the wiki's first page.
  await page.goto(`/wiki/${seq}`);
  await page.getByRole('navigation', { name: /wiki$/ }).getByRole('link', { name: 'Graph', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/view/graph$`));
  const view = page.getByTestId('campaign-graph');
  await expect(view.locator('.gn')).toHaveCount(3);
  await expect(view).toContainText('3 entries · 2 connections');

  // Filter by type.
  const filters = view.getByRole('group', { name: 'Show types' });
  await filters.getByLabel(/Character/).uncheck();
  await expect(view.locator('.gn')).toHaveCount(2);
  await expect(node(view, mira.id)).toHaveCount(0);
  await filters.getByLabel(/Character/).check();
  await expect(view.locator('.gn')).toHaveCount(3);

  // Click previews, Open navigates.
  await node(view, mira.id).click();
  await view.getByTestId('graph-preview').getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${seq}/${mira.key}$`));
  await page.goBack();

  // Over 50 entries: one cluster per type; a click opens it.
  for (let i = 0; i < 30; i++) {
    const p = await entry(page, projectId, place.id, `Hamlet ${i}`);
    await run(page, 'wiki', 'addLink', { kindKey: 'lives_in', fromCardId: p.id, toCardId: ember.id });
  }
  for (let i = 0; i < 20; i++) {
    const c = await entry(page, projectId, npc.id, `Villager ${i}`);
    await run(page, 'wiki', 'addLink', { kindKey: 'lives_in', fromCardId: c.id, toCardId: ember.id });
  }
  await expect(view).toContainText('53 entries');
  await expect(view.locator('.gn.cluster')).toHaveCount(2);
  const places = view.locator('.gn.cluster').filter({ hasText: 'Place (31)' });
  await expect(view.locator('.gn.cluster').first()).toHaveAttribute('aria-label', /^(Place \(31\)|Character \(21\)): open to show them$/);
  await page.screenshot({ path: `${SHOTS}/graph-clusters.png` });
  await places.click();
  await expect(view.locator('.gn.cluster')).toHaveCount(1);
  await expect(view.locator('.gn')).toHaveCount(31 + 1 + 1);
  await expect(node(view, ember.id)).toBeVisible();

  // Zoom: wheel, + and 0 (fit) change the picture's transform.
  const inner = view.locator('svg > g').first();
  const t0 = await inner.getAttribute('transform');
  const svg = await view.locator('svg').boundingBox();
  await page.mouse.move(svg!.x + svg!.width / 2, svg!.y + svg!.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => inner.getAttribute('transform')).not.toBe(t0);
  await node(view, ember.id).focus();
  const t1 = await inner.getAttribute('transform');
  await page.keyboard.press('+');
  await expect.poll(() => inner.getAttribute('transform')).not.toBe(t1);
  await page.keyboard.press('0');
  await expect.poll(() => inner.getAttribute('transform')).toBe(t0);
  // Drag pans.
  await page.mouse.move(svg!.x + 10, svg!.y + 10);
  await page.mouse.down();
  await page.mouse.move(svg!.x + 90, svg!.y + 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => inner.getAttribute('transform')).not.toBe(t0);
  await page.screenshot({ path: `${SHOTS}/graph-campaign.png` });
  // Keyboard only: zoomed in, the view follows the focused node; Shift+arrows pan.
  const inBox = async () => {
    const id = await focusedNode(page);
    const b = (await node(view, id!).locator('.gn-dot').boundingBox())!;
    return b.x >= svg!.x && b.y >= svg!.y && b.x + b.width <= svg!.x + svg!.width && b.y + b.height <= svg!.y + svg!.height;
  };
  await node(view, ember.id).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('+');
  await expect.poll(inBox).toBe(true);
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowRight']) {
    await page.keyboard.press(key);
    await expect.poll(inBox).toBe(true);
  }
  const t2 = await inner.getAttribute('transform');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => inner.getAttribute('transform')).not.toBe(t2);
  await expect(view).toContainText('Shift+arrow keys to move');
  await page.keyboard.press('0');
  await expect.poll(() => inner.getAttribute('transform')).toBe(t0);
  // Esc leaves the graph for the Fit button.
  await node(view, ember.id).focus();
  await page.keyboard.press('Escape');
  await expect(view.getByRole('button', { name: 'Fit' })).toBeFocused();
});

test('timing: panning the 2 000-node campaign graph, every type opened', async ({ page }) => {
  test.setTimeout(600_000);
  const { projectId, seq } = await campaign(page, 'Wide World');
  const place = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Place' });
  const npc = await run<{ id: string }>(page, 'wiki', 'createType', { projectId, name: 'Character' });
  await run(page, 'wiki', 'createLinkKind', { projectId, key: 'near', label: 'near', reverseLabel: 'near', fromTypes: [], toTypes: [] });
  // 2 000 entries in a ring with chords, made from inside the page in parallel batches.
  await page.evaluate(async ([projectId, placeId, npcId]) => {
    const call = async (ns: string, action: string, payload: object) => {
      const r = await fetch(`/dispatch/${ns}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(`${ns}/${action}: ${r.status}`);
      return (await r.json()).payload;
    };
    const ids: string[] = [];
    for (let i = 0; i < 2000; i += 25) {
      const batch = await Promise.all(Array.from({ length: Math.min(25, 2000 - i) }, (_, j) =>
        call('wiki', 'createEntry', { projectId, typeId: (i + j) % 3 ? placeId : npcId, name: `Stead ${i + j}` })));
      ids.push(...batch.map((b: any) => b.id));
    }
    const pairs: [string, string][] = [];
    for (let i = 0; i < ids.length; i++) { pairs.push([ids[i], ids[(i + 1) % ids.length]]); if (i % 4 === 0) pairs.push([ids[i], ids[(i * 7 + 13) % ids.length]]); }
    for (let i = 0; i < pairs.length; i += 25) {
      await Promise.all(pairs.slice(i, i + 25).map(([a, b]) => call('wiki', 'addLink', { kindKey: 'near', fromCardId: a, toCardId: b })));
    }
  }, [projectId, place.id, npc.id] as const);

  await page.goto(`/wiki/${seq}/view/graph`);
  const view = page.getByTestId('campaign-graph');
  await expect(view).toContainText('2,000 entries');
  for (const name of ['Place', 'Character']) await view.locator('.gn.cluster').filter({ hasText: name }).click();
  await expect(view.locator('.gn')).toHaveCount(2000, { timeout: 30_000 });
  const svg = (await view.locator('svg').boundingBox())!;

  // Per pointer move: from the event to the end of the frame that shows it (script, render, style, layout, paint).
  const measure = async (label: string, act: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as any;
      w.__moves = [];
      w.__onMove = () => { const t = performance.now(); requestAnimationFrame(() => setTimeout(() => w.__moves.push(performance.now() - t), 0)); };
      window.addEventListener('pointermove', w.__onMove, true);
    });
    await act();
    await page.waitForTimeout(200);
    const f = await page.evaluate(() => { const w = window as any; window.removeEventListener('pointermove', w.__onMove, true); return (w.__moves as number[]).sort((a, b) => a - b); });
    const q = (p: number) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    console.log(`[graph ${label}] 2 000 nodes, ${f.length} moves: event to painted frame median ${q(0.5).toFixed(1)} ms, p90 ${q(0.9).toFixed(1)} ms, max ${f[f.length - 1].toFixed(1)} ms`);
    return q(0.5);
  };
  await measure('pan', async () => {
    await page.mouse.move(svg.x + 6, svg.y + 6);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++) await page.mouse.move(svg.x + 6 + i * 4, svg.y + 6 + i * 2);
    await page.mouse.up();
  });
  await measure('hover', async () => {
    // 20 nodes on screen, hovered one after another.
    const at = await view.locator('.gn .gn-dot').evaluateAll((els, box) => els.map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.left > box.x + 4 && r.right < box.x + box.width - 4 && r.top > box.y + 4 && r.bottom < box.y + box.height - 4)
      .slice(0, 400).filter((_, i) => i % 20 === 0).map((r) => [r.left + r.width / 2, r.top + r.height / 2]), svg);
    expect(at.length).toBeGreaterThan(10);
    for (const [x, y] of at) await page.mouse.move(x, y, { steps: 2 });
  });
});
