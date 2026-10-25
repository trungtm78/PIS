import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionLabel, decisionSubmitLabel, formProblemMessage, measurementProblemMessage, statusLabel } from './labels';
import { DECISIONS, STATUSES } from './model';
import type { FormProblem, MeasurementProblem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

describe('the words of the measurements', () => {
  it('has a word for every status, every decision and every problem of a field', () => {
    for (const status of STATUSES) expect(statusLabel(t, status)).not.toContain('missing:');
    for (const decision of DECISIONS) {
      expect(decisionLabel(t, decision)).not.toContain('missing:');
      expect(decisionSubmitLabel(t, decision)).not.toContain('missing:');
    }
    const problems: Array<FormProblem | 'choose'> = ['required', 'tooLong', 'quantity', 'positive', 'uuid', 'tooMany', 'choose'];
    expect(new Set(problems.map((problem) => formProblemMessage(t, problem))).size).toBe(problems.length);
    expect(problems.map((problem) => formProblemMessage(t, problem)).join()).not.toContain('missing:');
  });

  it('has a sentence for every refusal of this story, and the one that says what is left says how much', () => {
    const own: MeasurementProblem[] = ['exceeds', 'decrease', 'duplicateReference', 'revisionNotEffective', 'permitGate', 'inAcceptance', 'evidenceRequired', 'periodTaken', 'measurementState'];
    const sentences = own.map((problem) => measurementProblemMessage(t, { problem, remaining: undefined }, 'en-US'));
    expect(new Set(sentences).size).toBe(own.length);
    expect(sentences.join()).not.toContain('missing:');
    expect(measurementProblemMessage(t, { problem: 'exceeds', remaining: '4500.000000' }, 'en-US')).toBe(t('ctr.measurement.error.exceedsLeft', { remaining: '4,500' }));
    expect(measurementProblemMessage(t, { problem: 'selfApproval', remaining: undefined }, 'en-US')).toBe(t('ctr.change.error.selfApproval'));
  });
});
