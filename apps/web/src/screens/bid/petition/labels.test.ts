import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formProblemMessage, kindLabel, outcomeLabel, problemMessage, statusLabel } from './labels';
import { OUTCOMES, PETITION_KINDS, PETITION_STATUSES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

describe('the words of the petitions', () => {
  it('has a word for every kind, status, outcome and problem of a field', () => {
    for (const kind of PETITION_KINDS) expect(kindLabel(t, kind)).not.toContain('missing:');
    for (const status of PETITION_STATUSES) expect(statusLabel(t, status)).not.toContain('missing:');
    for (const outcome of OUTCOMES) expect(outcomeLabel(t, outcome)).not.toContain('missing:');
    const problems: FormProblem[] = ['required', 'date', 'future', 'uuid'];
    expect(new Set(problems.map((problem) => formProblemMessage(t, problem))).size).toBe(problems.length);
    expect(problems.map((problem) => formProblemMessage(t, problem)).join()).not.toContain('missing:');
  });

  it('has a sentence for every refusal, and the one with a last day says which day', () => {
    const all: Problem[] = [
      'outOfTimeFuture',
      'outOfTimeNoResult',
      'outOfTimeBeforeResult',
      'outOfTimeFiling',
      'documentLodged',
      'petitionState',
      'conflict',
      'ruleUnconfirmed',
      'calendar',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    const sentences = all.map((problem) => problemMessage(t, { problem, lastDayToFile: undefined }));
    expect(new Set(sentences).size).toBe(all.length);
    expect(sentences.join()).not.toContain('missing:');
    expect(problemMessage(t, { problem: 'outOfTimeFiling', lastDayToFile: '2026-11-25' })).toBe(t('bid.petitions.error.outOfTimeFilingUntil', { day: '2026-11-25' }));
  });
});
