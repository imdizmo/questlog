import { test, expect, type Locator, type Page } from '@playwright/test';
import { ensureWorkspace, run, snapshot, unique, SHOTS } from './helpers';

/** Screenshots go here (BALANCE_SHOTS to keep them with a report). */
const shots = process.env.BALANCE_SHOTS ?? SHOTS;
const entryPage = (page: Page) => page.getByTestId('entry-page');

/** Replaces a formula box's text by typing, closes the suggestions and leaves the box (which saves). */
async function typeFormula(page: Page, box: Locator, text: string) {
  await box.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await box.blur();
}

/** A made-up campaign: a Sword and a Slime with the duel's numbers, types created through the API. */
async function campaign(page: Page) {
  const project = await run<{ id: string }>(page, 'projects', 'create', { name: unique('Balance') });
  const mk = (name: string, fields: object[]) => run<{ id: string }>(page, 'wiki', 'createType', { projectId: project.id, name, fields });
  const weapon = await mk('Weapon', [
    { key: 'damage', label: 'damage', kind: 'number' }, { key: 'item_level', label: 'item level', kind: 'integer' },
    { key: 'kind', label: 'kind', kind: 'enum', options: ['Pierce', 'Slash'] }, { key: 'swing', label: 'swing', kind: 'number', unit: 's' },
    { key: 'crit_chance', label: 'crit chance', kind: 'number' },
  ]);
  const creature = await mk('Creature', [
    { key: 'hp', label: 'hp', kind: 'number', unit: 'hp' }, { key: 'armor', label: 'armor', kind: 'number', unit: 'hp' },
    { key: 'material', label: 'material', kind: 'enum', options: ['Wet', 'Dry'] },
  ]);
  const chart = await mk('Chart', [{ key: 'grid', label: 'grid', kind: 'table' }]);
  const formula = await mk('Formula', [{ key: 'rule', label: 'rule', kind: 'rule' }]);
  const fight = await mk('Fight', [{ key: 'scenario', label: 'scenario', kind: 'scenario' }]);
  const entry = async (typeId: string, name: string, fields?: object) => {
    const e = await run<{ id: string; key: string }>(page, 'wiki', 'createEntry', { projectId: project.id, typeId, name });
    if (fields) await run(page, 'wiki', 'setEntry', { cardId: e.id, fields });
    return e;
  };
  await entry(weapon.id, 'Sword', { damage: 9, item_level: 10, kind: 'Pierce', swing: 1.1, crit_chance: 0.2 });
  await entry(creature.id, 'Slime', { hp: 45, armor: 2, material: 'Wet' });
  const seq = (await snapshot(page)).projects.find((p: any) => p.id === project.id).seq as number;
  return { project, seq, ids: { weapon: weapon.id, creature: creature.id, chart: chart.id, formula: formula.id, fight: fight.id }, entry };
}

const duel = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  state: [{ name: 'hp', start: 'target.hp' }, { name: 'hits', start: '0' }, { name: 'crit', start: 'false' }, { name: 'dmg', start: '0' }],
  clocks: [{
    name: 'swing', every: 'attacker.swing',
    do: [
      { name: 'crit', formula: 'chance(attacker.crit_chance)' },
      { name: 'dmg', formula: '(15 * table(combo, hits + 1) * if(crit, 2, 1) + flat(attacker)) * table(kind_vs_material, attacker.kind, target.material)' },
      { name: 'hp', formula: 'hp - dmg' },
      { name: 'hits', formula: 'hits + 1' },
    ],
  }],
  end: 'hp <= 0', cap: 60,
  measures: [{ name: 'hits', formula: 'hits' }, { name: 'time_to_kill', formula: 'time' }],
};

