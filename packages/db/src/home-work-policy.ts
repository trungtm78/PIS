import { BUILTIN_POLICY_VERSION, WORK_POLICY_DEFAULT_CODE, WORK_POLICY_RULE_TYPES, clockPolicyOf, reminderPolicyOf, snoozePolicyOf } from '@machvon/kernel';
import type { ClockPolicy, ReminderPolicy, ResolvedGovernanceRule, SnoozePolicy } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** The three policies of the clocks of the alert centre as they are in force on a day, each with the version of the governance rule that says it (`builtin` when it is the default of the platform). */
export interface WorkPolicies {
  snooze: SnoozePolicy;
  clock: ClockPolicy;
  reminder: ReminderPolicy;
  versions: { snooze: string; clock: string; reminder: string };
  /** The numbers are the starting values of the research, not confirmed with the customer: every screen that shows them says so. */
  unverified: { snooze: boolean; clock: boolean; reminder: boolean };
}

/** The version a decision carries: `builtin` for the default of the platform, `v<n>` for the approved rule that decided it. */
export const policyVersionOf = (rule: Pick<ResolvedGovernanceRule, 'source' | 'version'>): string => (rule.source === 'DEFAULT' ? BUILTIN_POLICY_VERSION : `v${rule.version}`);

/**
 * Reads the thresholds of the clocks (snooze caps, the two clocks, the cadence of reminders) through the governance port: the approved rule of the tenant in force on the day, else the built-in default (G0-1). No number
 * of them is written in a controller or a screen; a rule that does not say all of what its type needs was refused when it was approved and is refused again here rather than half applied.
 */
export class WorkPolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async read(tx: TenantTx, asOf: string | Date, unitChain: readonly string[] = []): Promise<WorkPolicies> {
    const options = { unitChain: [...unitChain] };
    const snooze = await this.port.require(tx, WORK_POLICY_RULE_TYPES.snooze, WORK_POLICY_DEFAULT_CODE, asOf, options);
    const clock = await this.port.require(tx, WORK_POLICY_RULE_TYPES.clock, WORK_POLICY_DEFAULT_CODE, asOf, options);
    const reminder = await this.port.require(tx, WORK_POLICY_RULE_TYPES.reminder, WORK_POLICY_DEFAULT_CODE, asOf, options);
    return {
      snooze: snoozePolicyOf(snooze.params),
      clock: clockPolicyOf(clock.params),
      reminder: reminderPolicyOf(reminder.params),
      versions: { snooze: policyVersionOf(snooze), clock: policyVersionOf(clock), reminder: policyVersionOf(reminder) },
      unverified: { snooze: snooze.unverified, clock: clock.unverified, reminder: reminder.unverified },
    };
  }
}
