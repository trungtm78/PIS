import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { conclusionFormProblemMessage, conclusionKindLabel, conclusionProblemMessage, conclusionStatusLabel, findingCategoryLabel, findingSeverityLabel, recommendationStatusLabel, recommendationTypeLabel } from './labels';
import { CONCLUSION_KINDS, CONCLUSION_STATUSES, FINDING_CATEGORIES, FINDING_SEVERITIES, RECOMMENDATION_STATUSES, RECOMMENDATION_TYPES } from './model';
import type { ConclusionFormProblem, ConclusionProblem } from './model';

const FORM_PROBLEMS: ConclusionFormProblem[] = ['required', 'tooShort', 'tooLong', 'invalid', 'future', 'early', 'order', 'exceeds'];
const PROBLEMS: ConclusionProblem[] = [
  'decisionNotEffective',
  'stateInvalid',
  'revisionInvalid',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'findingDuplicate',
  'recommendationDuplicate',
  'amountRequired',
  'totalMismatch',
  'targetOutside',
  'general',
];

describe('the words of the screens of the conclusion (UI-AUD-04, UI-AUD-05)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every kind, status, group, severity, type, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(CONCLUSION_KINDS.map((kind) => conclusionKindLabel(t, kind)));
      distinct(CONCLUSION_STATUSES.map((status) => conclusionStatusLabel(t, status)));
      distinct(FINDING_CATEGORIES.map((category) => findingCategoryLabel(t, category)));
      distinct(FINDING_SEVERITIES.map((severity) => findingSeverityLabel(t, severity)));
      distinct(RECOMMENDATION_TYPES.map((type) => recommendationTypeLabel(t, type)));
      distinct(RECOMMENDATION_STATUSES.map((status) => recommendationStatusLabel(t, status)));
      distinct(FORM_PROBLEMS.map((problem) => conclusionFormProblemMessage(t, problem)));
      distinct(PROBLEMS.map((problem) => conclusionProblemMessage(t, problem, '50000000')));
    });

    it(`says what is left of the total in dong in ${locale}, and nothing is left when the server did not say`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      expect(conclusionProblemMessage(t, 'totalMismatch', '50000000')).toContain('50.000.000');
      expect(conclusionProblemMessage(t, 'totalMismatch')).toContain('0');
    });
  }
});
