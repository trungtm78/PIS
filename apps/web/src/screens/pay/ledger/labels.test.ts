import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { entryKindLabel } from './labels';
import { ENTRY_KINDS } from './model';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `missing:${key}`;

describe('the words of the cumulative ledger', () => {
  it('has a different word for every kind of entry', () => {
    const words = ENTRY_KINDS.map((kind) => entryKindLabel(t, kind));
    expect(new Set(words).size).toBe(ENTRY_KINDS.length);
    expect(words.join()).not.toContain('missing:');
  });
});
