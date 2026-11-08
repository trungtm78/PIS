import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { GOVRULE_FIXTURES } from './govrule.fixtures';
import type { RuleFixture } from './govrule.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';

const foreign = GOVRULE_FIXTURES[FOREIGN];
const rules = foreign.rules;

/**
 * The foreign-id cases of the governance rules, the registry of alert types, the exceptions to the separation of duties and the log of the certification of a figure (ADM, BI): a TNT-A user names a version, an
 * exception, an alert type or a figure of TNT-B. Each command has a version or an exception of its own (see `RuleRole` and `SodRole`), so that what the owner does in the control run never takes the object of
 * another case away. The bodies are valid, so that the request reaches the lookup.
 *
 * The alert type is read by its code: the code of TNT-B is a code that no built-in type has, so another tenant finds neither a rule of its own nor a default and is answered 404.
 *
 * The log of the certification is the one read that cannot be answered 404: it reads the lines of a subject and a key, and the key is any well formed text (a KPI code that has no lines is an empty log, not a missing
 * figure), so the lines of the other tenant are hidden by row-level security and the answer is 200 with no line. The case expects that (and the body is still judged by the notes of the lines of TNT-B), and the
 * control run leaves it out because it names no object that the owner could be refused.
 */
export const GOVRULE_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getGovernanceRule', method: 'GET', id: rules.read.id },
  { operation: 'getGovernanceRuleDiff', method: 'GET', id: rules.read.id },
  { operation: 'submitGovernanceRule', method: 'POST', id: rules.submit.id, versioned: true, body: { reason: 'Isolation foreign submission attempt' } },
  { operation: 'withdrawGovernanceRule', method: 'POST', id: rules.withdraw.id, versioned: true, body: { reason: 'Isolation foreign withdrawal attempt' } },
  { operation: 'approveGovernanceRule', method: 'POST', id: rules.approve.id, versioned: true, body: { reason: 'Isolation foreign approval attempt' } },
  { operation: 'retireGovernanceRule', method: 'POST', id: rules.retire.id, versioned: true, body: { reason: 'Isolation foreign retirement attempt' } },
  { operation: 'getAlertType', method: 'GET', id: foreign.alertType.code },
  { operation: 'getSodException', method: 'GET', id: foreign.sod.read.id },
  { operation: 'approveSodException', method: 'POST', id: foreign.sod.approve.id, versioned: true, body: { comment: 'Isolation foreign approval attempt' } },
  { operation: 'rejectSodException', method: 'POST', id: foreign.sod.reject.id, versioned: true, body: { reason: 'Isolation foreign rejection attempt' } },
  { operation: 'revokeSodException', method: 'POST', id: foreign.sod.revoke.id, versioned: true, body: { reason: 'Isolation foreign revocation attempt' } },
  { operation: 'getAnalyticsCertificationLog', method: 'GET', id: foreign.certification.key, pathParams: { subject: 'KPI' }, expectedStatuses: [200, 404] },
];

/**
 * The ids that the foreign-id cases of `channels/api.ts` for the request to appraise a project again and the alert to the auditors must name: the rows those handlers look up (`project_reappraisal_request` and
 * `project_governance_alert`), not a revision of the project. They are the rows of TNT-B that this seed writes.
 */
export const GOVRULE_ID_OVERRIDES: Readonly<Record<string, string>> = {
  decideReappraisalRequest: foreign.baseline.reappraisalId,
  acknowledgeGovernanceAlert: foreign.baseline.alertId,
};

/** Every operation of the ADM governance rule, SoD and BI certification controllers on the tenant plane: the suite principal holds the permission of each. */
export const GOVRULE_OPERATIONS: readonly string[] = [
  'createGovernanceRuleDraft',
  'submitGovernanceRule',
  'withdrawGovernanceRule',
  'approveGovernanceRule',
  'retireGovernanceRule',
  'listGovernanceRules',
  'getGovernanceRuleCatalog',
  'getEffectiveGovernanceRule',
  'listGovernanceRuleVersions',
  'getGovernanceRule',
  'getGovernanceRuleDiff',
  'listAlertTypes',
  'getAlertType',
  'requestSodException',
  'approveSodException',
  'rejectSodException',
  'revokeSodException',
  'getSodMatrix',
  'listSodExceptions',
  'getSodException',
  'listSodAuditExceptions',
  'listSodAuditUses',
  'listAnalyticsCertifications',
  'getAnalyticsCertificationLog',
  'transitionAnalyticsCertification',
];

/** The tables the seed fills, all with an `id`; nothing in them changes when a row is only read or found. */
export const GOVRULE_SNAPSHOT_TABLES: readonly string[] = [
  'governance_rule',
  'sod_exception',
  'sod_exception_approval',
  'sod_exception_use',
  'analytics_certification',
  'project_component',
  'project_baseline',
  'project_baseline_line',
  'project_reappraisal_request',
  'project_governance_alert',
];

