import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import { createTranslator } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import { documentFieldLabel, guardLabel, guardStateLabel, moveLabel, stageFieldProblemMessage, stageProblemMessage } from './pipeline-labels';
import { STAGE_OPERATIONS } from './pipeline-model';
import type { GuardKey, GuardState, StageFieldProblem, StageProblemReason } from './pipeline-model';

const GUARDS: GuardKey[] = ['DECISION_DOCUMENT', 'INVESTMENT_DECISION_DOCUMENT', 'NATIONAL_CODE', 'OPEN_OBLIGATIONS'];
const STATES: GuardState[] = ['MET', 'UNMET', 'WARNING', 'INPUT_REQUIRED'];
const FIELD_PROBLEMS: StageFieldProblem[] = ['reasonRequired', 'reasonShort', 'reasonLong', 'documentRequired', 'documentInvalid', 'dateInvalid'];
const REASONS: StageProblemReason[] = ['transitionDenied', 'decisionRequired', 'nationalCodeRequired', 'nationalCodeFormat', 'openObligations', 'versionConflict', 'validation', 'notFound', 'denied', 'general'];

describe('the words of the project bank', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every move, guard, state and refusal in ${locale}, each differently (UI-PRJ-14)`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(STAGE_OPERATIONS.map((operation) => moveLabel(t, operation)));
      distinct(GUARDS.map((key) => guardLabel(t, key)));
      distinct(STATES.map((state) => guardStateLabel(t, state)));
      distinct(FIELD_PROBLEMS.map((problem) => stageFieldProblemMessage(t, problem)));
      distinct(REASONS.map((reason) => stageProblemMessage(t, reason)));
      expect(documentFieldLabel(t, 'INVESTMENT_DECISION_DOCUMENT')).not.toBe(documentFieldLabel(t, 'DECISION_DOCUMENT'));
    });
  }
});
