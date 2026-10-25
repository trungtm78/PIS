import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionLabel, documentRoleLabel, formProblemMessage, kindLabel, problemMessage, punchStatusLabel, severityLabel, statusLabel, verificationLabel } from './labels';
import { DECISIONS, HANDOVER_KINDS, HANDOVER_STATUSES, PUNCH_STATUSES, SEVERITIES, VERIFICATIONS } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the handovers', () => {
  it('has a word for every kind, status, severity, state of an item, verdict, decision and document', () => {
    distinct(HANDOVER_KINDS.map((kind) => kindLabel(t, kind)));
    distinct(HANDOVER_STATUSES.map((status) => statusLabel(t, status)));
    distinct(SEVERITIES.map((severity) => severityLabel(t, severity)));
    distinct(PUNCH_STATUSES.map((status) => punchStatusLabel(t, status)));
    distinct(VERIFICATIONS.map((outcome) => verificationLabel(t, outcome)));
    distinct(DECISIONS.map((decision) => decisionLabel(t, decision)));
    distinct(['MINUTES', 'AS_BUILT', 'OM_MANUAL', 'WARRANTY_CERTIFICATE'].map((role) => documentRoleLabel(t, role)));
    expect(documentRoleLabel(t, 'OTHER')).toBe('OTHER');
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'date', 'uuid', 'tooLong', 'past', 'tooMany'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal, and names the critical items that are still open', () => {
    const all: Problem[] = [
      'contractState',
      'minutesRequired',
      'permitGate',
      'handoverState',
      'punchState',
      'openCritical',
      'asBuiltRequired',
      'criticalWaiver',
      'evidenceRequired',
      'selfApproval',
      'notClean',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(all.map((problem) => problemMessage(t, { problem, detail: [] })));
    expect(problemMessage(t, { problem: 'openCritical', detail: ['1', '3'] })).toBe(`${vi_['ast.handover.error.openCritical']} ${t('ast.handover.error.items', { items: '1, 3' })}`);
  });
});
