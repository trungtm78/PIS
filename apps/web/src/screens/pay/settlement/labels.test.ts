import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { groupLabel, outcomeLabel, problemMessage, refusalMessage, scopeLabel, statusLabel, urgencyLabel } from './labels';
import { GROUPS, OUTCOMES, SCOPES, STATUSES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the settlement of a project', () => {
  it('has a different word for every status, scope, group and outcome', () => {
    distinct(STATUSES.map((status) => statusLabel(t, status)));
    distinct(SCOPES.map((scope) => scopeLabel(t, scope)));
    distinct(GROUPS.map((group) => groupLabel(t, group)));
    distinct(OUTCOMES.map((outcome) => outcomeLabel(t, outcome)));
  });

  it('says how many days are left, or how late the deadline is', () => {
    expect(urgencyLabel(t, 'late', -6)).toBe('Quá hạn 6 ngày');
    expect(urgencyLabel(t, 'near', 20)).toBe('Còn 20 ngày');
    expect(urgencyLabel(t, 'later', 155)).toBe('Còn 155 ngày');
  });

  it('has a sentence for every problem with a field', () => {
    const problems: FormProblem[] = ['required', 'tooLong', 'uuid', 'uuids', 'day', 'future', 'year', 'tooMany'];
    distinct(problems.map((problem) => problemMessage(t, problem)));
  });

  it('has a different sentence for every refusal', () => {
    const problems: Problem[] = [
      'openExists',
      'stageInvalid',
      'groupMissing',
      'ruleUnconfirmed',
      'stateInvalid',
      'noOutstanding',
      'hasOutstanding',
      'decisionRequired',
      'approvalRequired',
      'notClean',
      'selfApproval',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(problems.map((problem) => refusalMessage(t, problem)));
  });
});
