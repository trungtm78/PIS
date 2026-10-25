import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, formProblemMessage, householdStatusLabel, legalBasisLabel, rightKindLabel } from './labels';
import { HOUSEHOLD_STATUSES, LEGAL_BASES, RIGHT_KINDS } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'past'];
const COMMAND_PROBLEMS: CommandProblem[] = [
  'legalBasisRequired',
  'consentRequired',
  'householdDuplicate',
  'linkDuplicate',
  'shareExceeded',
  'documentNotClean',
  'sealUnavailable',
  'validation',
  'notFound',
  'denied',
  'general',
];

describe('the words of the household screen (UI-LND-03)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every status, legal basis, right, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(HOUSEHOLD_STATUSES.map((status) => householdStatusLabel(t, status)));
      distinct(LEGAL_BASES.map((basis) => legalBasisLabel(t, basis)));
      distinct(RIGHT_KINDS.map((kind) => rightKindLabel(t, kind)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