const INSERT_RULE = `insert into machvon.governance_rule
  (tenant_id, id, rule_type, code, version, unit_id, status, params, effective_from, effective_to, reason, created_by, created_at, submitted_by, submitted_at, approved_by, approved_at)
  values ($1, $2, $3, $4, 1, null, $5, $6::jsonb, $7::date, null, $8, $9, timestamptz '2026-01-05 08:00:00+00', $10::uuid,
          case when $10::uuid is null then null else timestamptz '2026-01-06 08:00:00+00' end, $11::uuid,
          case when $11::uuid is null then null else timestamptz '2026-01-07 08:00:00+00' end)
  on conflict do nothing`;

const INSERT_SOD = `insert into machvon.sod_exception
  (tenant_id, id, action_a, action_b, scope, subject_id, member_id, requested_by, reason, valid_from, valid_to, rule_version, approvers_needed, approvals, status, decided_at, version, created_at)
  values ($1, $2, 'prj.prepare_revision', 'prj.approve_revision', 'SAME_PROJECT', $3, $4, $4, $5, $6::date, $6::date, 0, 2, $7, $8::text,
          case when $8::text = 'APPROVED' then timestamptz '2026-01-10 08:00:00+00' else null end, 1, timestamptz '2026-01-08 08:00:00+00')
  on conflict do nothing`;

const INSERT_SOD_APPROVAL = `insert into machvon.sod_exception_approval
  (tenant_id, id, exception_id, approver_id, decision, comment, decided_at)
  values ($1, $2, $3, $4, 'APPROVE', $5, timestamptz '2026-01-09 08:00:00+00') on conflict do nothing`;

const INSERT_SOD_USE = `insert into machvon.sod_exception_use
  (tenant_id, id, outcome, exception_id, action_a, action_b, scope, subject_id, member_id, taking, command, record_id, rule_version, used_at)
  values ($1, $2, $3, $4::uuid, 'prj.prepare_revision', 'prj.approve_revision', 'SAME_PROJECT', $5, $6, 'prj.approve_revision', $7, $5, 0, timestamptz '2026-01-12 08:00:00+00')
  on conflict do nothing`;

const INSERT_CERTIFICATION = `insert into machvon.analytics_certification
  (tenant_id, id, subject, subject_key, version, seq, status, actor_membership_id, confirmed_by_membership_id, note, created_at)
  values ($1, $2, 'KPI', $3, $4, $5, $6, $7, $8, $9, timestamptz '2026-01-13 08:00:00+00') on conflict do nothing`;

const INSERT_COMPONENT = `insert into machvon.project_component
  (tenant_id, id, project_id, code, name, planned_value_vnd, sort_order, valid_from, created_by, updated_by)
  values ($1, $2, $3, $4, $5, 1000, 0, date '2026-01-01', $6, $6) on conflict do nothing`;

const INSERT_BASELINE = `insert into machvon.project_baseline
  (tenant_id, id, project_id, version, kind, basis, total_investment_vnd, bac_vnd, planned_start, planned_finish, source_revision_id, taken_by, taken_at)
  values ($1, $2, $3, 0, 'V0', 'BASELINE', 1000, 1000, date '2026-01-01', date '2026-12-31', null, $4, timestamptz '2026-01-11 08:00:00+00') on conflict do nothing`;

const INSERT_BASELINE_LINE = `insert into machvon.project_baseline_line
  (tenant_id, id, baseline_id, project_id, component_id, code, name, bac_vnd, planned_start, planned_finish)
  values ($1, $2, $3, $4, $5, $6, $7, 1000, date '2026-01-01', date '2026-12-31') on conflict do nothing`;

const INSERT_REAPPRAISAL = `insert into machvon.project_reappraisal_request
  (tenant_id, id, project_id, baseline_id, status, reasons, cost_pct, finish_slip_days, threshold_cost_pct, threshold_slip_days, rule_version, triggered_by, requested_by, requested_at, version)
  values ($1, $2, $3, $4, 'OPEN', array['COST', 'SLIP']::text[], 25, 30, 10, 14, 'built-in:1', 'REVISION', $5, timestamptz '2026-01-14 08:00:00+00', 1) on conflict do nothing`;

const INSERT_ALERT = `insert into machvon.project_governance_alert
  (tenant_id, id, project_id, alert_type, audience, subject_kind, subject_id, move_count, threshold, rule_version, status, raised_by, raised_at, version)
  values ($1, $2, $3, 'RESCHEDULE_COUNT', 'AUD', 'PROJECT', null, 3, 3, 'built-in:1', 'OPEN', $4, timestamptz '2026-01-15 08:00:00+00', 1) on conflict do nothing`;

