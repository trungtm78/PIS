import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formProblemMessage, outcomeLabel, problemMessage, resultLabel, roleLabel, statusLabel, typeLabel } from './labels';
import { INSPECTION_STATUSES, INSPECTION_TYPES, OUTCOMES, RESULTS, SIGNER_ROLES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the inspections', () => {
  it('has a word for every kind, status, result, answer and signing role', () => {
    distinct(INSPECTION_TYPES.map((type) => typeLabel(t, type)));
    distinct(INSPECTION_STATUSES.map((status) => statusLabel(t, status)));
    distinct(RESULTS.map((result) => resultLabel(t, result)));
    distinct(OUTCOMES.map((outcome) => outcomeLabel(t, outcome)));
    distinct(SIGNER_ROLES.map((role) => roleLabel(t, role)));
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'date', 'uuid', 'tooLong', 'past', 'noParticipant', 'unanswered', 'passWithFailed', 'noFailed', 'conditionUnstated'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = [
      'permitGate',
      'contractState',
      'duplicate',
      'regime',
      'inspectionState',
      'checklistInvalid',
      'checklistMissing',
      'checklistContradicts',
      'checklistCondition',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(all.map((problem) => problemMessage(t, problem)));
  });
});
