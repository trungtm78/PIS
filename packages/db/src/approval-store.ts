import { DomainError, activeGrants, addWorkingTime, advanceWorkflow, assertValidDefinition, businessTypeOf, canonicalJson, finalCommandKey, requiredApprovals, scopeContains, sha256Hex, slaAction, vietnamDateOf, versionConflict, withinDelegation } from '@machvon/kernel';
import type { ApprovalDecisionKind, ApprovalSlaAction, ApprovalWorkflowDefinition, EffectiveAccess, ResourceRef, WorkflowOutcome, WorkflowStep } from '@machvon/kernel';
import { randomUUID } from 'node:crypto';
import { DoaMatrixStore } from './doa-matrix-store.ts';
import { loadAccessIn } from './effective-access-store.ts';
import { SCOPE_CONTAINS_UNIT } from './signer-authority-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { AuditEntry } from './audit-writer.ts';
import type { OutboxEventInput } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';
const HOUR_MS = 3_600_000;
const APPROVAL_CALENDAR_CODE = 'WORKDAY_VN';
const DECIDE_PERMISSION = 'approval.decide';
/** The most approvers a step gives its task to: a band that has many holders is not asked of all of them. */
const MAX_TASKS_PER_STEP = 20;
/** The most tasks one pass of the SLA job looks at for a tenant; the rest wait for the next pass, the oldest deadline first. */
export const SLA_PASS_LIMIT = 500;
/** The share of the working time to the deadline at which an approver is reminded. */
const REMINDER_SHARE = 0.8;
/** A working day, the time between two reminders of an overdue task. */
const WORKING_DAY_MINUTES = 8 * 60;

/** What the engine writes beside the state: the audit trail and the events. The caller's command scope (or a workflow activity) provides both. */
export interface ApprovalEffects {
  /** The membership that acts. */
  actor: string;
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<unknown>;
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<unknown>;
  /** Work for after the transaction committed (a counter, a cache); present where the caller is a command, absent for a job. */
  afterCommit?(callback: () => void | Promise<void>): void;
}

/** The final command of an instance, as the module that owns the business type runs it (ADM 3.7 item 6). The domain's own transition table is the guard: a refusal ends the instance as GUARD_REJECTED. */
export type FinalCommand = (call: { tx: TenantTx; instance: InstanceRecord; outcome: WorkflowOutcome; command: string; idempotencyKey: string; effects: ApprovalEffects }) => Promise<'APPLIED' | 'GUARD_REJECTED'>;

export interface VersionRecord {
  id: string;
  businessType: string;
  kind: string;
  revision: number;
  status: 'Draft' | 'Published' | 'Superseded' | 'Retired';
  definition: unknown;
  createdBy: string;
  lastEditedBy: string | null;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  version: number;
  sortKey: string;
}

export interface InstanceRecord {
  id: string;
  workflowVersionId: string;
  businessType: string;
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  status: 'Running' | 'Completed' | 'Cancelled' | 'Failed';
  outcome: string | null;
  currentStep: number;
  decisionSeq: number;
  documentType: string;
  amountVnd: string | null;
  unitId: string;
  initiatorId: string;
  doaMatrixVersionId: string | null;
  doaApproverRoleId: string | null;
  doaLevels: number | null;
  startedAt: string;
  endedAt: string | null;
  version: number;
  sortKey: string;
}

export interface TaskRecord {
  id: string;
  workflowInstanceId: string;
  stepId: string;
  stepIndex: number;
  assigneeId: string;
  assigneeName: string | null;
  delegatedFromId: string | null;
  /** The viewer holds a delegation from the assignee that reaches the unit of the instance: they may decide the task. */
  delegatedToMe: boolean;
  dueAt: string;
  status: 'Pending' | 'Decided' | 'Reassigned' | 'Cancelled' | 'Expired';
  decision: ApprovalDecisionKind | null;
  reason: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  businessType: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  version: number;
  sortKey: string;
  /** What the monitor (ADM-18) shows beside the task: the instance it belongs to, the figure and the definition it runs by. */
  instanceVersion: number;
  instanceStatus: InstanceRecord['status'];
  amountVnd: string | null;
  documentType: string;
  unitId: string;
  workflowRevision: number;
  stepName: string | null;
  escalatedAt: string | null;
  overdueReminders: number;
  reassignedFromId: string | null;
  escalatedFromId: string | null;
}

interface VersionRow {
  id: string;
  business_type: string;
  kind: string;
  revision: number;
  status: VersionRecord['status'];
  definition_json: unknown;
  created_by: string;
  last_edited_by: string | null;
  published_by: string | null;
  created_at: string;
  published_at: string | null;
  version: string;
  sort_key: string;
}

