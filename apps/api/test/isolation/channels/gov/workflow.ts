import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { WORKFLOW_FIXTURES, WORKFLOW_ITEM_RULES, WORKFLOW_ROLES } from './workflow.fixtures';
import type { WorkflowFixture, WorkflowFixtures, WorkflowItemCode } from './workflow.fixtures';
import type { SeedContext } from './support';

const FOREIGN = WORKFLOW_FIXTURES['TNT-B'];
const FOREIGN_MEMBER = MEMBERSHIP_FIXTURES['TNT-B'].id;

function foreignItem(role: 'complete' | 'assign', code: WorkflowItemCode): string {
  const item = FOREIGN.workflows[role].items.find((one) => one.code === code);
  if (item === undefined) throw new Error(`The isolation fixtures hold no item ${code} for the ${role} workflow of TNT-B`);
  return item.id;
}

function foreignException(): string {
  const exception = FOREIGN.workflows.decide.exception;
  if (exception === null) throw new Error('The isolation fixtures hold no exception for the decide workflow of TNT-B');
  return exception.id;
}

/**
 * The foreign-id cases of the workflow of a procurement package (PRC-1): a TNT-A user names a package, a workflow, a checklist item or a step exception of TNT-B. Each command has a workflow of its own (see `WorkflowRole`),
 * in the state it starts from, so that what the owner does in the control run never takes the object of another case away; the start is aimed at a draft package, which the owner is refused (409) without anything written.
 * The bodies are valid, so that the request reaches the lookup; the versioned commands are seeded at version 1, the one the suite sends in `If-Match`.
 */
export const WORKFLOW_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getPackageWorkflow', method: 'GET', id: FOREIGN.workflows.read.packageId },
  { operation: 'getPackageWorkflowTimeline', method: 'GET', id: FOREIGN.workflows.read.packageId },
  { operation: 'startPackageWorkflow', method: 'POST', id: FOREIGN.start.packageId, body: { owner_id: FOREIGN_MEMBER } },
  {
    operation: 'completePackageChecklistItem',
    method: 'POST',
    id: foreignItem('complete', 'PLAN_NOTE'),
    body: { evidence: [{ kind: 'ATTESTATION', note: 'Isolation foreign attestation attempt' }], note: 'Isolation foreign completion attempt' },
  },
  { operation: 'assignPackageChecklistItem', method: 'POST', id: foreignItem('assign', 'PLAN_EXTRA'), body: { owner_id: FOREIGN_MEMBER } },
  { operation: 'advancePackageStep', method: 'POST', id: FOREIGN.workflows.advance.workflowId, versioned: true, body: { note: 'Isolation foreign advance attempt' } },
  { operation: 'returnPackageStep', method: 'POST', id: FOREIGN.workflows.return.workflowId, versioned: true, body: { to_step: 'DOC_PREPARE', reason: 'Isolation foreign return attempt' } },
  { operation: 'holdPackageWorkflow', method: 'POST', id: FOREIGN.workflows.hold.workflowId, versioned: true, body: { reason: 'Isolation foreign hold attempt' } },
  { operation: 'resumePackageWorkflow', method: 'POST', id: FOREIGN.workflows.resume.workflowId, versioned: true, body: { note: 'Isolation foreign resume attempt' } },
  { operation: 'assignPackageWorkflowOwner', method: 'POST', id: FOREIGN.workflows.owner.workflowId, versioned: true, body: { owner_id: FOREIGN_MEMBER } },
  { operation: 'requestPackageStepException', method: 'POST', id: FOREIGN.workflows.request.workflowId, body: { kind: 'CORRECT_BACK', reason: 'Isolation foreign exception attempt' } },
  { operation: 'decidePackageStepException', method: 'POST', id: foreignException(), body: { decision: 'APPROVE', note: 'Isolation foreign decision attempt' } },
  { operation: 'cancelPackageWorkflow', method: 'POST', id: FOREIGN.workflows.cancel.workflowId, versioned: true, body: { reason: 'Isolation foreign cancellation attempt' } },
];

