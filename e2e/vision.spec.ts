import { test, expect } from '@playwright/test';
import { ensureWorkspace, newPerson, run, snapshot, unique } from './helpers';

test('vision board: create from a card, nav link, read only for a member, delete', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Vision proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Vision list'), projectId: project.id, spaceId: 1 });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Moodboard host' });

  // No boards yet: the empty state.
  await page.goto('/vision');
  await expect(page.getByRole('heading', { name: 'Vision board' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pick task' })).toBeVisible();

  // Create from the card's "Board" button.
  await openCard(page, 'Moodboard host');
  await page.getByTestId('card-page').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(/\/vision\/1$/);
  await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Moodboard host' })).toBeVisible();
  await expect(page.getByText('This board is read-only for you')).toHaveCount(0);

  // The nav link goes to the last opened board, from anywhere.
  await page.goto('/decks');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vision board' })).toHaveAttribute('href', '/vision/1');
  await page.keyboard.press('Shift+Digit4');
  await expect(page).toHaveURL(/\/vision\/1$/);
  // /vision redirects to it.
  await page.goto('/vision');
  await expect(page).toHaveURL(/\/vision\/1$/);

  // Board picker lists it, marked as current.
  await page.getByRole('button', { name: 'Moodboard host' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose board' });
  await expect(picker.getByText('Last opened')).toBeVisible();
  await expect(picker.getByText('All boards')).toBeVisible();
  await expect(picker.getByRole('option', { name: /Moodboard host/ })).toHaveCount(2); // last opened and all
  await expect(picker.getByRole('option', { name: /Moodboard host/ }).last()).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // Read only: the owner (creator) keeps editing, a member does not.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitemradio', { name: /Read only/ }).click();
  await expect.poll(async () => (await snapshot(page)).visionBoards[0].state).toBe('read_only');
  await expect(page.getByText('This board is read-only for you')).toHaveCount(0);
  // The creator still has the node tools; pin a note for the member to see.
  const ownerTools = page.getByRole('group', { name: 'Node tools' });
  await ownerTools.getByRole('button', { name: 'Text' }).click();
  const vb = (await page.getByTestId('board-viewport').boundingBox())!;
  await page.mouse.click(vb.x + 300, vb.y + 200);
  await page.getByRole('textbox', { name: 'Text' }).fill('Pinned');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-node-type="text"]')).toHaveText('Pinned');

  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [project.id] });
  const b = await newPerson(browser);
  const name = unique('Mia');
  const res = await b.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  await b.goto('/vision/1');
  await expect(b.getByText('This board is read-only for you')).toBeVisible();
  await expect(b.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  await expect(b.getByRole('group', { name: 'Node tools' })).toHaveCount(0);
  // Read only: selecting a node offers Focus only, and dragging it pans the view instead of moving it.
  const pinned = b.locator('[data-node-type="text"]');
  await expect(pinned).toHaveText('Pinned');
  await pinned.click();
  const bar = b.getByRole('toolbar', { name: 'Node actions' });
  await expect(bar.getByRole('button')).toHaveText(['Focus']);
  const start = (await pinned.boundingBox())!;
  await b.mouse.move(start.x + 20, start.y + 20);
  await b.mouse.down({ button: 'middle' });
  await b.mouse.move(start.x + 120, start.y + 80, { steps: 4 });
  await b.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await pinned.boundingBox())!.x).toBeGreaterThan(start.x + 50); // the view moved
  expect(await pinned.evaluate((el: HTMLElement) => [el.dataset.x, el.dataset.y])).toEqual(['220', '180']);
  await b.keyboard.press('Delete');
  await expect(pinned).toHaveCount(1);
  // A member who is not the creator or a manager gets no state radios and no delete.
  await b.getByRole('button', { name: 'More' }).click();
  await expect(b.getByRole('menuitem', { name: 'Go to task' })).toBeVisible();
  await expect(b.getByRole('menuitemradio')).toHaveCount(0);
  await expect(b.getByRole('menuitem', { name: 'Delete board' })).toHaveCount(0);
  await b.context().close();

  // Delete returns to the empty state.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete board' }).click();
  await page.getByRole('dialog', { name: 'Delete board?' }).getByRole('button', { name: 'Delete board' }).click();
  await expect(page).toHaveURL(/\/vision$/);
  await expect(page.getByRole('heading', { name: 'Vision board' })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).visionBoards.length).toBe(0);
  // It stays on the empty state: /vision does not bounce back to the deleted board.
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/vision$/);
  await expect(page.getByRole('heading', { name: 'Vision board' })).toBeVisible();
});

async function openCard(page: import('@playwright/test').Page, title: string) {
  await page.goto('/decks');
  await page.getByRole('link', { name: /Vision list/ }).first().click();
  await page.getByTestId('card-tile').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('card-page')).toBeVisible();
}

// Node positions are read from the data-* attributes each node renders (the stored pos, not the drag preview).
type Pos = { x: number; y: number; w: number; h: number; parent: string | null; color: string | null; id: string };
const posOf = (node: import('@playwright/test').Locator) => node.evaluate((el: HTMLElement): Pos => ({
  id: el.dataset.nodeId!, x: Number(el.dataset.x), y: Number(el.dataset.y), w: Number(el.dataset.w), h: Number(el.dataset.h),
  parent: el.dataset.parent || null, color: el.dataset.color || null,
}));

