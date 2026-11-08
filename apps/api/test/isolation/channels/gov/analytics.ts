import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { PROJECT_FIXTURES } from '../../suite';
import { ANALYTICS_FIXTURES } from './analytics.fixtures';
import type { SeedContext } from './support';

const FOREIGN = ANALYTICS_FIXTURES['TNT-B'];

/** Every operation of the executive analytics (GOV-11b): the test role of the suite holds the permission of each. */
export const ANALYTICS_OPERATIONS: readonly string[] = [
  'getDisbursementOutlook',
  'recordAnalyticsDecision',
  'recordAnalyticsDecisionOutcome',
  'listAnalyticsDecisions',
  'getAnalyticsDecision',
  'getDataFreshness',
  'getDataTrustScorecard',
  'getMetricLineageGraph',
  'getMultiMetricRanking',
  'listRankingAnnotations',
  'listRankingComplaints',
  'proposeRankingAnnotation',
  'decideRankingAnnotation',
  'fileRankingComplaint',
  'resolveRankingComplaint',
  'getBottleneckAnalysis',
  'listHaltedProjects',
  'getHaltedProject',
  'recordProjectHalt',
  'saveRestartPlan',
  'decideRestartPlan',
  'closeRestartStep',
  'closeProjectHalt',
  'getAnalyticsHeatmap',
  'getAnalyticsBacktest',
  'getAnalyticsTrendRanking',
];

/** The tables the seed fills, all with an `id`; nothing in them changes when a row is only read or found by someone of the other tenant. */
export const ANALYTICS_SNAPSHOT_TABLES: readonly string[] = ['analytics_decision', 'analytics_decision_outcome', 'ranking_annotation', 'ranking_complaint', 'project_halt_dossier', 'project_restart_step'];

/** The id-bearing operations of the analytics: the owner (TNT-B) finds a real object for each of them (see `seedAnalytics`), and the body of a command is valid so the request reaches the lookup. */
export const ANALYTICS_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getAnalyticsDecision', method: 'GET', id: FOREIGN.decision.id },
  { operation: 'recordAnalyticsDecisionOutcome', method: 'POST', id: FOREIGN.decision.id, body: { outcome: 'STILL_OPEN', note: 'Isolation foreign outcome' } },
  { operation: 'decideRankingAnnotation', method: 'POST', id: FOREIGN.annotation.id, body: { decision: 'APPROVE', note: 'Isolation foreign decision' } },
  { operation: 'resolveRankingComplaint', method: 'POST', id: FOREIGN.complaint.id, body: { action: 'START_REVIEW' } },
  { operation: 'getHaltedProject', method: 'GET', id: FOREIGN.dossier.id },
  { operation: 'saveRestartPlan', method: 'POST', id: FOREIGN.dossier.id, body: { steps: [{ title: 'Isolation foreign step', owner_unit_id: FOREIGN.dossier.id, due_on: '2999-01-01' }] } },
  { operation: 'decideRestartPlan', method: 'POST', id: FOREIGN.dossier.id, body: { decision: 'APPROVE', note: 'Isolation foreign decision' } },
  { operation: 'closeRestartStep', method: 'POST', id: FOREIGN.dossier.id, pathParams: { step_id: FOREIGN.dossier.stepId }, body: { status: 'DONE', note: 'Isolation foreign closure' } },
  { operation: 'closeProjectHalt', method: 'POST', id: FOREIGN.dossier.id, body: { outcome: 'CANCELLED', note: 'Isolation foreign closure' } },
];

/** Seeds, for the tenant of the context, a decision, a note, a complaint and a halt dossier with a step. */
export async function seedAnalytics(client: Client, context: SeedContext): Promise<void> {
  const fixtures = ANALYTICS_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const principal = context.membershipId;
  const project = PROJECT_FIXTURES[context.tenant].id;
  await client.query(
    `insert into machvon.analytics_decision (tenant_id, id, subject_kind, subject_title, decision_kind, reason, figures, figures_sha256, decided_by)
     values ($1, $2, 'FREE', $3, 'DEFER', $4, '{}'::jsonb, repeat('a', 64), $5) on conflict do nothing`,
    [tenantId, fixtures.decision.id, fixtures.decision.title, fixtures.decision.reason, principal],
  );
  await client.query(
    `insert into machvon.ranking_annotation (tenant_id, id, unit_id, reason_code, metric_codes, evidence, valid_from, valid_to, proposed_by)
     values ($1, $2, $3, 'LAND_CLEARANCE', array['RATE'], $4, current_date, current_date + 30, $5) on conflict do nothing`,
    [tenantId, fixtures.annotation.id, context.home, fixtures.annotation.evidence, principal],
  );
  await client.query(
    `insert into machvon.ranking_complaint (tenant_id, id, unit_id, metric_code, as_of_date, claim, due_on, filed_by)
     values ($1, $2, $3, 'RATE', current_date, $4, current_date + 10, $5) on conflict do nothing`,
    [tenantId, fixtures.complaint.id, context.home, fixtures.complaint.claim, principal],
  );
  await client.query(
    `insert into machvon.project_halt_dossier (tenant_id, id, project_id, reason_code, reason_text, halted_on, created_by)
     values ($1, $2, $3, 'OTHER', $4, current_date - 5, $5) on conflict do nothing`,
    [tenantId, fixtures.dossier.id, project, fixtures.dossier.reason, principal],
  );
  await client.query(
    `insert into machvon.project_restart_step (tenant_id, id, dossier_id, plan_version, ordinal, title, owner_unit_id, due_on)
     values ($1, $2, $3, 1, 1, $4, $5, current_date + 10) on conflict do nothing`,
    [tenantId, fixtures.dossier.stepId, fixtures.dossier.id, fixtures.dossier.stepTitle, context.home],
  );
}
