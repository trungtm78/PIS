import { PAUSE_REASONS, SNOOZE_REASONS, clockPolicyDefaults, snoozePolicyDefaults } from '@machvon/kernel';
import type { Client } from 'pg';
import { MEMBERSHIP_FIXTURES, PERIOD_SNAPSHOT_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { HOME_FIXTURES } from './home.fixtures';
import type { SeedContext } from './support';

/** Every operation of the HOME controllers of the alert centre and the colours on the tenant plane: the suite principal holds the permission of each. */
export const HOME_OPERATIONS: readonly string[] = [
  'claimWork',
  'assignWork',
  'snoozeWork',
  'pauseWorkClock',
  'resumeWorkClock',
  'getSnoozedWork',
  'getWorkClockPolicies',
  'getMyWork',
  'getMyWorkCounts',
  'getKpiRegister',
  'exportHomeFigures',
  'getHomeChanges',
  'getRagReading',
  'setRagOverride',
  'revokeRagOverride',
  'scoreEarlyWarningWeek',
];

/** The tables the home seed fills, all with an `id`; nothing in them changes when a row is only read or found. */
export const HOME_SNAPSHOT_TABLES: readonly string[] = ['explanation_request', 'work_action', 'governance_rule', 'rag_override', 'early_warning_score'];

const INSERT_ITEM = `insert into machvon.explanation_request
  (tenant_id, id, subject_kind, project_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, created_by, updated_by)
  select $1, $2, 'PROJECT', $3, $4, $5, $6::uuid, now() + ($7::int * interval '1 day'), now() + ($7::int * interval '1 day'), 'REQUESTED', $8::uuid, $8::uuid
   where not exists (select 1 from machvon.explanation_request where id = $2::uuid)`;

const INSERT_SNOOZE = `insert into machvon.work_action
  (tenant_id, id, source, source_id, action, actor_membership_id, snooze_until, reason, reason_code, snooze_ordinal, snooze_final, policy_version)
  values ($1, $2, 'EXPLANATION', $3, 'SNOOZE', $4, now() + interval '2 days', $5, 'WAITING_INFORMATION', 1, false, 'builtin') on conflict do nothing`;

const INSERT_PAUSE = `insert into machvon.work_action
  (tenant_id, id, source, source_id, action, actor_membership_id, allowed_by_membership_id, paused_until, reason, reason_code, policy_version)
  values ($1, $2, 'EXPLANATION', $3, 'PAUSE_CLOCK', $4, $5, now() + interval '5 days', $6, 'WAITING_EXTERNAL_PARTY', 'builtin') on conflict do nothing`;

const INSERT_RULE = `insert into machvon.governance_rule
  (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
  values ($1, $2, $3, $4, 1, 'APPROVED', $5::jsonb, date '2026-01-01', $6, $7, $7, now(), $8, now()) on conflict do nothing`;

const INSERT_OVERRIDE = `insert into machvon.rag_override
  (tenant_id, id, unit_id, action, band, rule_band, until, reason, actor_membership_id)
  values ($1, $2, $3, 'SET', 'AMBER', 'NO_DATA', ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 60), $4, $5) on conflict do nothing`;

const INSERT_SCORE = `insert into machvon.early_warning_score
  (tenant_id, id, week_start, unit_id, snapshot_id, as_of_date, score, band, coverage_pct, critical_warnings, overdue_explanations, breakdown, rule_versions, unverified, computed_by)
  values ($1, $2, date '2025-12-29', $3, $4, date '2026-01-03', $5::numeric, 'AMBER', 100, 0, 0, '{}'::jsonb, '{}'::jsonb, true, $6) on conflict do nothing`;

/**
 * Seeds, for the tenant of the context: seven work items (explanation requests of the first project that the suite principal has to answer, one open request for each trigger), one of them overdue and put off by
 * another member (so that the list of what is put off has a row and the list of the work keeps it), one with a pause of its clocks that holds; an approved rule of the clock policy and of the snooze policy with a reason code of
 * the tenant, an approved definition of an indicator of the tenant, an override of the colour of the first unit that holds for sixty days, and the score of that unit for the week before the one of the frozen snapshot.
 * The days of the requests, the postponement, the pause and the override are counted from the day the suite runs on, so that they are live and in the shape that is looked for whatever day it is.
 */
export async function seedHome(client: Client, context: SeedContext): Promise<void> {
  const fixtures = HOME_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const principal = context.membershipId;
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const project = PROJECT_FIXTURES[context.tenant].id;

  // The work items: asked of the principal by another member.
  for (const item of Object.values(fixtures.items)) {
    await client.query(INSERT_ITEM, [tenantId, item.id, project, item.triggerCode, item.question, principal, item.dueInDays, maker]);
  }
  // The overdue one has been put off by the other member (so it is still on the list of the principal), and the `resume` one has a pause that holds (allowed by the other member, as the policy asks).
  await client.query(INSERT_SNOOZE, [tenantId, fixtures.snooze.id, fixtures.items.snoozed.id, maker, fixtures.snooze.note]);
  await client.query(INSERT_PAUSE, [tenantId, fixtures.pause.id, fixtures.items.resume.id, principal, maker, fixtures.pause.note]);

  // The policies of the clocks: the defaults of the platform and one reason code more, written by one member and approved by another.
  const clock = { ...clockPolicyDefaults(), pause_reasons: [...PAUSE_REASONS, fixtures.policies.pauseReason] };
  const snooze = { ...snoozePolicyDefaults(), reasons: [...SNOOZE_REASONS, fixtures.policies.snoozeReason] };
  await client.query(INSERT_RULE, [tenantId, fixtures.policies.clockRuleId, 'CLOCK_POLICY', 'DEFAULT', JSON.stringify(clock), 'Isolation clock policy of the tenant', maker, principal]);
  await client.query(INSERT_RULE, [tenantId, fixtures.policies.snoozeRuleId, 'SNOOZE_POLICY', 'DEFAULT', JSON.stringify(snooze), 'Isolation snooze policy of the tenant', maker, principal]);

  // The definition of an indicator that only the tenant has.
  const kpi = fixtures.kpi;
  const definition = {
    name: kpi.name,
    formula: kpi.formula,
    numerator: kpi.numerator,
    denominator: kpi.denominator,
    exclusions: [],
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    source: kpi.source,
    owner: kpi.owner,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 0,
    rag_code: null,
  };
  await client.query(INSERT_RULE, [tenantId, kpi.ruleId, 'KPI_DEFINITION', kpi.code, JSON.stringify(definition), 'Isolation indicator of the tenant', maker, principal]);

  // The colour of the first unit: the one the frozen snapshot has a line for. An override of another member holds, and the week before has a score.
  await client.query(INSERT_OVERRIDE, [tenantId, fixtures.override.id, context.home, fixtures.override.reason, maker]);
  await client.query(INSERT_SCORE, [tenantId, fixtures.score.id, context.home, PERIOD_SNAPSHOT_FIXTURES[context.tenant].id, fixtures.score.value, principal]);
}
