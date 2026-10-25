import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { blockerLabel, conditionLabel, formProblemMessage, problemMessage, statusLabel } from './labels';
import { BLOCKERS, RELEASE_CONDITIONS, RETENTION_STATUSES } from './model';
import type { FormProblem, Problem, ProblemView } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

const view = (problem: Problem, patch: Partial<ProblemView> = {}): ProblemView => ({ problem, blocker: undefined, leftVnd: undefined, notBefore: undefined, ...patch });

describe('the words of the retention', () => {
  it('has a word for every status, every condition and every reason a release waits', () => {
    distinct(RETENTION_STATUSES.map((status) => statusLabel(t, status)));
    distinct(RELEASE_CONDITIONS.map((condition) => conditionLabel(t, condition)));
    distinct(BLOCKERS.map((blocker) => blockerLabel(t, blocker, '2028-03-01')));
    expect(blockerLabel(t, 'NOT_BEFORE', '2028-03-01')).toContain('2028-03-01');
    expect(blockerLabel(t, 'NOT_BEFORE', null)).not.toContain('{day}');
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'uuid', 'tooLong', 'amount', 'exceeds'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = ['conditionNotMet', 'exceedsHeld', 'selfApproval', 'notClean', 'versionConflict', 'paymentState', 'validation', 'notFound', 'denied', 'session', 'general'];
    distinct(all.map((problem) => problemMessage(t, view(problem), 'vi')));
  });

  it('says what the condition waits for and how much is still held', () => {
    expect(problemMessage(t, view('conditionNotMet', { blocker: 'WARRANTY_OPEN' }), 'vi')).toContain(vi_['ctr.retention.blocker.warrantyOpen']);
    expect(problemMessage(t, view('conditionNotMet', { blocker: 'NOT_BEFORE', notBefore: '2028-03-01' }), 'vi')).toContain('2028-03-01');
    expect(problemMessage(t, view('conditionNotMet'), 'vi')).toContain(vi_['ctr.retention.blocker.unknown']);
    expect(problemMessage(t, view('exceedsHeld', { leftVnd: '60000000' }), 'vi')).toContain(new Intl.NumberFormat('vi').format(60000000));
    expect(problemMessage(t, view('exceedsHeld'), 'vi')).toContain('0');
  });
});
