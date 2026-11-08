import type { Client } from 'pg';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import type { ForeignAttemptSpec } from '../api';
import { MR1_FIXTURES } from './mr1.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const project = PROJECT_FIXTURES[FOREIGN].id;
const foreign = MR1_FIXTURES[FOREIGN];

/**
 * The foreign-id cases of the risk register scored from signals and of the effectiveness after the investment (MR-1): a TNT-A user names a project, an alert, a set of targets or an assessment of TNT-B. The
 * bodies are valid, so that the request reaches the lookup. The lists and the board have no id: the markers of the fixtures prove they show nothing of the other tenant.
 */
export const MR1_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getProjectRiskSignals', method: 'GET', id: project },
  { operation: 'getProjectEffectiveness', method: 'GET', id: project },
  { operation: 'acknowledgeProjectRiskAlert', method: 'POST', id: foreign.alert.id, versioned: true, body: { note: 'Isolation foreign acknowledgement attempt' } },
  {
    operation: 'saveEffectTargetDraft',
    method: 'POST',
    id: project,
    body: {
      basis: 'Isolation foreign decision of the investment',
      indicators: [{ code: 'FOREIGN_OUTPUT', name: 'Isolation foreign output', unit: 'MWh', direction: 'HIGHER_IS_BETTER', target_value: '1000', data_source: 'Isolation foreign meter', formula: 'Isolation foreign sum' }],
    },
  },
  { operation: 'fixEffectTargets', method: 'POST', id: foreign.draftSet.id, versioned: true, body: {} },
  { operation: 'recordEffectMeasurement', method: 'POST', id: project, body: { indicator_code: foreign.indicators.fixed.code, measured_on: '2026-01-31', value: '800', method_note: 'Isolation foreign measurement' } },
  { operation: 'generateEffectCalendar', method: 'POST', id: project, body: {} },
  { operation: 'submitEffectAssessment', method: 'POST', id: project, body: { kind: 'AD_HOC', conclusion: 'SATISFACTORY', summary: 'Isolation foreign assessment attempt' } },
  { operation: 'decideEffectAssessment', method: 'POST', id: foreign.assessment.id, versioned: true, body: { decision: 'APPROVE' } },
];

/** Every operation of the MR-1 controllers: the suite principal holds the permission of each. */
export const MR1_OPERATIONS: readonly string[] = [
  'getRiskSignalBoard',
  'getProjectRiskSignals',
  'listProjectRiskAlerts',
  'acknowledgeProjectRiskAlert',
  'getProjectEffectiveness',
  'saveEffectTargetDraft',
  'fixEffectTargets',
  'recordEffectMeasurement',
  'generateEffectCalendar',
  'submitEffectAssessment',
  'decideEffectAssessment',
];

/** The tables the MR-1 seed fills, all with an `id`; nothing in them changes when a row is only read or found. */
export const MR1_SNAPSHOT_TABLES: readonly string[] = ['project_risk_signal', 'project_risk_alert', 'effect_target_set', 'effect_indicator', 'effect_assessment'];

/**
 * Seeds, for the tenant of the context, a signal line of the project with an open critical alert, a set of targets that stands FIXED with one indicator and an assessment waiting for its decision (made by
 * a member other than the suite principal, so that the owner may decide it), and a draft that replaces the fixed set (written by that member, so that the owner may fix it).
 */
