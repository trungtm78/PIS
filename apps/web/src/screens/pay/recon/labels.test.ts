import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { itemStatusLabel, kindLabel, problemMessage, refusalMessage, resolutionLabel } from './labels';
import { ITEM_KINDS, ITEM_STATUSES, RESOLUTIONS } from './model';
import type { Problem, ReconProblem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the differences', () => {
  it('has a different word for every kind, every status and every resolution', () => {
    distinct(ITEM_KINDS.map((kind) => kindLabel(t, kind)));
    distinct(ITEM_STATUSES.map((status) => itemStatusLabel(t, status)));
    distinct(RESOLUTIONS.map((resolution) => resolutionLabel(t, resolution)));
  });

  it('has a sentence for every problem with a field', () => {
    const problems: ReconProblem[] = ['required', 'tooLong', 'uuid', 'invalid', 'past'];
    distinct(problems.map((problem) => problemMessage(t, problem)));
  });

  it('has a sentence for every refusal', () => {
    const problems: Problem[] = [
      'mismatch',
      'alreadyMatched',
      'paymentState',
      'itemState',
      'approvalRequired',
      'selfApproval',
      'planYear',
      'notClean',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(problems.map((problem) => refusalMessage(t, { problem, mismatch: null })));
  });
});
