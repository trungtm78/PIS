import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionLabel, formProblemMessage, problemMessage, statusLabel } from './labels';
import { DECISIONS, STATUSES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the acceptance of work', () => {
  it('has a word for every status and decision', () => {
    distinct(STATUSES.map((status) => statusLabel(t, status)));
    distinct(DECISIONS.map((decision) => decisionLabel(t, decision)));
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'tooLong', 'uuid', 'tooMany'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal, and the one for a value above the contract says how much is left', () => {
    const all: Problem[] = [
      'measurementNotApproved',
      'measurementAccepted',
      'qualityRequired',
      'openNcr',
      'exceedsContract',
      'revisionNotEffective',
      'claimed',
      'selfApproval',
      'contractState',
      'acceptanceState',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(all.map((problem) => problemMessage(t, { problem, remainingVnd: undefined }, 'vi')));
    const left = problemMessage(t, { problem: 'exceedsContract', remainingVnd: '100000000' }, 'vi');
    expect(left).toContain('100.000.000');
    expect(left).not.toBe(problemMessage(t, { problem: 'exceedsContract', remainingVnd: undefined }, 'vi'));
    expect(problemMessage(t, { problem: 'exceedsContract', remainingVnd: 'x' }, 'vi')).toContain('x');
  });
});
