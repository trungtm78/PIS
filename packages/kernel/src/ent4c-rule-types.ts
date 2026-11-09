import type { AlertTypeSeed, FieldSpec, RuleTypeInput } from './governance-rules.ts';
import { ENT4C_TEXT } from './messages/ent4c-texts.ts';
import { SCHEDULE_CODES, SCHEDULE_RULE_TYPE, SCHEDULE_STEP_KINDS, scheduleDefaults, scheduleDefect } from './reporting-schedule.ts';

/**
 * The kinds of governance rule that lane ENT-4c adds (QT.02): the reporting schedule with a deadline per step, and the alert types of its reminders. This file holds only data; `registerEnt4cRules` in governance-rules.ts
 * registers it. Every number is a starting value that the customer confirms: UNVERIFIED, and every screen that shows one says so.
 */

const AS_OF = '2026-11-09';
const int = (min: number, max: number): FieldSpec => ({ kind: 'int', min, max });

export const ent4cScheduleType = (): RuleTypeInput => ({
  type: SCHEDULE_RULE_TYPE,
  ownerModule: 'DIS',
  modules: ['DIS', 'ADM', 'HOME'],
  formula: ENT4C_TEXT.schedule_formula,
  source: ENT4C_TEXT.schedule_source,
  asOf: AS_OF,
  legalStatus: 'UNVERIFIED',
  schema: {
    steps: {
      kind: 'list',
      of: { kind: 'object', fields: { kind: { kind: 'enum', values: SCHEDULE_STEP_KINDS }, offset_days: int(0, 366), time: { kind: 'time', optional: true } } },
      min: SCHEDULE_STEP_KINDS.length,
      max: SCHEDULE_STEP_KINDS.length,
    },
    reminder_days_before: { kind: 'list', of: int(1, 60), max: 6 },
    overdue_repeat_days: int(0, 30),
    overdue_max_reminders: int(0, 30),
    escalate_after_overdue_days: int(0, 90),
  },
  refine: scheduleDefect,
  defaults: Object.fromEntries(SCHEDULE_CODES.map((code) => [code, { params: scheduleDefaults(code) }])),
});

/** The alert types of the reminders: who owns each, what is expected and what happens when nothing is done (G0-3). */
export const ENT4C_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'REPORTING_STEP_DUE_SOON', source: 'REPORTING_CALENDAR', owner: 'STEP_OWNER', action: ENT4C_TEXT.due_soon_action, consequence: ENT4C_TEXT.due_soon_consequence, hours: 72, severity: 'WATCH', why: ENT4C_TEXT.due_soon_why },
  { code: 'REPORTING_STEP_OVERDUE', source: 'REPORTING_CALENDAR', owner: 'STEP_OWNER', action: ENT4C_TEXT.overdue_action, consequence: ENT4C_TEXT.overdue_consequence, hours: 24, severity: 'ACTION', why: ENT4C_TEXT.overdue_why },
  { code: 'REPORTING_STEP_ESCALATED', source: 'REPORTING_CALENDAR', owner: 'UNIT_LEADER', action: ENT4C_TEXT.escalated_action, consequence: ENT4C_TEXT.escalated_consequence, hours: 24, severity: 'URGENT', why: ENT4C_TEXT.escalated_why },
];
