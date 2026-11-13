import { pwfKpi } from '@machvon/kernel';
import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { PWF_CHECKLIST_CODE, PWF_FIXTURES, PWF_TASK_CODE } from './pwf.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = PWF_FIXTURES[FOREIGN];
const FOREIGN_PROJECT = PROJECT_FIXTURES[FOREIGN].id;

/**
 * The foreign-id cases of the workflow of a project and of the scores of staff (PWF-1 to PWF-3): a TNT-A user names the project, task, exception, proposal, period, line, adjustment or response of TNT-B. Each is judged in the
 * scope of the caller, so another tenant meets the 404 of an object that does not exist (a refusal for want of a right would tell that it does). The bodies are valid, so that the request reaches the lookup; the person named
 * in the assignment is the one of TNT-B, so that its owner finds everything the case names.
 */
export const PWF_SPECS: readonly ForeignAttemptSpec[] = [
  // The workflow of a project and its schedule: named by the project.
  { operation: 'startProjectWorkflow', method: 'POST', id: FOREIGN_PROJECT, body: { template_code: 'PUBLIC_PROCUREMENT', planned_start_date: '2026-11-02' } },
  { operation: 'getProjectWorkflow', method: 'GET', id: FOREIGN_PROJECT },
  { operation: 'adoptProjectWorkflow', method: 'POST', id: FOREIGN_PROJECT, body: { template_code: 'PUBLIC_PROCUREMENT', planned_start_date: '2026-09-01', effective_date: '2026-10-15', dry_run: true } },
  { operation: 'listProjectTasks', method: 'GET', id: FOREIGN_PROJECT },
  { operation: 'getProjectSchedule', method: 'GET', id: FOREIGN_PROJECT },
  { operation: 'evaluateProjectGate', method: 'GET', id: FOREIGN_PROJECT, pathParams: { target: 'startProjectImplementation' } },
  { operation: 'proposeProjectReschedule', method: 'POST', id: FOREIGN_PROJECT, versioned: true, body: { reason: 'Isolation foreign attempt to move the start of the project' } },
  // One task and its ledger.
  { operation: 'getProjectTask', method: 'GET', id: FOREIGN_FIXTURE.taskId },
  { operation: 'startProjectTask', method: 'POST', id: FOREIGN_FIXTURE.taskId, versioned: true, body: {} },
  { operation: 'attachProjectTaskEvidence', method: 'POST', id: FOREIGN_FIXTURE.taskId, body: { evidence_kind: 'DOCUMENT', external_ref: 'isolation-foreign-evidence' } },
  { operation: 'completeProjectTaskChecklistItem', method: 'POST', id: FOREIGN_FIXTURE.taskId, pathParams: { item_code: PWF_CHECKLIST_CODE }, versioned: true, body: {} },
  { operation: 'completeProjectTask', method: 'POST', id: FOREIGN_FIXTURE.taskId, versioned: true, body: {} },
  { operation: 'approveProjectTaskCompletion', method: 'POST', id: FOREIGN_FIXTURE.taskId, versioned: true, body: { decision: 'APPROVE' } },
  { operation: 'returnProjectTask', method: 'POST', id: FOREIGN_FIXTURE.taskId, versioned: true, body: { reason: 'Isolation foreign attempt to send the task back' } },
  { operation: 'requestProjectTaskException', method: 'POST', id: FOREIGN_FIXTURE.taskId, body: { kind: 'PAUSE', reason: 'Isolation foreign attempt to pause the task' } },
  { operation: 'resumeProjectTask', method: 'POST', id: FOREIGN_FIXTURE.taskId, versioned: true, body: {} },
  {
    operation: 'assignProjectTask',
    method: 'POST',
    id: FOREIGN_FIXTURE.taskId,
    body: { membership_id: MEMBERSHIP_FIXTURES[FOREIGN].id, role: 'RESPONSIBLE', valid_from: '2026-01-01', share_pct: 100, reason: 'Isolation foreign attempt to assign the task' },
  },
  { operation: 'listProjectTaskAssignments', method: 'GET', id: FOREIGN_FIXTURE.taskId },
  { operation: 'listTaskKpiResults', method: 'GET', id: FOREIGN_FIXTURE.taskId },
  // The decisions on an exception and on a proposal to move the schedule are addressed to the exception and to the proposal.
  { operation: 'decideProjectTaskException', method: 'POST', id: FOREIGN_FIXTURE.exceptionId, versioned: true, body: { decision: 'APPROVE' } },
  { operation: 'getProjectReschedule', method: 'GET', id: FOREIGN_FIXTURE.proposalId },
  { operation: 'decideProjectReschedule', method: 'POST', id: FOREIGN_FIXTURE.proposalId, versioned: true, body: { decision: 'APPROVE' } },
  // The scores of staff: a period, a line of it, an adjustment and a response. Each read and each command is judged in the units of the caller.
  { operation: 'getStaffScorePeriod', method: 'GET', id: FOREIGN_FIXTURE.periodId },
  { operation: 'listStaffScoreLines', method: 'GET', id: FOREIGN_FIXTURE.periodId },
  { operation: 'listStaffScoreSignals', method: 'GET', id: FOREIGN_FIXTURE.periodId },
  { operation: 'getStaffScoreOverview', method: 'GET', id: FOREIGN_FIXTURE.periodId },
  { operation: 'exportStaffScorePeriod', method: 'GET', id: FOREIGN_FIXTURE.periodId, query: 'format=csv' },
  { operation: 'getStaffScoreLine', method: 'GET', id: FOREIGN_FIXTURE.lineId },
  { operation: 'requestStaffScoreAdjustment', method: 'POST', id: FOREIGN_FIXTURE.lineId, body: { points: 3, reason: 'Isolation foreign attempt to add points to a line' } },
  { operation: 'submitStaffScoreResponse', method: 'POST', id: FOREIGN_FIXTURE.ownLineId, body: { body: 'Isolation foreign answer to a score of another tenant.' } },
  { operation: 'decideStaffScoreAdjustment', method: 'POST', id: FOREIGN_FIXTURE.adjustmentId, versioned: true, body: { decision: 'APPROVE' } },
  { operation: 'handleStaffScoreResponse', method: 'POST', id: FOREIGN_FIXTURE.responseId, versioned: true, body: { outcome: 'KEEP', conclusion: 'Isolation foreign handling of a response.' } },
  // The two that move a period come last: the owner who locks a draft computes its lines again, and one who makes a period official ends the answers to it, so the cases above must have been run first.
  { operation: 'lockStaffScorePeriod', method: 'POST', id: FOREIGN_FIXTURE.lockPeriodId, versioned: true, body: {} },
  { operation: 'officializeStaffScorePeriod', method: 'POST', id: FOREIGN_FIXTURE.lockedPeriodId, versioned: true, body: {} },
];

