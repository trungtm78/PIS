import { randomUUID } from 'node:crypto';
import { DomainError, asUuid, assertFourEyes, compareDecimal, subtractDecimal, versionConflict } from '@machvon/kernel';
import { assertDecisionDocument } from './bid-decision-document.ts';
import { checkedPlan, commentOf } from './bid-plan-input.ts';
import type { CheckedPlan, NewPlanInput } from './bid-plan-input.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const IN_FORCE_LINE_STATUS = 'PUBLISHED';

export const PLAN_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'CANCELLED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_DECISIONS = ['APPROVE', 'REJECT', 'RETURN'] as const;
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

/** A project takes a procurement plan from the pipeline to the end of implementation (BID 3 section 4: the project is at PIPELINE or later and still alive). */
export const PLANNABLE_PROJECT_STATUSES: readonly string[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'];

export interface BidCreatedPackage {
  id: string;
  code: string;
  budgetVnd: string;
  allocationLineId: string;
}

export interface BidCreatedPlan {
  id: string;
  projectId: string;
  revision: number;
  version: 1;
  status: 'DRAFT';
  supersedesId: string | null;
  /** The draft of the project that this plan replaced (a draft is restarted, never edited), or null. */
  replacedPlanId: string | null;
  totalVnd: string;
  packages: BidCreatedPackage[];
}

/** What the packages of a plan ask of one line of capital, beside what the line has been given. */
export interface BidAllocationUse {
  allocationLineId: string;
  allocatedVnd: string;
  packagesVnd: string;
}

export interface BidSubmittedPlan {
  id: string;
  projectId: string;
  revision: number;
  version: number;
  status: 'IN_REVIEW';
  totalVnd: string;
  allocations: BidAllocationUse[];
}

export interface BidDecisionInput {
  decision: PlanDecision;
  decisionDocumentId?: string | undefined;
  comment?: string | undefined;
}

export interface BidDecidedPlan {
  id: string;
  projectId: string;
  revision: number;
  version: number;
  status: 'APPROVED' | 'CANCELLED' | 'DRAFT';
  decision: PlanDecision;
  decisionDocumentId: string | null;
  comment: string | null;
  totalVnd: string;
  supersededPlanId: string | null;
  packageIds: string[];
  allocations: BidAllocationUse[];
}

interface PlanLock {
  id: string;
  projectId: string;
  revision: number;
  status: PlanStatus;
  version: number;
  totalVnd: string;
  createdBy: string;
  submittedBy: string | null;
}

interface PlanLockSql {
  id: string;
  project_id: string;
  revision: number;
  status: PlanStatus;
  version: string;
  total_value_vnd: string;
  created_by: string;
  submitted_by: string | null;
}

const PLAN_LOCK_COLUMNS = 'id, project_id, revision, status, version::text as version, total_value_vnd::text as total_value_vnd, created_by, submitted_by';

const toLock = (row: PlanLockSql): PlanLock => ({
  id: row.id,
  projectId: row.project_id,
  revision: row.revision,
  status: row.status,
  version: Number(row.version),
  totalVnd: row.total_value_vnd,
  createdBy: row.created_by,
  submittedBy: row.submitted_by,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (extensions?: Record<string, unknown>): DomainError => new DomainError('PLAN_STATE_INVALID', 409, 'status', extensions === undefined ? undefined : { extensions });

/**
 * The procurement plan (ST-BID-001, BID 3 F1): a planner drafts a plan of packages for a project, each paid from one line of capital that
 * the capital plan has published; the plan is submitted only when, line by line, the packages cost no more than the line was given, and an
 * authority other than the maker and the submitter approves it on a decision document in force. An approved plan is replaced by a revision,
 * never edited; the one APPROVED plan of a project is the plan in force. The project row is locked first by every command, then the plan
 * rows, so two commands on one project never wait for each other in a cycle.
 */
export class BidPlanStore {
  /**
   * Creates a plan as a DRAFT revision of the project. The packages are judged for their shape and for their lines (a line of another project,
   * or none, is ALLOCATION_LINE_INVALID); a plan in review blocks a new one (PLAN_STATE_INVALID), and a draft is replaced by it.
   */
  async createPlan(tx: TenantTx, input: NewPlanInput, actor: string, scope: ScopeBuilder): Promise<BidCreatedPlan> {
    const plan = checkedPlan(input);
    const project = await this.lockProject(tx, plan.projectId, scope);
    if (!PLANNABLE_PROJECT_STATUSES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id');
    await this.assertLinesBelongTo(tx, plan);

    const earlier = await tx.query<{ id: string; revision: number; status: PlanStatus; version: string }>(
      'select id, revision, status, version::text as version from machvon.procurement_plan where project_id = $1::uuid order by revision desc for update',
      [plan.projectId],
    );
    const open = earlier.find((row) => row.status === 'DRAFT' || row.status === 'IN_REVIEW');
    if (open?.status === 'IN_REVIEW') throw stateInvalid({ open_plan_id: open.id });
    if (open !== undefined) await this.replaceDraft(tx, open.id, actor);

    const approved = earlier.find((row) => row.status === 'APPROVED');
    const revision = (earlier[0]?.revision ?? 0) + 1;
    const supersedesId = approved?.id ?? earlier[0]?.id ?? null;
    const id = randomUUID();
    await this.insertPlan(tx, id, plan, revision, supersedesId, actor);
    const packages = await this.insertPackages(tx, id, plan, revision, actor);
    await this.recordEvent(tx, { planId: id, kind: 'CREATED', from: null, to: 'DRAFT', actor });
    return { id, projectId: plan.projectId, revision, version: 1, status: 'DRAFT', supersedesId, replacedPlanId: open?.id ?? null, totalVnd: plan.totalVnd, packages };
  }

  /**
   * DRAFT to IN_REVIEW. Refusals in order: the plan (404 outside the scope), the version (409), the state (409 PLAN_STATE_INVALID), the stage of
   * the project (422 PROJECT_STAGE_INVALID), the lines (409 ALLOCATION_LINE_INVALID) and the sums (422 PACKAGE_BUDGET_EXCEEDS_ALLOCATION).
   */
  async submit(tx: TenantTx, planId: string, expectedVersion: number, actor: string, scope: ScopeBuilder): Promise<BidSubmittedPlan> {
    const plan = await this.lockPlanAndProject(tx, planId, scope);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version);
    if (plan.status !== 'DRAFT') throw stateInvalid();
    await this.assertProjectStage(tx, plan.projectId);
    const allocations = await this.assertWithinAllocation(tx, plan);
    await tx.query("update machvon.procurement_plan set status = 'IN_REVIEW', submitted_by = $2::uuid, submitted_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [plan.id, actor]);
    await this.setPackageStatus(tx, plan.id, 'IN_REVIEW');
    await this.recordEvent(tx, { planId: plan.id, kind: 'SUBMITTED', from: 'DRAFT', to: 'IN_REVIEW', actor });
    return { id: plan.id, projectId: plan.projectId, revision: plan.revision, version: plan.version + 1, status: 'IN_REVIEW', totalVnd: plan.totalVnd, allocations };
  }

  /**
   * The decision on a plan in review. The maker and the submitter never decide (403 SELF_APPROVAL_DENIED). An approval rests on a decision
   * document in force (a decision, `QD`) and is judged against the lines again; it replaces the plan in force of the project, which becomes
   * SUPERSEDED. A rejection ends the plan, a return gives it back as a DRAFT; both need the words that explain them.
   */
  async decide(tx: TenantTx, planId: string, expectedVersion: number, input: BidDecisionInput, decider: string, scope: ScopeBuilder): Promise<BidDecidedPlan> {
    const asked = this.checkedDecision(input);
    const plan = await this.lockPlanAndProject(tx, planId, scope);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version);
    assertFourEyes(plan.createdBy, decider);
    if (plan.submittedBy !== null) assertFourEyes(plan.submittedBy, decider);
    if (plan.status !== 'IN_REVIEW') throw stateInvalid();
    const base = { id: plan.id, projectId: plan.projectId, revision: plan.revision, version: plan.version + 1, decision: asked.decision, comment: asked.comment ?? null, totalVnd: plan.totalVnd };
    if (asked.decision === 'APPROVE') return this.approve(tx, plan, asked, decider, base);
    const status = asked.decision === 'REJECT' ? 'CANCELLED' : 'DRAFT';
    const submitted = status === 'DRAFT' ? ', submitted_by = null, submitted_at = null' : '';
    await tx.query(`update machvon.procurement_plan set status = $2${submitted}, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [plan.id, status, decider]);
    await this.setPackageStatus(tx, plan.id, status);
    await this.recordEvent(tx, { planId: plan.id, kind: asked.decision === 'REJECT' ? 'REJECTED' : 'RETURNED', from: 'IN_REVIEW', to: status, actor: decider, comment: asked.comment });
    return { ...base, status, decisionDocumentId: null, supersededPlanId: null, packageIds: [], allocations: [] };
  }

  private async approve(tx: TenantTx, plan: PlanLock, asked: CheckedDecision, decider: string, base: Pick<BidDecidedPlan, 'id' | 'projectId' | 'revision' | 'version' | 'decision' | 'comment' | 'totalVnd'>): Promise<BidDecidedPlan> {
    const documentId = await assertDecisionDocument(tx, asked.decisionDocumentId);
    await this.assertProjectStage(tx, plan.projectId);
    // The lines may have moved since the plan was submitted: the sums are judged again at the moment of the approval.
    const allocations = await this.assertWithinAllocation(tx, plan);
    const previous = (
      await tx.query<{ id: string }>("select id from machvon.procurement_plan where project_id = $1::uuid and status = 'APPROVED' and id <> $2::uuid for update", [plan.projectId, plan.id])
    )[0];
    if (previous !== undefined) {
      await tx.query("update machvon.procurement_plan set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [previous.id, decider]);
      await this.setPackageStatus(tx, previous.id, 'SUPERSEDED');
      await this.recordEvent(tx, { planId: previous.id, kind: 'SUPERSEDED', from: 'APPROVED', to: 'SUPERSEDED', actor: decider });
    }
    // The unique index of the one APPROVED plan per project has the last word on a race: the loser gets the refusal meant for it.
    await tx.query('savepoint bid_plan_approve');
    try {
      await tx.query(
        `update machvon.procurement_plan
            set status = 'APPROVED', decision_document_id = $2::uuid, approved_by = $3::uuid, approved_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [plan.id, documentId, decider],
      );
      await tx.query('release savepoint bid_plan_approve');
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query('rollback to savepoint bid_plan_approve');
      throw stateInvalid();
    }
    const packageIds = await this.setPackageStatus(tx, plan.id, 'PLANNED', documentId);
    await this.recordEvent(tx, { planId: plan.id, kind: 'APPROVED', from: 'IN_REVIEW', to: 'APPROVED', actor: decider, comment: asked.comment, decisionDocumentId: documentId });
    return { ...base, status: 'APPROVED', decisionDocumentId: documentId, supersededPlanId: previous?.id ?? null, packageIds, allocations };
  }

  /** The shape of a decision: its words and its document are the ones the kind of decision takes. */
  private checkedDecision(input: BidDecisionInput): CheckedDecision {
    if (!PLAN_DECISIONS.includes(input.decision)) throw invalid('decision');
    const comment = commentOf(input.comment);
    if (input.decision === 'APPROVE') {
      const documentId = input.decisionDocumentId === undefined ? undefined : asUuid(input.decisionDocumentId);
      if (input.decisionDocumentId !== undefined && documentId === undefined) throw invalid('decision_document_id');
      return { decision: 'APPROVE', decisionDocumentId: documentId, comment };
    }
    // Only an approval rests on a decision document; a rejection and a return say why in words.
    if (input.decisionDocumentId !== undefined) throw invalid('decision_document_id');
    if (comment === undefined) throw invalid('comment');
    return { decision: input.decision, decisionDocumentId: undefined, comment };
  }

  /** Locks the project of the plan (in the scope of the caller), then the plan; a plan outside the scope does not exist for the caller. */
  private async lockPlanAndProject(tx: TenantTx, planId: string, scope: ScopeBuilder): Promise<PlanLock> {
    const peek = (await tx.query<{ project_id: string }>('select project_id from machvon.procurement_plan where id = $1::uuid', [planId]))[0];
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockProject(tx, peek.project_id, scope);
    const rows = await tx.query<PlanLockSql>(`select ${PLAN_LOCK_COLUMNS} from machvon.procurement_plan where id = $1::uuid for update`, [planId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toLock(rows[0]);
  }

  private async lockProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<{ id: string; status: string }> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string; status: string }>(`select p.id, p.status from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql} for update of p`, [projectId, ...predicate.params]);
    // A project outside the scope of the caller, or of another tenant, does not exist for them.
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  private async assertProjectStage(tx: TenantTx, projectId: string): Promise<void> {
    const rows = await tx.query<{ status: string }>('select status from machvon.project where id = $1::uuid', [projectId]);
    if (!PLANNABLE_PROJECT_STATUSES.includes(rows[0]?.status ?? '')) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id');
  }

  /** Every line the packages name exists and is a line of the project of the plan. */
  private async assertLinesBelongTo(tx: TenantTx, plan: CheckedPlan): Promise<void> {
    const wanted = [...new Set(plan.packages.map((pack) => pack.allocationLineId))];
    const found = await tx.query<{ id: string }>('select id from machvon.allocation_line where id = any($1::uuid[]) and project_id = $2::uuid', [wanted, plan.projectId]);
    const known = new Set(found.map((row) => row.id));
    const index = plan.packages.findIndex((pack) => !known.has(pack.allocationLineId));
    if (index >= 0) throw new DomainError('ALLOCATION_LINE_INVALID', 409, `packages.${index}.allocation_line_id`);
  }

  /**
   * Sums the budgets of the packages line by line and checks each sum against what the line was given (BR-BID-02). A line counts when the
   * capital plan that holds it is PUBLISHED and the line is of the project of the plan; the rows of the lines are locked FOR SHARE so no
   * change of a line slips in between the check and the write. All lines over their limit are named in the refusal.
   */
  private async assertWithinAllocation(tx: TenantTx, plan: PlanLock): Promise<BidAllocationUse[]> {
    const wanted = await tx.query<{ allocation_line_id: string; packages_vnd: string }>(
      'select allocation_line_id, sum(budget_vnd)::text as packages_vnd from machvon.procurement_package where plan_id = $1::uuid group by allocation_line_id order by allocation_line_id',
      [plan.id],
    );
    if (wanted.length === 0) throw invalid('packages');
    const lines = await tx.query<{ id: string; project_id: string | null; amount_vnd: string; plan_status: string | null }>(
      `select al.id, al.project_id, al.amount_vnd::text as amount_vnd, coalesce(cp.status, pv.status) as plan_status
         from machvon.allocation_line al
         join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
         left join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
        where al.id = any($1::uuid[])
        order by al.id
        for share of al`,
      [wanted.map((row) => row.allocation_line_id)],
    );
    const byId = new Map(lines.map((line) => [line.id, line]));
    const uses: BidAllocationUse[] = [];
    for (const row of wanted) {
      const line = byId.get(row.allocation_line_id);
      if (line?.project_id !== plan.projectId || line.plan_status !== IN_FORCE_LINE_STATUS) {
        throw new DomainError('ALLOCATION_LINE_INVALID', 409, 'allocation_line_id', { extensions: { allocation_line_id: row.allocation_line_id } });
      }
      uses.push({ allocationLineId: row.allocation_line_id, allocatedVnd: line.amount_vnd, packagesVnd: row.packages_vnd });
    }
    const over = uses.filter((use) => compareDecimal(use.packagesVnd, use.allocatedVnd) > 0);
    if (over.length > 0) {
      throw new DomainError('PACKAGE_BUDGET_EXCEEDS_ALLOCATION', 422, 'packages', {
        extensions: {
          lines: over.map((use) => ({ allocation_line_id: use.allocationLineId, allocated_vnd: use.allocatedVnd, packages_vnd: use.packagesVnd, excess_vnd: subtractDecimal(use.packagesVnd, use.allocatedVnd) })),
        },
      });
    }
    return uses;
  }

  private async insertPlan(tx: TenantTx, id: string, plan: CheckedPlan, revision: number, supersedesId: string | null, actor: string): Promise<void> {
    await tx.query('savepoint bid_plan_create');
    try {
      await tx.query(
        `insert into machvon.procurement_plan
           (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, supersedes_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::integer, $4, $5::numeric, $6, 'DRAFT', $7::uuid, $8::uuid, $8::uuid, 1)`,
        [id, plan.projectId, revision, plan.title, plan.totalVnd, plan.legalBasis, supersedesId, actor],
      );
      await tx.query('release savepoint bid_plan_create');
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      // Another transaction made a revision between the read and the write: the unique indexes have the last word.
      await tx.query('rollback to savepoint bid_plan_create');
      throw stateInvalid();
    }
  }

  private async insertPackages(tx: TenantTx, planId: string, plan: CheckedPlan, revision: number, actor: string): Promise<BidCreatedPackage[]> {
    const rows = plan.packages.map((pack) => ({
      id: randomUUID(),
      code: pack.code,
      title: pack.title,
      budget_vnd: pack.budgetVnd,
      method: pack.method,
      contract_type: pack.contractType,
      bidding_form: pack.biddingForm,
      allocation_line_id: pack.allocationLineId,
      planned_start_period: pack.plannedStartPeriod,
      duration_days: pack.durationDays,
    }));
    await tx.query(
      `insert into machvon.procurement_package
         (tenant_id, id, project_id, code, budget_vnd, method, revision, status, plan_id, title, contract_type, bidding_form, allocation_line_id, planned_start_period, duration_days, created_by)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, r.id, $2::uuid, r.code, r.budget_vnd::numeric, r.method, $3::integer, 'DRAFT', $1::uuid, r.title, r.contract_type,
              r.bidding_form, r.allocation_line_id, r.planned_start_period, r.duration_days, $4::uuid
         from jsonb_to_recordset($5::jsonb)
              as r(id uuid, code text, title text, budget_vnd text, method text, contract_type text, bidding_form text, allocation_line_id uuid, planned_start_period text, duration_days integer)`,
      [planId, plan.projectId, revision, actor, JSON.stringify(rows)],
    );
    return rows.map((row) => ({ id: row.id, code: row.code, budgetVnd: row.budget_vnd, allocationLineId: row.allocation_line_id }));
  }

  /** A draft is restarted by a new plan: it ends as CANCELLED with its packages and the step is kept in its history. */
  private async replaceDraft(tx: TenantTx, planId: string, actor: string): Promise<void> {
    await tx.query("update machvon.procurement_plan set status = 'CANCELLED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [planId, actor]);
    await this.setPackageStatus(tx, planId, 'CANCELLED');
    await this.recordEvent(tx, { planId, kind: 'REPLACED', from: 'DRAFT', to: 'CANCELLED', actor });
  }

  /** Moves the packages of a plan to the status of the plan; an approval also names the decision they rest on. Returns their ids. */
  private async setPackageStatus(tx: TenantTx, planId: string, status: string, decisionDocumentId?: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      'update machvon.procurement_package set status = $2, approved_decision_id = coalesce($3::uuid, approved_decision_id), version = version + 1 where plan_id = $1::uuid returning id',
      [planId, status, decisionDocumentId ?? null],
    );
    return rows.map((row) => row.id).sort();
  }

  private async recordEvent(
    tx: TenantTx,
    event: { planId: string; kind: string; from: string | null; to: string; actor: string; comment?: string | undefined; decisionDocumentId?: string | undefined },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.procurement_plan_event (tenant_id, id, plan_id, event_kind, from_status, to_status, actor_id, comment, decision_document_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::uuid)`,
      [randomUUID(), event.planId, event.kind, event.from, event.to, event.actor, event.comment ?? null, event.decisionDocumentId ?? null],
    );
  }
}

interface CheckedDecision {
  decision: PlanDecision;
  decisionDocumentId: string | undefined;
  comment: string | undefined;
}
