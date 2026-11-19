/**
 * The person's Home choices, kept with their other preferences on the server (web/src/prefs.ts, key `home`): the
 * picture, the layout, which kinds show as cards, what to show, whether "Recently worked on" is open, and how wide the
 * page beside Home is (web/src/homeSplit.ts; clamped to the window where it is used). Where things sit on the Web view
 * is the shared Home board's, not a preference; an old `moved` field is ignored. A value that is partly malformed (an
 * older version, a hand edit) keeps its good fields.
 */
import { prefs, usePref } from './prefs';
import { PIC_KEYS, type PicKey } from './homePictures';
import { CARD_KINDS, type CardKind } from './homeLayout';
import { PANE_DEFAULT } from './homeSplit';

export interface HomePrefs {
  pic: PicKey;
  layout: 'web' | 'tree';
  cards: CardKind[];
  show: { area: boolean; list: boolean; quest: boolean };
  recent: boolean;
  /** The split pane's width, in pixels. */
  pane: number;
}
export const HOME_DEFAULT: HomePrefs = { pic: PIC_KEYS[0], layout: 'web', cards: [], show: { area: true, list: true, quest: false }, recent: true, pane: PANE_DEFAULT };

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function readHomePrefs(v: unknown): HomePrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return HOME_DEFAULT;
  const x = v as Record<string, unknown>;
  const show = (x.show && typeof x.show === 'object' ? x.show : {}) as Record<string, unknown>;
  return {
    pic: PIC_KEYS.includes(x.pic as PicKey) ? (x.pic as PicKey) : HOME_DEFAULT.pic,
    layout: x.layout === 'tree' || x.layout === 'web' ? x.layout : HOME_DEFAULT.layout,
    cards: Array.isArray(x.cards) ? CARD_KINDS.filter((k) => (x.cards as unknown[]).includes(k)).sort((a, b) => (x.cards as unknown[]).indexOf(a) - (x.cards as unknown[]).indexOf(b)) : [],
    show: { area: bool(show.area, true), list: bool(show.list, true), quest: bool(show.quest, false) },
    recent: bool(x.recent, true),
    pane: typeof x.pane === 'number' && Number.isFinite(x.pane) && x.pane > 0 && x.pane < 10_000 ? Math.round(x.pane) : PANE_DEFAULT,
  };
}

const anything = (v: unknown): v is unknown => true;

/** The person's Home choices and a setter that changes some of them (each a deliberate click: sent at once). */
export function useHomePrefs(): [HomePrefs, (p: Partial<HomePrefs>) => void] {
  const current = readHomePrefs(usePref('home', anything, undefined));
  return [current, (p) => prefs.set('home', { ...readHomePrefs(prefs.get('home', anything, undefined)), ...p }, true)];
}
