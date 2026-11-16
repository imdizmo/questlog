import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isFileUrl, isVideoId, type BoardNode } from '../shared/board';
import { NodeView } from '../web/src/board/nodes';
import { readEdge, readNode, trimUndo } from '../web/src/board/useBoard';
import { ErrorBoundary } from '../web/src/components/ErrorBoundary';

const ymap = (o: Record<string, unknown>) => { const m = new Y.Map<unknown>(); for (const [k, v] of Object.entries(o)) m.set(k, v); return m; };
/** A map only reads once it belongs to a doc. */
const inDoc = (o: Record<string, unknown>) => { const d = new Y.Doc(); const m = d.getMap<Y.Map<unknown>>('x'); m.set('a', ymap(o)); return m.get('a')!; };
const pos = { x: 20, y: 40, w: 160, h: 40, parent: null };
const end = { nodeId: 'abc', side: 'left' };

describe('reading the board doc', () => {
  it('reads a well-formed node and edge', () => {
    expect(readNode('n', inDoc({ type: 'text', value: { content: 'hi' }, pos }))).toMatchObject({ id: 'n', type: 'text', value: { content: 'hi' }, pos });
    expect(readEdge('e', inDoc({ value: { source: end, target: { ...end, side: 'top' } } }))).toMatchObject({ id: 'e' });
  });

  it('skips malformed nodes instead of throwing', () => {
    const bad: Array<Record<string, unknown>> = [
      { type: 'bogus', value: {}, pos },
      { type: 'text', value: {}, pos: { ...pos, x: 'a' } },
      { type: 'text', value: {}, pos: { ...pos, y: Infinity } },
      { type: 'text', value: {}, pos: { ...pos, w: NaN } },
      { type: 'text', value: {}, pos: { ...pos, x: 1e25 } },
      { type: 'text', value: {}, pos: { ...pos, w: -40 } },
      { type: 'text', value: {}, pos: { ...pos, h: 0 } },
      { type: 'text', value: {}, pos: { ...pos, parent: 5 } },
      { type: 'text', value: 'nope', pos },
      { type: 'text', value: null, pos },
      { type: 'text', value: {}, pos: null },
      { type: 'text', value: {}, pos, color: 'chartreuse' },
      { value: {}, pos },
    ];
    for (const b of bad) expect(readNode('n', inDoc(b)), JSON.stringify(b)).toBeNull();
  });

  it('skips malformed edges instead of throwing', () => {
    const bad: Array<Record<string, unknown>> = [
      { value: null },
      { value: 'x' },
      { value: { source: end } },
      { value: { source: end, target: { nodeId: 'b', side: 'middle' } } },
      { value: { source: { nodeId: 5, side: 'left' }, target: end } },
      { value: { source: end, target: end }, label: 5 },
      {},
    ];
    for (const b of bad) expect(readEdge('e', inDoc(b)), JSON.stringify(b)).toBeNull();
  });
});

const BAD_URLS = [
  'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://evil.example/x.png', '//evil.example/x',
  '/api/files/%2e%2e/api/snapshot', '/api/files/.%2e/covers/x', '/api/files/%2E%2E/%2E%2E/snapshot', '/api/files/../snapshot',
  '/api/files/', '/api/files/a/b', '/api/files/a?x=1', '/api/files/a#b', '/other/abc', ' /api/files/abc', '/api/files/abc\n', '',
];
const BAD_IDS = ['', 'short', 'aqz-KE-bpKQx', 'aqz KE bpKQ', 'aqz-KE-bpK"', 'aqz-KE-bp<>', 'https://youtu.be/aqz-KE-bpKQ', 'aqz-KE-bpK\n'];

describe('error boundary', () => {
  it('turns a render error into state, and a new reset key clears it', () => {
    const err = new TypeError('p is not a function');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
    expect(ErrorBoundary.getDerivedStateFromProps({ what: 'x', resetKey: 'b', children: null }, { error: err, key: 'a' })).toEqual({ key: 'b', error: null });
    expect(ErrorBoundary.getDerivedStateFromProps({ what: 'x', resetKey: 'a', children: null }, { error: err, key: 'a' })).toBeNull();
    expect(renderToStaticMarkup(createElement(ErrorBoundary, { what: 'This board', children: createElement('p', null, 'ok') }))).toBe('<p>ok</p>');
  });
});

