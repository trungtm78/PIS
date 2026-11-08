import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { CONTRACT_FIXTURES, MEMBERSHIP_FIXTURES, PROJECT_FIXTURES, REALLOCATION_FIXTURES } from '../../suite';
import { GOV11A_FIXTURES } from './gov11a.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = GOV11A_FIXTURES[FOREIGN];
const PROJECT = PROJECT_FIXTURES[FOREIGN].id;
const CONTRACT = CONTRACT_FIXTURES[FOREIGN].id;

/**
 * The foreign-id cases of the operations of GOV-11a that name a row: the reallocation proposal of the impact, the contract of the linkage and the adjustment versions, the adjustment version that is
 * reviewed, the project of the look-ahead and of the lessons, and each row of the look-ahead and of the lessons that a command changes. A TNT-A user names an object of TNT-B; the bodies are valid, so the
 * request reaches the lookup.
 */
export const GOV11A_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getReallocationImpact', method: 'GET', id: REALLOCATION_FIXTURES[FOREIGN].id },
  { operation: 'getContractLinkage', method: 'GET', id: CONTRACT },
  { operation: 'listContractAdjustments', method: 'GET', id: CONTRACT },
  { operation: 'reviewContractAdjustment', method: 'POST', id: FOREIGN_FIXTURE.adjustment.id, versioned: true, body: { decision: 'KEEP_BASELINE', note: 'Isolation foreign review attempt of the baseline' } },
  { operation: 'getLookAhead', method: 'GET', id: PROJECT },
  { operation: 'listLessons', method: 'GET', id: PROJECT },
  {
    operation: 'createLookAheadPlan',
    method: 'POST',
    id: PROJECT,
    body: { week_start: '2026-03-02', horizon_weeks: 3, items: [{ description: 'Isolation foreign look-ahead item', planned_start: '2026-03-03', planned_finish: '2026-03-04' }] },
  },
  { operation: 'publishLookAheadPlan', method: 'POST', id: FOREIGN_FIXTURE.draftPlan.id, versioned: true, body: {} },
  { operation: 'raiseLookAheadConstraint', method: 'POST', id: FOREIGN_FIXTURE.raiseItem.id, body: { kind: 'MATERIAL', description: 'Isolation foreign constraint attempt' } },
  { operation: 'clearLookAheadConstraint', method: 'POST', id: FOREIGN_FIXTURE.constraint.id, versioned: true, body: {} },
  { operation: 'recordLookAheadOutcome', method: 'POST', id: FOREIGN_FIXTURE.outcomeItem.id, versioned: true, body: { outcome: 'DONE' } },
  {
    operation: 'proposeLesson',
    method: 'POST',
    id: PROJECT,
    body: { category: 'PLANNING', title: 'Isolation foreign lesson', situation: 'Isolation foreign situation of the lesson.', recommendation: 'Isolation foreign recommendation of the lesson.' },
  },
  { operation: 'decideLesson', method: 'POST', id: FOREIGN_FIXTURE.lesson.id, versioned: true, body: { decision: 'APPROVE' } },
  { operation: 'requestLessonWaiver', method: 'POST', id: PROJECT, body: { reason: 'Isolation foreign waiver attempt of the lessons learned.' } },
  { operation: 'decideLessonWaiver', method: 'POST', id: FOREIGN_FIXTURE.waiver.id, versioned: true, body: { decision: 'APPROVE' } },
];

/** Every operation of GOV-11a: the test role of the suite holds the permission of each. */
export const GOV11A_OPERATIONS: readonly string[] = [
  'getReallocationImpact',
  'listReallocationCandidates',
  'getDisbursementMilestones',
  'getDisbursementForecastAccuracy',
  'listPaymentClocks',
  'listPaymentReturnReasons',
  'listContractSettlementClocks',
  'getContractLinkage',
  'listContractAdjustments',
  'reviewContractAdjustment',
  'createLookAheadPlan',
  'publishLookAheadPlan',
  'raiseLookAheadConstraint',
  'clearLookAheadConstraint',
  'recordLookAheadOutcome',
  'getLookAhead',
  'proposeLesson',
  'decideLesson',
  'requestLessonWaiver',
  'decideLessonWaiver',
  'listLessons',
];

/** The tables the seed fills that the snapshot reads, so a foreign command that changed one of them is seen. */
export const GOV11A_SNAPSHOT_TABLES: readonly string[] = ['look_ahead_plan', 'look_ahead_item', 'look_ahead_constraint', 'lesson_learned', 'lesson_waiver', 'contract_adjustment'];

const INSERT_PLAN = `insert into machvon.look_ahead_plan (tenant_id, id, project_id, owner_unit_id, week_start, horizon_weeks, status, policy_version, published_by, published_at, created_by, updated_by)
  select $1::uuid, $2::uuid, p.id, p.owner_unit_id, $3::date, 3, $4::text, 0, case when $4::text = 'PUBLISHED' then $5::uuid end, case when $4::text = 'PUBLISHED' then now() end, $5::uuid, $5::uuid
    from machvon.project p where p.id = $6::uuid
     and not exists (select 1 from machvon.look_ahead_plan where id = $2::uuid)`;

