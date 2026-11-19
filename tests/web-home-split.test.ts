import { describe, expect, it } from 'vitest';
import { besideRoute, clampPane, HOME_MIN, PANE_DEFAULT, PANE_MIN, paneKey, paneUrl, sideOf, withBoard, withSide } from '../web/src/homeSplit';

const q = (s: string) => new URLSearchParams(s);

describe("Home's split view: the address", () => {
  it('puts the page beside Home in `side`, keeping Home\'s board and the page\'s own query', () => {
    expect(withSide('', '/decks/4-creatures')).toBe('/home?side=/decks/4-creatures');
    expect(withSide('?board=3', '/decks/4-creatures')).toBe('/home?board=3&side=/decks/4-creatures');
    expect(withSide('?board=3&side=/decks/4&panel=sort', '/wiki/1/goblin?panels=a.b')).toBe('/home?board=3&side=/wiki/1/goblin&panels=a.b');
    // the page added Home's query to its own path (a canonical slug): Home's keys in it are not the page's
    expect(withSide('?board=3&side=/decks/4&panel=sort', '/decks/4-creatures?board=3&side=%2Fdecks%2F4&panel=sort'))
      .toBe('/home?board=3&side=/decks/4-creatures&panel=sort');
  });

  it('closes the pane: Home and its board alone', () => {
    expect(withSide('?board=3&side=/decks/4&panel=sort', null)).toBe('/home?board=3');
    expect(withSide('?side=/decks/4', null)).toBe('/home');
  });

  it('reads the page back, and refuses what can\'t sit beside Home', () => {
    expect(sideOf(q('side=/decks/4-creatures'))).toEqual({ path: '/decks/4-creatures', route: { name: 'deck', deckSeq: 4, slug: 'creatures' } });
    expect(sideOf(q('side=%2Fdecks%2F4-creatures'))?.path).toBe('/decks/4-creatures');
    expect(sideOf(q(''))).toBeNull();
    for (const bad of ['/home', '/new', '/vision/2', '/login', '/open/x', '//evil.example/x', 'decks/4', '/api/prefs', 'https://x.y/decks/4'])
      expect(sideOf(q(`side=${encodeURIComponent(bad)}`)), bad).toBeNull();
    expect(besideRoute('/decks/4/card/1a-x')).toMatchObject({ name: 'deckCard', code: '1a' });
  });

  it('gives the pane\'s page an address of its own (Open in its own tab)', () => {
    expect(paneUrl('?board=3&side=/decks/4-creatures&panel=sort')).toBe('/decks/4-creatures?panel=sort');
    expect(paneUrl('?side=/wiki/1/goblin')).toBe('/wiki/1/goblin');
    expect(paneUrl('?board=3')).toBeNull();
    // round trip
    expect(paneUrl(withSide('?board=2', '/decks/7-x?search=a').slice('/home'.length))).toBe('/decks/7-x?search=a');
  });
});

describe("Home's split view: the width", () => {
  it('keeps both sides big enough', () => {
    expect(clampPane(560, 1400)).toBe(560);
    expect(clampPane(100, 1400)).toBe(PANE_MIN);
    expect(clampPane(1300, 1400)).toBe(1400 - HOME_MIN);
    expect(clampPane(600.6, 1400)).toBe(601);
    expect(clampPane(Number.NaN, 1400)).toBe(PANE_DEFAULT);
    // no room for both (or not measured yet): the pane's least
    expect(clampPane(560, 500)).toBe(PANE_MIN);
    expect(clampPane(560, 0)).toBe(PANE_MIN);
  });

  it('moves with the keys: Left widens the pane, Right narrows it, Shift further, Home and End the ends', () => {
    expect(paneKey('ArrowLeft', 560, 1400, false)).toBe(584);
    expect(paneKey('ArrowRight', 560, 1400, false)).toBe(536);
    expect(paneKey('ArrowLeft', 560, 1400, true)).toBe(680);
    expect(paneKey('ArrowRight', PANE_MIN, 1400, false)).toBe(PANE_MIN);
    expect(paneKey('Home', 700, 1400, false)).toBe(PANE_MIN);
    expect(paneKey('End', 700, 1400, false)).toBe(1400 - HOME_MIN);
    expect(paneKey('Enter', 700, 1400, false)).toBeNull();
  });
});

describe("Home's split view: what can't sit beside Home", () => {
  it('refuses a path that resolves elsewhere (dot segments), and keeps the resolved one', () => {
    for (const bad of ['/.//example.com/x', '/%2e//example.com/x', '/decks/../..//example.com', '/a/./b/../../home'])
      expect(sideOf(q(`side=${encodeURIComponent(bad)}`)), bad).toBeNull();
    expect(sideOf(q('side=/decks/4-x'))?.path).toBe('/decks/4-x');
    expect(sideOf(q(`side=${encodeURIComponent('/wiki/1/göblin')}`))?.path).toBe('/wiki/1/g%C3%B6blin');
    expect(sideOf(q('side=/wiki/1/%E0%A4%A'))).toBeNull(); // malformed escape
    expect(paneUrl('?side=/.//example.com/x')).toBeNull();
  });

  it('switches boards with the page beside Home kept', () => {
    expect(withBoard('?side=/decks/4&panel=sort', 7)).toBe('/home?side=/decks/4&panel=sort&board=7');
    expect(withBoard('?board=7&side=/decks/4', null)).toBe('/home?side=/decks/4');
    expect(withBoard('', 3)).toBe('/home?board=3');
  });
});