/** Every operation of the workflow controllers on the tenant plane: the suite principal holds the permission of each. */
export const WORKFLOW_OPERATIONS: readonly string[] = [
  'startPackageWorkflow',
  'completePackageChecklistItem',
  'assignPackageChecklistItem',
  'advancePackageStep',
  'returnPackageStep',
  'holdPackageWorkflow',
  'resumePackageWorkflow',
  'assignPackageWorkflowOwner',
  'requestPackageStepException',
  'decidePackageStepException',
  'cancelPackageWorkflow',
  'getPackageWorkflow',
  'getPackageWorkflowTimeline',
  'listPackageWorkflows',
  'getPackageWorkflowBoard',
  'getPackageProcessTree',
  'getPackageProcessTreeNode',
  'listPackageProcessTreeNodePackages',
  'getPackageProcessTreeNodeFeed',
  'getPackageWorkflowStatistics',
  'exportPackageWorkflowReport',
  'getPackageWorkflowSummary',
];

/** The tables the workflow seed fills, all with an `id`; nothing in them changes when a row is only read or found (the lookups lock rows but write none). */
export const WORKFLOW_SNAPSHOT_TABLES: readonly string[] = [
  'procurement_package',
  'package_workflow',
  'package_step',
  'package_checklist_item',
  'package_checklist_evidence',
  'package_step_exception',
  'package_workflow_log',
];

// The packages carry no plan (the total of a plan is the sum of its packages, so a package beside the seeded one would break it): a package without a plan is only the code, the money, the method and the status.
const INSERT_PACKAGE = `insert into machvon.procurement_package
  (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by)
  values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, $5, $6, $7) on conflict do nothing`;

const INSERT_WORKFLOW = `insert into machvon.package_workflow
  (tenant_id, id, package_id, method, definition_code, definition_rule_version, definition_hash, definition, status, current_step_code, current_visit, owner_membership_id,
   hold_reason, held_at, held_by, started_at, started_by, last_activity_at, last_activity_on, row_version)
  values ($1, $2, $3, 'OPEN_BIDDING', 'OPEN_BIDDING', 0, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13::timestamptz, $14, $15::timestamptz, $16::date, 1) on conflict do nothing`;

const INSERT_STEP = `insert into machvon.package_step
  (tenant_id, id, workflow_id, package_id, visit, step_code, entered_at, entered_on, entered_by, entry_kind, standard_working_days, due_on, due_basis,
   exited_at, exited_on, exited_by, exit_kind, working_days_spent, calendar_days_spent)
  values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::date, $9, $10, 5, $11::date, 'WORKING_DAYS', $12::timestamptz, $13::date, $14, $15, $16, $17) on conflict do nothing`;

const INSERT_ITEM = `insert into machvon.package_checklist_item
  (tenant_id, id, workflow_id, step_visit_id, package_id, step_code, item_code, name, required, owner_role, due_on, evidence_kinds, evidence_required,
   status, completed_via, completed_by, completed_at, completion_note, row_version)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PROCUREMENT_OFFICER', $10::date, $11::text[], $12, $13, $14, $15, $16::timestamptz, $17, 1) on conflict do nothing`;

const INSERT_EVIDENCE = `insert into machvon.package_checklist_evidence
  (tenant_id, id, item_id, workflow_id, evidence_kind, note, attached_by, attached_at)
  values ($1, $2, $3, $4, 'ATTESTATION', $5, $6, $7::timestamptz) on conflict do nothing`;

const INSERT_EXCEPTION = `insert into machvon.package_step_exception
  (tenant_id, id, workflow_id, step_visit_id, package_id, kind, item_codes, reason, requested_by, requested_at)
  values ($1, $2, $3, $4, $5, 'SKIP_ITEMS', array['PLAN_NOTE']::text[], $6, $7, $8::timestamptz) on conflict do nothing`;

const INSERT_LOG = `insert into machvon.package_workflow_log
  (tenant_id, id, workflow_id, package_id, kind, at, actor, step_code, reason, subject)
  values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10) on conflict do nothing`;

/** The running of the clock on the working days of a visit: the visits that were left took the week the fixtures give them, five working days. */
const SPENT = { workingDays: 5, calendarDays: 7 } as const;

