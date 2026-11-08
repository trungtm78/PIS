import { alertTypeDefaults, registerIntegrationRules, registerRuleDefaults, registerRuleType } from '@machvon/kernel';
import type { AlertTypeSeed, FieldSpec } from '@machvon/kernel';
import { registerConnectorAlertReader } from '@machvon/db';
import { ebsAlertReader, hpmAlertReader } from './integration-alerts.ts';
import { textsOf } from '../report-forms/texts.ts';

/**
 * The governance rules and the alert types of the connections of the enterprise edition (ENT-2). Every number has its formula, its source and its day, and is flagged unverified: nobody at the customer has confirmed them
 * and the interfaces they depend on (HPM, Oracle EBS) are PENDING-EXTERNAL (R18). Registered once when the package loads (a second call changes nothing), so a public process never carries these codes:
 *   - `HPM_PUSH_POLICY`: the tries a push gets and the age of the last delivery that is aging and stale (`DEFAULT`);
 *   - `EBS_RECONCILE_POLICY`: the working days an item of difference with Oracle EBS has to be explained (`DEFAULT`);
 *   - `CONNECTOR_FRESHNESS` code `EBS_FILE`: how old the last applied file of Oracle EBS may be;
 *   - `ALERT_TYPE` `HPM_PUSH_FAILED` and `HPM_PUSH_STALE`: owner, expected action and consequence of a push that failed and of a delivery that is stale (a stale EBS file is the base alert `CONNECTOR_STALE`);
 *   - the readers that put those two connections into the source CONNECTOR of the alert centre.
 */
interface IntegrationTexts {
  source: string;
  hpmPolicy: { formula: string; source: string };
  ebsPolicy: { formula: string; source: string };
  ebsFreshness: { formula: string };
  alerts: Record<'hpmPushFailed' | 'hpmPushStale', { action: string; consequence: string; why: string }>;
}

export const integrationTexts = (): IntegrationTexts => textsOf<IntegrationTexts>('integration');

export const INTEGRATION_AS_OF = '2026-11-08';
export const SEVERITY_VALUES = ['URGENT', 'ACTION', 'WATCH'] as const;

const HPM_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  max_attempts: { kind: 'int', min: 1, max: 20 },
  warn_after_hours: { kind: 'int', min: 1, max: 8760 },
  max_age_hours: { kind: 'int', min: 1, max: 8760 },
  stale_severity: { kind: 'enum', values: SEVERITY_VALUES },
};

const EBS_SCHEMA: Readonly<Record<string, FieldSpec>> = { due_in_working_days: { kind: 'int', min: 1, max: 365 } };

let registered = false;

/** Registers the rules, the alert types and the alert readers of the connections of the enterprise edition. Idempotent. */
export function registerEnterpriseIntegrationRules(): void {
  if (registered) return;
  registered = true;
  registerIntegrationRules();
  const texts = integrationTexts();
  registerRuleDefaults('CONNECTOR_FRESHNESS', {
    EBS_FILE: {
      params: { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false },
      formula: texts.ebsFreshness.formula,
      source: texts.source,
      asOf: INTEGRATION_AS_OF,
      legalStatus: 'UNVERIFIED',
    },
  });
  registerRuleType({
    type: 'HPM_PUSH_POLICY',
    ownerModule: 'HPM',
    modules: ['HPM', 'HOME'],
    formula: texts.hpmPolicy.formula,
    source: texts.hpmPolicy.source,
    asOf: INTEGRATION_AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: HPM_SCHEMA,
    refine: (params) => ((params.warn_after_hours as number) > (params.max_age_hours as number) ? 'warn_after_hours' : undefined),
    defaults: { DEFAULT: { params: { max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' } } },
  });
  registerRuleType({
    type: 'EBS_RECONCILE_POLICY',
    ownerModule: 'EBS',
    modules: ['EBS', 'HOME'],
    formula: texts.ebsPolicy.formula,
    source: texts.ebsPolicy.source,
    asOf: INTEGRATION_AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: EBS_SCHEMA,
    defaults: { DEFAULT: { params: { due_in_working_days: 5 } } },
  });
  const seeds: readonly AlertTypeSeed[] = [
    { code: 'HPM_PUSH_FAILED', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: texts.alerts.hpmPushFailed.action, consequence: texts.alerts.hpmPushFailed.consequence, hours: 24, severity: 'ACTION', why: texts.alerts.hpmPushFailed.why },
    { code: 'HPM_PUSH_STALE', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: texts.alerts.hpmPushStale.action, consequence: texts.alerts.hpmPushStale.consequence, hours: 48, severity: 'ACTION', why: texts.alerts.hpmPushStale.why },
  ];
  registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(seeds, { source: texts.source }));
  registerConnectorAlertReader(hpmAlertReader);
  registerConnectorAlertReader(ebsAlertReader);
}