async function drag(page: import('@playwright/test').Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 4 });
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 4 });
  await page.mouse.up();
}

async function centre(node: import('@playwright/test').Locator) {
  const b = (await node.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('vision board canvas: place, edit, move, contain, colour, delete, undo, two movers', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Canvas proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Canvas list'), projectId: project.id, spaceId: 1 });
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Canvas host' });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: card.id });
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  const tools = page.getByRole('group', { name: 'Node tools' });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(tools.getByRole('button', { name: 'Redo' })).toBeDisabled();

  const view = page.getByTestId('board-viewport');
  const box = (await view.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });

  // Text: choose the tool, click the board; the node is centred on the click and opens for editing.
  await tools.getByRole('button', { name: 'Text' }).click();
  await page.mouse.click(at(300, 200).x, at(300, 200).y);
  const editor = page.getByRole('textbox', { name: 'Text' });
  await expect(editor).toBeFocused();
  await editor.fill('Hello');
  await editor.press('Enter');
  const text = page.locator('[data-node-type="text"]').filter({ hasText: 'Hello' });
  await expect(text).toHaveText('Hello');
  expect(await posOf(text)).toMatchObject({ x: 220, y: 180, w: 160, h: 40, parent: null });

  // Persisted: a reload shows it again.
  await page.reload();
  await expect(page.locator('[data-node-type="text"]')).toHaveText('Hello');

  // Move: one snapped write on drop. 220+150 → 380 (snap 370 up), 180+90 → 280 (snap 270 up).
  await drag(page, await centre(text), { x: 150, y: 90 });
  await expect.poll(async () => { const p = await posOf(text); return [p.x, p.y]; }).toEqual([380, 280]);

  // A container; drag the text into it: parent is set. Dragging it out clears it.
  await tools.getByRole('button', { name: 'Container' }).click();
  await page.mouse.click(at(700, 400).x, at(700, 400).y);
  const box1 = page.locator('[data-node-type="container"]');
  const cont = await posOf(box1);
  expect(cont).toMatchObject({ x: 600, y: 360, w: 200, h: 100 });
  await page.keyboard.press('Escape');
  // text centre (460, 300) → container centre (700, 410)
  await drag(page, await centre(text), { x: 240, y: 110 });
  await expect.poll(async () => (await posOf(text)).parent).toBe(cont.id);
  // Moving the container moves its child too.
  await drag(page, { x: box.x + 610, y: box.y + 450 }, { x: -200, y: 0 }); // below the text, clear of its toolbar
  await expect.poll(async () => (await posOf(box1)).x).toBe(400);
  await expect.poll(async () => (await posOf(text)).x).toBe(420);
  expect((await posOf(text)).parent).toBe(cont.id);

  // Container label through Edit.
  await page.mouse.click(box.x + 500, box.y + 375);
  const bar = page.getByRole('toolbar', { name: 'Node actions' });
  await bar.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Container label' }).fill('Ideas');
  await page.keyboard.press('Enter');
  await expect(box1).toContainText('Ideas');

  // Colour the text green.
  await text.click();
  await bar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Green' }).click();
  await expect.poll(async () => (await posOf(text)).color).toBe('green');

  // Delete key, Undo brings it back (with its colour and parent), Redo removes it again.
  await text.click();
  await page.keyboard.press('Delete');
  await expect(text).toHaveCount(0);
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(text).toHaveText('Hello');
  expect(await posOf(text)).toMatchObject({ color: 'green', parent: cont.id });
  await expect(tools.getByRole('button', { name: 'Redo' })).toBeEnabled();
  await tools.getByRole('button', { name: 'Redo' }).click();
  await expect(text).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(text).toHaveCount(1);

  // Esc cancels a chosen tool.
  await tools.getByRole('button', { name: 'Text' }).click();
  await expect(tools.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(tools.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'false');

  // Resize: growing the container over a node adopts it; the size snaps (one write on release).
  await tools.getByRole('button', { name: 'Text' }).click();
  await page.mouse.click(at(620, 480).x, at(620, 480).y); // → 540..700 × 460..500, outside the container
  await page.keyboard.press('Escape'); // leaves the editor, keeps the empty node
  const loose = page.locator('[data-node-type="text"]').filter({ hasNotText: 'Hello' });
  expect(await posOf(loose)).toMatchObject({ x: 540, y: 460, parent: null });
  await page.mouse.click(box.x + 410, box.y + 375);
  const se = page.locator('[data-handle="se"]');
  await drag(page, await centre(se), { x: 95, y: 45 });
  await expect.poll(async () => { const p = await posOf(box1); return [p.x, p.y, p.w, p.h]; }).toEqual([400, 360, 300, 140]);
  await expect.poll(async () => (await posOf(loose)).parent).toBe(cont.id);

  // Zoom in 10 % steps; Focus fills about 60 % of the view; the percentage resets to 100 %.
  const zoom = page.getByRole('group', { name: 'Zoom' });
  await zoom.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom.getByRole('button', { name: /^Zoom 110%/ })).toBeVisible();
  await zoom.getByRole('button', { name: 'Zoom out' }).click();
  await zoom.getByRole('button', { name: 'Zoom out' }).click();
  await expect(zoom.getByRole('button', { name: /^Zoom 90%/ })).toBeVisible();
  await box1.click({ position: { x: 12, y: 12 } });
  await bar.getByRole('button', { name: 'Focus' }).click();
  const focused = (await box1.boundingBox())!;
  const fill = Math.max(focused.width / box.width, focused.height / box.height);
  expect(fill).toBeGreaterThan(0.5);
  expect(fill).toBeLessThanOrEqual(0.61);
  await zoom.getByRole('button', { name: /^Zoom \d+%/ }).click();
  await expect(zoom.getByRole('button', { name: /^Zoom 100%/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Keyboard: a tool button pressed with Enter places the node at the view centre and opens its editor;
  // Enter in the editor writes and returns focus to the node.
  await tools.getByRole('button', { name: 'Text' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused();
  await page.keyboard.type('Keys');
  await page.keyboard.press('Enter');
  const keys = page.locator('[data-node-type="text"]').filter({ hasText: 'Keys' });
  await expect(keys).toBeFocused();
  const k0 = await posOf(keys);
  // Arrows move one grid step per press (Shift: 5), Alt+arrows resize.
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await posOf(keys)).x).toBe(k0.x + 20);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await posOf(keys)).y).toBe(k0.y + 100);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => (await posOf(keys)).w).toBe(180);
  // Enter edits; Esc cancels and focus is back on the node.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(keys).toBeFocused();
  // Tab reaches the toolbar; arrows rove; the swatches open on the current colour; picking one returns to Colour.
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('button', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: 'Colour' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bar.getByRole('button', { name: 'None' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: 'Blue' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await posOf(keys)).color).toBe('blue');
  await expect(bar.getByRole('button', { name: 'Colour' })).toBeFocused();
  // Esc closes the swatches first (focus on Colour), then deselects (focus on the node).
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(bar.getByRole('button', { name: 'Blue' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Colour' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(keys).toBeFocused();
  // +/- zoom with focus in the canvas; Space selects; Delete removes and leaves focus on the canvas.
  await page.keyboard.press('+');
  await expect(zoom.getByRole('button', { name: /^Zoom 110%/ })).toBeVisible();
  await page.keyboard.press('-');
  await expect(zoom.getByRole('button', { name: /^Zoom 100%/ })).toBeVisible();
  await page.keyboard.press(' ');
  await expect(bar).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(keys).toHaveCount(0);
  await expect(view).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect(keys).toHaveCount(1);

  // Two pages move the same node at once: both end with the same position (last writer wins).
  const ctx2 = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const p2 = await ctx2.newPage();
  await ensureWorkspace(p2);
  await p2.goto(`/vision/${accountSeq}`);
  const text2 = p2.locator('[data-node-type="text"]').filter({ hasText: 'Hello' });
  await expect(text2).toHaveText('Hello');
  const before = await posOf(text);
  const [c1, c2] = [await centre(text), await centre(text2)];
  await page.mouse.move(c1.x, c1.y);
  await p2.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await p2.mouse.down();
  await page.mouse.move(c1.x + 100, c1.y + 200, { steps: 5 });
  await p2.mouse.move(c2.x + 300, c2.y - 100, { steps: 5 });
  await Promise.all([page.mouse.up(), p2.mouse.up()]);
  await expect.poll(async () => {
    const [a, b] = [await posOf(text), await posOf(text2)];
    return a.x === b.x && a.y === b.y && (a.x !== before.x || a.y !== before.y);
  }).toBe(true);

  // Undo reverts only my own change: A nudges the node, B colours it, A undoes: the nudge goes, B's colour stays.
  const p0 = await posOf(text);
  await text.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await posOf(text2)).x).toBe(p0.x - 20);
  await text2.click();
  await p2.getByRole('toolbar', { name: 'Node actions' }).getByRole('button', { name: 'Colour' }).click();
  await p2.getByRole('button', { name: 'Pink' }).click();
  await expect.poll(async () => (await posOf(text)).color).toBe('pink');
  await text.focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await posOf(text2)).x).toBe(p0.x);
  expect((await posOf(text)).color).toBe('pink');
  expect((await posOf(text2)).color).toBe('pink');
  await ctx2.close();
});

