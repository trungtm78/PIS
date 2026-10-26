import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, complaintChannelLabel, complaintStatusLabel, complaintSubjectLabel, formProblemMessage } from './labels';
import { COMPLAINT_CHANNELS, COMPLAINT_STATUSES, COMPLAINT_SUBJECTS } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'future', 'early'];
const COMMAND_PROBLEMS: CommandProblem[] = ['householdNotFound', 'stateInvalid', 'documentRequired', 'documentNotClean', 'ruleUnconfirmed', 'versionConflict', 'scopeDenied', 'validation', 'notFound', 'general'];

describe('the words of the complaint screen (UI-LND-08)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every channel, subject, status, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(COMPLAINT_CHANNELS.map((channel) => complaintChannelLabel(t, channel)));
      distinct(COMPLAINT_SUBJECTS.map((subject) => complaintSubjectLabel(t, subject)));
      distinct(COMPLAINT_STATUSES.map((status) => complaintStatusLabel(t, status)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