test('balance: a table, a rule with a live example, the duel in the simulator, the export', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureWorkspace(page);
  const { project, seq, ids, entry } = await campaign(page);

  // 1. A table through the grid editor: kind × material.
  await entry(ids.chart, 'Kind vs material');
  await page.goto(`/wiki/${seq}/kind_vs_material`);
  const box = entryPage(page).getByTestId('infobox');
  await box.getByLabel('grid key 1 values').fill('Pierce, Slash');
  await box.getByRole('button', { name: 'Add column key' }).click();
  await box.getByLabel('grid key 2 values').fill('Wet, Dry');
  for (const [cell, v] of [['Pierce × Wet', '0.6'], ['Pierce × Dry', '1'], ['Slash × Wet', '1.2'], ['Slash × Dry', '0.8']]) await box.getByLabel(`grid ${cell}`).fill(v);
  await box.getByLabel('grid Slash × Dry').press('Enter');
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'kind_vs_material')?.fields?.grid)
    .toEqual({ keys: [{ values: ['Pierce', 'Slash'] }, { values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1, 1.2, 0.8] });
  // A half-typed key list never drops filled-in numbers on its own: not by leaving the box, not by changing the mode.
  const stored = async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'kind_vs_material')?.fields?.grid;
  const before = await stored();
  await box.getByLabel('grid key 1 values').fill('Pierce');
  await box.getByLabel('grid mode').selectOption('step');
  await expect(box.getByText(/leave out numbers that are filled in/)).toBeVisible();
  await box.getByLabel('grid Pierce × Wet').fill('0.6');
  await box.getByLabel('grid Pierce × Wet').blur();
  await page.waitForTimeout(300);
  expect(await stored()).toEqual(before);
  await box.getByLabel('grid mode').selectOption('exact');
  await box.getByLabel('grid key 1 values').fill('Pierce, Slash');
  await box.getByLabel('grid key 1 values').press('Enter');
  await expect(box.getByText(/leave out numbers/)).toHaveCount(0);
  expect(await stored()).toEqual(before);
  // "Save without them" drops them on purpose.
  await box.getByLabel('grid key 1 values').fill('Pierce');
  await box.getByRole('button', { name: 'Save without them' }).click();
  await expect.poll(stored).toEqual({ keys: [{ values: ['Pierce'] }, { values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1] });
  await box.getByLabel('grid key 1 values').fill('Pierce, Slash');
  await box.getByLabel('grid Slash × Wet').fill('1.2');
  await box.getByLabel('grid Slash × Dry').fill('0.8');
  await box.getByLabel('grid Slash × Dry').press('Enter');
  await expect.poll(stored).toEqual(before);
  await entry(ids.chart, 'Combo', { grid: { keys: [{ values: [1, 2, 3, 4, 5] }], mode: 'step', cells: [1.05, 1.1, 1.15, 1.2, 1.25] } });
  await entry(ids.formula, 'Flat', { rule: { roles: [{ name: 'weapon', type: 'weapon' }], parts: [], result: 'weapon.damage * (1 + 0.1 * (weapon.item_level - 1))', examples: [] } });

  // 2. A rule written in the editor: roles, two parts, a result.
  await entry(ids.formula, 'Hit');
  await page.goto(`/wiki/${seq}/hit`);
  const rule = entryPage(page).getByRole('region', { name: 'rule' });
  await rule.getByRole('button', { name: 'Add role' }).click();
  await rule.getByLabel('Role 1 name').fill('attacker');
  await rule.getByLabel('Role 1 type').selectOption({ label: 'Weapon' });
  await rule.getByRole('button', { name: 'Add role' }).click();
  await rule.getByLabel('Role 2 name').fill('target');
  await rule.getByLabel('Role 2 type').selectOption({ label: 'Creature' });
  await rule.getByRole('button', { name: 'Add part' }).click();
  await rule.getByLabel('Part 1 name').fill('crit');
  await typeFormula(page, rule.getByRole('combobox', { name: 'Part crit formula' }), 'chance(attacker.crit_chance)');
  await rule.getByRole('button', { name: 'Add part' }).click();
  await rule.getByLabel('Part 2 name').fill('base');
  await typeFormula(page, rule.getByRole('combobox', { name: 'Part base formula' }), '15 * if(crit, 2, 1) + flat(attacker)');

  // Completion offers the target's fields with their unit.
  const result = rule.getByRole('combobox', { name: 'Result formula' });
  await result.click();
  await page.keyboard.type('base - target.ar');
  const menu = page.getByRole('listbox', { name: 'Suggestions for Result formula' });
  await expect(menu.getByRole('option', { name: /^armor \(hp\)/ })).toBeVisible();
  // While the list is open the half-typed name is underlined, but its problem is not spelled out (nor covered).
  await expect(rule.getByText(/has no field 'ar'/)).toHaveCount(0);
  const area = (await rule.getByRole('group', { name: 'Result' }).boundingBox())!;
  await page.screenshot({ path: `${shots}/formula-completion.png`, clip: { x: area.x, y: area.y, width: area.width, height: area.height + 90 } });
  // A typo is a plain error under the box, with the closest name.
  await page.keyboard.type('mr');
  await page.keyboard.press('Escape');
  await expect(rule.getByText("'Creature' has no field 'armr' — did you mean 'armor'?")).toBeVisible();
  await expect(result).toHaveAttribute('aria-invalid', 'true');

  // The live example: Sword and Slime (picked by default), seed 1; the values follow the text as it is typed.
  await typeFormula(page, result, 'base * table(kind_vs_material, attacker.kind, target.material)');
  await expect(rule.getByText(/has no field/)).toHaveCount(0);
  const example = rule.getByRole('group', { name: 'Live example' });
  await expect(example.getByLabel('Example attacker')).toHaveValue('sword');
  await expect(example.getByLabel('Example target')).toHaveValue('slime');
  await example.getByLabel('Example seed').fill('1');
  const crit = await rule.getByLabel('Value of crit').textContent();
  const flat = 9 * (1 + 0.1 * 9);
  const base = 15 * (crit === 'yes' ? 2 : 1) + flat;
  await expect(rule.getByLabel('Value of base')).toHaveText(String(Math.round(base * 1e4) / 1e4));
  await expect(rule.getByLabel('Value of result')).toHaveText(String(Math.round(base * 0.6 * 1e4) / 1e4));
  await result.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' + 1');
  await expect(rule.getByLabel('Value of result')).toHaveText(String(Math.round((base * 0.6 + 1) * 1e4) / 1e4));
  // Enter with no suggestions open saves, as leaving the box does.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(result).toBeFocused();
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'hit')?.fields?.rule?.result)
    .toBe('base * table(kind_vs_material, attacker.kind, target.material) + 1');
  await rule.getByRole('button', { name: 'Save as example' }).click();
  await expect(rule.getByRole('button', { name: 'Saved as example' })).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'hit')?.fields?.rule)
    .toEqual({
      roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
      parts: [{ name: 'crit', formula: 'chance(attacker.crit_chance)' }, { name: 'base', formula: '15 * if(crit, 2, 1) + flat(attacker)' }],
      result: 'base * table(kind_vs_material, attacker.kind, target.material) + 1',
      examples: [{ roles: { attacker: 'sword', target: 'slime' }, seed: 1 }],
    });
  await expect(rule.getByRole('group', { name: 'Saved examples' })).toContainText('seed 1');
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await rule.screenshot({ path: `${shots}/rule-editor.png` });
  await page.setViewportSize({ width: 1280, height: 720 });

  // 3. The duel: 10,000 runs split 2 hits / 3 hits about 36 % / 64 %.
  await entry(ids.fight, 'Duel', { scenario: duel });
  await page.goto(`/wiki/${seq}/duel`);
  const scen = entryPage(page).getByRole('region', { name: 'scenario' });
  await scen.getByRole('tab', { name: 'Simulator' }).click();
  const sim = scen.getByTestId('simulator');
  await expect(sim.getByLabel('Simulator attacker')).toHaveValue('sword');
  await sim.getByLabel('Runs').fill('10000');
  await sim.getByLabel('Seed', { exact: true }).fill('42');
  await sim.getByRole('button', { name: 'Run' }).click();
  const results = sim.getByTestId('sim-results');
  await expect(results).toContainText('10,000 runs', { timeout: 30_000 });
  const hits = results.getByRole('table', { name: 'hits by value' });
  const share = async (v: string) => Number((await hits.getByRole('row').filter({ has: page.getByRole('cell', { name: v, exact: true }) }).getByRole('cell').nth(2).textContent())!.replace(/[ %]/g, ''));
  expect(Math.abs((await share('2')) - 36)).toBeLessThanOrEqual(2);
  expect(Math.abs((await share('3')) - 64)).toBeLessThanOrEqual(2);
  await expect(results.getByRole('img', { name: /Histogram of hits/ })).toBeVisible();
  await expect(results).toContainText('No outliers');

  // 4. The swing timing varies by ±10 % (edited in the scenario editor): the time to kill spreads, outliers show, and
  //    replaying one shows its ticks.
  await scen.getByRole('tab', { name: 'Scenario' }).click();
  await typeFormula(page, scen.getByRole('combobox', { name: 'swing every' }), 'attacker.swing * (0.9 + 0.2 * rand())');
  await expect.poll(async () => (await snapshot(page)).cards.find((c: any) => c.entryKey === 'duel')?.fields?.scenario?.clocks?.[0]?.every)
    .toBe('attacker.swing * (0.9 + 0.2 * rand())');
  await scen.getByRole('tab', { name: 'Simulator' }).click();
  await sim.getByLabel('Runs').fill('2000');
  await sim.getByRole('button', { name: 'Run' }).click();
  await expect(results).toContainText('2,000 runs', { timeout: 30_000 });
  const outliers = results.getByRole('table', { name: 'Outliers' });
  await expect(outliers).toBeVisible();
  const first = outliers.getByRole('row').nth(1);
  const seed = (await first.getByRole('cell').nth(3).textContent())!;
  await first.getByRole('button', { name: /^Replay run/ }).click();
  const replay = sim.getByTestId('sim-replay');
  await expect(replay.getByRole('heading', { name: `Run with seed ${seed}` })).toBeVisible();
  const ticks = replay.getByRole('table', { name: `Ticks of the run with seed ${seed}` });
  await expect(ticks.getByRole('columnheader', { name: 'hp' })).toBeVisible();
  expect(await ticks.getByRole('row').count()).toBeGreaterThanOrEqual(3);
  await expect(ticks.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText('swing');
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await scen.screenshot({ path: `${shots}/simulator.png` });

  // 5. The export carries the rule with its golden sample.
  const exp = await (await page.request.get(`/api/wiki/${project.id}/export`)).json();
  const hit = exp.rules.find((r: any) => r.name === 'hit');
  expect(hit.samples).toEqual([{ roles: { attacker: 'sword', target: 'slime' }, seed: 1, parts: { crit: crit === 'yes', base }, result: base * 0.6 + 1 }]);
  expect(exp.scenarios.map((s: any) => s.name)).toEqual(['duel']);
});

