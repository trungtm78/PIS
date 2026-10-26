import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { authorityKindLabel, commandProblemMessage, engagementStatusLabel, engagementTypeLabel, formProblemMessage, holdStatusLabel, scopeKindLabel } from './labels';
import { AUTHORITY_KINDS, ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES, SCOPE_KINDS } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooShort', 'tooLong', 'invalid', 'future', 'early', 'order'];
const COMMAND_PROBLEMS: CommandProblem[] = ['codeDuplicate', 'decisionNotEffective', 'stateInvalid', 'conclusionExists', 'versionConflict', 'scopeDenied', 'validation', 'notFound', 'general'];

describe('the words of the engagement screens (UI-AUD-02, UI-AUD-03)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every status, kind, authority, scope kind, hold state, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(ENGAGEMENT_STATUSES.map((status) => engagementStatusLabel(t, status)));
      distinct(ENGAGEMENT_TYPES.map((type) => engagementTypeLabel(t, type)));
      distinct(AUTHORITY_KINDS.map((kind) => authorityKindLabel(t, kind)));
      distinct(SCOPE_KINDS.map((kind) => scopeKindLabel(t, kind)));
      distinct([holdStatusLabel(t, null), holdStatusLabel(t, 'Active'), holdStatusLabel(t, 'Released')]);
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