test('vision board connectors: draw, label, colour, delete with node, undo, keyboard connect, read only', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Edge proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Edge list'), projectId: project.id, spaceId: 1 });
  const card = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Edge host' });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: card.id });
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  const tools = page.getByRole('group', { name: 'Node tools' });
  const box = (await page.getByTestId('board-viewport').boundingBox())!;

  const put = async (label: string, x: number, y: number) => {
    await tools.getByRole('button', { name: 'Text' }).click();
    await page.mouse.click(box.x + x, box.y + y);
    await page.getByRole('textbox', { name: 'Text' }).fill(label);
    await page.keyboard.press('Enter');
    return page.locator('[data-node-type="text"]').filter({ hasText: label });
  };
  const a = await put('Alpha', 200, 200);
  const b = await put('Beta', 600, 200);
  const c = await put('Gamma', 400, 400);
  const edges = page.locator('[data-edge-id]');
  await expect(edges).toHaveCount(0);

  // Four handles on the hovered node, each named for its side; drop near B's left side.
  await a.hover();
  for (const side of ['top', 'right', 'bottom', 'left']) await expect(page.getByRole('button', { name: `Connect from ${side}` })).toBeVisible();
  const bb = (await b.boundingBox())!;
  const from = await centre(page.getByRole('button', { name: 'Connect from right' }));
  await drag(page, from, { x: bb.x + 10 - from.x, y: bb.y + bb.height / 2 - from.y });
  await expect(edges).toHaveCount(1);
  const idA = (await posOf(a)).id, idB = (await posOf(b)).id, idC = (await posOf(c)).id;
  await expect(edges).toHaveAttribute('data-source', idA);
  await expect(edges).toHaveAttribute('data-source-side', 'right');
  await expect(edges).toHaveAttribute('data-target', idB);
  await expect(edges).toHaveAttribute('data-target-side', 'left');

  // Dropping on empty space or on the same node makes nothing.
  await a.hover();
  const h = await centre(page.getByRole('button', { name: 'Connect from bottom' }));
  await drag(page, h, { x: 0, y: 150 }); // empty canvas
  await expect(edges).toHaveCount(1);
  await a.hover();
  const h2 = await centre(page.getByRole('button', { name: 'Connect from bottom' }));
  const ab = (await a.boundingBox())!;
  await drag(page, h2, { x: ab.x + 20 - h2.x, y: ab.y + 20 - h2.y }); // back onto A
  await expect(edges).toHaveCount(1);

  // Label it through the edge toolbar, then colour it pink.
  await page.mouse.click(box.x + 100, box.y + 500); // clear the selection
  await edges.focus();
  const bar = page.getByRole('toolbar', { name: 'Connector actions' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Edit label' }).click();
  await page.getByRole('textbox', { name: 'Connector label' }).fill('needs');
  await page.keyboard.press('Enter');
  await expect(edges).toHaveAttribute('data-label', 'needs');
  await expect(edges).toBeFocused();
  await page.keyboard.press('Tab');
  await bar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Pink' }).click();
  await expect(edges).toHaveAttribute('data-color', 'pink');

  // Edges follow a node live while it is dragged: the path changes before the drop.
  const d0 = await edges.locator('.bedge-line').getAttribute('d');
  const bc = await centre(b);
  await page.mouse.move(bc.x, bc.y);
  await page.mouse.down();
  await page.mouse.move(bc.x + 60, bc.y + 80, { steps: 4 });
  expect(await edges.locator('.bedge-line').getAttribute('d')).not.toBe(d0);
  await page.mouse.up();

  // Focus frames both ends.
  await edges.focus();
  await bar.getByRole('button', { name: 'Focus' }).click();
  for (const n of [a, b]) {
    const nb = (await n.boundingBox())!;
    expect(nb.x).toBeGreaterThanOrEqual(box.x);
    expect(nb.x + nb.width).toBeLessThanOrEqual(box.x + box.width);
  }

  // Delete key removes only the edge; the nodes stay. Undo brings it back.
  await edges.focus();
  await page.keyboard.press('Delete');
  await expect(edges).toHaveCount(0);
  await expect(a).toHaveCount(1);
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(edges).toHaveCount(1);
  await expect(edges).toHaveAttribute('data-label', 'needs');

  // Deleting node B removes the edge; Undo brings back both.
  await b.click();
  await page.keyboard.press('Delete');
  await expect(b).toHaveCount(0);
  await expect(edges).toHaveCount(0);
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(b).toHaveCount(1);
  await expect(edges).toHaveCount(1);
  await expect(edges).toHaveAttribute('data-color', 'pink');

  // Keyboard connect: A (focused, selected) -> toolbar "Connect to…" -> Gamma.
  await a.focus();
  await page.keyboard.press('Tab');
  const nodeBar = page.getByRole('toolbar', { name: 'Node actions' });
  await nodeBar.getByRole('button', { name: /^Connect to/ }).click();
  const list = nodeBar.getByRole('group', { name: 'Connect to' });
  await expect(list.getByRole('button')).toHaveCount(2); // Beta, Gamma; never itself
  await list.getByRole('button', { name: /Gamma/ }).click();
  await expect(edges).toHaveCount(2);
  await expect(page.locator(`[data-edge-id][data-source="${idA}"][data-target="${idC}"]`)).toHaveCount(1);

  // Read only: a member sees the edges but has no handles and no edit actions.
  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [project.id] });
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitemradio', { name: /Read only/ }).click();
  const m = await newPerson(browser);
  const name = unique('Eve');
  const res = await m.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  await m.goto(`/vision/${accountSeq}`);
  await expect(m.getByText('This board is read-only for you')).toBeVisible();
  const medges = m.locator('[data-edge-id]');
  await expect(medges).toHaveCount(2);
  await m.locator('[data-node-type="text"]').filter({ hasText: 'Alpha' }).hover();
  await expect(m.getByRole('button', { name: /^Connect from/ })).toHaveCount(0);
  await medges.first().focus();
  await expect(m.getByRole('toolbar', { name: 'Connector actions' }).getByRole('button')).toHaveText(['Focus']);
  await m.keyboard.press('Delete');
  await expect(medges).toHaveCount(2);
  await m.context().close();
});

