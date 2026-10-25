import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { basisLabel, kindLabel, problemMessage, statusLabel } from './labels';
import { BASES, KINDS, STATUSES } from './model';
import type { Problem } from './model';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `missing:${key}`;

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the advance', () => {
  it('has a different word for every status, kind and basis', () => {
    distinct(STATUSES.map((status) => statusLabel(t, status)));
    distinct(KINDS.map((kind) => kindLabel(t, kind)));
    distinct(BASES.map((basis) => basisLabel(t, basis)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = ['recoveryExceeded', 'stateInvalid', 'documentNotClean', 'versionConflict', 'validation', 'notFound', 'denied', 'session', 'general'];
    distinct(all.map((problem) => problemMessage(t, problem)));
  });
});
