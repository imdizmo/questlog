import { describe, it, expect } from 'vitest';
import { parseContent } from '../shared/content';

describe('parseContent', () => {
  it('extracts tags, mentions, codes', () => {
    const r = parseContent('# Title\nfix #Bug and #bug with @ada see $115');
    expect(r.tags).toEqual(['bug']);
    expect(r.mentions).toEqual(['ada']);
    expect(r.cardCodes).toEqual(['115']);
  });
  it('counts checkboxes', () => {
    expect(parseContent('- [x] a\n- [ ] b').checkboxStats).toEqual({ checked: 1, total: 2 });
    expect(parseContent('plain').checkboxStats).toBeNull();
  });
  it('ignores code spans and fences', () => {
    expect(parseContent('code `#nottag`').tags).toEqual([]);
    expect(parseContent('```\n#x @y $115\n- [x] z\n```').tags).toEqual([]);
    expect(parseContent('```\n- [x] z\n```').checkboxStats).toBeNull();
  });
  it('tag must follow whitespace', () => {
    expect(parseContent('a#b').tags).toEqual([]);
  });
  it('word count strips markdown', () => {
    expect(parseContent('# Fog shader').wordCount).toBe(2);
  });
});
