import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndPlanStore, TenantDatabase, householdScopeUnits, projectScope } from '@machvon/db';
import type { CompensationPlanLine, PlanItemLine, TenantTx } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { projectRefs, reaches } from './reach';

const WRITE_PERMISSION = PERMISSIONS.draftCompensationPlan;
const READ_PERMISSION = PERMISSIONS.listCompensationPlans;
/** The rights that let a caller see a plan at all: whoever reads, writes or approves plans of a place knows they exist; without one of them a plan does not exist for the caller. */
const SEEING_PERMISSIONS: readonly string[] = ['land.read', WRITE_PERMISSION, 'land.plan.approve', 'land.payment.write'];
const RESOURCE_TYPE = 'compensation_plan';
const CLASSIFICATION = 'INTERNAL';

/** A plan as the screen reads it: an allowlist of what a plan is. */
export function planLineView(line: CompensationPlanLine): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    section_id: line.sectionId,
    executor_unit_id: line.executorUnitId,
    executor_kind: line.executorKind,
    plan_code: line.planCode,
    revision: line.revision,
    supersedes_id: line.supersedesId,
    revision_reason: line.revisionReason,
    total_compensation_vnd: line.totalCompensationVnd,
    total_support_vnd: line.totalSupportVnd,
    total_resettlement_vnd: line.totalResettlementVnd,
    grand_total_vnd: line.grandTotalVnd,
    status: line.status,
    posting_started_on: line.postingStartedOn,
    posting_ends_on: line.postingEndsOn,
    posting_place_text: line.postingPlaceText,
    feedback_summary: line.feedbackSummary,
    approved_on: line.approvedOn,
    payment_due_on: line.paymentDueOn,
    decision_document_version_id: line.decisionDocumentVersionId,
    version: line.version,
  };
}

/** An item as the screen reads it: an allowlist of what an item is; the amounts of a household are read only inside its unit. */
export function planItemView(line: PlanItemLine): Record<string, unknown> {
  return {
    id: line.id,
    plan_id: line.planId,
    household_id: line.householdId,
    household_code: line.householdCode,
    parcel_id: line.parcelId,
    parcel_code: line.parcelCode,
    owner_unit_id: line.ownerUnitId,
    item_kind: line.itemKind,
    amount_vnd: line.amountVnd,
    basis_inventory_id: line.basisInventoryId,
    quantity: line.quantity,
    unit_code: line.unitCode,
    unit_price_vnd: line.unitPriceVnd,
    price_decision_ref: line.priceDecisionRef,
    price_decision_revision: line.priceDecisionRevision,
    legal_basis: line.legalBasis,
  };
}