describe('undo trimming', () => {
  it('releases what dropped steps deleted, so a long session keeps the doc flat', () => {
    const run = (limit: number | null) => {
      const doc = new Y.Doc();
      const nodes = doc.getMap<Y.Map<unknown>>('nodes');
      doc.transact(() => nodes.set('a', ymap({ type: 'text', value: { content: 'x' }, pos })));
      const um = new Y.UndoManager([nodes], { trackedOrigins: new Set(['L']), captureTimeout: 0 });
      if (limit !== null) um.on('stack-item-added', () => trimUndo(um, limit));
      for (let i = 0; i < 300; i++) doc.transact(() => nodes.get('a')!.set('pos', { ...pos, x: i * 20 }), 'L');
      return { bytes: Y.encodeStateAsUpdate(doc).byteLength, steps: um.undoStack.length, um, doc };
    };
    const untrimmed = run(null);
    const trimmed = run(10);
    expect(trimmed.steps).toBe(10);
    // 300 kept pos objects vs. about the last 10
    expect(trimmed.bytes).toBeLessThan(untrimmed.bytes / 5);
    // the kept steps still undo
    trimmed.um.undo();
    expect((trimmed.doc.getMap<Y.Map<unknown>>('nodes').get('a')!.get('pos') as { x: number }).x).toBe(298 * 20);
  });
});

describe('media values', () => {
  it('accepts only /api/files/<id> and 11-character video ids', () => {
    expect(isFileUrl('/api/files/0b9c2e1a-1d2f-4a8b-9c3d-5e6f7a8b9c0d')).toBe(true);
    expect(isVideoId('aqz-KE-bpKQ')).toBe(true);
    for (const u of BAD_URLS) expect(isFileUrl(u), u).toBe(false);
    for (const u of [null, 5, {}, undefined]) expect(isFileUrl(u)).toBe(false);
    for (const v of BAD_IDS) expect(isVideoId(v), v).toBe(false);
  });

  it('skips image and video nodes with bad values when reading', () => {
    for (const url of BAD_URLS) expect(readNode('n', inDoc({ type: 'image', value: { url, width: 1, height: 1 }, pos })), url).toBeNull();
    for (const videoId of BAD_IDS) expect(readNode('n', inDoc({ type: 'video', value: { videoId }, pos })), videoId).toBeNull();
    expect(readNode('n', inDoc({ type: 'image', value: { url: '/api/files/abc-1_x', width: 1, height: 1 }, pos }))).not.toBeNull();
    expect(readNode('n', inDoc({ type: 'video', value: { videoId: 'aqz-KE-bpKQ' }, pos }))).not.toBeNull();
  });

  const html = (type: 'image' | 'video', value: Record<string, unknown>) => {
    const node: BoardNode = { id: 'n', type, value, pos: { ...pos, parent: null } };
    return renderToStaticMarkup(createElement(NodeView, { node, selected: false, editing: false, onCommit: () => {}, onEndEdit: () => {} }));
  };

  it('renders a placeholder for bad values even if they reach the renderer', () => {
    for (const url of BAD_URLS) {
      const out = html('image', { url });
      expect(out, url).not.toContain('<img');
      expect(out).toContain('Image not available');
    }
    for (const videoId of BAD_IDS) {
      const out = html('video', { videoId });
      expect(out, videoId).not.toContain('href');
      expect(out).toContain('Video not available');
    }
    expect(html('image', { url: '/api/files/abc-1_x' })).toContain('src="/api/files/abc-1_x"');
    expect(html('video', { videoId: 'aqz-KE-bpKQ' })).toContain('href="https://www.youtube.com/watch?v=aqz-KE-bpKQ"');
  });

  it('validates a Smart Node value field by field', () => {
    const ok = { queryId: null, mode: 'horBar' };
    const good: Record<string, unknown>[] = [
      ok, { queryId: 'abc', mode: 'table', label: 'x'.repeat(200), columns: ['owner', 'tags'], order: 'priority', hideArchived: true },
      { queryId: 'abc', mode: 'verBar', segments: false, order: null },
    ];
    for (const value of good) expect(readNode('n', inDoc({ type: 'filter', value, pos })), JSON.stringify(value)).not.toBeNull();
    const bad: Record<string, unknown>[] = [
      {}, { mode: 'horBar' }, { queryId: 1, mode: 'horBar' }, { queryId: undefined, mode: 'horBar' }, { queryId: null, mode: 'pie' },
      { ...ok, label: 'x'.repeat(201) }, { ...ok, label: 5 }, { ...ok, columns: 'owner' }, { ...ok, columns: ['owner', 'secret'] },
      { ...ok, columns: ['owner', 'owner'] }, { ...ok, order: 'manual' }, { ...ok, order: 3 }, { ...ok, hideArchived: 'yes' }, { ...ok, segments: 1 },
    ];
    for (const value of bad) expect(readNode('n', inDoc({ type: 'filter', value, pos })), JSON.stringify(value)).toBeNull();
  });
});