/** Every operation of the controllers of PWF: the test role of the suite holds the permission of each, so that the reads and the control run reach their handlers instead of a refusal for lack of a right. */
export const PWF_OPERATIONS: readonly string[] = [
  'validateProjectWorkflowTemplate',
  'previewProjectWorkflowTemplate',
  'startProjectWorkflow',
  'getProjectWorkflow',
  'adoptProjectWorkflow',
  'listProjectTasks',
  'getProjectSchedule',
  'evaluateProjectGate',
  'getProjectTask',
  'startProjectTask',
  'attachProjectTaskEvidence',
  'completeProjectTaskChecklistItem',
  'completeProjectTask',
  'approveProjectTaskCompletion',
  'returnProjectTask',
  'requestProjectTaskException',
  'decideProjectTaskException',
  'resumeProjectTask',
  'assignProjectTask',
  'listProjectTaskAssignments',
  'proposeProjectReschedule',
  'getProjectReschedule',
  'decideProjectReschedule',
  'getDeadlineBoard',
  'getDeadlineCalendar',
  'getUpcomingMilestones',
  'getProjectWorkload',
  'getMyTasks',
  'getDeadlinePreference',
  'setDeadlinePreference',
  'previewDeadlineBand',
  'getKpiOperations',
  'listTaskKpiResults',
  'computeStaffScorePeriod',
  'listStaffScorePeriods',
  'lockStaffScorePeriod',
  'getStaffScorePeriod',
  'listStaffScoreLines',
  'getMyStaffScore',
  'getStaffScoreLine',
  'compareStaffScoreLines',
  'exportStaffScorePeriod',
  'listStaffScoreSignals',
  'getStaffScoreOverview',
  'requestStaffScoreAdjustment',
  'decideStaffScoreAdjustment',
  'submitStaffScoreResponse',
  'handleStaffScoreResponse',
  'officializeStaffScorePeriod',
];

/** The tables the seed fills that the snapshot reads, and that no read of these operations changes. */
export const PWF_SNAPSHOT_TABLES: readonly string[] = [
  'project_workflow',
  'project_task',
  'project_task_exception',
  'project_reschedule_proposal',
  'staff_score_period',
  'staff_score_line',
  'staff_score_adjustment',
  'staff_score_response',
  'staff_score_signal',
];