test('vision board media: card (existing, new), image upload, YouTube video', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Media proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Media list'), projectId: project.id, spaceId: 1 });
  const host = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Media host' });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Linked target', effort: 3, priority: 'a' });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: host.id });
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  const tools = page.getByRole('group', { name: 'Node tools' });
  const view = page.getByTestId('board-viewport');
  const box = (await view.boundingBox())!;
  const click = (x: number, y: number) => page.mouse.click(box.x + x, box.y + y);
  const nodes = (type: string) => page.locator(`[data-node-type="${type}"]`);

  // Existing card: choosing the tool and clicking opens the dialog; nothing is written until a card is chosen.
  await tools.getByRole('button', { name: 'Task' }).click();
  await click(300, 200);
  const dlg = page.getByRole('dialog', { name: 'Add task' });
  await expect(dlg).toBeVisible();
  await expect(nodes('card')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(nodes('card')).toHaveCount(0);

  await tools.getByRole('button', { name: 'Task' }).click();
  await click(300, 200);
  await dlg.getByRole('combobox', { name: 'Search tasks' }).fill('linked');
  await dlg.getByRole('option', { name: /Linked target/ }).click();
  const card = nodes('card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Linked target');
  await expect(card).toContainText('3');
  await expect(card).toBeFocused();
  // Live title: renaming the card updates the node.
  const target = (await snapshot(page)).cards.find((c: any) => c.content === 'Linked target');
  await run(page, 'cards', 'update', { id: target.id, content: 'Linked renamed', contentVersion: target.contentVersion });
  await expect(card).toContainText('Linked renamed');
  // Clicking the node opens the card panel over the board; the URL stays on the board.
  await card.click();
  const panel = page.getByRole('complementary', { name: 'Open task' });
  await expect(panel.getByTestId('card-page')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/vision/${accountSeq}$`));
  await panel.getByRole('button', { name: 'Close task' }).click();
  await expect(panel).toHaveCount(0);

  // Create new: the card lands in the host's deck, and the node shows it.
  await tools.getByRole('button', { name: 'Task' }).click();
  await click(600, 200);
  await dlg.getByRole('tab', { name: 'Create new' }).click();
  await expect(dlg.getByLabel('Create in')).toContainText(/Media list/);
  await dlg.getByLabel('Task title').fill('Fresh idea');
  await dlg.getByRole('button', { name: 'Create task' }).click();
  await expect(nodes('card')).toHaveCount(2);
  await expect(nodes('card').filter({ hasText: 'Fresh idea' })).toBeFocused();
  const made = (await snapshot(page)).cards.find((c: any) => c.content.startsWith('Fresh idea'));
  expect(made.deckId).toBe(deck.id);

  // Image: a generated PNG (kept in memory), uploaded to the host card, shown at its natural size.
  const png = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 150;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e07b00'; g.fillRect(0, 0, 300, 150);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await tools.getByRole('button', { name: 'Image' }).click();
  await click(300, 450);
  const upl = page.getByRole('dialog', { name: 'Upload image' });
  await expect(nodes('image')).toHaveCount(0);
  await upl.getByLabel('Choose image').setInputFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: png });
  const img = nodes('image');
  await expect(img).toHaveCount(1);
  await expect(img).toBeFocused();
  expect(await posOf(img)).toMatchObject({ w: 300, h: 150 });
  const pic = img.locator('img');
  await expect.poll(() => pic.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(300);
  await expect(pic).toHaveAttribute('src', /^\/api\/files\/[\w-]+$/);
  expect((await snapshot(page)).files.filter((f: any) => f.cardId === host.id && f.name === 'swatch.png')).toHaveLength(1);

  // Video: an invalid value shows an error and writes nothing; a valid id shows the link, no embed.
  await tools.getByRole('button', { name: 'Video' }).click();
  await click(700, 450);
  const vd = page.getByRole('dialog', { name: 'Add YouTube video' });
  await vd.getByLabel('YouTube URL or id').fill('not a video');
  await vd.getByRole('button', { name: 'Add video' }).click();
  await expect(vd.getByRole('alert')).toContainText(/YouTube/);
  await expect(nodes('video')).toHaveCount(0);
  await vd.getByLabel('YouTube URL or id').fill('aqz-KE-bpKQ');
  await vd.getByRole('button', { name: 'Add video' }).click();
  const vid = nodes('video');
  await expect(vid).toHaveCount(1);
  await expect(vid).toBeFocused();
  await expect(vid).toContainText('aqz-KE-bpKQ');
  const link = vid.getByRole('link', { name: /Open on YouTube/ });
  await expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(vid.locator('iframe, video')).toHaveCount(0);

  // Keyboard: the Card tool from the keyboard (Enter on the tool) opens the dialog at once; Esc returns focus.
  const cardTool = tools.getByRole('button', { name: 'Task' });
  await cardTool.focus();
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(cardTool).toBeFocused();

  // A deleted card is not shown: its node says so.
  await run(page, 'cards', 'update', { id: made.id, visibility: 'deleted' });
  await expect(nodes('card').filter({ hasText: 'Fresh idea' })).toHaveCount(0);
  await expect(nodes('card').filter({ hasText: 'Task not available' })).toHaveCount(1);

  // Persisted across a reload.
  await page.reload();
  await expect(nodes('card')).toHaveCount(2);
  await expect(nodes('image').locator('img')).toHaveCount(1);
  await expect(nodes('video')).toContainText('aqz-KE-bpKQ');
});

test('vision board smart node: filter, figures, table, add to board, keyboard', async ({ page }) => {
  await ensureWorkspace(page);
  // The database is shared between specs, so the tag is unique to this run (other specs use #bug).
  const tag = `bug${Date.now() % 100000}`;
  const me = (await page.evaluate(async () => (await (await fetch('/api/snapshot')).json()).me.id)) as string;
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Smart proj') });
  await run(page, 'projects', 'update', { id: project.id, tags: [{ name: tag, emoji: null }] });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Smart list'), projectId: project.id, spaceId: 1 });
  const host = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Smart host' });
  const one = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: `Crash on load #${tag}`, assigneeId: me });
  await run(page, 'cards', 'create', { deckId: deck.id, content: `Flicker on resize #${tag}` });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Unrelated chore' });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: host.id });
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  const tools = page.getByRole('group', { name: 'Node tools' });
  const box = (await page.getByTestId('board-viewport').boundingBox())!;
  const smart = page.locator('[data-node-type="filter"]');

  // Place: no filter yet.
  await tools.getByRole('button', { name: 'Smart Node' }).click();
  await page.mouse.click(box.x + 560, box.y + 240); // clear of the tool rail, which would cover the wide toolbar
  await expect(smart).toContainText('No filter yet');
  const bar = page.getByRole('toolbar', { name: 'Node actions' });
  await expect(bar.getByRole('button')).toHaveText(['Display', 'Set up filter', 'Open as search', 'Edit label', 'Colour', 'Connect to…', 'Focus', 'Delete']);

  // Set up the tag filter: two cards are listed; nothing is written until Save.
  await bar.getByRole('button', { name: 'Set up filter' }).click();
  const panel = page.getByRole('complementary', { name: 'Smart filter' });
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox', { name: 'Filter tasks' }).fill(`#${tag}`);
  await panel.getByRole('option', { name: `#${tag}` }).click();
  await expect(panel.getByRole('list', { name: 'Matching tasks' }).getByRole('listitem')).toHaveCount(2);
  await expect(smart).toContainText('No filter yet');
  await panel.getByRole('button', { name: 'Save filter' }).click();
  await expect(smart).toContainText(`#${tag} tasks`);
  await expect(smart).toContainText('0%');
  expect((await snapshot(page)).visionQueries.filter((q: any) => q.cardId === host.id)).toHaveLength(1);

  // Figures follow the cards.
  await run(page, 'cards', 'update', { id: one.id, status: 'done' });
  await expect(smart).toContainText('50%');

  // Add to board: a card node lands beside the Smart Node.
  await panel.getByRole('listitem').filter({ hasText: 'Flicker on resize' }).getByRole('button', { name: '+ Add to board' }).click();
  const placed = page.locator('[data-node-type="card"]');
  await expect(placed).toHaveCount(1);
  await expect(placed).toContainText('Flicker on resize');
  const [s, c] = [await smart.evaluate((el: HTMLElement) => +el.dataset.x! + +el.dataset.w!), await placed.evaluate((el: HTMLElement) => +el.dataset.x!)];
  expect(c).toBeGreaterThanOrEqual(s);

  // Esc closes the panel and focus goes back to the node.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(smart).toBeFocused();
  // Keyboard: Enter on the node opens the panel with the cursor in the chip input; the first Esc closes its menu, the next the panel.
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  const chipInput = panel.getByRole('combobox', { name: 'Filter tasks' });
  await expect(chipInput).toBeFocused();
  await chipInput.fill('@');
  await expect(panel.getByRole('listbox', { name: 'Filter suggestions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('listbox')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await chipInput.fill('');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(smart).toBeFocused();

  // Display: Table with the Owner column.
  await bar.getByRole('button', { name: 'Display' }).click();
  const display = page.getByRole('group', { name: 'Display' });
  await display.getByRole('button', { name: 'Number' }).click();
  await expect(smart).toContainText('1 of 2 done');
  await display.getByRole('button', { name: 'Table' }).click();
  await display.getByRole('checkbox', { name: 'Owner' }).check();
  await expect(smart.getByRole('columnheader', { name: 'Owner' })).toBeVisible();
  await expect(smart.getByRole('row')).toHaveCount(3); // header and two cards
  await expect(smart).toContainText('Crash on load');
  await expect(smart).toContainText('Flicker on resize');
  await expect(smart.getByRole('row').filter({ hasText: 'Crash on load' })).toContainText(/\w/);
  expect(await posOf(smart)).toMatchObject({ w: 160, h: 200 });
  // Esc closes the popover first and returns focus to Display.
  await page.keyboard.press('Escape');
  await expect(display).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Display' })).toBeFocused();

  // Save B, then Undo: the node goes back to A's figures (A's query is still live), not "Filter not available".
  await bar.getByRole('button', { name: 'Set up filter' }).click();
  await panel.getByRole('button', { name: `Remove filter #${tag}` }).click();
  await panel.getByRole('button', { name: 'Save filter' }).click();
  await expect(smart).toContainText('All tasks');
  expect((await snapshot(page)).visionQueries.filter((q: any) => q.cardId === host.id)).toHaveLength(2);
  await page.getByRole('group', { name: 'Node tools' }).getByRole('button', { name: 'Undo' }).click();
  await expect(smart).toContainText(`#${tag} tasks`);
  await expect(smart).not.toContainText('Filter not available');
  await panel.getByRole('button', { name: 'Close filter' }).click();
  await expect(panel).toHaveCount(0);

  // Open as search goes to /decks with the chips.
  await bar.getByRole('button', { name: 'Open as search' }).click();
  await expect(page).toHaveURL(/\/decks\?search=/);

  // Persisted: the label and table survive a reload.
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.locator('[data-node-type="filter"]')).toContainText(`#${tag} tasks`);
  await expect(page.locator('[data-node-type="filter"]').getByRole('columnheader', { name: 'Owner' })).toBeVisible();
});

test('vision board presence: named cursor, selection outline, avatar stack, leaving', async ({ page, browser }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Presence proj') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: unique('Presence list'), projectId: project.id, spaceId: 1 });
  const host = await run<{ id: string }>(page, 'cards', 'create', { deckId: deck.id, content: 'Presence host' });
  const { accountSeq } = await run<{ accountSeq: number }>(page, 'visionBoard', 'createBoard', { cardId: host.id });
  await page.goto(`/vision/${accountSeq}`);
  await expect(page.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  const tools = page.getByRole('group', { name: 'Node tools' });
  const box = (await page.getByTestId('board-viewport').boundingBox())!;
  await tools.getByRole('button', { name: 'Text' }).click();
  await page.mouse.click(box.x + 300, box.y + 200);
  await page.getByRole('textbox', { name: 'Text' }).fill('Shared note');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-node-type="text"]')).toHaveText('Shared note');

  const { token } = await run<{ token: string }>(page, 'invites', 'create', { role: 'member', projectIds: [project.id] });
  const b = await newPerson(browser);
  const name = unique('Zed');
  const res = await b.request.post(`/api/invites/${token}/accept`, {
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, password: 'another good password' },
  });
  expect(res.ok()).toBeTruthy();
  await b.goto(`/vision/${accountSeq}`);
  await expect(b.getByRole('status', { name: /Connection: online/ })).toBeVisible();
  await expect(b.locator('[data-node-type="text"]')).toHaveText('Shared note');

  // Both are in the header stack, with accessible names.
  const stackA = page.getByRole('list', { name: 'On this board' });
  await expect(stackA.getByRole('img', { name })).toBeVisible();
  await expect(stackA.getByRole('img', { name: /Ada Owner/ })).toBeVisible();

  // B moves the mouse: A shows B's named cursor.
  const bbox = (await b.getByTestId('board-viewport').boundingBox())!;
  await b.mouse.move(bbox.x + 500, bbox.y + 300, { steps: 3 });
  await b.mouse.move(bbox.x + 520, bbox.y + 320, { steps: 3 });
  const cursor = page.locator('[data-peer-cursor]');
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toContainText(name);
  // It sits in board coordinates: it follows A's pan.
  const before = (await cursor.boundingBox())!;
  await page.mouse.move(box.x + 700, box.y + 400);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 780, box.y + 440, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await cursor.boundingBox())!.x).toBeGreaterThan(before.x + 50);

  // B selects the node: A sees an outline on it.
  await b.locator('[data-node-type="text"]').click();
  await expect(page.locator('[data-peer-outline]')).toHaveCount(1);
  const nodeId = await page.locator('[data-node-type="text"]').getAttribute('data-node-id');
  await expect(page.locator('[data-peer-outline]')).toHaveAttribute('data-peer-outline', nodeId!);

  // B leaves: cursor, outline and avatar go.
  await b.context().close();
  await expect(cursor).toHaveCount(0);
  await expect(page.locator('[data-peer-outline]')).toHaveCount(0);
  await expect(stackA.getByRole('img', { name })).toHaveCount(0);
});

