import { describe, expect, it } from 'vitest';
import { filterAssets, groupAssets, sniff, versionAtLeast, type Asset } from '../shared/assets';

// The Assets library's shared rules (shared/assets.ts): what bytes are accepted, the library's version gate, and how
// the page filters and groups.
const bytes = (...b: (number | string)[]) => new Uint8Array(b.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const WEBP = bytes('RIFF', 4, 0, 0, 0, 'WEBPVP8 ');
const GLB = bytes('glTF', 2, 0, 0, 0, 12, 0, 0, 0);

describe('sniff', () => {
  it('knows the four accepted kinds by their first bytes', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(JPG)).toBe('image/jpeg');
    expect(sniff(WEBP)).toBe('image/webp');
    expect(sniff(GLB)).toBe('model/gltf-binary');
  });

  it('refuses everything else', () => {
    expect(sniff(bytes('GIF89a', 1, 0))).toBeNull();
    expect(sniff(bytes('<!doctype html>'))).toBeNull();
    expect(sniff(bytes('glTF', 1, 0, 0, 0, 12, 0, 0, 0))).toBeNull(); // glTF 1 binary: not ours
    expect(sniff(bytes(0x89, 'PN'))).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
    expect(sniff(bytes('RIFF', 4, 0, 0, 0, 'WAVEfmt '))).toBeNull();
  });
});

describe('versionAtLeast', () => {
  it('compares dotted numbers', () => {
    expect(versionAtLeast('0.7.0', '0.7.0')).toBe(true);
    expect(versionAtLeast('0.10.1', '0.7.0')).toBe(true);
    expect(versionAtLeast('1.0', '0.7.0')).toBe(true);
    expect(versionAtLeast('0.7.0-beta', '0.7.0')).toBe(true);
    expect(versionAtLeast('0.6.9', '0.7.0')).toBe(false);
    expect(versionAtLeast(null, '0.7.0')).toBe(false);
    expect(versionAtLeast('x', '0.7.0')).toBe(false);
    expect(versionAtLeast(7, '0.7.0')).toBe(false);
  });
});

describe('filter and groups', () => {
  const a = (id: string, title: string, kind: Asset['kind'], f: Asset['for'], source: Asset['source']): Asset => ({
    id, projectId: 'p', title, kind, for: f, source, link: null, hasPicture: true, pictureMime: 'image/png', hasModel: false,
    size: 1, createdBy: null, createdAt: 1, updatedAt: 1, usedIn: [],
  });
  const list = [
    a('1', 'Drowned Man', 'model', 'Creatures', 'asset-shelf'),
    a('2', 'The beach, key art', 'picture', 'Key art', 'uploaded'),
    a('3', 'Zone 0', 'map', 'Places', 'groundwork'),
    a('4', 'Foam', 'concept', null, 'url'),
  ];

  it('filters by words, kind and what it is for', () => {
    expect(filterAssets(list, { q: '', kind: 'all', fors: new Set() }).map((x) => x.id)).toEqual(['1', '2', '3', '4']);
    expect(filterAssets(list, { q: 'BEACH', kind: 'all', fors: new Set() }).map((x) => x.id)).toEqual(['2']);
    expect(filterAssets(list, { q: '', kind: 'model', fors: new Set() }).map((x) => x.id)).toEqual(['1']);
    expect(filterAssets(list, { q: '', kind: 'all', fors: new Set(['Places', 'Key art']) }).map((x) => x.id)).toEqual(['2', '3']);
  });

  it('groups by source, empty groups left out', () => {
    expect(groupAssets(list).map((g) => [g.title, g.items.map((x) => x.id)])).toEqual([
      ['From Asset Shelf', ['1']], ['Maps from Groundwork', ['3']], ['Uploaded', ['2', '4']],
    ]);
    expect(groupAssets([list[1]]).map((g) => g.title)).toEqual(['Uploaded']);
  });
});
