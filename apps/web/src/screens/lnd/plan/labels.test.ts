import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, executorKindLabel, formProblemMessage, planItemKindLabel, planStatusLabel } from './labels';
import { EXECUTOR_KINDS, ITEM_KINDS, PLAN_STATUSES } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid'];
const COMMAND_PROBLEMS: CommandProblem[] = ['codeDuplicate', 'stateInvalid', 'notConfirmed', 'versionConflict', 'scopeDenied', 'validation', 'notFound', 'general'];

describe('the words of the plan screen (UI-LND-05)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every executor, status, kind of item, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(EXECUTOR_KINDS.map((kind) => executorKindLabel(t, kind)));
      distinct(PLAN_STATUSES.map((status) => planStatusLabel(t, status)));
      distinct(ITEM_KINDS.map((kind) => planItemKindLabel(t, kind)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