const VERSION_COLUMNS = `id, business_type, kind, revision, status, definition_json, created_by, last_edited_by, published_by, ${TIME('created_at')} as created_at, ${TIME('published_at')} as published_at, version::text as version, ${TIME('created_at')} as sort_key`;
const toVersion = (row: VersionRow): VersionRecord => ({
  id: row.id,
  businessType: row.business_type,
  kind: row.kind,
  revision: row.revision,
  status: row.status,
  definition: row.definition_json,
  createdBy: row.created_by,
  lastEditedBy: row.last_edited_by,
  publishedBy: row.published_by,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

interface InstanceRow {
  id: string;
  workflow_version_id: string;
  business_type: string;
  resource_type: string;
  resource_id: string;
  resource_version: string;
  status: InstanceRecord['status'];
  outcome: string | null;
  current_step: number;
  decision_seq: number;
  document_type: string;
  amount_vnd: string | null;
  unit_id: string;
  initiator_id: string;
  doa_matrix_version_id: string | null;
  doa_approver_role_id: string | null;
  doa_levels: number | null;
  started_at: string;
  ended_at: string | null;
  version: string;
  sort_key: string;
}

const INSTANCE_COLUMNS = `i.id, i.workflow_version_id, i.business_type, i.resource_type, i.resource_id, i.resource_version::text as resource_version, i.status, i.outcome, i.current_step, i.decision_seq, i.document_type, i.amount_vnd::text as amount_vnd, i.unit_id,
  i.initiator_membership_id as initiator_id, i.doa_matrix_version_id, i.doa_approver_role_id, i.doa_levels, ${TIME('i.started_at')} as started_at, ${TIME('i.ended_at')} as ended_at, i.version::text as version, ${TIME('i.started_at')} as sort_key`;
const toInstance = (row: InstanceRow): InstanceRecord => ({
  id: row.id,
  workflowVersionId: row.workflow_version_id,
  businessType: row.business_type,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  resourceVersion: Number(row.resource_version),
  status: row.status,
  outcome: row.outcome,
  currentStep: row.current_step,
  decisionSeq: row.decision_seq,
  documentType: row.document_type,
  amountVnd: row.amount_vnd,
  unitId: row.unit_id,
  initiatorId: row.initiator_id,
  doaMatrixVersionId: row.doa_matrix_version_id,
  doaApproverRoleId: row.doa_approver_role_id,
  doaLevels: row.doa_levels,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

interface TaskRow {
  id: string;
  workflow_instance_id: string;
  step_id: string;
  step_index: number;
  assignee_id: string;
  assignee_name: string | null;
  on_behalf_of_id: string | null;
  delegated_to_me: boolean;
  due_at: string;
  status: TaskRecord['status'];
  decision: ApprovalDecisionKind | null;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  business_type: string;
  resource_type: string;
  resource_id: string;
  created_at: string;
  version: string;
  sort_key: string;
  instance_version: string;
  instance_status: InstanceRecord['status'];
  amount_vnd: string | null;
  document_type: string;
  unit_id: string;
  workflow_revision: number;
  step_name: string | null;
  escalated_at: string | null;
  overdue_reminders: number;
  reassigned_from_id: string | null;
  escalated_from_id: string | null;
}

const TASK_FROM = `machvon.approval_task t join machvon.workflow_instance i on i.tenant_id = t.tenant_id and i.id = t.workflow_instance_id
  join machvon.workflow_version v on v.tenant_id = i.tenant_id and v.id = i.workflow_version_id
  left join machvon.tenant_user_directory a on a.tenant_id = t.tenant_id and a.membership_id = t.assignee_id`;
/** Whether the member holds a delegation of approval.decide from the assignee of the task whose scope contains the unit of its instance: the delegate may see the task and decide it. */
const delegatedTo = (member: string, assignee: string, unit: string, at: string): string => `exists (
  select 1 from machvon.delegation_grant d
   where d.delegator_membership_id = ${assignee} and d.delegate_membership_id = ${member}::uuid and d.status = 'Active' and d.valid_from <= ${at}::timestamptz and ${at}::timestamptz < d.valid_until
     and exists (select 1 from unnest(d.permissions) p where p = 'approval.decide' or p = 'approval.*' or p = '*')
     and ${SCOPE_CONTAINS_UNIT("d.scope_json->>'kind'", "array(select jsonb_array_elements_text(coalesce(d.scope_json->'ref_ids', '[]'::jsonb))::uuid)", unit)})`;
const taskColumns = (delegated: string): string => `t.id, t.workflow_instance_id, t.step_id, t.step_index, t.assignee_id, a.display_name as assignee_name, t.on_behalf_of_id, ${TIME('t.due_at')} as due_at, t.status, t.decision, t.reason, ${TIME('t.decided_at')} as decided_at,
  t.decided_by, i.business_type, i.resource_type, i.resource_id, ${TIME('t.created_at')} as created_at, t.version::text as version, ${TIME('t.created_at')} as sort_key, ${delegated} as delegated_to_me,
  i.version::text as instance_version, i.status as instance_status, i.amount_vnd::text as amount_vnd, i.document_type, i.unit_id, v.revision as workflow_revision, v.definition_json->'steps'->t.step_index->>'name' as step_name,
  ${TIME('t.escalated_at')} as escalated_at, t.overdue_reminders, t.reassigned_from_task_id as reassigned_from_id, t.escalated_from_task_id as escalated_from_id`;
const TASK_COLUMNS = taskColumns('false');
const toTask = (row: TaskRow): TaskRecord => ({
  id: row.id,
  workflowInstanceId: row.workflow_instance_id,
  stepId: row.step_id,
  stepIndex: row.step_index,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_name,
  delegatedFromId: row.on_behalf_of_id,
  delegatedToMe: row.delegated_to_me,
  dueAt: row.due_at,
  status: row.status,
  decision: row.decision,
  reason: row.reason,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
  businessType: row.business_type,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
  instanceVersion: Number(row.instance_version),
  instanceStatus: row.instance_status,
  amountVnd: row.amount_vnd,
  documentType: row.document_type,
  unitId: row.unit_id,
  workflowRevision: row.workflow_revision,
  stepName: row.step_name,
  escalatedAt: row.escalated_at,
  overdueReminders: row.overdue_reminders,
  reassignedFromId: row.reassigned_from_id,
  escalatedFromId: row.escalated_from_id,
});

export interface StartInput {
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  businessType: string;
  amountVnd: string | null;
  unitId: string;
  initiatorMembershipId: string;
  now: Date;
}

export interface DecideInput {
  taskId: string;
  expectedVersion: number;
  decision: ApprovalDecisionKind;
  reason: string | undefined;
  returnToStep: string | undefined;
  now: Date;
  finish: FinalCommand;
}

/** What one pass of the SLA did for a tenant, and the figures of its gauges. */
export interface SlaSweepResult {
  /** Reminders before the deadline. */
  reminded: number;
  /** Reminders of tasks past their deadline. */
  overdueReminded: number;
  /** The tasks found past their deadline for the first time (reminded, escalated or expired): the breaches. */
  breached: number;
  escalated: number;
  /** Escalations that could not be made: the target cannot hold the task. */
  escalationFailed: number;
  expired: number;
  instancesExpired: number;
  /** The pending tasks of the tenant after the pass, and how many of them are past their deadline. */
  open: number;
  overdue: number;
}

/** What a decision did, for the audit row and the answer. */
export type DecisionResult =
  | { kind: 'DECIDED'; task: TaskRecord; instance: InstanceRecord; step: 'STAYED' | 'NEXT_STEP' | 'RETURNED_TO_STEP' | 'COMPLETED'; outcome: string | null; finalCommand: string | null; createdTaskIds: string[] }
  | { kind: 'SELF_APPROVAL'; task: TaskRecord; reassignedTo: string | null };

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The approval engine (ST-ADM-012, ADM 3.7): the definitions a tenant publishes per business type, the instances a business module starts in its own transaction, and the tasks approvers decide. The database is the authority of
 * the state; this class follows the definition. There is no separate workflow server: each step is a transaction, locked on the task and the instance, so that two decisions of one task are one 200 and one 409 and nothing is
 * written twice.
 */
export class ApprovalStore {
  private readonly doa = new DoaMatrixStore();
  private readonly calendars = new WorkCalendarStore();

  // ---- the definitions ---------------------------------------------------------------------------------------------------------------

  /** A new draft of a business type, one revision after the latest; the definition is validated and refused with its defects (422 `WORKFLOW_DEFINITION_INVALID`) and nothing is stored then. */
  async createDraft(tx: TenantTx, input: { businessType: string; definition: unknown }, actor: string): Promise<VersionRecord> {
    assertValidDefinition(input.definition, input.businessType);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [latest] = await tx.query<{ revision: number | null }>("select max(revision) as revision from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1", [input.businessType]);
      await tx.query('savepoint workflow_revision');
      try {
        const [row] = await tx.query<VersionRow>(
          `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, last_edited_by, definition_hash)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::jsonb, 'Draft', 'APPROVAL', $4::uuid, $4::uuid, $5) returning ${VERSION_COLUMNS}`,
          [input.businessType, (latest?.revision ?? 0) + 1, JSON.stringify(input.definition), actor, sha256Hex(canonicalJson(input.definition))],
        );
        await tx.query('release savepoint workflow_revision');
        return toVersion(row as VersionRow);
      } catch (error) {
        // Two drafts made at the same moment ask for the same revision: the transaction goes back to before the insert and the second asks again.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION || attempt === 2) throw error;
        await tx.query('rollback to savepoint workflow_revision');
      }
    }
    throw new Error('unreachable');
  }

  private async lockVersion(tx: TenantTx, id: string): Promise<VersionRecord> {
    const [row] = await tx.query<VersionRow>(`select ${VERSION_COLUMNS} from machvon.workflow_version where id = $1::uuid and kind = 'APPROVAL' for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toVersion(row);
  }

  /** Edits a draft at the version read; a definition that is published or superseded is not edited (409 `WORKFLOW_NOT_DRAFT`), and the business type of a draft is not changed. */
  async updateDraft(tx: TenantTx, id: string, expectedVersion: number, input: { businessType: string; definition: unknown }, editor: string): Promise<VersionRecord> {
    const current = await this.lockVersion(tx, id);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Draft') throw new DomainError('WORKFLOW_NOT_DRAFT', 409, 'status');
    if (input.businessType !== current.businessType) throw invalid('business_type');
    assertValidDefinition(input.definition, current.businessType);
    const [row] = await tx.query<VersionRow>(`update machvon.workflow_version set definition_json = $2::jsonb, definition_hash = $3, last_edited_by = $4::uuid, version = version + 1 where id = $1::uuid returning ${VERSION_COLUMNS}`, [id, JSON.stringify(input.definition), sha256Hex(canonicalJson(input.definition)), editor]);
    return toVersion(row as VersionRow);
  }

  /** Publishes a draft: not by the one who wrote it (403 `SELF_APPROVAL_DENIED`), a definition that is valid, and the one in force for the business type becomes superseded. Instances that run keep their version. */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string, now: Date): Promise<{ version: VersionRecord; supersededId: string | null }> {
    // Publications of one business type go one at a time: the lock is taken before the one in force is read, so a second publication finds the first and supersedes it.
    const [peek] = await tx.query<{ business_type: string }>("select business_type from machvon.workflow_version where id = $1::uuid and kind = 'APPROVAL'", [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query("select pg_advisory_xact_lock(hashtext('workflow-publish:' || current_setting('app.tenant_id', true) || ':' || $1))", [peek.business_type]);
    const current = await this.lockVersion(tx, id);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Draft') throw new DomainError('WORKFLOW_NOT_DRAFT', 409, 'status');
    // Neither the author nor the last to edit the draft publishes it: the one who wrote the definition is not its checker, judged on the person and not on the membership.
    const people = await tx.query<{ id: string; user_id: string }>('select id, user_id from machvon.membership where id = any($1::uuid[])', [[current.createdBy, current.lastEditedBy ?? current.createdBy, publisher]]);
    const userOf = (membershipId: string): string | undefined => people.find((row) => row.id === membershipId)?.user_id;
    const publisherUser = userOf(publisher);
    if (publisherUser !== undefined && (userOf(current.createdBy) === publisherUser || (current.lastEditedBy !== null && userOf(current.lastEditedBy) === publisherUser))) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    assertValidDefinition(current.definition, current.businessType);
    const [inForce] = await tx.query<{ id: string }>("select id from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1 and status = 'Published' for update", [current.businessType]);
    if (inForce !== undefined) await tx.query("update machvon.workflow_version set status = 'Superseded', version = version + 1 where id = $1::uuid", [inForce.id]);
    const [row] = await tx.query<VersionRow>(
      `update machvon.workflow_version set status = 'Published', published_by = $2::uuid, published_at = $3::timestamptz, effective_from = $3::timestamptz, supersedes_id = $4::uuid, version = version + 1 where id = $1::uuid returning ${VERSION_COLUMNS}`,
      [id, publisher, now.toISOString(), inForce?.id ?? null],
    );
    return { version: toVersion(row as VersionRow), supersededId: inForce?.id ?? null };
  }

  async listVersions(tx: TenantTx, filters: { businessType?: string | undefined; status?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<VersionRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<VersionRow>(
      `select ${VERSION_COLUMNS} from machvon.workflow_version
        where kind = 'APPROVAL' and ($1::text is null or business_type = $1) and ($2::text is null or status = $2) and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
        order by created_at desc, id desc limit $5::int`,
      [filters.businessType ?? null, filters.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toVersion);
  }

  async findVersion(tx: TenantTx, id: string): Promise<VersionRecord | undefined> {
    const [row] = await tx.query<VersionRow>(`select ${VERSION_COLUMNS} from machvon.workflow_version where id = $1::uuid and kind = 'APPROVAL'`, [id]);
    return row === undefined ? undefined : toVersion(row);
  }

  // ---- starting and cancelling an instance (the service a business module calls) ----------------------------------------------------

  /**
   * `ApprovalService.start`: inside the transaction of the module that submits a record. It takes the published definition of the business type (422 `WORKFLOW_NOT_CONFIGURED`), resolves the DoA band when a step uses it (422
   * `DOA_RULE_NOT_FOUND`: the submit rolls back and the record stays a draft), writes the instance Running, pinned to the version and the matrix, and gives the first step its tasks. A record has one running instance (409
   * `WORKFLOW_ALREADY_RUNNING`).
   */
  async start(tx: TenantTx, effects: ApprovalEffects, input: StartInput): Promise<InstanceRecord> {
    const spec = businessTypeOf(input.businessType);
    if (spec === undefined) throw invalid('business_type');
    const [published] = await tx.query<VersionRow>(`select ${VERSION_COLUMNS} from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1 and status = 'Published'`, [input.businessType]);
    if (published === undefined) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    const version = toVersion(published);
    const definition = version.definition as ApprovalWorkflowDefinition;
    let pinned: { matrixVersionId: string; approverRoleId: string; levels: number } | undefined;
    if (definition.steps.some((step) => step.assignee_rule.type === 'DOA')) {
      const resolution = await this.doa.resolve(tx, { documentType: spec.documentType, amountVnd: input.amountVnd ?? '0', unitId: input.unitId, businessDate: vietnamDateOf(input.now) });
      pinned = { matrixVersionId: resolution.matrixVersionId, approverRoleId: resolution.approverRoleId, levels: resolution.approvalLevels };
    }
    let instance: InstanceRecord;
    try {
      const [row] = await tx.query<InstanceRow>(
        `insert into machvon.workflow_instance
           (tenant_id, id, workflow_version_id, resource_type, resource_id, resource_version, status, started_at, business_type, document_type, amount_vnd, unit_id, initiator_membership_id, initiator_user_id, doa_matrix_version_id, doa_approver_role_id, doa_levels, step_entered_seq, temporal_workflow_id)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $14::uuid, $1::uuid, $2, $3::uuid, $4, 'Running', $5::timestamptz, $6, $7, $8::numeric, $9::uuid, m.id, m.user_id, $11::uuid, $12::uuid, $13, 0,
                'appr:' || nullif(current_setting('app.tenant_id', true), '') || ':' || $14
           from machvon.membership m where m.id = $10::uuid
         returning ${INSTANCE_COLUMNS.replaceAll('i.', '').replace('initiator_membership_id as initiator_id', 'initiator_membership_id as initiator_id')}`,
        [version.id, input.resourceType, input.resourceId, input.resourceVersion, input.now.toISOString(), input.businessType, spec.documentType, input.amountVnd, input.unitId, input.initiatorMembershipId, pinned?.matrixVersionId ?? null, pinned?.approverRoleId ?? null, pinned?.levels ?? null, randomUUID()],
      );
      instance = toInstance(row as InstanceRow);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('WORKFLOW_ALREADY_RUNNING', 409, 'resource_id');
      throw error;
    }
    const created = await this.openStep(tx, instance, definition, 0, input.now, new Set());
    await effects.audit({
      action: 'workflow.instance_started',
      resourceType: 'workflow_instance',
      resourceId: instance.id,
      diff: { business_type: input.businessType, resource_type: input.resourceType, resource_id: input.resourceId, workflow_version_id: version.id, revision: version.revision, doa_matrix_version_id: pinned?.matrixVersionId ?? null, tasks: created.length },
    });
    await effects.emit({
      aggregateType: 'workflow_instance',
      aggregateId: instance.id,
      aggregateVersion: 1,
      type: 'adm.workflow_instance.started.v1',
      schemaVersion: 1,
      payload: { instance_id: instance.id, business_type: input.businessType, resource_type: input.resourceType, resource_id: input.resourceId, workflow_version_id: version.id, initiator_id: input.initiatorMembershipId, task_ids: created },
      eventKey: `workflow_instance:${instance.id}:started`,
    });
    return instance;
  }

  /**
   * The published version of a business type that runs `definition`, for a module whose steps are governed as data (WF-1: the governance rules registry holds them). The version in force that already has this definition is
   * the answer; otherwise the definition is published as the next revision and the one in force is superseded, in this transaction. The person who proposed the rule is the author and the person who approved it is the
   * publisher, so the checker of the rule is the checker of the definition (the table refuses the same person in both). Instances that run keep the version they started with.
   */
  async adopt(tx: TenantTx, effects: ApprovalEffects, input: { businessType: string; definition: unknown; proposedBy: string; approvedBy: string; ruleVersion: number; now: Date }): Promise<VersionRecord> {
    assertValidDefinition(input.definition, input.businessType);
    const hash = sha256Hex(canonicalJson(input.definition));
    await tx.query("select pg_advisory_xact_lock(hashtext('workflow-publish:' || current_setting('app.tenant_id', true) || ':' || $1))", [input.businessType]);
    const [inForce] = await tx.query<VersionRow & { definition_hash: string }>(`select ${VERSION_COLUMNS}, definition_hash from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1 and status = 'Published' for update`, [input.businessType]);
    if (inForce !== undefined && inForce.definition_hash === hash) return toVersion(inForce);
    const [latest] = await tx.query<{ revision: number | null }>("select max(revision) as revision from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1", [input.businessType]);
    if (inForce !== undefined) await tx.query("update machvon.workflow_version set status = 'Superseded', version = version + 1 where id = $1::uuid", [inForce.id]);
    const [row] = await tx.query<VersionRow>(
      `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, created_by, last_edited_by, published_by, published_at, effective_from, supersedes_id, definition_hash)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::jsonb, 'Published', 'APPROVAL', $4::uuid, $4::uuid, $5::uuid, $6::timestamptz, $6::timestamptz, $7::uuid, $8) returning ${VERSION_COLUMNS}`,
      [input.businessType, (latest?.revision ?? 0) + 1, JSON.stringify(input.definition), input.proposedBy, input.approvedBy, input.now.toISOString(), inForce?.id ?? null, hash],
    );
    const version = toVersion(row as VersionRow);
    await effects.audit({ action: 'workflow.adopted', resourceType: 'workflow_version', resourceId: version.id, classification: 'INTERNAL', diff: { business_type: version.businessType, revision: version.revision, superseded_id: inForce?.id ?? null, rule_version: input.ruleVersion } });
    await effects.emit({
      aggregateType: 'workflow_version',
      aggregateId: version.id,
      aggregateVersion: version.version,
      type: 'adm.workflow_version.published.v1',
      schemaVersion: 1,
      payload: { workflow_version_id: version.id, business_type: version.businessType, revision: version.revision, superseded_id: inForce?.id ?? null },
      eventKey: `workflow_version:${version.id}:published`,
    });
    return version;
  }

  /** The instance of a record that is running now, or undefined (a record has at most one running instance). */
  async findRunning(tx: TenantTx, resourceType: string, resourceId: string): Promise<InstanceRecord | undefined> {
    const [row] = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from machvon.workflow_instance i where i.resource_type = $1 and i.resource_id = $2::uuid and i.status = 'Running'`, [resourceType, resourceId]);
    return row === undefined ? undefined : toInstance(row);
  }

  /** The instance a record had last, running or not (the one a screen shows beside the record). */
  async findLatest(tx: TenantTx, resourceType: string, resourceId: string): Promise<InstanceRecord | undefined> {
    const [row] = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from machvon.workflow_instance i where i.resource_type = $1 and i.resource_id = $2::uuid order by i.started_at desc, i.id desc limit 1`, [resourceType, resourceId]);
    return row === undefined ? undefined : toInstance(row);
  }

  /** The definition an instance runs by, as it was published when the instance started. */
  async definitionOf(tx: TenantTx, instance: InstanceRecord): Promise<ApprovalWorkflowDefinition> {
    const [row] = await tx.query<{ definition_json: unknown }>('select definition_json from machvon.workflow_version where id = $1::uuid', [instance.workflowVersionId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row.definition_json as ApprovalWorkflowDefinition;
  }

  /** Every task of an instance, the first step first (those the viewer is not allowed to see are left out unless `all`). */
  async tasksOf(tx: TenantTx, instanceId: string): Promise<TaskRecord[]> {
    const rows = await tx.query<TaskRow>(`select ${TASK_COLUMNS} from ${TASK_FROM} where t.workflow_instance_id = $1::uuid order by t.step_index, t.created_at, t.id`, [instanceId]);
    return rows.map(toTask);
  }

  /** The pending task of an instance that this member may decide: their own, or one whose assignee delegated approval.decide to them for the unit of the instance. */
  async pendingTaskFor(tx: TenantTx, instance: InstanceRecord, membershipId: string): Promise<TaskRecord | undefined> {
    const rows = await tx.query<TaskRow>(
      `select ${taskColumns(delegatedTo('$2', 't.assignee_id', 'i.unit_id', 'now()'))} from ${TASK_FROM} where t.workflow_instance_id = $1::uuid and t.status = 'Pending' order by t.due_at, t.id`,
      [instance.id, membershipId],
    );
    return rows.map(toTask).find((task) => task.assigneeId === membershipId || task.delegatedToMe);
  }

  /** `ApprovalService.cancel`: the module withdrew the record. The running instance ends Cancelled and its open tasks with it; with no running instance nothing happens (false). */
  async cancel(tx: TenantTx, effects: ApprovalEffects, input: { resourceType: string; resourceId: string; reason: string; now: Date }): Promise<boolean> {
    const [row] = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from machvon.workflow_instance i where i.resource_type = $1 and i.resource_id = $2::uuid and i.status = 'Running' for update`, [input.resourceType, input.resourceId]);
    if (row === undefined) return false;
    await this.endCancelled(tx, effects, toInstance(row), input.reason, input.now, 'MODULE');
    return true;
  }

  /** `cancelWorkflowInstance` (ADM-18): an operator ends a running instance with a reason. 409 `WORKFLOW_STATE_INVALID` when it is not running, 409 `VERSION_CONFLICT` when it changed since the operator read it. The record in the owning module is not touched: the event tells the module. */
  async cancelInstance(tx: TenantTx, effects: ApprovalEffects, input: { instanceId: string; expectedVersion: number; reason: string; now: Date }): Promise<InstanceRecord> {
    const [row] = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from machvon.workflow_instance i where i.id = $1::uuid for update`, [input.instanceId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const instance = toInstance(row);
    if (instance.status !== 'Running') throw new DomainError('WORKFLOW_STATE_INVALID', 409, 'status');
    if (instance.version !== input.expectedVersion) throw versionConflict(instance.version);
    await this.endCancelled(tx, effects, instance, input.reason, input.now, 'OPERATOR');
    return (await this.findInstance(tx, instance.id)) ?? instance;
  }

  private async endCancelled(tx: TenantTx, effects: ApprovalEffects, instance: InstanceRecord, reason: string, now: Date, by: 'MODULE' | 'OPERATOR'): Promise<void> {
    await tx.query("update machvon.approval_task set status = 'Cancelled', version = version + 1 where workflow_instance_id = $1::uuid and status = 'Pending'", [instance.id]);
    await tx.query("update machvon.workflow_instance set status = 'Cancelled', outcome = 'CANCELLED', ended_at = $2::timestamptz, version = version + 1 where id = $1::uuid", [instance.id, now.toISOString()]);
    await effects.audit({ action: 'workflow.instance_cancelled', resourceType: 'workflow_instance', resourceId: instance.id, reason, diff: { business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, by } });
    await effects.emit({
      aggregateType: 'workflow_instance',
      aggregateId: instance.id,
      aggregateVersion: instance.version + 1,
      type: 'adm.workflow_instance.cancelled.v1',
      schemaVersion: 1,
      payload: { instance_id: instance.id, business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, outcome: 'CANCELLED', by },
      eventKey: `workflow_instance:${instance.id}:cancelled`,
    });
  }

  // ---- deciding a task ---------------------------------------------------------------------------------------------------------------

  /**
   * `decideApprovalTask` (ADM 3.7 item 5). The task and its instance are locked; the task has to be pending (409 `TASK_ALREADY_DECIDED`) at the version read; the caller is the assignee or a person the assignee delegated to
   * (403 `APPROVER_NOT_AUTHORIZED`); the maker is never the checker, judged on the user account (BR-ADM-02): the task then goes to another eligible person and the refusal is answered after that is committed. The DoA band
   * is judged again against the grants as they are now. The decision may move the instance to its next step, send it back to an earlier one, or end it by calling the final command with a key that makes a retry harmless.
   */
  async decide(tx: TenantTx, effects: ApprovalEffects, input: DecideInput): Promise<DecisionResult> {
    // The instance is locked before any of its tasks, as `cancel` does, so that decisions on different tasks of one instance wait for one another and never for each other's rows.
    const [peek] = await tx.query<{ workflow_instance_id: string }>('select workflow_instance_id from machvon.approval_task where id = $1::uuid', [input.taskId]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query('select id from machvon.workflow_instance where id = $1::uuid for update', [peek.workflow_instance_id]);
    const [locked] = await tx.query<TaskRow & { instance_row: never }>(`select ${TASK_COLUMNS} from ${TASK_FROM} where t.id = $1::uuid for update of t`, [input.taskId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const task = toTask(locked);
    const [instanceRow] = await tx.query<InstanceRow & { definition_json: unknown; step_entered_seq: number }>(
      `select ${INSTANCE_COLUMNS}, v.definition_json, i.step_entered_seq from machvon.workflow_instance i join machvon.workflow_version v on v.tenant_id = i.tenant_id and v.id = i.workflow_version_id where i.id = $1::uuid`,
      [task.workflowInstanceId],
    );
    const instance = toInstance(instanceRow as InstanceRow);
    const definition = (instanceRow as { definition_json: unknown }).definition_json as ApprovalWorkflowDefinition;
    if (task.status !== 'Pending' || instance.status !== 'Running') throw new DomainError('TASK_ALREADY_DECIDED', 409, 'status');
    if (task.version !== input.expectedVersion) throw versionConflict(task.version);
    const step = definition.steps[task.stepIndex];
    if (step === undefined) throw new DomainError('WORKFLOW_DEFINITION_INVALID', 422, '$.steps');
    if (input.decision !== 'approve' && (input.reason === undefined || input.reason.trim().length < 10)) throw invalid('reason');

    // Who decides: the assignee, or the person the assignee delegated the decision to.
    const caller = effects.actor;
    let onBehalfOf: string | null = null;
    let delegationId: string | null = null;
    if (task.assigneeId !== caller) {
      const [delegation] = await tx.query<{ id: string }>(
        `select d.id from machvon.delegation_grant d
          where d.delegator_membership_id = $1::uuid and d.delegate_membership_id = $2::uuid and d.status = 'Active' and d.valid_from <= $3::timestamptz and $3::timestamptz < d.valid_until
            and exists (select 1 from unnest(d.permissions) p where p = $4 or p = 'approval.*' or p = '*')
            and ${SCOPE_CONTAINS_UNIT("d.scope_json->>'kind'", "array(select jsonb_array_elements_text(coalesce(d.scope_json->'ref_ids', '[]'::jsonb))::uuid)", '$5')}
          order by d.valid_from desc limit 1`,
        [task.assigneeId, caller, input.now.toISOString(), DECIDE_PERMISSION, instance.unitId],
      );
      if (delegation === undefined) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'assignee');
      onBehalfOf = task.assigneeId;
      delegationId = delegation.id;
    }

    // The maker is not the checker, by the person and not by the membership (BR-ADM-02).
    const users = await tx.query<{ id: string; user_id: string }>('select id, user_id from machvon.membership where id = any($1::uuid[])', [[instance.initiatorId, caller, task.assigneeId]]);
    const userOf = (membershipId: string): string | undefined => users.find((row) => row.id === membershipId)?.user_id;
    const initiatorUser = userOf(instance.initiatorId);
    if (initiatorUser !== undefined && (userOf(caller) === initiatorUser || userOf(task.assigneeId) === initiatorUser)) {
      // The task goes to someone else only when the maker holds it themself; a maker who only tries to decide for the assignee is refused, and the assignee keeps the task.
      const reassignedTo = userOf(task.assigneeId) === initiatorUser ? await this.reassign(tx, effects, instance, definition, task, new Set([initiatorUser]), input.now) : null;
      return { kind: 'SELF_APPROVAL', task, reassignedTo };
    }

    // The grants as they are now: a band or a role the approver no longer holds is not decided under.
    const authority = await loadAccessIn(tx, onBehalfOf ?? caller);
    const place = await this.placeOf(tx, instance.unitId);
    if (!(await this.authorised(tx, step, instance, authority, place, input.now, task.escalatedFromId !== null))) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'approver');

    // One person is one approval in a step: someone who already decided in this step (as themselves or for another assignee) does not decide again.
    const [already] = await tx.query<{ n: string }>(
      "select count(*)::text as n from machvon.approval_task t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = t.decided_by where t.workflow_instance_id = $1::uuid and t.step_index = $2 and t.status = 'Decided' and t.decision_seq > $3::integer and m.user_id = $4::uuid",
      [instance.id, task.stepIndex, (instanceRow as { step_entered_seq: number }).step_entered_seq, userOf(caller) ?? randomUUID()],
    );
    if (Number(already?.n ?? 0) > 0) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'already_decided');
    // A DoA step is approved by people who did not approve the steps before it (the tasks were given that way): a delegation does not let the same person in again.
    const callerUser = userOf(caller);
    if (step.assignee_rule.type === 'DOA' && callerUser !== undefined && (await this.previousApprovers(tx, instance.id, definition, task.stepIndex)).has(callerUser)) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'approved_earlier');

    const sequence = instance.decisionSeq + 1;
    const reason = input.reason === undefined || input.reason.trim() === '' ? null : input.reason.trim();
    await tx.query(
      `update machvon.approval_task set status = 'Decided', decision = $2, reason = $3, decided_at = $4::timestamptz, decided_by = $5::uuid, on_behalf_of_id = $6::uuid, delegation_id = $7::uuid, return_to_step = $8, decision_seq = $9::integer, version = version + 1 where id = $1::uuid`,
      [task.id, input.decision, reason, input.now.toISOString(), caller, onBehalfOf, delegationId, input.returnToStep ?? null, sequence],
    );
    await tx.query('update machvon.workflow_instance set decision_seq = $2, version = version + 1 where id = $1::uuid', [instance.id, sequence]);
    const [counted] = await tx.query<{ approvals: string }>(
      "select count(distinct m.user_id)::text as approvals from machvon.approval_task t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = t.decided_by where t.workflow_instance_id = $1::uuid and t.step_index = $2 and t.status = 'Decided' and t.decision = 'approve' and t.decision_seq > $3::integer",
      [instance.id, task.stepIndex, (instanceRow as { step_entered_seq: number }).step_entered_seq],
    );
    const next = advanceWorkflow(definition, task.stepIndex, input.decision, Number(counted?.approvals ?? 0), instance.doaLevels ?? undefined, input.returnToStep);

    const created: string[] = [];
    let stepResult: 'STAYED' | 'NEXT_STEP' | 'RETURNED_TO_STEP' | 'COMPLETED' = 'STAYED';
    let outcome: string | null = null;
    let finalCommand: string | null = null;
    if (next.kind === 'NEXT_STEP' || next.kind === 'RETURN_TO_STEP') {
      await tx.query("update machvon.approval_task set status = 'Cancelled', version = version + 1 where workflow_instance_id = $1::uuid and status = 'Pending'", [instance.id]);
      await tx.query('update machvon.workflow_instance set current_step = $2, step_entered_seq = $3::integer where id = $1::uuid', [instance.id, next.stepIndex, sequence]);
      const approvers = await this.previousApprovers(tx, instance.id, definition, next.stepIndex);
      created.push(...(await this.openStep(tx, { ...instance, currentStep: next.stepIndex }, definition, next.stepIndex, input.now, approvers)));
      stepResult = next.kind === 'NEXT_STEP' ? 'NEXT_STEP' : 'RETURNED_TO_STEP';
    } else if (next.kind === 'COMPLETE') {
      await tx.query("update machvon.approval_task set status = 'Cancelled', version = version + 1 where workflow_instance_id = $1::uuid and status = 'Pending'", [instance.id]);
      finalCommand = definition.terminal[next.outcome === 'APPROVED' ? 'approved' : next.outcome === 'RETURNED' ? 'returned' : 'rejected'];
      // The domain's own transition table is the guard (BR-ADM-07): when it refuses, the record is left as it was and the instance says so.
      const applied = await input.finish({ tx, instance: { ...instance, decisionSeq: sequence }, outcome: next.outcome, command: finalCommand, idempotencyKey: finalCommandKey(instance.id, sequence), effects });
      outcome = applied === 'APPLIED' ? next.outcome : 'GUARD_REJECTED';
      await tx.query("update machvon.workflow_instance set status = 'Completed', outcome = $2, ended_at = $3::timestamptz, version = version + 1 where id = $1::uuid", [instance.id, outcome, input.now.toISOString()]);
      stepResult = 'COMPLETED';
    }

    const decided = await this.findTask(tx, task.id);
    const after = await this.findInstance(tx, instance.id);
    await effects.emit({
      aggregateType: 'approval_task',
      aggregateId: task.id,
      aggregateVersion: task.version + 1,
      type: 'adm.approval_task.decided.v1',
      schemaVersion: 1,
      payload: { task_id: task.id, instance_id: instance.id, business_type: instance.businessType, step_id: task.stepId, decision: input.decision, decided_by: caller, on_behalf_of: onBehalfOf, resource_type: instance.resourceType, resource_id: instance.resourceId },
      eventKey: `approval_task:${task.id}:decided`,
    });
    if (stepResult === 'COMPLETED') {
      await effects.emit({
        aggregateType: 'workflow_instance',
        aggregateId: instance.id,
        aggregateVersion: instance.version + 2,
        type: 'adm.workflow_instance.completed.v1',
        schemaVersion: 1,
        payload: { instance_id: instance.id, business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, outcome, command: finalCommand, idempotency_key: finalCommandKey(instance.id, sequence) },
        eventKey: `workflow_instance:${instance.id}:completed`,
      });
      if (outcome === 'GUARD_REJECTED') {
        // An alert for the operators: the module refused the end of an approval that was granted.
        await effects.emit({
          aggregateType: 'workflow_instance',
          aggregateId: instance.id,
          aggregateVersion: instance.version + 2,
          type: 'adm.workflow_guard_rejected.v1',
          schemaVersion: 1,
          payload: { instance_id: instance.id, business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, command: finalCommand },
          eventKey: `workflow_instance:${instance.id}:guard_rejected`,
        });
      }
    }
    return { kind: 'DECIDED', task: decided ?? task, instance: after ?? instance, step: stepResult, outcome, finalCommand, createdTaskIds: created };
  }

  // ---- the operations on a running approval (ADM-18) -----------------------------------------------------------------------------------

  /**
   * `reassignApprovalTask` (ADM 3.7 item 8): an operator gives a pending task to another person. The new assignee has to be able to decide it as the step asks, as the grants are now (403 `APPROVER_NOT_AUTHORIZED`), and is
   * never the maker (403 `SELF_APPROVAL_DENIED`). The old task is Reassigned; the new one is Pending with the same deadline and the same clock. 409 `TASK_ALREADY_DECIDED` when the task is no longer pending, 409
   * `VERSION_CONFLICT` when it changed since the operator read it.
   */
  async reassignTask(tx: TenantTx, effects: ApprovalEffects, input: { taskId: string; expectedVersion: number; newAssignee: string; reason: string; now: Date }): Promise<{ from: TaskRecord; task: TaskRecord }> {
    const [peek] = await tx.query<{ workflow_instance_id: string }>('select workflow_instance_id from machvon.approval_task where id = $1::uuid', [input.taskId]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query('select id from machvon.workflow_instance where id = $1::uuid for update', [peek.workflow_instance_id]);
    const [locked] = await tx.query<TaskRow>(`select ${TASK_COLUMNS} from ${TASK_FROM} where t.id = $1::uuid for update of t`, [input.taskId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const task = toTask(locked);
    const { instance, definition, stepEnteredSeq } = await this.instanceOf(tx, task.workflowInstanceId);
    if (task.status !== 'Pending' || instance.status !== 'Running') throw new DomainError('TASK_ALREADY_DECIDED', 409, 'status');
    if (task.version !== input.expectedVersion) throw versionConflict(task.version);
    if (input.newAssignee === task.assigneeId) throw invalid('new_assignee_membership_id');
    const step = definition.steps[task.stepIndex];
    if (step === undefined) throw new DomainError('WORKFLOW_DEFINITION_INVALID', 422, '$.steps');
    const verdict = await this.canHold(tx, step, instance, definition, task.stepIndex, stepEnteredSeq, input.newAssignee, input.now);
    if (verdict === 'UNKNOWN') throw invalid('new_assignee_membership_id');
    if (verdict === 'MAKER') throw new DomainError('SELF_APPROVAL_DENIED', 403, 'new_assignee_membership_id');
    if (verdict !== 'OK') throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'new_assignee_membership_id', { extensions: { cause: verdict } });

    await tx.query("update machvon.approval_task set status = 'Reassigned', reason = $2, version = version + 1 where id = $1::uuid", [task.id, input.reason.trim()]);
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, remind_at, reminded_at, next_reminder_at, overdue_reminders, escalated_at, escalated_from_task_id, reassigned_from_task_id, step_id, step_index, status)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, due_at, remind_at, reminded_at, next_reminder_at, overdue_reminders, escalated_at, escalated_from_task_id, id, step_id, step_index, 'Pending' from machvon.approval_task where id = $3::uuid returning id`,
      [instance.id, input.newAssignee, task.id],
    );
    const created = row?.id as string;
    await effects.audit({ action: 'approval.reassigned', resourceType: 'approval_task', resourceId: task.id, reason: input.reason.trim(), diff: { instance_id: instance.id, step_id: task.stepId, from_membership_id: task.assigneeId, to_membership_id: input.newAssignee, new_task_id: created } });
    await effects.emit({
      aggregateType: 'approval_task',
      aggregateId: task.id,
      aggregateVersion: task.version + 1,
      type: 'adm.approval_task.reassigned.v1',
      schemaVersion: 1,
      payload: { task_id: task.id, new_task_id: created, instance_id: instance.id, from_membership_id: task.assigneeId, to_membership_id: input.newAssignee, reason: 'OPERATOR', due_at: task.dueAt },
      eventKey: `approval_task:${task.id}:reassigned`,
    });
    const from = (await this.findTask(tx, task.id)) ?? task;
    return { from, task: (await this.findTask(tx, created)) as TaskRecord };
  }

  private async instanceOf(tx: TenantTx, instanceId: string): Promise<{ instance: InstanceRecord; definition: ApprovalWorkflowDefinition; stepEnteredSeq: number }> {
    const [row] = await tx.query<InstanceRow & { definition_json: unknown; step_entered_seq: number }>(
      `select ${INSTANCE_COLUMNS}, v.definition_json, i.step_entered_seq from machvon.workflow_instance i join machvon.workflow_version v on v.tenant_id = i.tenant_id and v.id = i.workflow_version_id where i.id = $1::uuid`,
      [instanceId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { instance: toInstance(row), definition: row.definition_json as ApprovalWorkflowDefinition, stepEnteredSeq: row.step_entered_seq };
  }

  /**
   * Whether a member may be given a task of this step now: they exist, are not the maker (judged on the person), are not in the step already (a task open or an approval given since the step was entered), did not approve
   * a step before a DoA step, and hold the authority the step asks for as their grants are now.
   */
  private async canHold(tx: TenantTx, step: WorkflowStep, instance: InstanceRecord, definition: ApprovalWorkflowDefinition, stepIndex: number, stepEnteredSeq: number, membershipId: string, now: Date, escalating = false): Promise<'OK' | 'UNKNOWN' | 'MAKER' | 'IN_STEP' | 'APPROVED_EARLIER' | 'NOT_AUTHORISED'> {
    const user = await this.userOf(tx, membershipId);
    if (user === undefined) return 'UNKNOWN';
    if (user === (await this.userOf(tx, instance.initiatorId))) return 'MAKER';
    const [inStep] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.approval_task t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = coalesce(t.decided_by, t.assignee_id)
        where t.workflow_instance_id = $1::uuid and t.step_index = $2 and m.user_id = $4::uuid and (t.status = 'Pending' or (t.status = 'Decided' and t.decision_seq > $3::integer))`,
      [instance.id, stepIndex, stepEnteredSeq, user],
    );
    if (Number(inStep?.n ?? 0) > 0) return 'IN_STEP';
    if (step.assignee_rule.type === 'DOA' && (await this.previousApprovers(tx, instance.id, definition, stepIndex)).has(user)) return 'APPROVED_EARLIER';
    const access = await loadAccessIn(tx, membershipId);
    return (await this.authorised(tx, step, instance, access, await this.placeOf(tx, instance.unitId), now, escalating)) ? 'OK' : 'NOT_AUTHORISED';
  }

  // ---- the SLA of the open tasks (ADM 3.7 item 4) ----------------------------------------------------------------------------------------

  /**
   * One pass of the SLA over the open tasks of the tenant, the oldest deadline first, at most `SLA_PASS_LIMIT`: a reminder at 80 percent of the working time; at the deadline what the step says (REMIND: a reminder every working day,
   * ESCALATE: the task is also given to the step's escalation target, once, EXPIRE: the task expires, and the instance with it when the step can no longer reach the approvals it needs). Every task is judged under the lock of its
   * instance and is left to the next pass when a command holds that lock, so a pass and a decision never undo each other. A pass repeated at the same time changes nothing.
   */
  async sweepSla(tx: TenantTx, effects: ApprovalEffects, now: Date): Promise<SlaSweepResult> {
    const result: SlaSweepResult = { reminded: 0, overdueReminded: 0, breached: 0, escalated: 0, escalationFailed: 0, expired: 0, instancesExpired: 0, open: 0, overdue: 0 };
    const candidates = await tx.query<{ id: string; workflow_instance_id: string }>(
      `select t.id, t.workflow_instance_id from machvon.approval_task t join machvon.workflow_instance i on i.tenant_id = t.tenant_id and i.id = t.workflow_instance_id
        where t.status = 'Pending' and i.status = 'Running' and ((t.reminded_at is null and t.remind_at <= $1::timestamptz) or t.due_at <= $1::timestamptz) and (t.next_reminder_at is null or t.next_reminder_at <= $1::timestamptz)
        order by t.due_at, t.id limit $2::int`,
      [now.toISOString(), SLA_PASS_LIMIT],
    );
    for (const candidate of candidates) {
      // The instance first, as a decision does; one that a command holds is left to the next pass.
      const [free] = await tx.query<{ id: string }>('select id from machvon.workflow_instance where id = $1::uuid and status = \'Running\' for update skip locked', [candidate.workflow_instance_id]);
      if (free === undefined) continue;
      const [locked] = await tx.query<TaskRow>(`select ${TASK_COLUMNS} from ${TASK_FROM} where t.id = $1::uuid and t.status = 'Pending' for update of t`, [candidate.id]);
      if (locked === undefined) continue;
      await this.judge(tx, effects, toTask(locked), now, result);
    }
    const [counts] = await tx.query<{ open: string; overdue: string }>("select count(*)::text as open, (count(*) filter (where due_at <= $1::timestamptz))::text as overdue from machvon.approval_task where status = 'Pending'", [now.toISOString()]);
    result.open = Number(counts?.open ?? 0);
    result.overdue = Number(counts?.overdue ?? 0);
    return result;
  }

  private async judge(tx: TenantTx, effects: ApprovalEffects, task: TaskRecord, now: Date, result: SlaSweepResult): Promise<void> {
    const [clockRow] = await tx.query<{ remind_at: string | null; reminded_at: string | null; next_reminder_at: string | null; escalated_at: string | null }>(
      `select ${TIME('remind_at')} as remind_at, ${TIME('reminded_at')} as reminded_at, ${TIME('next_reminder_at')} as next_reminder_at, ${TIME('escalated_at')} as escalated_at from machvon.approval_task where id = $1::uuid`,
      [task.id],
    );
    const at = (value: string | null | undefined): Date | null => (value === null || value === undefined ? null : new Date(value));
    const { instance, definition, stepEnteredSeq } = await this.instanceOf(tx, task.workflowInstanceId);
    const step = definition.steps[task.stepIndex];
    if (step === undefined) return;
    const action: ApprovalSlaAction = slaAction({ remindAt: at(clockRow?.remind_at), remindedAt: at(clockRow?.reminded_at), dueAt: new Date(task.dueAt), nextReminderAt: at(clockRow?.next_reminder_at), escalatedAt: at(clockRow?.escalated_at) }, step.on_timeout, now);
    // `notification.recipients` is what the notification service reads to know who to tell: the approver the task is given to (the channels they get it on are the tenant's notification workflow).
    const subject = { task_id: task.id, instance_id: instance.id, business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, step_id: task.stepId, assignee_id: task.assigneeId, due_at: task.dueAt, notification: { recipients: [task.assigneeId] } };
    const remind = async (kind: 'BEFORE_DUE' | 'OVERDUE', extra: Record<string, unknown> = {}): Promise<void> => {
      const sent = task.overdueReminders + (kind === 'OVERDUE' ? 1 : 0);
      if (kind === 'BEFORE_DUE') await tx.query('update machvon.approval_task set reminded_at = $2::timestamptz where id = $1::uuid', [task.id, now.toISOString()]);
      else {
        const next = await this.dueOf(tx, WORKING_DAY_MINUTES, now);
        await tx.query('update machvon.approval_task set reminded_at = coalesce(reminded_at, $2::timestamptz), next_reminder_at = $3::timestamptz, overdue_reminders = overdue_reminders + 1 where id = $1::uuid', [task.id, now.toISOString(), next.toISOString()]);
      }
      await effects.emit({ aggregateType: 'approval_task', aggregateId: task.id, aggregateVersion: task.version, type: 'adm.approval_task.reminded.v1', schemaVersion: 1, payload: { ...subject, kind, ...extra }, eventKey: `approval_task:${task.id}:reminded:${kind === 'BEFORE_DUE' ? 0 : sent}` });
      if (kind === 'BEFORE_DUE') result.reminded += 1;
      else result.overdueReminded += 1;
    };
    const clockEscalated = clockRow?.escalated_at !== null && clockRow?.escalated_at !== undefined;
    // A task that was escalated is counted once, when it escalated; the task it escalated to is a task of its own and is counted when its own deadline passes.
    if (action === 'EXPIRE' || action === 'ESCALATE' || (action === 'OVERDUE_REMIND' && task.overdueReminders === 0 && !(clockEscalated && task.escalatedFromId === null))) result.breached += 1;
    switch (action) {
      case 'NONE':
        return;
      case 'REMIND_BEFORE_DUE':
        await remind('BEFORE_DUE');
        return;
      case 'OVERDUE_REMIND':
        await remind('OVERDUE');
        return;
      case 'ESCALATE': {
        const target = step.escalate_to as string;
        const verdict = await this.canHold(tx, step, instance, definition, task.stepIndex, stepEnteredSeq, target, now, true);
        const next = await this.dueOf(tx, WORKING_DAY_MINUTES, now);
        // Whether it worked or not, the escalation is tried once: a target who cannot hold the task is said so and the task goes on being reminded.
        await tx.query('update machvon.approval_task set escalated_at = $2::timestamptz, next_reminder_at = $3::timestamptz where id = $1::uuid', [task.id, now.toISOString(), next.toISOString()]);
        // Several tasks of a step share one target: the first to be late gives them the task, and for the others there is nothing more to give.
        if (verdict === 'IN_STEP') return;
        if (verdict !== 'OK') {
          await effects.audit({ action: 'approval.escalation_failed', resourceType: 'approval_task', resourceId: task.id, diff: { instance_id: instance.id, step_id: task.stepId, escalate_to: target, cause: verdict } });
          await effects.emit({ aggregateType: 'approval_task', aggregateId: task.id, aggregateVersion: task.version, type: 'adm.approval_task.reminded.v1', schemaVersion: 1, payload: { ...subject, kind: 'OVERDUE', escalation_failed: verdict }, eventKey: `approval_task:${task.id}:reminded:escalation` });
          result.escalationFailed += 1;
          return;
        }
        const minutes = Math.max(1, Math.round(step.sla_working_hours * 60));
        const { due, remind: remindAt } = await this.clockOf(tx, minutes, now);
        const [row] = await tx.query<{ id: string }>(
          `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, remind_at, escalated_at, escalated_from_task_id, step_id, step_index, status)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::uuid, $7, $8, 'Pending') returning id`,
          [instance.id, target, due.toISOString(), remindAt.toISOString(), now.toISOString(), task.id, task.stepId, task.stepIndex],
        );
        await effects.audit({ action: 'approval.escalated', resourceType: 'approval_task', resourceId: task.id, diff: { instance_id: instance.id, step_id: task.stepId, escalated_to: target, new_task_id: row?.id } });
        await effects.emit({ aggregateType: 'approval_task', aggregateId: task.id, aggregateVersion: task.version, type: 'adm.approval_task.escalated.v1', schemaVersion: 1, payload: { ...subject, new_task_id: row?.id, escalated_to: target }, eventKey: `approval_task:${task.id}:escalated` });
        result.escalated += 1;
        return;
      }
      case 'EXPIRE': {
        await tx.query("update machvon.approval_task set status = 'Expired', version = version + 1 where id = $1::uuid", [task.id]);
        await effects.audit({ action: 'approval.task_expired', resourceType: 'approval_task', resourceId: task.id, diff: { instance_id: instance.id, step_id: task.stepId, due_at: task.dueAt } });
        await effects.emit({ aggregateType: 'approval_task', aggregateId: task.id, aggregateVersion: task.version + 1, type: 'adm.approval_task.expired.v1', schemaVersion: 1, payload: subject, eventKey: `approval_task:${task.id}:expired` });
        result.expired += 1;
        // The step is lost when the approvals given and the tasks still open cannot reach what it needs.
        const [given] = await tx.query<{ approvals: string }>(
          "select count(distinct m.user_id)::text as approvals from machvon.approval_task t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = t.decided_by where t.workflow_instance_id = $1::uuid and t.step_index = $2 and t.status = 'Decided' and t.decision = 'approve' and t.decision_seq > $3::integer",
          [instance.id, task.stepIndex, stepEnteredSeq],
        );
        const [open] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.approval_task where workflow_instance_id = $1::uuid and step_index = $2 and status = 'Pending'", [instance.id, task.stepIndex]);
        if (Number(given?.approvals ?? 0) + Number(open?.n ?? 0) >= requiredApprovals(step, instance.doaLevels ?? undefined)) return;
        await tx.query("update machvon.approval_task set status = 'Cancelled', version = version + 1 where workflow_instance_id = $1::uuid and status = 'Pending'", [instance.id]);
        await tx.query("update machvon.workflow_instance set status = 'Completed', outcome = 'EXPIRED', ended_at = $2::timestamptz, version = version + 1 where id = $1::uuid", [instance.id, now.toISOString()]);
        await effects.audit({ action: 'workflow.instance_expired', resourceType: 'workflow_instance', resourceId: instance.id, diff: { business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, step_id: task.stepId } });
        await effects.emit({
          aggregateType: 'workflow_instance',
          aggregateId: instance.id,
          aggregateVersion: instance.version + 1,
          type: 'adm.workflow_instance.completed.v1',
          schemaVersion: 1,
          payload: { instance_id: instance.id, business_type: instance.businessType, resource_type: instance.resourceType, resource_id: instance.resourceId, outcome: 'EXPIRED', command: null },
          eventKey: `workflow_instance:${instance.id}:completed`,
        });
        result.instancesExpired += 1;
        return;
      }
    }
  }

  /** Gives a task that the maker would decide to another eligible person (never the maker, never the one who tried), with the same due time. Returns the member it went to, or null when there is none. */
  private async reassign(tx: TenantTx, effects: ApprovalEffects, instance: InstanceRecord, definition: ApprovalWorkflowDefinition, task: TaskRecord, excludedUsers: ReadonlySet<string>, now: Date): Promise<string | null> {
    const step = definition.steps[task.stepIndex] as WorkflowStep;
    const taken = await tx.query<{ assignee_id: string }>("select assignee_id from machvon.approval_task where workflow_instance_id = $1::uuid and step_id = $2 and status in ('Pending', 'Decided')", [instance.id, task.stepId]);
    const candidates = await this.eligible(tx, step, instance, excludedUsers, now);
    const chosen = candidates.find((membershipId) => !taken.some((row) => row.assignee_id === membershipId));
    if (chosen === undefined) return null;
    await tx.query("update machvon.approval_task set status = 'Reassigned', version = version + 1 where id = $1::uuid", [task.id]);
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, remind_at, reminded_at, next_reminder_at, overdue_reminders, escalated_at, escalated_from_task_id, reassigned_from_task_id, step_id, step_index, status)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, due_at, remind_at, reminded_at, next_reminder_at, overdue_reminders, escalated_at, escalated_from_task_id, id, $4::text, $5::integer, 'Pending' from machvon.approval_task where id = $3::uuid returning id`,
      [instance.id, chosen, task.id, task.stepId, task.stepIndex],
    );
    await effects.emit({
      aggregateType: 'approval_task',
      aggregateId: task.id,
      aggregateVersion: task.version + 1,
      type: 'adm.approval_task.reassigned.v1',
      schemaVersion: 1,
      payload: { task_id: task.id, new_task_id: row?.id, instance_id: instance.id, from_membership_id: task.assigneeId, to_membership_id: chosen, reason: 'SELF_APPROVAL' },
      eventKey: `approval_task:${task.id}:reassigned`,
    });
    return chosen;
  }

  // ---- steps and approvers -----------------------------------------------------------------------------------------------------------

  /**
   * The people who approved the steps before `belowIndex` in the traversal the instance is in now. The decisions are replayed in order: an approval counts for its step, and a return to an earlier step takes back the
   * approvals of that step and of every step after it (they will be given again).
   */
  private async previousApprovers(tx: TenantTx, instanceId: string, definition: ApprovalWorkflowDefinition, belowIndex: number): Promise<Set<string>> {
    const rows = await tx.query<{ step_index: number; decision: string; return_to_step: string | null; user_id: string }>(
      "select t.step_index, t.decision, t.return_to_step, m.user_id from machvon.approval_task t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = t.decided_by where t.workflow_instance_id = $1::uuid and t.status = 'Decided' and t.decision in ('approve', 'return') order by t.decision_seq, t.id",
      [instanceId],
    );
    const valid: Array<{ stepIndex: number; user: string }> = [];
    for (const row of rows) {
      if (row.decision === 'approve') valid.push({ stepIndex: row.step_index, user: row.user_id });
      else {
        const target = definition.steps.findIndex((step) => step.id === row.return_to_step);
        if (target >= 0) for (let at = valid.length - 1; at >= 0; at -= 1) if ((valid[at] as { stepIndex: number }).stepIndex >= target) valid.splice(at, 1);
      }
    }
    return new Set(valid.filter((entry) => entry.stepIndex < belowIndex).map((entry) => entry.user));
  }

  private async placeOf(tx: TenantTx, unitId: string): Promise<ResourceRef> {
    const [unit] = await tx.query<{ path: string }>('select path from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (unit === undefined) throw invalid('unit_id');
    return { ownerUnitPath: unit.path, ownerUnitId: unitId };
  }

  /** Whether the approver, with the grants they hold now, may decide a task of this step of this instance. */
  private async authorised(tx: TenantTx, step: WorkflowStep, instance: InstanceRecord, access: EffectiveAccess, place: ResourceRef, now: Date, escalating = false): Promise<boolean> {
    if (!access.membershipActive) return false;
    const rule = step.assignee_rule;
    // Whatever names the approver, the right to decide has to be held over the place of the approval, or the decision is refused at the door and the step can never finish.
    if (!withinDelegation(access, now, DECIDE_PERMISSION, place, 0)) return false;
    // The person the step escalates to is named by the definition itself, which a second administrator published: they decide the task they were escalated, whatever the rule of the step says of the first assignee. Only for an
    // escalation: when the step opens, or an operator reassigns an ordinary task, the rule of the step holds for them as for anyone.
    if (escalating && step.escalate_to !== undefined && step.escalate_to === access.membershipId) return true;
    if (rule.type === 'SPECIFIC') return (rule.membership_ids ?? []).includes(access.membershipId);
    if (rule.type === 'ROLE_IN_UNIT') {
      const unit = await this.placeOf(tx, rule.unit_id as string);
      return activeGrants(access, now).some((grant) => grant.roleCode === rule.role_code && scopeContains(grant.scope, unit));
    }
    const [role] = await tx.query<{ rank: number }>('select rank from machvon.role_definition where id = $1::uuid', [instance.doaApproverRoleId]);
    return role !== undefined && withinDelegation(access, now, DECIDE_PERMISSION, place, role.rank);
  }

  /** The members who may be given a task of this step now, by membership id, in a stable order; the people in `excludedUsers` (the maker, an earlier approver) are left out, and so is any membership of theirs. */
  private async eligible(tx: TenantTx, step: WorkflowStep, instance: InstanceRecord, excludedUsers: ReadonlySet<string>, now: Date): Promise<string[]> {
    const rule = step.assignee_rule;
    let candidates: Array<{ id: string; user_id: string }>;
    if (rule.type === 'SPECIFIC') {
      candidates = await tx.query<{ id: string; user_id: string }>("select id, user_id from machvon.membership where id = any($1::uuid[]) and status = 'Active' order by id", [rule.membership_ids ?? []]);
    } else {
      // Anyone who holds a grant of the right kind now; the scope is judged below with the same functions the commands use.
      candidates = await tx.query<{ id: string; user_id: string }>(
        `select distinct m.id, m.user_id from machvon.membership m join machvon.role_grant g on g.tenant_id = m.tenant_id and g.membership_id = m.id join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
          where m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or $1::timestamptz < m.valid_until) and g.effective_from <= $1::timestamptz and (g.effective_until is null or $1::timestamptz < g.effective_until)
            and ($2::text is null or r.code = $2) order by m.id`,
        [now.toISOString(), rule.type === 'ROLE_IN_UNIT' ? (rule.role_code ?? null) : null],
      );
    }
    const place = await this.placeOf(tx, instance.unitId);
    const chosen: string[] = [];
    const people = new Set<string>();
    for (const candidate of candidates) {
      // A person with memberships in several units is asked once.
      if (excludedUsers.has(candidate.user_id) || people.has(candidate.user_id)) continue;
      if (candidate.user_id === (await this.userOf(tx, instance.initiatorId))) continue;
      const access = await loadAccessIn(tx, candidate.id);
      if (await this.authorised(tx, step, instance, access, place, now)) {
        chosen.push(candidate.id);
        people.add(candidate.user_id);
      }
      if (chosen.length >= MAX_TASKS_PER_STEP) break;
    }
    return chosen;
  }

  private async userOf(tx: TenantTx, membershipId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ user_id: string }>('select user_id from machvon.membership where id = $1::uuid', [membershipId]);
    return row?.user_id;
  }

  /** The time by which a step is due: working time on the calendar of the tenant, or elapsed days of 8 working hours when the calendar of the year is not published. */
  private async dueOf(tx: TenantTx, minutes: number, now: Date): Promise<Date> {
    const source = await this.calendars.source(tx, APPROVAL_CALENDAR_CODE, Number(vietnamDateOf(now).slice(0, 4)));
    try {
      return addWorkingTime(source, now, { minutes });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
      return new Date(now.getTime() + Math.ceil(minutes / WORKING_DAY_MINUTES) * 24 * HOUR_MS);
    }
  }

  /**
   * The deadline of a step of N working minutes and its reminder point, 80 percent of the working time to it on the calendar of the tenant; with no calendar published the deadline is counted in days of 8 hours (rounded up)
   * and the reminder is 80 percent of the elapsed time to it.
   */
  private async clockOf(tx: TenantTx, minutes: number, now: Date): Promise<{ due: Date; remind: Date }> {
    const source = await this.calendars.source(tx, APPROVAL_CALENDAR_CODE, Number(vietnamDateOf(now).slice(0, 4)));
    try {
      return { due: addWorkingTime(source, now, { minutes }), remind: addWorkingTime(source, now, { minutes: Math.max(1, Math.round(minutes * REMINDER_SHARE)) }) };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
      const due = new Date(now.getTime() + Math.ceil(minutes / WORKING_DAY_MINUTES) * 24 * HOUR_MS);
      return { due, remind: new Date(now.getTime() + Math.floor((due.getTime() - now.getTime()) * REMINDER_SHARE)) };
    }
  }

  /** Opens a step: a task for every eligible approver, due by the SLA. 422 `NO_ELIGIBLE_APPROVER` when fewer people than the step needs can approve (the instance would never finish). */
  private async openStep(tx: TenantTx, instance: InstanceRecord, definition: ApprovalWorkflowDefinition, index: number, now: Date, excludedUsers: ReadonlySet<string>): Promise<string[]> {
    const step = definition.steps[index] as WorkflowStep;
    const excluded = new Set(excludedUsers);
    const initiatorUser = await this.userOf(tx, instance.initiatorId);
    if (initiatorUser !== undefined) excluded.add(initiatorUser);
    const approvers = await this.eligible(tx, step, instance, step.assignee_rule.type === 'DOA' ? excluded : new Set(initiatorUser === undefined ? [] : [initiatorUser]), now);
    const needed = requiredApprovals(step, instance.doaLevels ?? undefined);
    if (approvers.length < needed) throw new DomainError('NO_ELIGIBLE_APPROVER', 422, step.id, { extensions: { needed, eligible: approvers.length } });
    const minutes = Math.max(1, Math.round(step.sla_working_hours * 60));
    // The reminder is at 80 percent of the working time to the deadline, counted on the same calendar.
    const { due, remind } = await this.clockOf(tx, minutes, now);
    const ids: string[] = [];
    for (const assignee of approvers) {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, remind_at, step_id, step_index, status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5, $6, 'Pending') returning id`,
        [instance.id, assignee, due.toISOString(), remind.toISOString(), step.id, index],
      );
      if (row !== undefined) ids.push(row.id);
    }
    return ids;
  }

  // ---- reads -------------------------------------------------------------------------------------------------------------------------

  async findInstance(tx: TenantTx, id: string): Promise<InstanceRecord | undefined> {
    const [row] = await tx.query<InstanceRow>(`select ${INSTANCE_COLUMNS} from machvon.workflow_instance i where i.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toInstance(row);
  }

  /** The instances; a person who does not run workflows sees those they started and those they have a task in. */
  async listInstances(tx: TenantTx, viewer: { membershipId: string; all: boolean }, filters: { id?: string | undefined; resourceType?: string | undefined; resourceId?: string | undefined; status?: string | undefined; businessType?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<InstanceRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<InstanceRow>(
      `select ${INSTANCE_COLUMNS} from machvon.workflow_instance i
        where ($1::boolean or i.initiator_membership_id = $2::uuid or exists (select 1 from machvon.approval_task t where t.tenant_id = i.tenant_id and t.workflow_instance_id = i.id and (t.assignee_id = $2::uuid or t.on_behalf_of_id = $2::uuid or t.decided_by = $2::uuid or ${delegatedTo('$2', 't.assignee_id', 'i.unit_id', 'now()')})))
          and ($3::text is null or i.resource_type = $3) and ($4::uuid is null or i.resource_id = $4::uuid) and ($5::text is null or i.status = $5) and ($6::text is null or i.business_type = $6)
          and ($7::timestamptz is null or (i.started_at, i.id) < ($7::timestamptz, $8::uuid)) and ($10::uuid is null or i.id = $10::uuid)
        order by i.started_at desc, i.id desc limit $9::int`,
      [viewer.all, viewer.membershipId, filters.resourceType ?? null, filters.resourceId ?? null, filters.status ?? null, filters.businessType ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, filters.id ?? null],
    );
    return rows.map(toInstance);
  }

  async findTask(tx: TenantTx, id: string, viewer?: string): Promise<TaskRecord | undefined> {
    const columns = viewer === undefined ? TASK_COLUMNS : taskColumns(delegatedTo('$2', 't.assignee_id', 'i.unit_id', 'now()'));
    const [row] = await tx.query<TaskRow>(`select ${columns} from ${TASK_FROM} where t.id = $1::uuid`, viewer === undefined ? [id] : [id, viewer]);
    return row === undefined ? undefined : toTask(row);
  }

  async listTasks(tx: TenantTx, viewer: { membershipId: string; all: boolean }, filters: { id?: string | undefined; status?: string | undefined; instanceId?: string | undefined; mine?: boolean | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<TaskRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<TaskRow>(
      `select ${taskColumns(delegatedTo('$2', 't.assignee_id', 'i.unit_id', 'now()'))} from ${TASK_FROM}
        where ($1::boolean or t.assignee_id = $2::uuid or t.on_behalf_of_id = $2::uuid or t.decided_by = $2::uuid or i.initiator_membership_id = $2::uuid or ${delegatedTo('$2', 't.assignee_id', 'i.unit_id', 'now()')}) and ($3::text is null or t.status = $3) and ($4::uuid is null or t.workflow_instance_id = $4::uuid)
          and (not $5::boolean or t.assignee_id = $2::uuid) and ($6::timestamptz is null or (t.created_at, t.id) < ($6::timestamptz, $7::uuid)) and ($9::uuid is null or t.id = $9::uuid)
        order by t.created_at desc, t.id desc limit $8::int`,
      [viewer.all, viewer.membershipId, filters.status ?? null, filters.instanceId ?? null, filters.mine === true, page.after?.code ?? null, page.after?.id ?? null, page.limit, filters.id ?? null],
    );
    return rows.map(toTask);
  }
}
