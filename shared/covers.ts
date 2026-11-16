/** Built-in cover artworks (drawn by the client); ids are stable. */
export const COVER_ARTWORKS: { id: number; name: string }[] = [
  { id: 1, name: 'Dawn ridge' },
  { id: 2, name: 'Lantern field' },
  { id: 3, name: 'Tide lines' },
  { id: 4, name: 'Moss stones' },
  { id: 5, name: 'Ember sky' },
  { id: 6, name: 'Paper hills' },
  { id: 7, name: 'Night harbor' },
  { id: 8, name: 'Copper dunes' },
  { id: 9, name: 'Frost glass' },
  { id: 10, name: 'Orchard rows' },
  { id: 11, name: 'Signal flags' },
  { id: 12, name: 'Slate waves' },
  { id: 13, name: 'Meadow grid' },
];

export type Cover = { kind: 'art'; id: number } | { kind: 'file'; fileId: string } | null;

export const COVER_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const COVER_MAX_BYTES = 10 * 1024 * 1024;