test('balance: 100,000 runs keep the page responsive and its memory flat', async ({ page }) => {
  test.setTimeout(120_000);
  await ensureWorkspace(page);
  const { seq, ids, entry } = await campaign(page);
  await entry(ids.chart, 'Kind vs material', { grid: { keys: [{ values: ['Pierce', 'Slash'] }, { values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1, 1.2, 0.8] } });
  await entry(ids.chart, 'Combo', { grid: { keys: [{ values: [1, 2, 3, 4, 5] }], mode: 'step', cells: [1.05, 1.1, 1.15, 1.2, 1.25] } });
  await entry(ids.formula, 'Flat', { rule: { roles: [{ name: 'weapon', type: 'weapon' }], parts: [], result: 'weapon.damage * (1 + 0.1 * (weapon.item_level - 1))', examples: [] } });
  await entry(ids.fight, 'Duel', { scenario: duel });
  await page.goto(`/wiki/${seq}/duel`);
  const scen = entryPage(page).getByRole('region', { name: 'scenario' });
  await scen.getByRole('tab', { name: 'Simulator' }).click();
  const sim = scen.getByTestId('simulator');
  await sim.getByLabel('Runs').fill('100000');

  // The page's heap through CDP, and the worker's through a browser session attached to it.
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize as number;
  const browserCdp = await page.context().browser()!.newBrowserCDPSession();
  let workerSession: string | null = null;
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;
  browserCdp.on('Target.receivedMessageFromTarget', (e: any) => {
    const m = JSON.parse(e.message);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  });
  const workerHeap = async (): Promise<number | null> => {
    if (!workerSession) {
      const { targetInfos } = await browserCdp.send('Target.getTargets') as any;
      const w = targetInfos.find((t: any) => t.type === 'worker' && /sim\.worker/.test(t.url));
      if (!w) return null;
      workerSession = (await browserCdp.send('Target.attachToTarget', { targetId: w.targetId, flatten: false }) as any).sessionId;
    }
    const id = nextId++;
    const got = new Promise<any>((resolve) => { pending.set(id, resolve); setTimeout(() => resolve(null), 1000); });
    await browserCdp.send('Target.sendMessageToTarget', { sessionId: workerSession!, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }) }).catch(() => {});
    const r = await got;
    return r ? r.usedSize : null;
  };

  await cdp.send('HeapProfiler.collectGarbage');
  const before = await heap();
  let pagePeak = before, workerPeak = 0, workerFirst: number | null = null, slowest = 0;
  await sim.getByRole('button', { name: 'Run' }).click();
  const results = sim.getByTestId('sim-results');
  const t0 = Date.now();
  while (!(await results.isVisible()) && Date.now() - t0 < 30_000) {
    // The page answers while the batch runs: an evaluate round trip stays short.
    const s = Date.now();
    await page.evaluate(() => 1);
    slowest = Math.max(slowest, Date.now() - s);
    pagePeak = Math.max(pagePeak, await heap());
    const w = await workerHeap();
    if (w !== null) { workerFirst ??= w; workerPeak = Math.max(workerPeak, w); }
    await page.waitForTimeout(100);
  }
  await expect(results).toContainText(/100,000 runs|Stopped at the 10 s limit/);
  pagePeak = Math.max(pagePeak, await heap());
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const summary = (await results.locator('.sim-summary').textContent()) ?? '';
  console.log(`[balance memory] page heap before ${mb(before)}, peak ${mb(pagePeak)}; worker heap first ${workerFirst === null ? 'n/a' : mb(workerFirst)}, peak ${mb(workerPeak)}; slowest page round trip ${slowest} ms; ${summary}`);
  expect(slowest).toBeLessThan(500);
  expect(pagePeak - before).toBeLessThan(50 * 1048576);
  await browserCdp.detach();
});
