import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionLabel, effectLabel, formProblemMessage, methodLabel, problemMessage, scopeLabel, statusLabel } from './labels';
import { ACCEPTANCE_SCOPES, ACCEPTANCE_STATUSES, DECISIONS, LEGAL_EFFECTS, SIGNATURE_METHODS } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the quality acceptance minutes', () => {
  it('has a word for every scope, status, method, worth of a signature and decision', () => {
    distinct(ACCEPTANCE_SCOPES.map((scope) => scopeLabel(t, scope)));
    distinct(ACCEPTANCE_STATUSES.map((status) => statusLabel(t, status)));
    distinct(SIGNATURE_METHODS.map((method) => methodLabel(t, method)));
    distinct(LEGAL_EFFECTS.map((effect) => effectLabel(t, effect)));
    distinct(DECISIONS.map((decision) => decisionLabel(t, decision)));
  });

  it('does not call an in-app confirmation a digital signature (BR-QMS-03)', () => {
    expect(effectLabel(t, 'INTERNAL_RECORD')).toContain('nội bộ');
    expect(effectLabel(t, 'INTERNAL_RECORD')).toContain('không phải chữ ký số');
    expect(effectLabel(t, 'LEGAL_E_SIGNATURE')).not.toContain('nội bộ');
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'uuid', 'tooLong', 'certSerial'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal, and the one for missing signatures names the roles', () => {
    const all: Problem[] = [
      'inspectionNotPassed',
      'openCriticalNcr',
      'contractState',
      'alreadyDrafted',
      'recordNoUsed',
      'contentChanged',
      'acceptanceState',
      'roleNotRequired',
      'alreadySigned',
      'methodNotAccepted',
      'notYourRole',
      'signaturesIncomplete',
      'selfApproval',
      'alreadyUsed',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'session',
      'general',
    ];
    distinct(all.map((problem) => problemMessage(t, { problem, missingRoles: [] })));
    expect(problemMessage(t, { problem: 'signaturesIncomplete', missingRoles: ['OWNER', 'SUPERVISOR'] })).toBe(t('qms.acceptance.error.signaturesMissing', { roles: `${vi_['qms.inspection.role.owner']}, ${vi_['qms.inspection.role.supervisor']}` }));
  });
});
