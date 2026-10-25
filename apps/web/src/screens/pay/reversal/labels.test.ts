import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { problemMessage, refusalMessage } from './labels';
import type { Problem, ReversalProblem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the reversal of a payment', () => {
  it('has a sentence for every problem with a field', () => {
    const problems: ReversalProblem[] = ['required', 'tooLong', 'uuid'];
    distinct(problems.map((problem) => problemMessage(t, problem)));
  });

  it('has a different sentence for every refusal', () => {
    const problems: Problem[] = [
      'refundMissing',
      'refundNotFound',
      'refundNotRefund',
      'refundOther',
      'refundAmount',
      'refundUsed',
      'approvalRequired',
      'notClean',
      'selfApproval',
      'paymentState',
      'retentionReleased',
      'advanceState',
      'valueExceeded',
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
