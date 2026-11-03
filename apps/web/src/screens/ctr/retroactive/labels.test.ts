import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { problemMessage } from '../change/labels';
import { describeProblem } from '../change/model';
import { adjustProblemMessage, daysText } from './labels';
import type { AdjustProblem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `MISSING ${key}`);
const failure = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 409, code, correlationId: 'c', extensions });

describe('the words of the retroactive adjustment', () => {
  it('says what is wrong with each field, a different thing for each problem', () => {
    const problems: AdjustProblem[] = ['date', 'notPast', 'json', 'tooMany', 'required', 'tooLong', 'amount', 'days', 'uuid'];
    const messages = problems.map((problem) => adjustProblemMessage(t, problem));
    expect(messages.some((message) => message.startsWith('MISSING'))).toBe(false);
    expect(new Set(messages).size).toBe(problems.length);
  });

  it('writes the sign of a number of days: extended, shortened or unchanged', () => {
    expect(daysText(t, 10)).toBe('+10 ngày');
    expect(daysText(t, -3)).toBe('-3 ngày');
    expect(daysText(t, 0)).toBe('0 ngày');
  });

  it('answers every refusal of the command in words, none twice', () => {
    const refusals = [
      failure('SETTLEMENT_ALREADY_APPROVED'),
      failure('VALUE_EXCEEDED'),
      failure('ACCEPTANCE_STATE_INVALID', { reason: 'NOT_ON_LEDGER' }),
      failure('VALIDATION_FAILED', { reason: 'NOT_RETROACTIVE' }),
      failure('VALIDATION_FAILED', { reason: 'BEFORE_CONTRACT' }),
      failure('VALIDATION_FAILED', { reason: 'NOT_AFTER_REVISION' }),
      failure('VALIDATION_FAILED', { reason: 'AFFECTED_MISMATCH' }),
      failure('CONTRACT_STATE_INVALID', { reason: 'REVISION_PENDING' }),
    ];
    const messages = refusals.map((error) => problemMessage(t, describeProblem(error)));
    expect(messages.some((message) => message.startsWith('MISSING'))).toBe(false);
    expect(new Set(messages).size).toBe(refusals.length);
  });
});
