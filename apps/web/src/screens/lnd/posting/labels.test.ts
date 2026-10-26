import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { commandProblemMessage, feedbackChannelLabel, feedbackStatusLabel, formProblemMessage, timerStatusLabel } from './labels';
import { FEEDBACK_CHANNELS, FEEDBACK_STATUSES, TIMER_STATUSES } from './model';
import type { CommandProblem, FormProblem } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'future', 'early'];
const COMMAND_PROBLEMS: CommandProblem[] = [
  'stateInvalid',
  'noItems',
  'notConfirmed',
  'ruleUnconfirmed',
  'notElapsed',
  'unresolved',
  'selfApproval',
  'decisionRequired',
  'documentNotClean',
  'alreadyHandled',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'general',
];

describe('the words of the posting screen (UI-LND-06)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every channel, status, timer state, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(FEEDBACK_CHANNELS.map((channel) => feedbackChannelLabel(t, channel)));
      distinct(FEEDBACK_STATUSES.map((status) => feedbackStatusLabel(t, status)));
      distinct(TIMER_STATUSES.map((status) => timerStatusLabel(t, status)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }
});
