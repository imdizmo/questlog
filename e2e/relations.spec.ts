import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/** A 1×1 PNG, built in the test so no binary fixture is committed. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A project with one deck; the given cards are created in it (first line = title). */
async function seed(page: Page, cards: { content: string; effort?: number }[]) {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Keep') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Tasks', projectId: project.id });
  const made: { id: string; path: string }[] = [];
  const snap0 = await snapshot(page);
  const seq = snap0.decks.find((d: any) => d.id === deck.id).seq as number;
  const deckPath = `/decks/${seq}-quests`;
  for (const c of cards) {
    const r = await run<{ id: string; accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, ...c });
    made.push({ id: r.id, path: `${deckPath}/card/${cardCode(r.accountSeq)}` });
  }
  return { projectId: project.id, deckId: deck.id, deckPath, cards: made };
}

const openCard = async (page: Page, path: string, title: string) => {
  await page.goto(path);
  await expect(page.getByTestId('card-page').getByRole('heading', { name: title })).toBeVisible();
};
const tile = (page: Page, title: string) => page.getByTestId('card-tile').filter({ hasText: title });
const cardPage = (page: Page) => page.getByTestId('card-page');

test('sub cards', async ({ page }) => {
  const { cards } = await seed(page, [{ content: 'Level 1', effort: 5 }, { content: 'Treasure room' }]);
  await openCard(page, cards[0].path, 'Level 1');

  // `s` opens the Sub cards tab.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('s');
  const panel = page.getByRole('tabpanel', { name: 'Subtasks' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No subtasks.')).toBeVisible();

  await panel.getByRole('button', { name: 'Add task' }).click();
  const input = panel.getByLabel('New subtask title');
  await input.fill('Boss');
  await input.press('Enter');
  await expect(panel.getByRole('list', { name: 'Subtasks' }).getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('list', { name: 'Subtasks' })).toContainText('Boss');

  // Hero header: sub card count, no Block/Review, Done disabled.
  await expect(cardPage(page).getByRole('button', { name: '1 subtask' })).toBeVisible();
  await expect(cardPage(page).getByRole('button', { name: 'Block' })).toHaveCount(0);
  await expect(cardPage(page).getByRole('button', { name: 'Review' })).toHaveCount(0);
  await expect(cardPage(page).getByRole('button', { name: 'Mark as done' })).toBeDisabled();
  // Own 5 + Boss 1 (fallback).
  await expect(cardPage(page).getByTestId('hero-effort')).toContainText('6');
  await expect(tile(page, 'Level 1').first().getByTestId('effort')).toHaveText('6');
  await expect(tile(page, 'Boss').getByTestId('parent-title')).toContainText('Level 1');

  // Attach an existing card, then detach it again.
  await panel.getByRole('button', { name: 'Add existing' }).click();
  await page.getByPlaceholder('Search tasks', { exact: true }).fill('Treasure');
  await page.getByRole('option', { name: /Treasure room/ }).click();
  await expect(cardPage(page).getByRole('button', { name: '2 subtasks' })).toBeVisible();
  await panel.getByRole('button', { name: 'Remove subtask Treasure room' }).click();
  await expect(cardPage(page).getByRole('button', { name: '1 subtask' })).toBeVisible();

  // The sub card links back to its hero.
  await tile(page, 'Boss').getByRole('link').click();
  await expect(cardPage(page).getByRole('heading', { name: 'Boss' })).toBeVisible();
  await expect(cardPage(page).getByRole('link', { name: /Open main task/ })).toContainText('Level 1');

  // History speaks about it.
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('history-label').filter({ hasText: 'Main task set' })).toBeVisible();
});

test('dependencies', async ({ page }) => {
  await ensureWorkspace(page);
  const settings = (await snapshot(page)).account.settings;
  await run(page, 'accounts', 'update', { settings: { ...settings, dependenciesEnabled: true } });
  const { cards } = await seed(page, [{ content: 'Gate' }, { content: 'Key' }]);
  const [gate, key] = cards;
  await openCard(page, gate.path, 'Gate');

  const badge = cardPage(page).getByTestId('dep-badge');
  await expect(badge).toHaveText('0 · 0');
  await badge.click();
  const pop = page.getByRole('dialog', { name: 'Dependencies' });
  // Focus moves into the popover on open.
  await expect(pop.getByRole('button', { name: 'Add locking task' })).toBeFocused();
  await pop.getByRole('button', { name: 'Add locking task' }).click();
  await page.getByPlaceholder('Search tasks', { exact: true }).fill('Key');
  await page.getByRole('option', { name: /Key/ }).click();
  await expect(pop.getByRole('list', { name: 'Locking dependencies' })).toContainText('Key');
  await expect(badge).toHaveText('1 · 0');
  // "Add locked card" no longer offers Key: Key already locks Gate (that would be a loop).
  await pop.getByRole('button', { name: 'Add locked task' }).click();
  await expect(page.getByRole('listbox', { name: 'Add locked task' }).getByRole('option', { name: /Key/ })).toHaveCount(0);
  await page.getByPlaceholder('Search tasks', { exact: true }).press('Escape');
  await expect(pop.getByRole('button', { name: 'Add locked task' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  // …and focus is back on the badge.
  await expect(badge).toBeFocused();

  await expect(tile(page, 'Gate').getByTestId('locked')).toBeVisible();
  await openCard(page, key.path, 'Key');
  await expect(cardPage(page).getByTestId('dep-badge')).toHaveText('0 · 1');

  // Starting a locked card asks first.
  await openCard(page, gate.path, 'Gate');
  await cardPage(page).getByRole('button', { name: 'Start' }).click();
  const confirm = page.getByRole('dialog', { name: 'Start a locked task?' });
  await expect(confirm).toContainText('1 unfinished task locks this one. Start anyway?');
  await confirm.getByRole('button', { name: 'Start anyway' }).click();
  await expect(cardPage(page).getByTestId('card-status')).toHaveText('Started');

  await run(page, 'cards', 'update', { id: key.id, status: 'done' });
  await expect(tile(page, 'Gate').getByTestId('locked')).toHaveCount(0);
});

test('attachments', async ({ page }) => {
  const { cards } = await seed(page, [{ content: 'Banner art' }]);
  await openCard(page, cards[0].path, 'Banner art');
  await page.getByRole('tab', { name: 'Attachments' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Attachments' });
  await expect(panel.getByRole('button', { name: 'Upload files' })).toBeVisible();
  await panel.getByLabel('Choose files to upload').setInputFiles({ name: 'flag.png', mimeType: 'image/png', buffer: PNG });

  const item = panel.getByRole('listitem').filter({ hasText: 'flag.png' });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('attachment-thumb')).toBeVisible();
  await expect(item.getByRole('link', { name: 'Download flag.png' })).toHaveAttribute('href', /\/api\/files\//);
  await expect(tile(page, 'Banner art').getByTestId('cover')).toBeVisible();
  await expect(cardPage(page).getByTestId('card-cover')).toBeVisible();

  await item.getByRole('button', { name: 'Remove flag.png' }).click();
  await page.getByRole('dialog', { name: 'Remove attachment?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(item).toHaveCount(0);
  await expect(tile(page, 'Banner art').getByTestId('cover')).toHaveCount(0);
  await expect(cardPage(page).getByTestId('card-cover')).toHaveCount(0);
});

test('automations', async ({ page }) => {
  const template = 'Bug report\nSteps to reproduce:\n1. ';
  const { deckPath, deckId } = await seed(page, [{ content: template }]);
  await page.goto(deckPath);
  await page.getByRole('button', { name: 'More list options' }).click();
  await page.getByRole('button', { name: 'Automations' }).click();
  const dlg = page.getByRole('dialog', { name: 'List automations' });
  await dlg.getByLabel('Auto project tag').selectOption('bug');
  await dlg.getByLabel('Default task').selectOption({ label: 'Bug report' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await snapshot(page)).decks.find((d: any) => d.id === deckId).autoTag).toBe('bug');

  await page.getByRole('button', { name: 'Add task' }).click();
  const add = page.getByRole('dialog', { name: 'New task' });
  await expect(add.getByLabel('Task text')).toHaveValue(template);
  await add.getByLabel('Task text').fill('Crash in menu');
  await add.getByLabel('Task text').press('Control+Enter');
  await expect(add).toBeHidden();
  await expect(tile(page, 'Crash in menu').getByTestId('tag')).toContainText('🐞');
  await expect(tile(page, 'Crash in menu').getByTestId('tag')).toContainText('bug');
});

/** A small orange-to-dark gradient PNG (w×h), encoded here so the screenshots show a real cover. */
function gradientPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(236 * (1 - t) + 26 * t); raw[o + 1] = Math.round(130 * (1 - t) + 26 * t); raw[o + 2] = Math.round(25 * (1 - t) + 30 * t);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('relations screenshots', async ({ page }) => {
  await ensureWorkspace(page);
  const settings = (await snapshot(page)).account.settings;
  await run(page, 'accounts', 'update', { settings: { ...settings, dependenciesEnabled: true } });
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { cards, deckPath } = await seed(page, [
    { content: 'Level 1\nThe first dungeon floor.', effort: 5 }, { content: 'Map the caves', effort: 3 }, { content: 'Lighting pass' },
  ]);
  const [level, map, light] = cards;
  await run(page, 'cards', 'update', { id: level.id, priority: 'a' });
  await run(page, 'cards', 'update', { id: map.id, priority: 'b' });
  await run(page, 'cards', 'update', { id: light.id, priority: 'c' });
  const deckId = (await snapshot(page)).cards.find((c: any) => c.id === level.id).deckId as string;
  for (const [t, e] of [['Milestone', 3], ['Treasure room', null]] as const) {
    await run(page, 'cards', 'create', { deckId, content: t, parentCardId: level.id, priority: 'a', ...(e ? { effort: e } : {}) });
  }
  await run(page, 'cards', 'update', { id: level.id, inDeps: [map.id] });
  await run(page, 'cards', 'create', { deckId, content: 'Playtest notes' }); // fills the "No priority" group
  const res = await page.request.post(`/api/cards/${level.id}/files?name=level-1.png`, { data: gradientPng(480, 200), headers: { 'content-type': 'image/png' } });
  expect(res.ok()).toBeTruthy();

  await openCard(page, level.path, 'Level 1');
  await page.getByRole('tab', { name: 'Subtasks' }).click();
  await expect(cardPage(page).getByTestId('dep-badge')).toHaveText('1 · 0');
  await expect(cardPage(page).getByTestId('card-cover')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phase2-subcards.png`, fullPage: true });

  await page.goto(deckPath);
  await expect(tile(page, 'Level 1').getByTestId('cover')).toBeVisible();
  await expect(page.getByTestId('deck-effort')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'No priority' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phase2-deck.png`, fullPage: true });
});

test('chips in card titles', async ({ page }) => {
  await ensureWorkspace(page);
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Chips') });
  const deck = await run<{ id: string }>(page, 'decks', 'create', { title: 'Chips', projectId: project.id });
  const x = await run<{ accountSeq: number }>(page, 'cards', 'create', { deckId: deck.id, content: 'Target task X' });
  const y = await run<{ accountSeq: number }>(page, 'cards', 'create', {
    deckId: deck.id, content: `Fix #bug see $${cardCode(x.accountSeq)} and $zzzz`,
  });
  const snap = await snapshot(page);
  const seq = snap.decks.find((d: any) => d.id === deck.id).seq as number;

  await page.goto(`/decks/${seq}-chips`);
  const t = page.getByTestId('card-tile').filter({ hasText: 'Fix' });
  await expect(t.locator('.md-tag')).toHaveText('#bug');
  await expect(t.locator('.card-ref').first()).toHaveText('Target task X');
  await expect(t.locator('.card-ref.missing')).toHaveText('$zzzz');

  await page.goto(`/decks/${seq}-chips/card/${cardCode(y.accountSeq)}`);
  const h = page.getByTestId('card-page').locator('.card-heading');
  await expect(h.locator('.md-tag')).toHaveText('#bug');
  const link = h.locator('a.card-ref');
  await expect(link).toHaveText('Target task X');
  await expect(link).toHaveAttribute('href', new RegExp(`/card/${cardCode(x.accountSeq)}-target-task-x$`));
});
