import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formProblemMessage, gradeLabel, problemMessage, statusLabel } from './labels';
import { CONSTRUCTION_GRADES, WARRANTY_STATUSES } from './model';
import type { FormProblem, Problem, ProblemView } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

const view = (problem: Problem, patch: Partial<ProblemView> = {}): ProblemView => ({ problem, minimum: undefined, period: undefined, endsOn: undefined, claims: [], ...patch });

describe('the words of the warranty', () => {
  it('has a word for every status and every grade of work, and one for a grade that is not stated', () => {
    distinct(WARRANTY_STATUSES.map((status) => statusLabel(t, status)));
    distinct([...CONSTRUCTION_GRADES, null].map((grade) => gradeLabel(t, grade)));
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'date', 'uuid', 'tooLong', 'amount', 'period', 'cover'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = ['belowMinimum', 'noRule', 'guaranteeRequired', 'handoverNotAccepted', 'notExpired', 'openClaims', 'stateInvalid', 'validation', 'notFound', 'denied', 'session', 'general'];
    distinct(all.map((problem) => problemMessage(t, view(problem))));
  });

  it('says the minimum and the term that was asked, the last day, and the claims that are open', () => {
    expect(problemMessage(t, view('belowMinimum', { minimum: 12, period: 6 }))).toBe(t('ast.warranty.error.belowMinimum', { minimum: 12, period: 6 }));
    expect(problemMessage(t, view('belowMinimum', { minimum: 12, period: 6 }))).toContain('12');
    expect(problemMessage(t, view('notExpired', { endsOn: '2027-09-01' }))).toContain('2027-09-01');
    expect(problemMessage(t, view('openClaims', { claims: ['WC-1', 'WC-2'] }))).toContain('WC-1, WC-2');
    expect(problemMessage(t, view('openClaims', { claims: ['WC-1', 'WC-2'] }))).toContain('2');
  });
});
