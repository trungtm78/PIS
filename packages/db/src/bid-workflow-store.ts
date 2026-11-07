import { createHash } from 'node:crypto';
import {
  DomainError,
  assertWorkflowReason,
  assertReturnTarget,
  assertWorkflowExceptionDecider,
  assessAdvance,
  canonicalWorkflowText,
  evidenceKindOf,
  isEvidenceKind,
  isWorkflowMethod,
  parseWorkflowDefinition,
  stepDueOn,
  workflowStepOf,
  vietnamDateOf,
  versionConflict,
  workflowDaysBetween,
  workflowParamsOf,
  workflowWorkingDaysBetween,
  WORKFLOW_RULE_TYPE,
} from '@machvon/kernel';
import type { Blocker, ExceptionKind, ItemState, ItemStatus, ProcurementWorkflowDefinition, VisitState, WorkflowStatus } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { PACKAGE_STATUSES_WITHOUT_MILESTONES } from './bid-milestone-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
export const MAX_EVIDENCE_PER_ITEM = 10;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (reason: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('PACKAGE_WORKFLOW_STATE_INVALID', 409, 'status', { extensions: { reason, ...extensions } });
const exceptionInvalid = (reason: string): DomainError => new DomainError('STEP_EXCEPTION_STATE_INVALID', 409, 'status', { extensions: { reason } });
const idOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the commands hand back and what they read.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a command left, as the audit row, the event and the answer are written from. */
export interface WorkflowResult {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  method: string;
  fromStatus: WorkflowStatus | null;
  status: WorkflowStatus;
  fromStep: string | null;
  toStep: string | null;
  visit: number | null;
  version: number;
  /** More facts of the command (ids, codes, days), never words of people. */
  facts: Record<string, unknown>;
}

export interface LockedWorkflow {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  method: string;
  status: WorkflowStatus;
  currentStep: string | null;
  currentVisit: number | null;
  ownerId: string | null;
  holdReason: string | null;
  heldOn: string | null;
  definition: ProcurementWorkflowDefinition;
  definitionRuleVersion: number;
  version: number;
}

interface LockSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  method: string;
  status: WorkflowStatus;
  current_step_code: string | null;
  current_visit: number | null;
  owner_membership_id: string | null;
  hold_reason: string | null;
  held_on: string | null;
  definition: Record<string, unknown>;
  definition_rule_version: number;
  row_version: number;
}

export interface VisitRow {
  id: string;
  visit: number;
  stepCode: string;
  enteredOn: string;
  entryKind: 'START' | 'ADVANCE' | 'RETURN' | 'CORRECTION';
  dueOn: string | null;
  standardWorkingDays: number;
}

interface VisitSql {
  id: string;
  visit: number;
  step_code: string;
  entered_on: string;
  entry_kind: VisitRow['entryKind'];
  due_on: string | null;
  standard_working_days: number;
}

export interface ItemRow {
  id: string;
  itemCode: string;
  name: string;
  required: boolean;
  status: ItemStatus;
  completedBy: string | null;
  dueOn: string | null;
  evidenceKinds: string[];
  evidenceRequired: boolean;
  allowedKinds: string[];
  milestoneKind: string | null;
  ownerId: string | null;
  version: number;
}

interface ItemSql {
  id: string;
  item_code: string;
  name: string;
  required: boolean;
  status: ItemStatus;
  completed_by: string | null;
  due_on: string | null;
  evidence_kinds: string[] | null;
  evidence_required: boolean;
  allowed_kinds: string[];
  milestone_kind: string | null;
  owner_membership_id: string | null;
  row_version: number;
}

export interface EvidenceInput {
  kind: string;
  documentId?: string | undefined;
  milestoneId?: string | undefined;
  externalRef?: string | undefined;
  note?: string | undefined;
}

const toLocked = (row: LockSql): LockedWorkflow => ({
  id: row.id,
  packageId: row.package_id,
  packageCode: row.package_code,
  projectId: row.project_id,
  method: row.method,
  status: row.status,
  currentStep: row.current_step_code,
  currentVisit: row.current_visit,
  ownerId: row.owner_membership_id,
  holdReason: row.hold_reason,
  heldOn: row.held_on,
  definition: parseWorkflowDefinition(row.definition),
  definitionRuleVersion: row.definition_rule_version,
  version: Number(row.row_version),
});

const toVisit = (row: VisitSql): VisitRow => ({ id: row.id, visit: row.visit, stepCode: row.step_code, enteredOn: row.entered_on, entryKind: row.entry_kind, dueOn: row.due_on, standardWorkingDays: row.standard_working_days });

const toItem = (row: ItemSql): ItemRow => ({
  id: row.id,
  itemCode: row.item_code,
  name: row.name,
  required: row.required,
  status: row.status,
  completedBy: row.completed_by,
  dueOn: row.due_on,
  evidenceKinds: row.evidence_kinds ?? [],
  evidenceRequired: row.evidence_required,
  allowedKinds: row.allowed_kinds,
  milestoneKind: row.milestone_kind,
  ownerId: row.owner_membership_id,
  version: Number(row.row_version),
});

export const visitStateOf = (visit: VisitRow, items: readonly ItemRow[]): VisitState => ({
  stepCode: visit.stepCode,
  enteredOn: visit.enteredOn,
  dueOn: visit.dueOn,
  items: items.map((item): ItemState => ({ code: item.itemCode, required: item.required, status: item.status, completedBy: item.completedBy, evidenceKinds: item.status === 'DONE' ? item.evidenceKinds : [], dueOn: item.dueOn })),
});

