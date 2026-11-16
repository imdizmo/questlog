import type { DeckType } from '../../../shared/types';

/** Our own line icons, 20×20 grid, drawn with currentColor. */
const PATHS = {
  close: 'M5 5l10 10M15 5L5 15',
  inbox: 'M3 11l2-6.5h10L17 11v5.5H3zM3 11h4.5l.8 1.8h3.4l.8-1.8H17',
  bell: 'M5 14.5V9a5 5 0 0 1 10 0v5.5l1.5 1.5h-13zM8.5 17.5a1.6 1.6 0 0 0 3 0',
  shield: 'M10 2.5l6 2.3v4.7c0 3.6-2.5 6.3-6 8-3.5-1.7-6-4.4-6-8V4.8z',
  plus: 'M10 4v12M4 10h12',
  more: 'M4.2 10a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0zM9.1 10a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0zM14 10a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0z',
  edit: 'M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13v3z',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10',
  gear: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8',
  hand: 'M6 10V4.5a1 1 0 0 1 2 0V9M8 9V3.5a1 1 0 0 1 2 0V9M10 9V4a1 1 0 0 1 2 0v5M12 9V6a1 1 0 0 1 2 0v6.5c0 3-2 5-5 5-2.2 0-3.5-1-4.5-2.7L3 11.5a1 1 0 0 1 1.7-1L6 12',
  grip: 'M7 5h.5M13 5h.5M7 10h.5M13 10h.5M7 15h.5M13 15h.5',
  up: 'M10 15V5M5 10l5-5 5 5',
  down: 'M10 5v10M5 10l5 5 5-5',
  sort: 'M6 4v12M3 7l3-3 3 3M14 16V4M11 13l3 3 3-3',
  eye: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  eyeOff: 'M3 3l14 14M8.6 5A8 8 0 0 1 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.2 2.9M5.6 6.4A14 14 0 0 0 2 10s3 5.5 8 5.5c1.4 0 2.6-.4 3.6-1',
  lock: 'M5 9h10v8H5zM7 9V6.5a3 3 0 0 1 6 0V9',
  logout: 'M8 4H4v12h4M12 6l4 4-4 4M16 10H8',
  play: 'M6.5 4.5l9 5.5-9 5.5z',
  stop: 'M5.5 5.5h9v9h-9z',
  block: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM5 5l10 10',
  review: 'M3 4h14v9.5H8.5L5 16.5v-3H3z',
  check: 'M4 10.5l4 4 8-9',
  link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1',
  restore: 'M4.5 10a5.5 5.5 0 1 0 1.8-4.1M4 3.5V7h3.5',
  search: 'M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12.2 12.2L16.5 16.5',
  chevron: 'M6 8l4 4 4-4',
  upload: 'M10 13V4M6 8l4-4 4 4M4 13.5V16h12v-2.5',
  file: 'M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15',
  hero: 'M4 4h12v5H4zM7 9v3.5h6M13 12.5v3.5H7v-3.5',
  user: 'M10 3.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 16.5c.8-2.8 3.2-4.5 6-4.5s5.2 1.7 6 4.5',
  // Open Decks
  globe: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM2.5 10h15M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.4 3-7.5z',
  star: 'M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z',
  upvote: 'M10 4.5l5.5 7h-3.2v4h-4.6v-4H4.5z',
  // vision board
  text: 'M4 5V3.5h12V5M10 3.5v13M7.5 16.5h5',
  card: 'M5 2.5h10v15H5zM7.5 6h5M7.5 9h5M7.5 12h3',
  smart: 'M3.5 16.5h13M5.5 16.5V11M10 16.5V6M14.5 16.5V9',
  frame: 'M3 6V3h3M14 3h3v3M17 14v3h-3M6 17H3v-3M8.5 3h3M8.5 17h3M3 8.5v3M17 8.5v3',
  undo: 'M7.5 4.5L4 8l3.5 3.5M4 8h8a4 4 0 0 1 0 8H9',
  redo: 'M12.5 4.5L16 8l-3.5 3.5M16 8H8a4 4 0 0 0 0 8h3',
  minus: 'M4 10h12',
  expand: 'M3.5 8V3.5H8M12 3.5h4.5V8M16.5 12v4.5H12M8 16.5H3.5V12',
  focus: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v3M10 15v3M2 10h3M15 10h3',
  // deck types
  asset: 'M3 15l4.5-6 3.5 4.5 2.5-3L17 15zM13 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 3h14v14H3z',
  task: 'M3.5 3.5h13v13h-13zM6.5 10l2.5 2.5 4.5-5',
  doc: 'M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15M7.5 9.5h5M7.5 12.5h5M7.5 15h3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} className="icon"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

export const DECK_TYPE_LABEL: Record<DeckType, string> = {
  asset: 'Asset list',
  task: 'Task list',
  doc: 'Lore list',
  mixed: 'Mixed list',
};

/** Mixed decks have no icon. */
export function DeckTypeIcon({ type, size = 18 }: { type: DeckType; size?: number }) {
  if (type === 'mixed') return null;
  return (
    <span className={`deck-icon deck-icon-${type}`} data-testid={`deck-icon-${type}`} title={DECK_TYPE_LABEL[type]}>
      <Icon name={type} size={size} />
    </span>
  );
}

/** The brand mark: three stacked cards, the front one orange. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="mark">
      <rect x="9" y="3" width="17" height="21" rx="3" fill="#2a2a30" transform="rotate(12 17 13)" />
      <rect x="7" y="5" width="17" height="21" rx="3" fill="#3a3a42" transform="rotate(4 15 15)" />
      <rect x="5" y="8" width="17" height="21" rx="3" fill="var(--accent)" />
      <path d="M10 15h7M10 19h5" stroke="#0f0f10" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
