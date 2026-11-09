import { SCHEDULE_CODES, SCHEDULE_RULE_TYPE, schedulePolicyOf } from '@machvon/kernel';
import type { SchedulePolicy, ScheduleCode } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** A schedule as it was read: the policy, and everything a decision or a screen needs to say where it came from. */
export interface ScheduleReading {
  code: ScheduleCode;
  policy: SchedulePolicy;
  /** The version of the rule that decided; 0 for the built-in default. */
  version: number;
  source: 'RULE' | 'DEFAULT';
  /** The numbers are a starting value nobody confirmed. */
  unverified: boolean;
  ruleId: string | null;
}

/**
 * The reader of the reporting schedule (QT.02, ENT-4c): the rule `REPORTING_SCHEDULE` of a kind of period in force on a business day, else the built-in default. It reads through the governance port, so a rule is the version the
 * tenant approved (proposer and approver differ) and a day before it took effect still reads the version in force then. It never writes.
 */
export class ReportingScheduleReader {
  private readonly port = new GovernancePolicyPort();

  async get(tx: TenantTx, code: ScheduleCode, asOf: string | Date): Promise<ScheduleReading> {
    const rule = await this.port.require(tx, SCHEDULE_RULE_TYPE, code, asOf);
    return { code, policy: schedulePolicyOf(rule.params), version: rule.version, source: rule.source, unverified: rule.unverified, ruleId: rule.ruleId };
  }

  /** Every kind of period, each read for the day. */
  async all(tx: TenantTx, asOf: string | Date): Promise<ScheduleReading[]> {
    const readings: ScheduleReading[] = [];
    for (const code of SCHEDULE_CODES) readings.push(await this.get(tx, code, asOf));
    return readings;
  }
}
