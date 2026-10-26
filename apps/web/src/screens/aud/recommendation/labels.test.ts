import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { actionStatusLabel, disputeOutcomeLabel, remediationFormProblemMessage, remediationProblemMessage } from './labels';
import { ACTION_STATUSES, DISPUTE_OUTCOMES } from './model';
import type { RemediationFormProblem, RemediationProblem } from './model';

const FORM_PROBLEMS: RemediationFormProblem[] = ['required', 'tooShort', 'tooLong', 'invalid', 'future', 'early', 'order', 'afterDeadline'];
const PROBLEMS: RemediationProblem[] = [
  'notOwner',
  'ownerOutOfScope',
  'dueAfterDeadline',
  'recommendationState',
  'actionState',
  'actionDuplicate',
  'evidenceRequired',
  'openActions',
  'recoveryIncomplete',
  'selfApproval',
  'documentNotEffective',
  'decisionNotEffective',
  'engagementState',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'general',
];

describe('the words of the screens of the follow-up (UI-AUD-06, UI-AUD-07)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every action state, answer, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(ACTION_STATUSES.map((status) => actionStatusLabel(t, status)));
      distinct(DISPUTE_OUTCOMES.map((outcome) => disputeOutcomeLabel(t, outcome)));
      distinct(FORM_PROBLEMS.map((problem) => remediationFormProblemMessage(t, problem)));
      distinct(PROBLEMS.map((problem) => remediationProblemMessage(t, problem, { deadline: '2026-12-31', remainingVnd: '100000000' })));
    });

    it(`says the deadline and what is left to recover in ${locale}, and nothing is left when the server did not say`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      expect(remediationProblemMessage(t, 'dueAfterDeadline', { deadline: '2026-12-31' })).toContain('2026-12-31');
      expect(remediationProblemMessage(t, 'recoveryIncomplete', { remainingVnd: '100000000' })).toContain('100.000.000');
      expect(remediationProblemMessage(t, 'recoveryIncomplete')).toContain('0');
    });
  }
});