test('a project board lays the project out as a tree, and updates without duplicates', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Tree project');
  const project = await run(page, 'projects', 'create', { name });
  const deck = await run(page, 'decks', 'create', { title: unique('Tree list'), projectId: project.id });
  const a = (await run(page, 'cards', 'create', { deckId: deck.id, content: 'Tree task A' })).id as string;
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Tree task B' });
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Tree sub of A', parentCardId: a });
  const done = (await run(page, 'cards', 'create', { deckId: deck.id, content: 'Tree finished' })).id as string;
  await run(page, 'cards', 'update', { id: done, status: 'done' });

  await page.goto('/vision');
  await page.getByRole('button', { name: 'Project board' }).click();
  const dlg = page.getByRole('dialog', { name: 'Project board' });
  await dlg.getByRole('combobox').selectOption({ label: name });
  await dlg.getByRole('button', { name: 'Create board' }).click();
  await expect(page).toHaveURL(/\/vision\/\d+$/);
  const canvas = page.getByRole('region', { name: 'Board' });
  // Open tasks only: A, B and A's subtask, not the finished one.
  await expect(canvas.locator('.bcard')).toHaveCount(3);
  await expect(canvas).toContainText(name);
  await expect(canvas).toContainText('Tree sub of A');
  await expect(canvas).not.toContainText('Tree finished');

  // A task added later comes in with "Project tree"; nothing already there is added twice.
  await run(page, 'cards', 'create', { deckId: deck.id, content: 'Tree task C' });
  await page.getByRole('button', { name: 'Project tree' }).click();
  const again = page.getByRole('dialog', { name: 'Project tree' });
  await again.getByRole('combobox').selectOption({ label: name });
  await again.getByRole('button', { name: 'Add to the board' }).click();
  await expect(canvas.locator('.bcard')).toHaveCount(4);
  await expect(page.getByRole('status').getByText('Added 1 task and 1 line')).toBeVisible();
});