async function seedOne(client: Client, context: SeedContext, workflow: WorkflowFixture, names: WorkflowFixtures['names'], definition: Record<string, unknown>, hash: string, maker: string): Promise<void> {
  const tenantId = context.tenantId;
  const project = PROJECT_FIXTURES[context.tenant].id;
  await client.query(INSERT_PACKAGE, [tenantId, workflow.packageId, project, workflow.packageCode, 'APPROVED', workflow.packageTitle, context.actorId]);
  const first = workflow.visits[0];
  if (first === undefined) throw new Error(`The workflow fixture ${workflow.role} has no visit`);
  await client.query(INSERT_WORKFLOW, [
    tenantId,
    workflow.workflowId,
    workflow.packageId,
    hash,
    JSON.stringify(definition),
    workflow.status,
    workflow.currentStep,
    workflow.currentVisit,
    workflow.ownerAssigned ? maker : null,
    workflow.holdReason,
    workflow.heldAt,
    workflow.heldAt === null ? null : maker,
    first.enteredAt,
    maker,
    workflow.lastActivityAt,
    workflow.lastActivityOn,
  ]);

  // The visits: those behind the current one were left for the next step on the day it was entered; the last one is open.
  for (const [position, visit] of workflow.visits.entries()) {
    const next = workflow.visits[position + 1];
    await client.query(INSERT_STEP, [
      tenantId,
      visit.id,
      workflow.workflowId,
      workflow.packageId,
      visit.visit,
      visit.stepCode,
      visit.enteredAt,
      visit.enteredOn,
      maker,
      position === 0 ? 'START' : 'ADVANCE',
      visit.dueOn,
      next?.enteredAt ?? null,
      next?.enteredOn ?? null,
      next === undefined ? null : maker,
      next === undefined ? null : 'ADVANCE',
      next === undefined ? null : SPENT.workingDays,
      next === undefined ? null : SPENT.calendarDays,
    ]);
  }

  // The checklist of the open visit: the items come from the first step of the definition, and the one that is done carries its attestation.
  const open = workflow.visits[workflow.visits.length - 1];
  if (open === undefined) throw new Error(`The workflow fixture ${workflow.role} has no open visit`);
  for (const item of workflow.items) {
    const rule = WORKFLOW_ITEM_RULES[item.code];
    const completion = item.done ? workflow.completion : null;
    if (item.done && completion === null) throw new Error(`The workflow fixture ${workflow.role} has a done item without a completion`);
    await client.query(INSERT_ITEM, [
      tenantId,
      item.id,
      workflow.workflowId,
      open.id,
      workflow.packageId,
      open.stepCode,
      item.code,
      names.items[item.code],
      rule.required,
      open.dueOn,
      [...rule.evidenceKinds],
      rule.evidenceRequired,
      item.done ? 'DONE' : 'OPEN',
      item.done ? 'PERSON' : null,
      item.done ? maker : null,
      item.done ? '2026-02-03T03:00:00Z' : null,
      completion?.note ?? null,
    ]);
    if (completion !== null) await client.query(INSERT_EVIDENCE, [tenantId, completion.evidenceId, item.id, workflow.workflowId, completion.evidenceNote, maker, '2026-02-03T03:00:00Z']);
  }

  // The exception that waits for the decision of someone else than the maker who asked for it.
  if (workflow.exception !== null) {
    await client.query(INSERT_EXCEPTION, [tenantId, workflow.exception.id, workflow.workflowId, open.id, workflow.packageId, workflow.exception.reason, maker, workflow.exception.requestedAt]);
  }

  // What the timeline reads: who was named the holder, the hold, the request of the exception.
  for (const log of workflow.logs) {
    const subject = log.kind === 'ASSIGN_OWNER' ? maker : log.kind === 'EXCEPTION_REQUESTED' ? (workflow.exception?.id ?? null) : null;
    await client.query(INSERT_LOG, [tenantId, log.id, workflow.workflowId, workflow.packageId, log.kind, log.at, maker, workflow.currentStep, log.reason, subject]);
  }
}

/**
 * Seeds, for the tenant of the context, the draft package that has no workflow and a package with a workflow for each role of `WorkflowRole`, in the state the command or the read of the role starts from. The days are fixed and in the
 * past, so that the workflows are live (and late) whatever the day the suite runs on. Everything is written by a member other than the suite principal, so that the owner may decide the exception. The workflows are written as rows (the
 * frozen definition with its hash), not through the store, so that the seed needs no rule of governance and no work calendar.
 */
export async function seedWorkflow(client: Client, context: SeedContext): Promise<void> {
  const fixtures = WORKFLOW_FIXTURES[context.tenant];
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const hash = createHash('sha256').update(JSON.stringify(fixtures.definition)).digest('hex');
  await client.query(INSERT_PACKAGE, [context.tenantId, fixtures.start.packageId, PROJECT_FIXTURES[context.tenant].id, fixtures.start.packageCode, 'DRAFT', fixtures.start.packageTitle, context.actorId]);
  for (const role of WORKFLOW_ROLES) await seedOne(client, context, fixtures.workflows[role], fixtures.names, fixtures.definition, hash, maker);
}