/** A template of one phase and one task, as the rule keeps its params; no gate, so the legal commands of the project stay open. */
const TEMPLATE = {
  name: 'Isolation workflow',
  phases: [{ code: 'P1', name: 'First phase', gates: [] }],
  tasks: [
    {
      code: PWF_TASK_CODE,
      name: 'Isolation task',
      phase: 'P1',
      kind: 'TASK',
      duration_working_days: 5,
      required: true,
      responsible_role: 'ROLE_A',
      priority: 'NORMAL',
      predecessors: [],
      legal_doc_types: [],
      form_templates: [],
      checklist: [{ code: PWF_CHECKLIST_CODE, name: 'Dossier checked', required: true, evidence_kinds: [] }],
      kpi_codes: [],
      when: [],
    },
  ],
};

/** The schedule of a proposal that moves nothing: the days of the tasks are not what the isolation cases are about. */
const PREVIEW = {
  schedule: { projectStart: null, projectFinish: null, criticalPath: [], longestPath: [], calendarVersions: [], tasks: [], findings: [], hash: 'f'.repeat(64) },
  changes: [],
  projectFinishShiftDays: null,
  excluded: [],
  names: {},
  phases: {},
};

const INSERT_WORKFLOW = `insert into machvon.project_workflow
  (tenant_id, id, project_id, template_code, template_rule_version, template_hash, template, facts, planned_start_date, status, created_by, updated_by)
  values ($1, $2, $3, 'ISOLATION_FLOW', 0, repeat('c', 64), $4::jsonb, '{}'::jsonb, date '2026-11-02', 'ACTIVE', $5, $5) on conflict do nothing`;

const INSERT_TASK = `insert into machvon.project_task
  (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, status, tracked,
   planned_start, planned_finish, baseline_start, baseline_finish, actual_start, created_by, updated_by)
  values ($1, $2, $3, $4, $5, $6, 'P1', 1, 'TASK', true, 'ROLE_A', 'NORMAL', 5, 'IN_PROGRESS', true,
   date '2026-11-02', date '2026-11-06', date '2026-11-02', date '2026-11-06', date '2026-11-02', $7, $7) on conflict do nothing`;

const INSERT_CHECKLIST_ITEM = `insert into machvon.project_task_checklist_item (tenant_id, task_id, item_code, name, required, evidence_kinds, done)
  values ($1, $2, $3, 'Dossier checked', true, '{}', false) on conflict do nothing`;

/** The task is held by the member the suite acts as, so that the lists of "my tasks" and of the deadlines have a row; a seed that runs again does not hold it twice. */
const INSERT_ASSIGNMENT = `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, valid_to, share_pct, reason, assigned_by)
  select $1::uuid, $2::uuid, $3::uuid, 'RESPONSIBLE', date '2026-11-02', null, 100, 'Held for the isolation fixture', $3::uuid
   where not exists (select 1 from machvon.project_task_assignment where task_id = $2::uuid)`;

const INSERT_EXCEPTION = `insert into machvon.project_task_exception (tenant_id, id, task_id, kind, items, valid_from, valid_to, reason, status, requested_by)
  values ($1, $2, $3, 'WAIVE_REQUIREMENT', $4::jsonb, date '2026-11-02', null, $5, 'REQUESTED', $6) on conflict do nothing`;

const INSERT_PROPOSAL = `insert into machvon.project_reschedule_proposal
  (tenant_id, id, workflow_id, status, base_version, base_schedule_version, input, preview, input_hash, result_hash, reason, proposed_by)
  values ($1, $2, $3, 'PROPOSED', 1, 1, '{}'::jsonb, $4::jsonb, repeat('d', 64), repeat('e', 64), $5, $6) on conflict do nothing`;

const INSERT_PERIOD_OF = `insert into machvon.staff_score_period
  (tenant_id, id, scope_unit_id, period_kind, period_from, period_to, status, policy_code, policy_version, preview_hash, computed_by, summary, created_by, updated_by)
  values ($1, $2, $3, 'QUARTER', $6::date, $7::date, 'DRAFT', 'DEFAULT', 0, repeat('a', 64), $4, $5::jsonb, $4, $4) on conflict do nothing`;

const INSERT_LOCKED_PERIOD = `insert into machvon.staff_score_period
  (tenant_id, id, scope_unit_id, period_kind, period_from, period_to, status, policy_code, policy_version, preview_hash, snapshot, snapshot_hash, computed_by, summary, locked_by, locked_at, response_until, created_by, updated_by)
  values ($1, $2, $3, 'QUARTER', date '2026-04-01', date '2026-06-30', 'LOCKED', 'DEFAULT', 0, repeat('a', 64), $6::jsonb, repeat('b', 64), $4, $5::jsonb, $4, now(), date '2026-12-31', $4, $4) on conflict do nothing`;