const INSERT_ITEM = `insert into machvon.look_ahead_item (tenant_id, id, plan_id, project_id, sequence, description, planned_start, planned_finish, responsible, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::text, $7::date, $7::date + 2, 'Crew', $8::uuid, $8::uuid
   where not exists (select 1 from machvon.look_ahead_item where id = $2::uuid)`;

const INSERT_CONSTRAINT = `insert into machvon.look_ahead_constraint (tenant_id, id, item_id, plan_id, project_id, kind, description, raised_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'MATERIAL', $6::text, $7::uuid
   where not exists (select 1 from machvon.look_ahead_constraint where id = $2::uuid)`;

const INSERT_LESSON = `insert into machvon.lesson_learned (tenant_id, id, project_id, owner_unit_id, category, title, situation, recommendation, proposed_by)
  select $1::uuid, $2::uuid, p.id, p.owner_unit_id, 'PLANNING', $3::text, 'The access road was not ready when the crews arrived.', 'Clear the site access before the contract starts.', $4::uuid
    from machvon.project p where p.id = $5::uuid
     and not exists (select 1 from machvon.lesson_learned where id = $2::uuid)`;

const INSERT_WAIVER = `insert into machvon.lesson_waiver (tenant_id, id, project_id, owner_unit_id, gate, reason, requested_by)
  select $1::uuid, $2::uuid, p.id, p.owner_unit_id, 'CLOSE', $3::text, $4::uuid
    from machvon.project p where p.id = $5::uuid
     and not exists (select 1 from machvon.lesson_waiver where project_id = p.id and gate = 'CLOSE' and status in ('REQUESTED', 'APPROVED'))
     and not exists (select 1 from machvon.lesson_waiver where id = $2::uuid)`;

/** The adjustment version that waits for a review: made by the other member, so that the suite principal may review it. It names the revision of the contract of the fixtures. */
const INSERT_ADJUSTMENT = `insert into machvon.contract_adjustment
  (tenant_id, id, contract_id, project_id, owner_unit_id, revision_id, revision, original_vnd, previous_vnd, new_vnd, delta_vnd, delta_pct_of_previous, cumulative_delta_vnd, cumulative_pct_of_original,
   classification, reasons, policy_version, made_by, review_status, review_note)
  select $1::uuid, $2::uuid, c.id, c.project_id, p.owner_unit_id, $5::uuid, 2, 1000000, 1000000, 1200000, 200000, 20.00, 200000, 20.00,
         'REVIEW_REQUIRED', array['ORIGINAL'], 0, $3::uuid, 'PENDING', null
    from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
   where c.id = $4::uuid
     and not exists (select 1 from machvon.contract_adjustment where id = $2::uuid or revision_id = $5::uuid)`;

/**
 * Seeds, for the tenant of the context, a draft plan and a published plan of the look-ahead of its project with the items and the open constraint that each command starts from, a lesson and a waiver that
 * wait for a decision of another person, and an adjustment version of its contract that waits for a review. The maker of each is the other member, so the suite principal may decide.
 */
export async function seedGov11a(client: Client, context: SeedContext): Promise<void> {
  const fixture = GOV11A_FIXTURES[context.tenant];
  const project = PROJECT_FIXTURES[context.tenant].id;
  const contract = CONTRACT_FIXTURES[context.tenant].id;
  const member = MEMBERSHIP_FIXTURES[context.tenant].id;
  const tenant = context.tenantId;
  await client.query(INSERT_PLAN, [tenant, fixture.draftPlan.id, fixture.draftPlan.weekStart, 'DRAFT', member, project]);
  await client.query(INSERT_PLAN, [tenant, fixture.livePlan.id, fixture.livePlan.weekStart, 'PUBLISHED', member, project]);
  await client.query(INSERT_ITEM, [tenant, fixture.draftItem.id, fixture.draftPlan.id, project, 1, fixture.draftItem.description, fixture.draftPlan.weekStart, member]);
  await client.query(INSERT_ITEM, [tenant, fixture.raiseItem.id, fixture.livePlan.id, project, 1, fixture.raiseItem.description, fixture.livePlan.weekStart, member]);
  await client.query(INSERT_ITEM, [tenant, fixture.outcomeItem.id, fixture.livePlan.id, project, 2, fixture.outcomeItem.description, fixture.livePlan.weekStart, member]);
  await client.query(INSERT_CONSTRAINT, [tenant, fixture.constraint.id, fixture.raiseItem.id, fixture.livePlan.id, project, fixture.constraint.description, member]);
  await client.query(INSERT_LESSON, [tenant, fixture.lesson.id, fixture.lesson.title, member, project]);
  await client.query(INSERT_WAIVER, [tenant, fixture.waiver.id, fixture.waiver.reason, member, project]);
  await client.query(INSERT_ADJUSTMENT, [tenant, fixture.adjustment.id, member, contract, CONTRACT_FIXTURES[context.tenant].revisionId]);
}
