import {
  ABSENCE_DEFAULT_CODE,
  ABSENCE_RULE_TYPE,
  ESCALATION_DEFAULT_CODE,
  ESCALATION_RULE_TYPE,
  HEALTH_DEFAULT_CODE,
  HEALTH_RULE_TYPE,
  NOTIFY_DEFAULT_CODE,
  NOTIFY_RULE_TYPE,
  absencePolicyOf,
  alertNotifyPolicyOf,
  escalationPolicyOf,
  healthTargetsOf,
} from '@machvon/kernel';
import type { AbsencePolicy, AlertNotifyPolicy, EscalationPolicy, HealthTargets } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import type { TenantTx } from './tenant-database.ts';

/** The four policies of the governance of the alert system as they are in force on a day, each with the version of the governance rule that says it (`builtin` for the default of the platform) and whether it is a starting value nobody confirmed. */
export interface AlertGovernancePolicies {
  escalation: EscalationPolicy;
  absence: AbsencePolicy;
  notify: AlertNotifyPolicy;
  health: HealthTargets;
  versions: { escalation: string; absence: string; notify: string; health: string };
  unverified: { escalation: boolean; absence: boolean; notify: boolean; health: boolean };
}

/** Reads the thresholds of the escalation, the absence cover, the notification profile and the health page through the governance port (G0-1): no number of them is written in a job, a controller or a screen. */
export class AlertGovernancePolicyReader {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async read(tx: TenantTx, asOf: string | Date, unitChain: readonly string[] = []): Promise<AlertGovernancePolicies> {
    const options = { unitChain: [...unitChain] };
    const escalation = await this.port.require(tx, ESCALATION_RULE_TYPE, ESCALATION_DEFAULT_CODE, asOf, options);
    const absence = await this.port.require(tx, ABSENCE_RULE_TYPE, ABSENCE_DEFAULT_CODE, asOf, options);
    const notify = await this.port.require(tx, NOTIFY_RULE_TYPE, NOTIFY_DEFAULT_CODE, asOf, options);
    const health = await this.port.require(tx, HEALTH_RULE_TYPE, HEALTH_DEFAULT_CODE, asOf, options);
    return {
      escalation: escalationPolicyOf(escalation.params),
      absence: absencePolicyOf(absence.params),
      notify: alertNotifyPolicyOf(notify.params),
      health: healthTargetsOf(health.params),
      versions: { escalation: policyVersionOf(escalation), absence: policyVersionOf(absence), notify: policyVersionOf(notify), health: policyVersionOf(health) },
      unverified: { escalation: escalation.unverified, absence: absence.unverified, notify: notify.unverified, health: health.unverified },
    };
  }
}
