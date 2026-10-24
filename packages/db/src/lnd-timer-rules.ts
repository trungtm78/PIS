import { DomainError, addCalendarDays, addWorkingDays } from '@machvon/kernel';
import type { LandDayCount, LandTimerCode, LandTimerRule } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

/** The type of the rule data of the timers (`master_record.master_type`). */
export const LAND_TIMER_RULE_TYPE = 'LND_TIMER';

/** A timer as the rule data in force states it, with where the rule comes from: what a deadline stores of it and what a screen says of it. */
export interface ResolvedLandTimer {
  rule: LandTimerRule;
  reading: RuleReading;
}

function ruleOf(code: LandTimerCode, reading: RuleReading): LandTimerRule {
  const { days, day_count: dayCount, calendar_code: calendarCode } = reading.attributes;
  // The rule was checked when it was published; a rule that does not read here is a defect of the data, never an answer to the caller.
  if (!Number.isInteger(days) || (dayCount !== 'CALENDAR' && dayCount !== 'WORKING')) throw new Error(`the timer rule ${code} cannot be read`);
  return { code, days: days as number, dayCount: dayCount as LandDayCount, calendarCode: typeof calendarCode === 'string' ? calendarCode : null };
}

/**
 * The timers of land clearance as rule data (BR-LND-01, rule type LND_TIMER of MDM): the rule in force on the date a timer starts decides how
 * many days it lasts, with its legal basis, and a timer that has started keeps the rule version it was counted by. No rule in force is
 * 422 TIMER_RULE_UNCONFIRMED: the platform never counts a statutory period from a number it made up.
 */
export class LndTimerRules {
  private readonly rules: MasterRules;
  private readonly calendars: WorkCalendarStore;

  constructor(rules: MasterRules = new MasterRules(), calendars: WorkCalendarStore = new WorkCalendarStore()) {
    this.rules = rules;
    this.calendars = calendars;
  }

  /** The rule of a timer in force on `asOf`; 422 TIMER_RULE_UNCONFIRMED when none is. */
  async resolve(tx: TenantTx, code: LandTimerCode, asOf: string): Promise<ResolvedLandTimer> {
    const reading = await this.rules.read(tx, LAND_TIMER_RULE_TYPE, code, asOf);
    if (reading === undefined) throw new DomainError('TIMER_RULE_UNCONFIRMED', 422);
    return { rule: ruleOf(code, reading), reading };
  }

  /**
   * The day a timer that starts on `startedOn` falls due. Calendar days are added as they are; working days are counted on the published
   * working calendar the rule names (ADM), and a year without one is 422 CALENDAR_NOT_EFFECTIVE rather than a guess.
   */
  async dueOn(tx: TenantTx, rule: LandTimerRule, startedOn: string): Promise<string> {
    if (rule.dayCount === 'CALENDAR' || rule.calendarCode === null) return addCalendarDays(startedOn, rule.days);
    const source = await this.calendars.source(tx, rule.calendarCode, Number(startedOn.slice(0, 4)));
    return addWorkingDays(source, startedOn, rule.days);
  }
}