/** The params of a version of `RAG_THRESHOLDS`: the green line is on the better side of the amber line. */
const RAG_PARAMS = { direction: 'HIGHER_IS_BETTER', green: 0.9, amber: 0.7, min_coverage_pct: 70 };

/**
 * Seeds, for the tenant of the context: the versions of a threshold in the states that each command looks for (a draft, a version submitted by the maker, an approved version in force), the alert type the tenant
 * approved for itself, four exceptions to the separation of duties (three asked for, one approved by two people and used), the lines of the certification of a figure, and the baseline of the project with its
 * request to appraise again and its alert to the auditors. Everything that a second person must decide is written by the member other than the suite principal, so that the principal may decide it. The
 * days of the versions that the owner approves begin far in the future (a version never begins in the past), and each exception covers a day of its own (no two live exceptions of one person and pair overlap).
 */
export async function seedGovrule(client: Client, context: SeedContext): Promise<void> {
  const fixtures = GOVRULE_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const principal = context.membershipId;
  const project = PROJECT_FIXTURES[context.tenant].id;

  const writeRule = async (type: string, rule: { id: string; code: string; reason: string; status: RuleFixture['status']; effectiveFrom: string }, params: unknown): Promise<void> => {
    const submitted = rule.status === 'DRAFT' ? null : maker;
    const approved = rule.status === 'APPROVED' ? principal : null;
    await client.query(INSERT_RULE, [tenantId, rule.id, type, rule.code, rule.status, JSON.stringify(params), rule.effectiveFrom, rule.reason, maker, submitted, approved]);
  };
  for (const rule of Object.values(fixtures.rules)) await writeRule('RAG_THRESHOLDS', rule, RAG_PARAMS);
  await writeRule(
    'ALERT_TYPE',
    { id: fixtures.alertType.id, code: fixtures.alertType.code, reason: fixtures.alertType.reason, status: 'APPROVED', effectiveFrom: '2026-01-01' },
    {
      source: 'ISOLATION',
      owner: 'AUDITOR',
      expected_action: fixtures.alertType.expectedAction,
      consequence: fixtures.alertType.consequence,
      response_hours: 72,
      default_severity: 'ACTION',
      reason_to_exist: fixtures.alertType.reasonToExist,
      review_on: '2030-01-01',
      enabled: true,
    },
  );

  // The exceptions are asked for by the maker for the maker, so the principal is neither the requester nor the person covered and may approve, reject or revoke them.
  for (const exception of Object.values(fixtures.sod)) {
    await client.query(INSERT_SOD, [tenantId, exception.id, project, maker, exception.reason, exception.day, exception.approvals, exception.status]);
  }
  const read = fixtures.sod.read;
  await client.query(INSERT_SOD_APPROVAL, [tenantId, fixtures.sodDecisions.byMaker.id, read.id, maker, fixtures.sodDecisions.byMaker.comment]);
  await client.query(INSERT_SOD_APPROVAL, [tenantId, fixtures.sodDecisions.byPrincipal.id, read.id, principal, fixtures.sodDecisions.byPrincipal.comment]);
  await client.query(INSERT_SOD_USE, [tenantId, fixtures.sodUses.used.id, 'EXCEPTION_USED', read.id, project, maker, fixtures.sodUses.used.command]);
  await client.query(INSERT_SOD_USE, [tenantId, fixtures.sodUses.blocked.id, 'BLOCKED', null, project, maker, fixtures.sodUses.blocked.command]);

  // A figure that the maker confirmed and the principal certified (the certifier is another person than the one who confirmed).
  const cert = fixtures.certification;
  await client.query(INSERT_CERTIFICATION, [tenantId, cert.confirmed.id, cert.key, cert.version, 1, 'CONFIRMED', maker, maker, cert.confirmed.note]);
  await client.query(INSERT_CERTIFICATION, [tenantId, cert.certified.id, cert.key, cert.version, 2, 'CERTIFIED', principal, maker, cert.certified.note]);

  // The baseline of the project: one first-level work package, version 0 with the line of that package, one request to appraise again and one alert, each raised by the maker.
  const base = fixtures.baseline;
  await client.query(INSERT_COMPONENT, [tenantId, base.componentId, project, base.componentCode, base.componentName, maker]);
  await client.query(INSERT_BASELINE, [tenantId, base.baselineId, project, maker]);
  await client.query(INSERT_BASELINE_LINE, [tenantId, base.baselineLineId, base.baselineId, project, base.componentId, base.componentCode, base.componentName]);
  await client.query(INSERT_REAPPRAISAL, [tenantId, base.reappraisalId, project, base.baselineId, maker]);
  await client.query(INSERT_ALERT, [tenantId, base.alertId, project, maker]);
}
