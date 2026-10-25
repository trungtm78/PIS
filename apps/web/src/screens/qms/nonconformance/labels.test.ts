import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { actionStatusLabel, formProblemMessage, laneLabel, problemMessage, severityLabel, sourceLabel, statusLabel, verificationLabel } from './labels';
import { ACTION_STATUSES, LANES, NCR_STATUSES, SEVERITIES, SOURCE_KINDS, VERIFICATIONS } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the non-conformances', () => {
  it('has a word for every severity, source, status, lane and verdict', () => {
    distinct(SEVERITIES.map((severity) => severityLabel(t, severity)));
    distinct(SOURCE_KINDS.map((source) => sourceLabel(t, source)));
    distinct(NCR_STATUSES.map((status) => statusLabel(t, status)));
    distinct(ACTION_STATUSES.map((status) => actionStatusLabel(t, status)));
    distinct(LANES.map((lane) => laneLabel(t, lane)));
    distinct(VERIFICATIONS.map((outcome) => verificationLabel(t, outcome)));
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'date', 'uuid', 'tooLong', 'past', 'sourceReference', 'evidenceRequired'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = [
      'contractState',
      'ncrState',
      'actionState',
      'actionsOpen',
      'evidenceRequired',
      'notClean',
      'selfApproval',
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
