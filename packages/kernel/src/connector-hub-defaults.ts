import { message } from './messages.ts';
import type { AlertTypeSeed } from './governance-rules.ts';
import { HUB_DEFAULT_OWNER_ROLE, HUB_POLICY_DEFAULTS } from './connector-hub.ts';

/**
 * The built-in defaults the Integration Hub (HUB-1) adds to the governance rules: the rule type `INTEGRATION_HUB_POLICY` (how many failures make a connector FAILING, when the whole hub counts as stale), the alert
 * types the hub raises (`CONNECTOR_FAILING`, `CONNECTOR_HUB_STALE`), the freshness codes of the connectors that had none, and the KPI definitions of the hub (`HUB_*`). Plain data: `governance-rules.ts` spreads it into
 * its registrations, so there is no import cycle. Every number is our own operational choice (the law sets none) and is flagged UNVERIFIED until the agency approves its own version.
 */

export const HUB_POLICY_PARAMS: Readonly<Record<string, unknown>> = {
  failing_after_runs: HUB_POLICY_DEFAULTS.failingAfterRuns,
  failing_severity: HUB_POLICY_DEFAULTS.failingSeverity,
  hub_stale_ratio_percent: HUB_POLICY_DEFAULTS.hubStaleRatioPercent,
  hub_stale_min_connectors: HUB_POLICY_DEFAULTS.hubStaleMinConnectors,
  hub_stale_severity: HUB_POLICY_DEFAULTS.hubStaleSeverity,
  incident_auto_open: HUB_POLICY_DEFAULTS.incidentAutoOpen,
  snapshot_retention_days: HUB_POLICY_DEFAULTS.snapshotRetentionDays,
};

export const hubPolicyFormula = (): string => message('hub.rule.policy.formula');
export const hubPolicySource = (): string => message('hub.rule.policy.source');

export const hubAlertSeeds = (): readonly AlertTypeSeed[] => [
  {
    code: 'CONNECTOR_FAILING',
    source: 'CONNECTOR',
    owner: HUB_DEFAULT_OWNER_ROLE,
    action: message('hub.rule.alert.failing.action'),
    consequence: message('hub.rule.alert.failing.consequence'),
    hours: 24,
    severity: 'ACTION',
    why: message('hub.rule.alert.failing.why'),
  },
  {
    code: 'CONNECTOR_HUB_STALE',
    source: 'CONNECTOR',
    owner: HUB_DEFAULT_OWNER_ROLE,
    action: message('hub.rule.alert.hub_stale.action'),
    consequence: message('hub.rule.alert.hub_stale.consequence'),
    hours: 24,
    severity: 'URGENT',
    why: message('hub.rule.alert.hub_stale.why'),
  },
];

export const hubAlertSource = (): string => message('hub.rule.alert.source');

/** The freshness codes (rule type `CONNECTOR_FRESHNESS`) of the connectors of the hub that had no code of their own: file connectors that are read about weekly. */
export const hubFreshnessDefaults = (): Readonly<Record<string, { params: Record<string, unknown>; formula: string }>> => ({
  NATIONAL_PIM_FILE: {
    params: { max_age_hours: 720, warn_after_hours: 504, stale_severity: 'WATCH', figures_blocked_when_stale: false },
    formula: message('hub.rule.freshness.national_pim_file.formula'),
  },
  PROCUREMENT_FILE: {
    params: { max_age_hours: 336, warn_after_hours: 168, stale_severity: 'WATCH', figures_blocked_when_stale: false },
    formula: message('hub.rule.freshness.procurement_file.formula'),
  },
});

export interface HubKpiDefault {
  params: Record<string, unknown>;
  unverified: boolean;
}

const kpiOwner = HUB_DEFAULT_OWNER_ROLE;

/** The figures of the hub for the KPI register: one definition each, with formula, numerator, denominator, what is left out and the source. */
export const hubKpiDefaults = (): Readonly<Record<string, HubKpiDefault>> => {
  const source = message('hub.rule.kpi.source');
  const common = { source, owner: kpiOwner, period: 'AS_OF_NOW', refresh_hours: 1, allowed_lag_days: 1 };
  return {
    HUB_CONNECTORS_HEALTHY_PCT: {
      unverified: true,
      params: {
        ...common,
        name: message('hub.rule.kpi.healthy.name'),
        formula: message('hub.rule.kpi.healthy.formula'),
        numerator: message('hub.rule.kpi.healthy.numerator'),
        denominator: message('hub.rule.kpi.healthy.denominator'),
        exclusions: [message('hub.rule.kpi.healthy.exclusions'), message('hub.rule.kpi.healthy.exclusions_2')],
        unit: 'PERCENT',
        decimals: 1,
      },
    },
    HUB_OLDEST_DATA_AGE_DAYS: {
      unverified: true,
      params: {
        ...common,
        name: message('hub.rule.kpi.oldest.name'),
        formula: message('hub.rule.kpi.oldest.formula'),
        exclusions: [message('hub.rule.kpi.oldest.exclusions')],
        unit: 'DAYS',
        decimals: 1,
      },
    },
    HUB_FAILED_RUNS_7D: {
      unverified: true,
      params: {
        ...common,
        name: message('hub.rule.kpi.failed.name'),
        formula: message('hub.rule.kpi.failed.formula'),
        exclusions: [message('hub.rule.kpi.failed.exclusions')],
        period: 'WEEK',
        unit: 'COUNT',
        decimals: 0,
      },
    },
    HUB_DISCREPANCY_BACKLOG: {
      unverified: true,
      params: {
        ...common,
        name: message('hub.rule.kpi.backlog.name'),
        formula: message('hub.rule.kpi.backlog.formula'),
        exclusions: [message('hub.rule.kpi.backlog.exclusions')],
        unit: 'COUNT',
        decimals: 0,
      },
    },
    HUB_PENDING_MAPPINGS: {
      unverified: true,
      params: {
        ...common,
        name: message('hub.rule.kpi.mappings.name'),
        formula: message('hub.rule.kpi.mappings.formula'),
        exclusions: [message('hub.rule.kpi.mappings.exclusions')],
        unit: 'COUNT',
        decimals: 0,
      },
    },
  };
};

/** The codes of the KPI definitions of the hub, in the order the screen shows them. */
export const HUB_KPI_CODES = ['HUB_CONNECTORS_HEALTHY_PCT', 'HUB_OLDEST_DATA_AGE_DAYS', 'HUB_FAILED_RUNS_7D', 'HUB_DISCREPANCY_BACKLOG', 'HUB_PENDING_MAPPINGS'] as const;
export type HubKpiCode = (typeof HUB_KPI_CODES)[number];