const INSERT_LINE = `insert into machvon.staff_score_line
  (tenant_id, id, period_id, membership_id, unit_id_at_period, score_computed, score_adjusted, rating, state, rated_task_count, effective_weight)
  values ($1, $2, $3, $4, $5, 80, 80, 'GOOD', 'RATED', 1, 1) on conflict do nothing`;

const INSERT_SIGNAL = `insert into machvon.staff_score_signal (tenant_id, id, period_id, membership_id, unit_id_at_period, code, task_codes)
  values ($1, $2, $3, $4, $5, 'CANCELLED_SHARE_HIGH', $6::jsonb) on conflict do nothing`;

const INSERT_ADJUSTMENT = `insert into machvon.staff_score_adjustment (tenant_id, id, line_id, subject_membership_id, unit_id_at_period, points, reason, status, requested_by)
  values ($1, $2, $3, $4, $5, 3, $6, 'REQUESTED', $7) on conflict do nothing`;

const INSERT_RESPONSE = `insert into machvon.staff_score_response (tenant_id, id, line_id, subject_membership_id, unit_id_at_period, body, status)
  values ($1, $2, $3, $4, $5, $6, 'OPEN') on conflict do nothing`;

/**
 * The workflow of the CONCEPT project of the tenant with one task that is being worked on, held by the member the suite acts as; an exception and a proposal to move the schedule that the other member asked for (so the
 * suite principal is a second person and may decide them); a draft period of the quarter with the line of the other member and a signal, a draft period to lock, and a locked period with the line of the other member (an adjustment and a response) and the line of the member the suite acts as (the one who may answer it).
 */
export async function seedPwf(client: Client, context: SeedContext): Promise<void> {
  const fixture = PWF_FIXTURES[context.tenant];
  const other = MEMBERSHIP_FIXTURES[context.tenant].id;
  const project = PROJECT_FIXTURES[context.tenant].id;
  const { tenantId, membershipId, home } = context;
  await client.query(INSERT_WORKFLOW, [tenantId, fixture.workflowId, project, JSON.stringify(TEMPLATE), membershipId]);
  await client.query(INSERT_TASK, [tenantId, fixture.taskId, fixture.workflowId, project, PWF_TASK_CODE, fixture.taskName, membershipId]);
  await client.query(INSERT_CHECKLIST_ITEM, [tenantId, fixture.taskId, PWF_CHECKLIST_CODE]);
  await client.query(INSERT_ASSIGNMENT, [tenantId, fixture.taskId, membershipId]);
  await client.query(INSERT_EXCEPTION, [tenantId, fixture.exceptionId, fixture.taskId, JSON.stringify([PWF_CHECKLIST_CODE]), fixture.exceptionReason, other]);
  await client.query(INSERT_PROPOSAL, [tenantId, fixture.proposalId, fixture.workflowId, JSON.stringify(PREVIEW), fixture.proposalReason, other]);
  const summary = { rated: 1, small_sample: 0, not_rated: 0, people: 1, mean_score: 80, excluded_tasks: 0, signals: 1 };
  await client.query(INSERT_PERIOD_OF, [tenantId, fixture.periodId, home, membershipId, JSON.stringify(summary), '2026-01-01', '2026-03-31']);
  await client.query(INSERT_LINE, [tenantId, fixture.lineId, fixture.periodId, other, home]);
  const lockPeriodSummary = { rated: 0, small_sample: 0, not_rated: 0, people: 0, mean_score: null, excluded_tasks: 0, signals: 0 };
  await client.query(INSERT_PERIOD_OF, [tenantId, fixture.lockPeriodId, home, membershipId, JSON.stringify(lockPeriodSummary), '2026-07-01', '2026-09-30']);
  await client.query(INSERT_LOCKED_PERIOD, [tenantId, fixture.lockedPeriodId, home, membershipId, JSON.stringify(summary), JSON.stringify({ policy: { code: 'DEFAULT', params: pwfKpi.DEFAULT_STAFF_SCORING_PARAMS } })]);
  await client.query(INSERT_LINE, [tenantId, fixture.lockedLineId, fixture.lockedPeriodId, other, home]);
  await client.query(INSERT_LINE, [tenantId, fixture.ownLineId, fixture.lockedPeriodId, membershipId, home]);
  await client.query(INSERT_SIGNAL, [tenantId, fixture.signalId, fixture.periodId, other, home, JSON.stringify([PWF_TASK_CODE])]);
  await client.query(INSERT_ADJUSTMENT, [tenantId, fixture.adjustmentId, fixture.lockedLineId, other, home, fixture.adjustmentReason, membershipId]);
  await client.query(INSERT_RESPONSE, [tenantId, fixture.responseId, fixture.lockedLineId, other, home, fixture.responseBody]);
}
