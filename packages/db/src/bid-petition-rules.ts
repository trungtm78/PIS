import { DomainError, addCalendarDays, addWorkingDays } from '@machvon/kernel';
import type { PetitionDayCount, PetitionKind, PetitionRule } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

/** The type of the rule data of the deadlines of petitions (`master_record.master_type`). */
export const PETITION_RULE_TYPE = 'BID_PETITION';

/** A deadline as the rule data in force states it, with where the rule comes from: what a petition stores of it and what a screen says of it. */
export interface ResolvedPetitionRule {
  rule: PetitionRule;
  reading: RuleReading;
}

function ruleOf(kind: PetitionKind, reading: RuleReading): PetitionRule {
  const { days, day_count: dayCount, calendar_code: calendarCode, filing_days: filingDays } = reading.attributes;
  // The rule was checked when it was published; a rule that does not read here is a defect of the data, never an answer to the caller.
  if (!Number.isInteger(days) || (dayCount !== 'CALENDAR' && dayCount !== 'WORKING')) throw new Error(`the petition rule ${kind} cannot be read`);
  return {
    kind,
    days: days as number,
    dayCount: dayCount as PetitionDayCount,
    calendarCode: typeof calendarCode === 'string' ? calendarCode : null,
    filingDays: Number.isInteger(filingDays) ? (filingDays as number) : null,
  };
}

/**
 * The deadlines of petitions as rule data (BR-BID-14, rule type BID_PETITION of MDM): the rule in force on the day a petition is received decides how many days the answer may take,
 * with its legal basis, and a petition keeps the version of the rule it was counted by. No rule in force is 422 TIMER_RULE_UNCONFIRMED: the platform never counts a statutory period
 * from a number it made up.
 */
export class BidPetitionRules {
  private readonly rules: MasterRules;
  private readonly calendars: WorkCalendarStore;

  constructor(rules: MasterRules = new MasterRules(), calendars: WorkCalendarStore = new WorkCalendarStore()) {
    this.rules = rules;
    this.calendars = calendars;
  }

  /** The rule of a kind of petition in force on `asOf`; 422 TIMER_RULE_UNCONFIRMED when none is. */
  async resolve(tx: TenantTx, kind: PetitionKind, asOf: string): Promise<ResolvedPetitionRule> {
    const reading = await this.rules.read(tx, PETITION_RULE_TYPE, kind, asOf);
    if (reading === undefined) throw new DomainError('TIMER_RULE_UNCONFIRMED', 422, 'petition_kind');
    return { rule: ruleOf(kind, reading), reading };
  }

  /**
   * The last day to answer a petition received on `receivedOn`. Calendar days are added as they are; working days are counted on the published working calendar the rule names (ADM), and
   * a year without one is 422 CALENDAR_NOT_EFFECTIVE rather than a guess.
   */
  dueOn(tx: TenantTx, rule: PetitionRule, receivedOn: string): Promise<string> {
    return this.after(tx, rule, receivedOn, rule.days);
  }

  /** The last day on which a petition about a result approved on `approvedOn` may still be lodged; null when the rule sets no limit. */
  async lastDayToFile(tx: TenantTx, rule: PetitionRule, approvedOn: string): Promise<string | null> {
    return rule.filingDays === null ? null : this.after(tx, rule, approvedOn, rule.filingDays);
  }

  private async after(tx: TenantTx, rule: PetitionRule, date: string, days: number): Promise<string> {
    if (rule.dayCount === 'CALENDAR' || rule.calendarCode === null) return addCalendarDays(date, days);
    const source = await this.calendars.source(tx, rule.calendarCode, Number(date.slice(0, 4)));
    return addWorkingDays(source, date, days);
  }
}