/** The plan has to exist for the caller (they see its project) and they need the right asked for: a plan they cannot see is 404, one they see and may not act on is 403. */
export async function mayActOnPlan(tx: TenantTx, plans: LndPlanStore, source: LndLandSource, access: EffectiveAccess, planId: string, permission: string, now: Date): Promise<void> {
  const place = await plans.place(tx, planId);
  const project = place === undefined ? undefined : await source.projectRef(tx, place.projectId);
  const refs = project === undefined ? [] : projectRefs(project);
  if (place === undefined || project === undefined || !SEEING_PERMISSIONS.some((seeing) => reaches(access, seeing, refs, now))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (!reaches(access, permission, refs, now)) throw new DomainError('SCOPE_DENIED', 403);
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * The plan of compensation, support and resettlement (ST-LND-005, LND 3.3, BR-LND-05, UAT-AC382, UAT-PLAN-30). A plan belongs to a project: the caller needs `land.plan.write` over the project (a grant on the unit
 * trees of its owner or investor, on the project or on the tenant) to draft, add items to and revise a plan, and a plan the caller cannot see does not exist for them. Its items belong to the households,
 * so they are written and read inside the units of the households (the grants on a project reach no household). The trail and the events carry ids, the code, the counts and the totals, never an amount of a household.
 */
@Controller()
export class CompensationPlanController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);

  @Post('compensation-plans')
  @HttpCode(200)
  @OperationId('draftCompensationPlan')
  @Command({ operation: 'draftCompensationPlan' })
  async draft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndDraftCompensationPlan']): Promise<CommandResult> {
    const now = new Date();
    const projectId = body.project_id.toLowerCase();
    const executorUnitId = body.executor_unit_id.toLowerCase();
    const project = await this.source.projectRef(scope.tx, projectId);
    const executor = await this.source.unitRef(scope.tx, executorUnitId);
    // A project or a unit of another tenant is indistinguishable from one that does not exist.
    if (project === undefined || executor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, WRITE_PERMISSION, projectRefs(project), now)) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.plans.draft(
      scope.tx,
      { projectId, sectionId: body.section_id, executorUnitId, executorKind: body.executor_kind, planCode: body.plan_code },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'lnd.plan_drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: { plan_code: created.planCode, project_id: created.projectId, section_id: created.sectionId, executor_unit_id: created.executorUnitId, executor_kind: created.executorKind, revision: created.revision, status: created.status },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'lnd.plan.drafted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: created.id,
        project_id: created.projectId,
        executor_unit_id: created.executorUnitId,
        plan_code: created.planCode,
        revision: created.revision,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('compensation-plans/:id/items')
  @HttpCode(200)
  @OperationId('addCompensationPlanItems')
  @Command({ operation: 'addCompensationPlanItems', versioned: true })
  async addItems(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndAddCompensationPlanItems'],
  ): Promise<CommandResult> {
    const now = new Date();
    await this.mayWrite(scope, access, id, now);
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const items = (Array.isArray(body.items) ? body.items : []).map((entry) => {
      const item = record(entry);
      return { householdId: item.household_id, parcelId: item.parcel_id, itemKind: item.item_kind, basisInventoryId: item.basis_inventory_id, amountVnd: item.amount_vnd, legalBasis: item.legal_basis };
    });
    const done = await this.plans.addItems(scope.tx, id, items, scope.expectedVersion ?? 0, scope.tenant.membershipId, units);
    await scope.audit({
      action: 'lnd.plan_items_added',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: 'PERSONAL',
      diff: {
        project_id: done.projectId,
        item_ids: done.added.map((entry) => entry.id),
        item_count: done.added.length,
        total_compensation_vnd: done.totals.compensation,
        total_support_vnd: done.totals.support,
        total_resettlement_vnd: done.totals.resettlement,
        grand_total_vnd: done.totals.grand,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.planId,
      aggregateVersion: done.version,
      type: 'lnd.plan.items_changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        items_added: done.added.length,
        grand_total_vnd: done.totals.grand,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.planId}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.planId);
  }

  @Post('compensation-plans/:id/revise')
  @HttpCode(200)
  @OperationId('revisePlan')
  @Command({ operation: 'revisePlan', versioned: true })
  async revise(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndRevisePlan'],
  ): Promise<CommandResult> {
    const now = new Date();
    await this.mayWrite(scope, access, id, now);
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const done = await this.plans.revise(scope.tx, id, body.reason, scope.expectedVersion ?? 0, scope.tenant.membershipId, units);
    await scope.audit({
      action: 'lnd.plan_revised',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        previous_plan_id: done.previousId,
        project_id: done.projectId,
        plan_code: done.planCode,
        revision: done.revision,
        items_copied: done.itemsCopied,
        grand_total_vnd: done.totals.grand,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'lnd.plan.revised.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.id,
        previous_plan_id: done.previousId,
        project_id: done.projectId,
        plan_code: done.planCode,
        revision: done.revision,
        grand_total_vnd: done.totals.grand,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:1`,
    });
    return commandResult(scope, 'DRAFT', 1, done.id);
  }

  private mayWrite(scope: CommandScope, access: EffectiveAccess, planId: string, now: Date): Promise<void> {
    return mayActOnPlan(scope.tx, this.plans, this.source, access, planId, WRITE_PERMISSION, now);
  }
}

/** The plans of a project and the items of a plan (LND-05), inside the scope of the caller. */
@Controller()
export class CompensationPlanReadsController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('compensation-plans')
  @OperationId('listCompensationPlans')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.plans.list(tx, projectScope(access, READ_PERMISSION, now), { projectId, status: typeof status === 'string' ? status : undefined, limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(planLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.planCode, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('compensation-plans/:id/items')
  @OperationId('listCompensationPlanItems')
  async items(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      const place = await this.plans.place(tx, id);
      const project = place === undefined ? undefined : await this.source.projectRef(tx, place.projectId);
      // A plan the caller cannot see is as if it did not exist.
      if (place === undefined || project === undefined || !reaches(access, READ_PERMISSION, projectRefs(project), now)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.plans.items(tx, id, await householdScopeUnits(tx, access, READ_PERMISSION, now));
    });
    return { items: rows.map(planItemView), next_cursor: null, as_of: now.toISOString() };
  }
}

