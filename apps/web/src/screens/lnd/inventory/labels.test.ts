import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, formProblemMessage, inventoryStatusLabel, itemKindLabel, outcomeLabel } from './labels';
import { INVENTORY_STATUSES, ITEM_KINDS, OUTCOMES } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'future', 'beforeSurvey'];
const COMMAND_PROBLEMS: CommandProblem[] = ['priceDecision', 'parcelNotLinked', 'selfApproval', 'stateInvalid', 'versionConflict', 'documentNotClean', 'validation', 'notFound', 'denied', 'general'];

describe('the words of the inventory screen (UI-LND-04)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every kind of asset, status, answer, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(ITEM_KINDS.map((kind) => itemKindLabel(t, kind)));
      distinct(INVENTORY_STATUSES.map((status) => inventoryStatusLabel(t, status)));
      distinct(OUTCOMES.map((outcome) => outcomeLabel(t, outcome)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
