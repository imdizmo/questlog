import { test, expect } from '@playwright/test';
import { deflateSync, crc32 } from 'node:zlib';
import { ensureWorkspace, run, unique, SHOTS } from './helpers';

/** A 1×1 PNG, built in the test so no binary fixture is committed. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A one-cube .glb (positions and indices only), built here too. */
function cubeGlb(): Buffer {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
  const pos = Buffer.alloc(p.length * 4); p.forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const ind = Buffer.alloc(idx.length * 2); idx.forEach((v, i) => ind.writeUInt16LE(v, i * 2));
  const bin = Buffer.concat([pos, ind, Buffer.alloc((4 - ((pos.length + ind.length) % 4)) % 4)]);
  const doc = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: ind.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] }, { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' }],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (b: Buffer, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, b]); };
  return Buffer.concat([head, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]);
}

/** A one-colour PNG, `size` px square. */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** A flat square facing the camera side, white, with a red picture embedded as its base colour texture. */
function texturedGlb(): Buffer {
  const pos = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uv = [0, 1, 1, 1, 1, 0, 0, 0];
  const idx = [0, 1, 2, 0, 2, 3];
  const f32 = (a: number[]) => { const b = Buffer.alloc(a.length * 4); a.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
  const u16 = (a: number[]) => { const b = Buffer.alloc(a.length * 2); a.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
  const parts = [f32(pos), f32(nrm), f32(uv), u16(idx), solidPng(8, [230, 20, 20])];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let bin = Buffer.alloc(0);
  for (const p of parts) {
    bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    views.push({ buffer: 0, byteOffset: bin.length, byteLength: p.length });
    bin = Buffer.concat([bin, p]);
  }
  bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const doc = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
    buffers: [{ byteLength: bin.length }], bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (b: Buffer, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, b]); };
  return Buffer.concat([head, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]);
}

test('assets: a textured .glb shows its texture, in the viewer and in its gallery picture', async ({ page }) => {
  const blocked: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text()); });
  await ensureWorkspace(page);
  const project = await run(page, 'projects', 'create', { name: unique('Textured') });
  const seq = (await (await page.request.get('/api/snapshot')).json()).projects.find((p: any) => p.id === project.id).seq;
  await page.goto(`/assets/${seq}`);
  await page.getByTestId('asset-file').setInputFiles([{ name: 'red square.glb', mimeType: 'model/gltf-binary', buffer: texturedGlb() }]);
  const img = page.getByRole('button', { name: 'red square' }).locator('img');
  await expect(img).toBeVisible({ timeout: 20_000 });
  // The gallery picture is rendered from the model: its middle is the texture's red, not the white material.
  const mid = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas'); c.width = el.naturalWidth; c.height = el.naturalHeight;
    const g = c.getContext('2d')!; g.drawImage(el, 0, 0);
    return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data];
  });
  expect(mid[0], `middle pixel ${mid}`).toBeGreaterThan(mid[1] * 2);
  expect(mid[0]).toBeGreaterThan(80);
  await img.click();
  await expect(page.getByRole('dialog', { name: 'red square' }).locator('[data-testid=viewer3d] canvas')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(blocked).toEqual([]);
});

test('assets: add, find, open, retag, use on an entry, view a model, delete', async ({ page }) => {
  await ensureWorkspace(page);
  const name = unique('Assets');
  const project = await run(page, 'projects', 'create', { name });
  await run(page, 'wiki', 'createEntry', { projectId: project.id, typeId: null, name: 'Drowned Man' });
  const seq = (await (await page.request.get('/api/snapshot')).json()).projects.find((p: any) => p.id === project.id).seq;

  await page.goto(`/assets/${seq}`);
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  await expect(page.getByText('No assets yet.')).toBeVisible();

  // From the computer: two pictures and a model.
  await page.getByTestId('asset-file').setInputFiles([
    { name: 'beach.png', mimeType: 'image/png', buffer: PNG },
    { name: 'title screen.png', mimeType: 'image/png', buffer: PNG },
    { name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: cubeGlb() },
  ]);
  const tiles = page.locator('.ap-tile');
  await expect(tiles).toHaveCount(3);
  await expect(page.getByRole('heading', { name: /Uploaded/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'cube' }).getByText('3D', { exact: true })).toBeVisible();

  // Search and kinds.
  await page.getByLabel('Find an asset').fill('beach');
  await expect(tiles).toHaveCount(1);
  await page.getByLabel('Find an asset').fill('');
  await page.getByRole('button', { name: '3D models' }).click();
  await expect(tiles).toHaveCount(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sounds later' })).toBeDisabled();

  // Open a picture, rename and tag it, use it on the entry.
  await page.getByRole('button', { name: 'beach' }).click();
  const view = page.getByRole('dialog', { name: 'beach' });
  await view.getByLabel('Name').fill('The beach, key art');
  await view.getByLabel('Name').press('Enter');
  await view.getByLabel('For').selectOption('Key art');
  await view.getByRole('button', { name: 'Use as a picture of…' }).click();
  await page.getByRole('dialog', { name: 'Use as a picture of…' }).getByRole('button', { name: 'Drowned Man' }).click();
  await expect(view.getByRole('link', { name: 'Drowned Man' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Key art', exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'The beach, key art' })).toBeVisible();
  await page.getByRole('button', { name: 'Key art', exact: true }).click();

  // The model opens in the 3D viewer.
  await page.getByRole('button', { name: 'cube' }).click();
  const model = page.getByRole('dialog', { name: 'cube' });
  await expect(model.locator('[data-testid=viewer3d] canvas')).toBeVisible({ timeout: 20_000 });
  await model.getByRole('button', { name: 'Wireframe' }).click();
  await expect(model.getByRole('button', { name: 'Wireframe' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: `${SHOTS}/assets-viewer.png` });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid=viewer3d]')).toHaveCount(0);

  // Without a team server the library browsers say so; the URL dialog refuses a private address.
  await page.getByRole('button', { name: 'Add an asset' }).click();
  await page.getByRole('menuitem', { name: /From Asset Shelf/ }).click();
  await expect(page.getByText('Asset Shelf needs a team server.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('button', { name: 'Add an asset' }).click();
  await page.getByRole('menuitem', { name: /From a URL/ }).click();
  const url = page.getByRole('dialog', { name: 'Add from a URL' });
  await url.getByLabel('Picture address').fill('http://127.0.0.1/x.png');
  await url.getByRole('button', { name: 'Add' }).click();
  await expect(url.getByRole('alert')).toContainText("Couldn't download");
  await url.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add an asset' }).click();
  await page.getByRole('menuitem', { name: /From the web/ }).click();
  await expect(page.getByText(/Coming: a browser add-on/)).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.screenshot({ path: `${SHOTS}/assets-gallery.png` });

  // Delete removes Questlog's copy; the entry keeps its own.
  await page.getByRole('button', { name: 'title screen' }).click();
  await page.getByRole('dialog', { name: 'title screen' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this asset?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(tiles).toHaveCount(2);
});