test('lines on a project board change the project: a task waits for another, and moves to another list', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Line project');
  const project = await run(page, 'projects', 'create', { name });
  const l1 = await run(page, 'decks', 'create', { title: unique('Line list one'), projectId: project.id });
  const l2title = unique('Line list two');
  const l2 = await run(page, 'decks', 'create', { title: l2title, projectId: project.id });
  const a = (await run(page, 'cards', 'create', { deckId: l1.id, content: 'Line task A' })).id as string;
  const b = (await run(page, 'cards', 'create', { deckId: l1.id, content: 'Line task B' })).id as string;

  await page.goto('/vision');
  await page.getByRole('button', { name: 'Project board' }).click();
  const dlg = page.getByRole('dialog', { name: 'Project board' });
  await dlg.getByRole('combobox').selectOption({ label: name });
  await dlg.getByRole('button', { name: 'Create board' }).click();
  await expect(page).toHaveURL(/\/vision\/\d+$/);
  const node = (text: string) => page.locator('[data-node-type]').filter({ hasText: text });
  await expect(node('Line task B')).toHaveCount(1);
  const edges = page.locator('[data-edge-id]');
  const before = await edges.count();

  // A → B: the board asks what the line means; "waits for" is saved on the task and labels the line.
  await node('Line task A').hover();
  let from = await centre(page.getByRole('button', { name: 'Connect from right' }));
  let to = (await node('Line task B').boundingBox())!;
  await drag(page, from, { x: to.x + 10 - from.x, y: to.y + to.height / 2 - from.y });
  const ask = page.getByRole('dialog', { name: 'What does this line mean?' });
  await expect(ask).toContainText('Line task A');
  await ask.getByRole('button', { name: 'It waits for it' }).click();
  await expect.poll(async () => (await snapshot(page)).cardDeps.some((d: any) => d.lockedCardId === a && d.lockingCardId === b)).toBe(true);
  await expect(edges).toHaveCount(before + 1);
  await expect(page.locator('[data-edge-id][data-label="waits for"]')).toHaveCount(1);

  // A → the other list: the task moves there, and its line to the old list goes away.
  await node('Line task A').hover();
  from = await centre(page.getByRole('button', { name: 'Connect from bottom' }));
  to = (await node(l2title).boundingBox())!;
  await drag(page, from, { x: to.x + 20 - from.x, y: to.y + to.height / 2 - from.y });
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.id === a).deckId).toBe(l2.id);
  await expect(page.getByRole('status').getByText(`Line task A moved to ${l2title}`)).toBeVisible();
  await expect(edges).toHaveCount(before + 1); // one line added (to the new list), one removed (from the old list)

  // Removing the "waits for" line removes the dependency from the task too.
  await page.locator('[data-edge-id][data-label="waits for"]').focus();
  await page.keyboard.press('Delete');
  await expect(edges).toHaveCount(before);
  await expect.poll(async () => (await snapshot(page)).cardDeps.some((d: any) => d.lockedCardId === a)).toBe(false);
});