const hashOf = (definition: ProcurementWorkflowDefinition): string => createHash('sha256').update(canonicalWorkflowText(definition)).digest('hex');

/**
 * The workflow of a procurement package (PRC-1, BID 3 F11, docs/bid-workflow.md). A planner starts a workflow for a package whose plan is approved: the definition of its selection method is read through the governance port (the approved
 * rule in force or the built-in default) and FROZEN into the row, with the version of the rule and a hash. The package then moves through the steps of that definition: a step has a checklist, each item is done with evidence, and the
 * package leaves the step only when the required items are done and the evidence of the step is there, or when an exception that another person approved covers them. Every visit of a step is a row of the append-only history; a return makes a
 * new visit. Commands lock the package row first, check the version of the workflow (the If-Match of the next command) and write one audited fact; they never write words of people into the audit or the event.
 */
export class BidWorkflowStore {
  private readonly policy: GovernancePolicyPort;
  private readonly calendars: HomeWorkCalendars;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policy = policy;
    this.calendars = calendars;
  }

  // ---- commands --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Starts the workflow of a package: 404 outside the scope, 409 `PACKAGE_STATE_INVALID` while its plan is not approved, 409 `PACKAGE_WORKFLOW_STATE_INVALID` (`ALREADY_STARTED`) when it has one, 422
   * `PACKAGE_WORKFLOW_METHOD_UNSUPPORTED` when its method has no definition. The owner, when given, is a member of the tenant.
   */
  async start(tx: TenantTx, input: { packageId: string; ownerId?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const packageId = idOf(input.packageId, 'package_id');
    const ownerId = input.ownerId === undefined ? null : idOf(input.ownerId, 'owner_id');
    const pack = await this.lockPackage(tx, packageId, scope);
    if (PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status)) throw new DomainError('PACKAGE_STATE_INVALID', 409, 'package_id', { extensions: { package_status: pack.status } });
    const existing = await tx.query<{ id: string }>('select id from machvon.package_workflow where package_id = $1::uuid', [pack.id]);
    if (existing[0] !== undefined) throw stateInvalid('ALREADY_STARTED', { workflow_id: existing[0].id });
    if (!isWorkflowMethod(pack.method)) throw new DomainError('PACKAGE_WORKFLOW_METHOD_UNSUPPORTED', 422, 'method', { extensions: { method: pack.method } });
    if (ownerId !== null) await this.assertMember(tx, ownerId, 'owner_id');
    const today = vietnamDateOf(now);
    const resolved = await this.policy.get(tx, WORKFLOW_RULE_TYPE, pack.method, today);
    if (resolved === undefined) throw new DomainError('PACKAGE_WORKFLOW_METHOD_UNSUPPORTED', 422, 'method', { extensions: { method: pack.method } });
    const definition = parseWorkflowDefinition(resolved.params, pack.method);
    const first = definition.steps[0];
    if (first === undefined) throw new DomainError('PACKAGE_WORKFLOW_METHOD_UNSUPPORTED', 422, 'method', { extensions: { method: pack.method } });
    const hash = hashOf(definition);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);

    const rows = await tx.query<{ id: string }>(
      `insert into machvon.package_workflow (tenant_id, package_id, method, definition_code, definition_rule_id, definition_rule_version, definition_hash, definition, current_step_code, current_visit, owner_membership_id, started_by, started_at, last_activity_at, last_activity_on)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $2, $3::uuid, $4, $5, $6::jsonb, $7, 1, $8::uuid, $9::uuid, $10::timestamptz, $10::timestamptz, $11::date)
       returning id`,
      [pack.id, pack.method, resolved.ruleId, resolved.version, hash, JSON.stringify(workflowParamsOf(definition)), first.code, ownerId, actor, now.toISOString(), today],
    );
    const id = (rows[0] as { id: string }).id;
    const locked: LockedWorkflow = { id, packageId: pack.id, packageCode: pack.code, projectId: pack.project_id, method: pack.method, status: 'IN_PROGRESS', currentStep: first.code, currentVisit: 1, ownerId, holdReason: null, heldOn: null, definition, definitionRuleVersion: resolved.version, version: 1 };
    await this.openVisit(tx, locked, first.code, 1, 'START', actor, now, calendars, null);
    await this.syncMilestones(tx, locked, actor, now);
    return {
      id,
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      method: pack.method,
      fromStatus: null,
      status: 'IN_PROGRESS',
      fromStep: null,
      toStep: first.code,
      visit: 1,
      version: 1,
      facts: { definition_rule_version: resolved.version, definition_rule_id: resolved.ruleId, definition_hash: hash, definition_source: resolved.source, owner_id: ownerId, unverified: resolved.unverified },
    };
  }

  /**
   * Completes an item of the checklist of the current step with its evidence. 404 outside the scope, 409 `PACKAGE_WORKFLOW_STATE_INVALID` when the workflow is not running or the item is not an open item of the current step, 422
   * `CHECKLIST_EVIDENCE_REQUIRED` when the item asks for evidence and none is given, 422 `VALIDATION_FAILED` for evidence that is not of a kind the item allows or does not point at what its kind needs.
   */
  async completeItem(tx: TenantTx, itemId: string, input: { evidence: readonly EvidenceInput[]; note?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const id = idOf(itemId, 'item_id');
    const found = await tx.query<{ workflow_id: string }>('select workflow_id from machvon.package_checklist_item where id = $1::uuid', [id]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const wf = await this.lockWorkflow(tx, found[0].workflow_id, scope);
    this.assertRunning(wf);
    const visit = await this.openVisitOf(tx, wf);
    const items = await this.itemsOf(tx, visit.id);
    const item = items.find((one) => one.id === id);
    if (item === undefined) throw stateInvalid('ITEM_NOT_IN_CURRENT_STEP');
    if (item.status !== 'OPEN') throw stateInvalid('ITEM_ALREADY_FINISHED', { item_code: item.itemCode });
    const note = input.note === undefined ? null : assertWorkflowReason(input.note, 'note');
    if (input.evidence.length > MAX_EVIDENCE_PER_ITEM) throw invalid('evidence');
    const checked = await this.checkEvidence(tx, wf, item, input.evidence);
    if (item.evidenceRequired && checked.length === 0) throw new DomainError('CHECKLIST_EVIDENCE_REQUIRED', 422, 'evidence', { extensions: { item_code: item.itemCode, allowed_kinds: item.allowedKinds } });
    await tx.query(
      `update machvon.package_checklist_item set status = 'DONE', completed_via = 'PERSON', completed_by = $2::uuid, completed_at = $3::timestamptz, completion_note = $4, row_version = row_version + 1 where id = $1::uuid`,
      [item.id, actor, now.toISOString(), note],
    );
    for (const evidence of checked) {
      await tx.query(
        `insert into machvon.package_checklist_evidence (tenant_id, item_id, workflow_id, evidence_kind, document_id, milestone_id, external_ref, note, attached_by, attached_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9::timestamptz)`,
        [item.id, wf.id, evidence.kind, evidence.documentId ?? null, evidence.milestoneId ?? null, evidence.externalRef ?? null, evidence.note ?? null, actor, now.toISOString()],
      );
    }
    const version = await this.touch(tx, wf, now);
    return this.result(wf, wf.status, wf.status, wf.currentStep, wf.currentStep, visit.visit, version, { item_id: item.id, item_code: item.itemCode, evidence_count: checked.length, evidence_kinds: checked.map((one) => one.kind), required: item.required });
  }

  /**
   * Moves the package out of its current step to the next one (or completes the workflow at the last step). 409 `PACKAGE_WORKFLOW_BLOCKED` with the blockers when a required item is open or the evidence of the step is missing (an approved
   * exception covers those two), 403 `WORKFLOW_MAKER_IS_APPROVER` when the step is maker-checker and the caller completed an item of it, 409 `PACKAGE_WORKFLOW_STATE_INVALID` when the workflow is not running, 409 version.
   */
  async advance(tx: TenantTx, workflowId: string, expectedVersion: number, input: { note?: string | undefined; exceptionId?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    this.assertRunning(wf);
    const note = input.note === undefined ? null : assertWorkflowReason(input.note, 'note');
    await this.syncMilestones(tx, wf, actor, now);
    const visit = await this.openVisitOf(tx, wf);
    const items = await this.itemsOf(tx, visit.id);
    let exception: { id: string } | undefined;
    if (input.exceptionId !== undefined) {
      const asked = await this.exceptionOf(tx, idOf(input.exceptionId, 'exception_id'), wf.id);
      if (asked.kind !== 'SKIP_ITEMS' || asked.status !== 'APPROVED' || asked.step_visit_id !== visit.id) throw exceptionInvalid('NOT_APPROVED_FOR_THIS_STEP');
      exception = { id: asked.id };
    }
    const verdict = assessAdvance(wf.definition, wf.status, visitStateOf(visit, items), { actor, exceptionApproved: exception !== undefined });
    if (!verdict.ok) {
      if (verdict.blockers.every((blocker) => blocker.code === 'MAKER_IS_APPROVER')) throw new DomainError('WORKFLOW_MAKER_IS_APPROVER', 403, 'actor', { extensions: { step_code: visit.stepCode } });
      throw new DomainError('PACKAGE_WORKFLOW_BLOCKED', 409, 'step', { extensions: { step_code: visit.stepCode, blockers: verdict.blockers.map((blocker: Blocker) => ({ code: blocker.code, subject: blocker.subject })), coverable_by_exception: verdict.coverable.length > 0 } });
    }
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (exception !== undefined) {
      await tx.query(
        `update machvon.package_checklist_item set status = 'WAIVED', completed_via = 'EXCEPTION', completed_by = $2::uuid, completed_at = $3::timestamptz, waived_exception_id = $4::uuid, row_version = row_version + 1
          where step_visit_id = $1::uuid and status = 'OPEN' and required`,
        [visit.id, actor, now.toISOString(), exception.id],
      );
      await tx.query(`update machvon.package_step_exception set status = 'USED', used_at = $2::timestamptz, row_version = row_version + 1 where id = $1::uuid`, [exception.id, now.toISOString()]);
    }
    const spent = await this.closeVisit(tx, visit, verdict.next === null ? 'COMPLETE' : 'ADVANCE', actor, now, calendars, note, wf.definition.steps.find((step) => step.code === visit.stepCode)?.makerChecker === true ? actor : null);
    if (verdict.next === null) {
      await tx.query(
        `update machvon.package_workflow set status = 'COMPLETED', current_step_code = null, current_visit = null, ended_at = $2::timestamptz, ended_by = $3::uuid, last_activity_at = $2::timestamptz, last_activity_on = $4::date, row_version = row_version + 1 where id = $1::uuid`,
        [wf.id, now.toISOString(), actor, vietnamDateOf(now)],
      );
      return this.result(wf, wf.status, 'COMPLETED', visit.stepCode, null, visit.visit, wf.version + 1, { exception_id: exception?.id ?? null, working_days_spent: spent.working, calendar_days_spent: spent.calendar });
    }
    const nextVisit = visit.visit + 1;
    await this.openVisit(tx, wf, verdict.next.code, nextVisit, 'ADVANCE', actor, now, calendars, null);
    await tx.query(
      `update machvon.package_workflow set current_step_code = $2, current_visit = $3, last_activity_at = $4::timestamptz, last_activity_on = $5::date, row_version = row_version + 1 where id = $1::uuid`,
      [wf.id, verdict.next.code, nextVisit, now.toISOString(), vietnamDateOf(now)],
    );
    await this.syncMilestones(tx, { ...wf, currentStep: verdict.next.code, currentVisit: nextVisit }, actor, now);
    return this.result(wf, wf.status, wf.status, visit.stepCode, verdict.next.code, nextVisit, wf.version + 1, { exception_id: exception?.id ?? null, working_days_spent: spent.working, calendar_days_spent: spent.calendar });
  }

  /** Sends the package back to an earlier step with a reason (a new visit of that step with a fresh checklist). 422 for a step that is not earlier, 409 when the workflow is not running. */
  async returnStep(tx: TenantTx, workflowId: string, expectedVersion: number, input: { toStep: string; reason: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    this.assertRunning(wf);
    const reason = assertWorkflowReason(input.reason);
    const visit = await this.openVisitOf(tx, wf);
    const target = assertReturnTarget(wf.definition, visit.stepCode, input.toStep);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    await this.closeVisit(tx, visit, 'RETURN', actor, now, calendars, reason, null);
    const nextVisit = visit.visit + 1;
    await this.openVisit(tx, wf, target.code, nextVisit, 'RETURN', actor, now, calendars, reason);
    await tx.query(
      `update machvon.package_workflow set current_step_code = $2, current_visit = $3, last_activity_at = $4::timestamptz, last_activity_on = $5::date, row_version = row_version + 1 where id = $1::uuid`,
      [wf.id, target.code, nextVisit, now.toISOString(), vietnamDateOf(now)],
    );
    return this.result(wf, wf.status, wf.status, visit.stepCode, target.code, nextVisit, wf.version + 1, { to_step: target.code });
  }

  /** Puts a running workflow on hold with a reason; the clock of the step is extended by the days it was held when it resumes. */
  async hold(tx: TenantTx, workflowId: string, expectedVersion: number, input: { reason: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    if (wf.status !== 'IN_PROGRESS') throw stateInvalid('NOT_RUNNING', { workflow_status: wf.status });
    const reason = assertWorkflowReason(input.reason);
    await tx.query(
      `update machvon.package_workflow set status = 'ON_HOLD', hold_reason = $2, held_at = $3::timestamptz, held_by = $4::uuid, last_activity_at = $3::timestamptz, last_activity_on = $5::date, row_version = row_version + 1 where id = $1::uuid`,
      [wf.id, reason, now.toISOString(), actor, vietnamDateOf(now)],
    );
    await this.log(tx, wf, 'HOLD', actor, now, reason, null);
    return this.result(wf, 'IN_PROGRESS', 'ON_HOLD', wf.currentStep, wf.currentStep, wf.currentVisit, wf.version + 1, {});
  }

  /** Resumes a workflow on hold; the due day of the current step moves later by the working days it was held (when the calendar is published). */
  async resume(tx: TenantTx, workflowId: string, expectedVersion: number, input: { note?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    if (wf.status !== 'ON_HOLD') throw stateInvalid('NOT_ON_HOLD', { workflow_status: wf.status });
    const note = input.note === undefined ? null : assertWorkflowReason(input.note, 'note');
    const today = vietnamDateOf(now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const visit = await this.openVisitOf(tx, wf);
    let extended: string | null = null;
    if (visit.dueOn !== null && wf.heldOn !== null) {
      const held = workflowWorkingDaysBetween(calendars, wf.heldOn, today);
      if (held !== undefined && held > 0) {
        const moved = stepDueOn(calendars, visit.dueOn, held);
        if (moved !== undefined && moved > visit.dueOn) {
          await tx.query('update machvon.package_step set due_on = $2::date where id = $1::uuid', [visit.id, moved]);
          extended = moved;
        }
      }
    }
    await tx.query(
      `update machvon.package_workflow set status = 'IN_PROGRESS', hold_reason = null, held_at = null, held_by = null, last_activity_at = $2::timestamptz, last_activity_on = $3::date, row_version = row_version + 1 where id = $1::uuid`,
      [wf.id, now.toISOString(), today],
    );
    await this.log(tx, wf, 'RESUME', actor, now, note, null);
    return this.result(wf, 'ON_HOLD', 'IN_PROGRESS', wf.currentStep, wf.currentStep, wf.currentVisit, wf.version + 1, { due_on: extended ?? visit.dueOn, due_extended: extended !== null });
  }

  /** Assigns the person who answers for the package, or reassigns it (a reassignment needs a reason). A member of the tenant only; the same person again changes nothing. */
  async assignOwner(tx: TenantTx, workflowId: string, expectedVersion: number, input: { ownerId: string; reason?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    if (wf.status === 'COMPLETED' || wf.status === 'CANCELLED') throw stateInvalid('ENDED', { workflow_status: wf.status });
    const ownerId = idOf(input.ownerId, 'owner_id');
    await this.assertMember(tx, ownerId, 'owner_id');
    if (wf.ownerId === ownerId) return this.result(wf, wf.status, wf.status, wf.currentStep, wf.currentStep, wf.currentVisit, wf.version, { owner_id: ownerId, changed: false });
    const reassign = wf.ownerId !== null;
    const reason = reassign ? assertWorkflowReason(input.reason, 'reason') : input.reason === undefined ? null : assertWorkflowReason(input.reason);
    await tx.query(`update machvon.package_workflow set owner_membership_id = $2::uuid, last_activity_at = $3::timestamptz, last_activity_on = $4::date, row_version = row_version + 1 where id = $1::uuid`, [wf.id, ownerId, now.toISOString(), vietnamDateOf(now)]);
    await this.log(tx, wf, reassign ? 'REASSIGN_OWNER' : 'ASSIGN_OWNER', actor, now, reason, ownerId);
    return this.result(wf, wf.status, wf.status, wf.currentStep, wf.currentStep, wf.currentVisit, wf.version + 1, { owner_id: ownerId, previous_owner_id: wf.ownerId, changed: true });
  }

  /** Names the person who answers for an open item of the current step. */
  async assignItem(tx: TenantTx, itemId: string, input: { ownerId: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const id = idOf(itemId, 'item_id');
    const found = await tx.query<{ workflow_id: string }>('select workflow_id from machvon.package_checklist_item where id = $1::uuid', [id]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const wf = await this.lockWorkflow(tx, found[0].workflow_id, scope);
    this.assertRunning(wf);
    const ownerId = idOf(input.ownerId, 'owner_id');
    await this.assertMember(tx, ownerId, 'owner_id');
    const visit = await this.openVisitOf(tx, wf);
    const items = await this.itemsOf(tx, visit.id);
    const item = items.find((one) => one.id === id);
    if (item === undefined || item.status !== 'OPEN') throw stateInvalid('ITEM_NOT_OPEN');
    await tx.query(`update machvon.package_checklist_item set owner_membership_id = $2::uuid, row_version = row_version + 1 where id = $1::uuid`, [item.id, ownerId]);
    const version = await this.touch(tx, wf, now);
    await this.log(tx, wf, 'ASSIGN_ITEM', actor, now, null, ownerId);
    return this.result(wf, wf.status, wf.status, wf.currentStep, wf.currentStep, wf.currentVisit, version, { item_id: item.id, item_code: item.itemCode, owner_id: ownerId });
  }

  /** Asks for an exception (SKIP_ITEMS: leave the step with required items open or evidence missing; CORRECT_BACK: take the package back one step) with a reason; another person decides. */
  async requestException(tx: TenantTx, workflowId: string, input: { kind: string; reason: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult & { exceptionId: string }> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    this.assertRunning(wf);
    const kind = input.kind as ExceptionKind;
    if (kind !== 'SKIP_ITEMS' && kind !== 'CORRECT_BACK') throw invalid('kind');
    const reason = assertWorkflowReason(input.reason);
    const visit = await this.openVisitOf(tx, wf);
    let itemCodes: string[] = [];
    if (kind === 'SKIP_ITEMS') {
      const items = await this.itemsOf(tx, visit.id);
      const verdict = assessAdvance(wf.definition, wf.status, visitStateOf(visit, items), { actor: '', exceptionApproved: false });
      if (verdict.coverable.length === 0) throw exceptionInvalid('NOTHING_TO_EXCEPT');
      itemCodes = items.filter((item) => item.required && item.status === 'OPEN').map((item) => item.itemCode);
    } else if (visit.visit < 2) throw exceptionInvalid('NO_PREVIOUS_STEP');
    const open = await tx.query<{ id: string }>(`select id from machvon.package_step_exception where step_visit_id = $1::uuid and kind = $2 and status in ('REQUESTED', 'APPROVED')`, [visit.id, kind]);
    if (open[0] !== undefined) throw exceptionInvalid('ALREADY_OPEN');
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.package_step_exception (tenant_id, workflow_id, step_visit_id, package_id, kind, item_codes, reason, requested_by, requested_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::text[], $6, $7::uuid, $8::timestamptz) returning id`,
      [wf.id, visit.id, wf.packageId, kind, itemCodes, reason, actor, now.toISOString()],
    );
    const exceptionId = (rows[0] as { id: string }).id;
    const version = await this.touch(tx, wf, now);
    await this.log(tx, wf, 'EXCEPTION_REQUESTED', actor, now, reason, exceptionId);
    return { ...this.result(wf, wf.status, wf.status, wf.currentStep, wf.currentStep, wf.currentVisit, version, { exception_id: exceptionId, exception_kind: kind, item_codes: itemCodes }), exceptionId };
  }

  /**
   * Decides an exception: another person than the one who asked (403 `SELF_APPROVAL_DENIED`). Approving SKIP_ITEMS lets the next advance leave the step; approving CORRECT_BACK takes the package back to the step before (the wrongly entered
   * visit ends as CORRECTED and a visit of the earlier step opens as a CORRECTION). 409 `STEP_EXCEPTION_STATE_INVALID` when the exception is not waiting or the package has moved on.
   */
  async decideException(tx: TenantTx, exceptionId: string, input: { decision: string; note?: string | undefined }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult & { exceptionId: string; kind: ExceptionKind }> {
    const id = idOf(exceptionId, 'exception_id');
    const found = await tx.query<{ workflow_id: string }>('select workflow_id from machvon.package_step_exception where id = $1::uuid', [id]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const wf = await this.lockWorkflow(tx, found[0].workflow_id, scope);
    const asked = await this.exceptionOf(tx, id, wf.id);
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw invalid('decision');
    const note = input.note === undefined ? null : assertWorkflowReason(input.note, 'note');
    assertWorkflowExceptionDecider(asked.requested_by, actor);
    if (asked.status !== 'REQUESTED') throw exceptionInvalid('NOT_WAITING');
    if (wf.status !== 'IN_PROGRESS' && wf.status !== 'ON_HOLD') throw exceptionInvalid('WORKFLOW_ENDED');
    const visit = await this.openVisitOf(tx, wf);
    if (visit.id !== asked.step_visit_id) throw exceptionInvalid('PACKAGE_MOVED_ON');
    const approve = input.decision === 'APPROVE';
    await tx.query(
      `update machvon.package_step_exception set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, row_version = row_version + 1 where id = $1::uuid`,
      [asked.id, approve ? 'APPROVED' : 'REJECTED', actor, now.toISOString(), note],
    );
    await this.log(tx, wf, approve ? 'EXCEPTION_APPROVED' : 'EXCEPTION_REJECTED', actor, now, note, asked.id);
    let toStep = wf.currentStep;
    let toVisit = wf.currentVisit;
    let version: number;
    if (approve && asked.kind === 'CORRECT_BACK') {
      const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
      const previous = await tx.query<{ step_code: string }>('select step_code from machvon.package_step where workflow_id = $1::uuid and visit = $2', [wf.id, visit.visit - 1]);
      const target = previous[0]?.step_code;
      if (target === undefined || workflowStepOf(wf.definition, target) === undefined) throw exceptionInvalid('NO_PREVIOUS_STEP');
      await this.closeVisit(tx, visit, 'CORRECTED', actor, now, calendars, asked.reason, null);
      toVisit = visit.visit + 1;
      toStep = target;
      await this.openVisit(tx, wf, target, toVisit, 'CORRECTION', actor, now, calendars, asked.reason);
      await tx.query(`update machvon.package_step_exception set status = 'USED', used_at = $2::timestamptz, row_version = row_version + 1 where id = $1::uuid`, [asked.id, now.toISOString()]);
      await tx.query(
        `update machvon.package_workflow set current_step_code = $2, current_visit = $3, last_activity_at = $4::timestamptz, last_activity_on = $5::date, row_version = row_version + 1 where id = $1::uuid`,
        [wf.id, target, toVisit, now.toISOString(), vietnamDateOf(now)],
      );
      await this.log(tx, wf, 'CORRECTION', actor, now, asked.reason, asked.id);
      version = wf.version + 1;
    } else version = await this.touch(tx, wf, now);
    return { ...this.result(wf, wf.status, wf.status, wf.currentStep, toStep, toVisit, version, { exception_id: asked.id, exception_kind: asked.kind, decision: input.decision }), exceptionId: asked.id, kind: asked.kind };
  }

  /** Cancels a workflow that will not go on (the bidding failed, the package was dropped) with a reason; the visit ends as CANCEL and the package leaves every step. */
  async cancel(tx: TenantTx, workflowId: string, expectedVersion: number, input: { reason: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<WorkflowResult> {
    const wf = await this.lockWorkflow(tx, idOf(workflowId, 'workflow_id'), scope);
    if (wf.version !== expectedVersion) throw versionConflict(wf.version);
    this.assertRunning(wf, true);
    const reason = assertWorkflowReason(input.reason);
    const visit = await this.openVisitOf(tx, wf);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    await this.closeVisit(tx, visit, 'CANCEL', actor, now, calendars, reason, null);
    await tx.query(
      `update machvon.package_workflow set status = 'CANCELLED', current_step_code = null, current_visit = null, hold_reason = null, held_at = null, held_by = null, ended_at = $2::timestamptz, ended_by = $3::uuid, end_reason = $4, last_activity_at = $2::timestamptz, last_activity_on = $5::date, row_version = row_version + 1 where id = $1::uuid`,
      [wf.id, now.toISOString(), actor, reason, vietnamDateOf(now)],
    );
    await this.log(tx, wf, 'CANCEL', actor, now, reason, null);
    return this.result(wf, wf.status, 'CANCELLED', visit.stepCode, null, visit.visit, wf.version + 1, {});
  }

  /**
   * Completes the items of the current step that a milestone of the package carries by itself (the dates that BID-17 records and BID-19 imports from the national bidding network): the milestone IS the evidence, the item is DONE via MILESTONE
   * with no person behind it. Called when a workflow starts, enters a step and is about to be left; another module that records a milestone may call it too (hook). Returns the codes it completed.
   */
  async syncMilestones(tx: TenantTx, wf: LockedWorkflow, actor: string, now: Date): Promise<string[]> {
    if (wf.status !== 'IN_PROGRESS' && wf.status !== 'ON_HOLD') return [];
    const rows = await tx.query<{ item_id: string; item_code: string; milestone_id: string }>(
      `select i.id as item_id, i.item_code, m.id as milestone_id
         from machvon.package_checklist_item i
         join machvon.package_step s on s.tenant_id = i.tenant_id and s.id = i.step_visit_id and s.exited_at is null
         join machvon.procurement_milestone m on m.tenant_id = i.tenant_id and m.package_id = i.package_id and m.milestone_kind = i.milestone_kind and m.actual_at is not null
        where i.workflow_id = $1::uuid and i.status = 'OPEN' and i.milestone_kind is not null`,
      [wf.id],
    );
    for (const row of rows) {
      await tx.query(`update machvon.package_checklist_item set status = 'DONE', completed_via = 'MILESTONE', completed_at = $2::timestamptz, row_version = row_version + 1 where id = $1::uuid`, [row.item_id, now.toISOString()]);
      await tx.query(
        `insert into machvon.package_checklist_evidence (tenant_id, item_id, workflow_id, evidence_kind, milestone_id, attached_by, attached_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'MILESTONE', $3::uuid, $4::uuid, $5::timestamptz)`,
        [row.item_id, wf.id, row.milestone_id, actor, now.toISOString()],
      );
    }
    return rows.map((row) => row.item_code);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private result(wf: LockedWorkflow, from: WorkflowStatus | null, to: WorkflowStatus, fromStep: string | null, toStep: string | null, visit: number | null, version: number, facts: Record<string, unknown>): WorkflowResult {
    return { id: wf.id, packageId: wf.packageId, packageCode: wf.packageCode, projectId: wf.projectId, method: wf.method, fromStatus: from, status: to, fromStep, toStep, visit, version, facts };
  }

  private assertRunning(wf: LockedWorkflow, allowHold = false): void {
    if (wf.status === 'IN_PROGRESS') return;
    if (allowHold && wf.status === 'ON_HOLD') return;
    throw stateInvalid(wf.status === 'ON_HOLD' ? 'ON_HOLD' : 'ENDED', { workflow_status: wf.status });
  }

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<{ id: string; code: string; project_id: string; method: string; status: string }> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string; code: string; project_id: string; method: string; status: string }>(
      `select k.id, k.code, k.project_id, k.method, k.status from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  async lockWorkflow(tx: TenantTx, workflowId: string, scope: ScopeBuilder): Promise<LockedWorkflow> {
    const predicate = scope(2);
    const rows = await tx.query<LockSql>(
      `select w.id, w.package_id, k.code as package_code, p.id as project_id, w.method, w.status, w.current_step_code, w.current_visit, w.owner_membership_id, w.hold_reason,
              ((w.held_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as held_on, w.definition, w.definition_rule_version, w.row_version
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.package_workflow w on w.tenant_id = k.tenant_id and w.package_id = k.id
        where w.id = $1::uuid and ${predicate.sql} for update of p, k, w`,
      [workflowId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toLocked(rows[0]);
  }

  private async assertMember(tx: TenantTx, membershipId: string, field: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [membershipId]);
    if (rows[0] === undefined) throw invalid(field);
  }

  async openVisitOf(tx: TenantTx, wf: LockedWorkflow): Promise<VisitRow> {
    const rows = await tx.query<VisitSql>(
      `select id, visit, step_code, entered_on::text as entered_on, entry_kind, due_on::text as due_on, standard_working_days from machvon.package_step where workflow_id = $1::uuid and exited_at is null`,
      [wf.id],
    );
    if (rows[0] === undefined) throw stateInvalid('NO_OPEN_STEP');
    return toVisit(rows[0]);
  }

  async itemsOf(tx: TenantTx, visitId: string): Promise<ItemRow[]> {
    const rows = await tx.query<ItemSql>(
      `select i.id, i.item_code, i.name, i.required, i.status, i.completed_by, i.due_on::text as due_on, i.evidence_required, i.evidence_kinds as allowed_kinds, i.milestone_kind, i.owner_membership_id, i.row_version,
              (select array_agg(distinct e.evidence_kind order by e.evidence_kind) from machvon.package_checklist_evidence e where e.tenant_id = i.tenant_id and e.item_id = i.id) as evidence_kinds
         from machvon.package_checklist_item i where i.step_visit_id = $1::uuid order by i.created_at, i.item_code`,
      [visitId],
    );
    return rows.map(toItem);
  }

  private async exceptionOf(tx: TenantTx, id: string, workflowId: string): Promise<{ id: string; kind: ExceptionKind; status: string; step_visit_id: string; requested_by: string; reason: string }> {
    const rows = await tx.query<{ id: string; kind: ExceptionKind; status: string; step_visit_id: string; requested_by: string; reason: string }>(
      'select id, kind, status, step_visit_id, requested_by, reason from machvon.package_step_exception where id = $1::uuid and workflow_id = $2::uuid',
      [id, workflowId],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  private async touch(tx: TenantTx, wf: LockedWorkflow, now: Date): Promise<number> {
    await tx.query(`update machvon.package_workflow set last_activity_at = $2::timestamptz, last_activity_on = $3::date, row_version = row_version + 1 where id = $1::uuid`, [wf.id, now.toISOString(), vietnamDateOf(now)]);
    return wf.version + 1;
  }

  private async log(tx: TenantTx, wf: LockedWorkflow, kind: string, actor: string, now: Date, reason: string | null, subject: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.package_workflow_log (tenant_id, workflow_id, package_id, kind, at, actor, step_code, reason, subject)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::timestamptz, $5::uuid, $6, $7, $8::uuid)`,
      [wf.id, wf.packageId, kind, now.toISOString(), actor, wf.currentStep, reason, subject],
    );
  }

  private async openVisit(tx: TenantTx, wf: LockedWorkflow, stepCode: string, visit: number, entryKind: VisitRow['entryKind'], actor: string, now: Date, calendars: WorkCalendarSource | undefined, note: string | null): Promise<void> {
    const step = workflowStepOf(wf.definition, stepCode);
    if (step === undefined) throw invalid('step');
    const today = vietnamDateOf(now);
    const due = stepDueOn(calendars, today, step.standardWorkingDays);
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.package_step (tenant_id, workflow_id, package_id, visit, step_code, entered_at, entered_on, entered_by, entry_kind, standard_working_days, due_on, due_basis, note)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::date, $7::uuid, $8, $9, $10::date, $11, $12) returning id`,
      [wf.id, wf.packageId, visit, stepCode, now.toISOString(), today, actor, entryKind, step.standardWorkingDays, due ?? null, due === undefined ? 'CALENDAR_UNAVAILABLE' : 'WORKING_DAYS', note],
    );
    const visitId = (rows[0] as { id: string }).id;
    for (const item of step.checklist) {
      const itemDue = stepDueOn(calendars, today, item.dueOffsetWorkingDays);
      await tx.query(
        `insert into machvon.package_checklist_item (tenant_id, workflow_id, step_visit_id, package_id, step_code, item_code, name, required, owner_role, due_on, evidence_kinds, evidence_required, milestone_kind)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::date, $10::text[], $11, $12)`,
        [wf.id, visitId, wf.packageId, stepCode, item.code, item.name, item.required, item.ownerRole, itemDue ?? null, [...item.evidenceKinds], item.evidenceRequired, item.milestoneKind],
      );
    }
  }

  private async closeVisit(tx: TenantTx, visit: VisitRow, exitKind: 'ADVANCE' | 'RETURN' | 'CANCEL' | 'COMPLETE' | 'CORRECTED', actor: string, now: Date, calendars: WorkCalendarSource | undefined, note: string | null, approvedBy: string | null): Promise<{ working: number | null; calendar: number }> {
    const today = vietnamDateOf(now);
    const calendar = Math.max(0, workflowDaysBetween(visit.enteredOn, today));
    const working = workflowWorkingDaysBetween(calendars, visit.enteredOn, today) ?? null;
    await tx.query(
      `update machvon.package_step set exited_at = $2::timestamptz, exited_on = $3::date, exited_by = $4::uuid, exit_kind = $5, approved_by = $6::uuid, working_days_spent = $7, calendar_days_spent = $8, note = coalesce(note, $9)
        where id = $1::uuid and exited_at is null`,
      [visit.id, now.toISOString(), today, actor, exitKind, approvedBy, working, calendar, exitKind === 'ADVANCE' || exitKind === 'COMPLETE' ? note : null],
    );
    return { working, calendar };
  }

  private async checkEvidence(tx: TenantTx, wf: LockedWorkflow, item: ItemRow, evidence: readonly EvidenceInput[]): Promise<EvidenceInput[]> {
    const checked: EvidenceInput[] = [];
    for (const [index, one] of evidence.entries()) {
      const at = (key: string): string => `evidence[${index}].${key}`;
      if (typeof one !== 'object' || one === null || !isEvidenceKind(one.kind)) throw invalid(at('kind'));
      if (item.allowedKinds.length > 0 && !item.allowedKinds.includes(one.kind)) throw invalid(at('kind'));
      const info = evidenceKindOf(one.kind);
      const note = one.note === undefined ? undefined : assertWorkflowReason(one.note, at('note'));
      const external = one.externalRef === undefined ? undefined : one.externalRef.trim();
      if (external !== undefined && (external.length < 1 || external.length > 200)) throw invalid(at('external_ref'));
      let documentId: string | undefined;
      let milestoneId: string | undefined;
      switch (info?.source) {
        case 'DOCUMENT': {
          documentId = idOf(one.documentId, at('document_id'));
          const rows = await tx.query<{ id: string }>('select id from machvon.document where id = $1::uuid', [documentId]);
          if (rows[0] === undefined) throw invalid(at('document_id'));
          break;
        }
        case 'MILESTONE': {
          milestoneId = idOf(one.milestoneId, at('milestone_id'));
          const rows = await tx.query<{ milestone_kind: string; actual_at: string | null }>('select milestone_kind, actual_at::text as actual_at from machvon.procurement_milestone where id = $1::uuid and package_id = $2::uuid', [milestoneId, wf.packageId]);
          const milestone = rows[0];
          if (milestone === undefined || milestone.actual_at === null || (item.milestoneKind !== null && milestone.milestone_kind !== item.milestoneKind)) throw invalid(at('milestone_id'));
          break;
        }
        case 'EXTERNAL_RECEIPT':
          if (external === undefined) throw invalid(at('external_ref'));
          break;
        case 'ATTESTATION':
          if (note === undefined) throw invalid(at('note'));
          break;
        default:
          throw invalid(at('kind'));
      }
      checked.push({ kind: one.kind, documentId, milestoneId, externalRef: external, note });
    }
    return checked;
  }
}

