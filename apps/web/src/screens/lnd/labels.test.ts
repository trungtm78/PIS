import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import { createTranslator } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import { commandProblemMessage, formProblemMessage, landUseLabel, noticeStateLabel, parcelStatusLabel, timerLabel } from './labels';
import { LAND_USE_GROUPS, PARCEL_STATUSES, TIMER_CODES } from './model';
import type { CommandProblem, FormProblem, NoticeState } from './model';

const FORM_PROBLEMS: FormProblem[] = ['required', 'tooLong', 'invalid', 'future'];
const COMMAND_PROBLEMS: CommandProblem[] = [
  'codeDuplicate',
  'areaInvalid',
  'ruleUnconfirmed',
  'stateInvalid',
  'documentNotClean',
  'masterNotEffective',
  'versionConflict',
  'validation',
  'notFound',
  'denied',
  'general',
];
const STATES: NoticeState[] = [{ kind: 'NONE' }, { kind: 'RUNNING', daysLeft: 12 }, { kind: 'ELAPSED' }, { kind: 'SATISFIED' }, { kind: 'BREACHED' }, { kind: 'CANCELLED' }];

describe('the words of the land screens (UI-LND-02)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every land use, stage, timer, state of a notice, field problem and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(LAND_USE_GROUPS.map((group) => landUseLabel(t, group)));
      distinct(PARCEL_STATUSES.map((status) => parcelStatusLabel(t, status)));
      distinct(TIMER_CODES.map((code) => timerLabel(t, code)));
      distinct(STATES.map((state) => noticeStateLabel(t, state)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(COMMAND_PROBLEMS.map((problem) => commandProblemMessage(t, problem)));
    });
  }

  it('says the days left in the words of the notice', () => {
    const { t } = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true });
    expect(noticeStateLabel(t, { kind: 'RUNNING', daysLeft: 12 })).toContain('12');
  });
});