test('a line from a list to another area moves the list there', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Area project');
  const project = await run(page, 'projects', 'create', { name });
  await run(page, 'projects', 'update', { id: project.id, spaces: [{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }, { id: 2, name: 'Second area', icon: null, defaultDeckType: 'mixed' }] });
  const t1 = unique('Area list one');
  const l1 = await run(page, 'decks', 'create', { title: t1, projectId: project.id, spaceId: 1 });
  const l2 = await run(page, 'decks', 'create', { title: unique('Area list two'), projectId: project.id, spaceId: 2 });
  await run(page, 'cards', 'create', { deckId: l1.id, content: 'Area task one' });
  await run(page, 'cards', 'create', { deckId: l2.id, content: 'Area task two' });

  await page.goto('/vision');
  await page.getByRole('button', { name: 'Project board' }).click();
  const dlg = page.getByRole('dialog', { name: 'Project board' });
  await dlg.getByRole('combobox').selectOption({ label: name });
  await dlg.getByRole('button', { name: 'Create board' }).click();
  await expect(page).toHaveURL(/\/vision\/\d+$/);
  const node = (text: string) => page.locator('[data-node-type="text"]').filter({ hasText: text });
  await expect(node('Second area')).toHaveCount(1);
  const edges = page.locator('[data-edge-id]');
  const before = await edges.count();

  await node(t1).hover();
  const from = await centre(page.getByRole('button', { name: 'Connect from left' }));
  const to = (await node('Second area').boundingBox())!;
  await drag(page, from, { x: to.x + to.width / 2 - from.x, y: to.y + to.height / 2 - from.y });
  await expect.poll(async () => (await snapshot(page)).decks.find((d: any) => d.id === l1.id).spaceId).toBe(2);
  await expect(page.getByRole('status').getByText(`${t1} moved to Second area`)).toBeVisible();
  await expect(edges).toHaveCount(before); // one line added (to the new area), one removed (from the old area)
});
