import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { docKindLabel, formProblemMessage, kindLabel, problemMessage, statusLabel, warningMessage } from './labels';
import { DOC_KINDS, KINDS, STATUSES } from './model';
import type { FormProblem, Problem, WarningCode } from './model';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `missing:${key}`;

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the payment request', () => {
  it('has a different word for every status, kind and kind of document', () => {
    distinct(STATUSES.map((status) => statusLabel(t, status)));
    distinct(KINDS.map((kind) => kindLabel(t, kind)));
    distinct(DOC_KINDS.map((kind) => docKindLabel(t, kind)));
  });

  it('has a sentence for every problem of a field and every warning', () => {
    const problems: FormProblem[] = ['required', 'tooLong', 'amount', 'uuid', 'date'];
    distinct(problems.map((problem) => formProblemMessage(t, problem)));
    const warnings: WarningCode[] = ['OTHER_DRAFTS_FOR_ACCEPTANCE', 'NATIONAL_CODE_MISSING', 'DUPLICATE_INVOICE_OTHER_CONTRACT'];
    distinct(warnings.map((warning) => warningMessage(t, warning)));
  });

  it('has a sentence for every refusal', () => {
    const all: Problem[] = [
      'acceptanceNotApproved',
      'claimed',
      'contractState',
      'referenceDuplicate',
      'paymentState',
      'netMismatch',
      'allocationUnavailable',
      'planYear',
      'nationalCode',
      'invoiceDuplicate',
      'documentNotClean',
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