export async function seedMr1(client: Client, context: SeedContext): Promise<void> {
  const fixtures = MR1_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const projectId = PROJECT_FIXTURES[context.tenant].id;
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const checker = context.membershipId;

  await client.query(
    `insert into machvon.project_risk_signal (tenant_id, id, project_id, signal_kind, status, likelihood, impact, evidence, rule_version, rule_unverified, first_scored_on, last_scored_on)
     values ($1, $2, $3, 'SCHEDULE_DELAY', 'ACTIVE', 4, 4, '{}'::jsonb, 'built-in:1', true, date '2026-02-01', date '2026-02-01') on conflict do nothing`,
    [tenantId, fixtures.signal.id, projectId],
  );
  await client.query(
    `insert into machvon.project_risk_alert (tenant_id, id, project_id, alert_type, subject_kind, signal_id, signal_kind, score, prior_score, threshold, rule_version, rule_unverified, status, raised_on, raised_by)
     values ($1, $2, $3, 'RISK_SCORE_CRITICAL', 'SIGNAL', $4, 'SCHEDULE_DELAY', 16, 0, 15, 'built-in:1', true, 'OPEN', date '2026-02-01', $5) on conflict do nothing`,
    [tenantId, fixtures.alert.id, projectId, fixtures.signal.id, maker],
  );

  // The set that stands FIXED: written as a draft with its indicator, then fixed by the member who is not its author (the database keeps the indicators of a draft only).
  await client.query(
    `insert into machvon.effect_target_set (tenant_id, id, project_id, version_no, status, basis, drafted_by) values ($1, $2, $3, 1, 'DRAFT', $4, $5) on conflict do nothing`,
    [tenantId, fixtures.fixedSet.id, projectId, fixtures.fixedSet.basis, maker],
  );
  await client.query(
    `insert into machvon.effect_indicator (tenant_id, id, target_set_id, project_id, code, name, unit, direction, baseline_value, baseline_on, target_value, data_source, formula, sort_order)
     values ($1, $2, $3, $4, $5, $6, 'MWh', 'HIGHER_IS_BETTER', 0, date '2026-01-01', 1000, 'Meter readings', 'Sum of the monthly readings', 1) on conflict do nothing`,
    [tenantId, fixtures.indicators.fixed.id, fixtures.fixedSet.id, projectId, fixtures.indicators.fixed.code, fixtures.indicators.fixed.name],
  );
  await client.query(
    `update machvon.effect_target_set set status = 'FIXED', fixed_by = $2, fixed_at = timestamptz '2026-02-02 08:00:00+00', fixed_on = date '2026-02-02' where id = $1 and status = 'DRAFT'`,
    [fixtures.fixedSet.id, checker],
  );

  // The draft that replaces it, written by the maker, waiting to be fixed by somebody else.
  await client.query(
    `insert into machvon.effect_target_set (tenant_id, id, project_id, version_no, status, basis, supersedes_id, supersede_reason, drafted_by) values ($1, $2, $3, 2, 'DRAFT', $4, $5, $6, $7) on conflict do nothing`,
    [tenantId, fixtures.draftSet.id, projectId, fixtures.draftSet.basis, fixtures.fixedSet.id, fixtures.draftSet.reason, maker],
  );
  await client.query(
    `insert into machvon.effect_indicator (tenant_id, id, target_set_id, project_id, code, name, unit, direction, target_value, data_source, formula, sort_order)
     values ($1, $2, $3, $4, $5, $6, '%', 'LOWER_IS_BETTER', 6, 'Grid operator report', 'Lost energy over energy sent', 1) on conflict do nothing`,
    [tenantId, fixtures.indicators.draft.id, fixtures.draftSet.id, projectId, fixtures.indicators.draft.code, fixtures.indicators.draft.name],
  );

  await client.query(
    `insert into machvon.effect_assessment (tenant_id, id, project_id, kind, target_set_id, as_of, status, conclusion, summary, lines, policy_version, policy_unverified, submitted_by)
     values ($1, $2, $3, 'FINAL', $4, date '2026-02-03', 'SUBMITTED', 'PARTIALLY_SATISFACTORY', $5, '[{"code":"X","band":"PARTIAL"}]'::jsonb, 'built-in:1', true, $6) on conflict do nothing`,
    [tenantId, fixtures.assessment.id, projectId, fixtures.fixedSet.id, fixtures.assessment.summary, maker],
  );
}
