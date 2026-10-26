import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, formProblemMessage, paymentMethodLabel, paymentStatusLabel } from './labels';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'future', 'early'];
const COMMAND_PROBLEMS: CommandProblem[] = [
  'exceedsHousehold',
  'exceedsPlan',
  'planState',
  'paymentState',
  'lateReason',
  'advanceExceeded',
  'advanceState',
  'documentNotClean',
  'ruleUnconfirmed',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'general',
];

describe('the words of the payment screen (UI-LND-07)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every method, status, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct([...PAYMENT_METHODS, 'DEPOSITED' as const].map((method) => paymentMethodLabel(t, method)));
      distinct(PAYMENT_STATUSES.map((status) => paymentStatusLabel(t, status)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
