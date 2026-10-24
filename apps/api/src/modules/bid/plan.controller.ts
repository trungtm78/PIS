import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BID_PLAN_STATUSES, BidPlanReads, BidPlanStore, TenantDatabase, bidReadScope, projectScope, readPackages } from '@machvon/db';
import type { BidPlanStatus, BidCreatedPlan, BidDecidedPlan, BidSubmittedPlan } from '@machvon/db';
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
import { packageView, planView } from './plan-view';

const RESOURCE_TYPE = 'procurement_plan';
const MANAGE_PERMISSION = PERMISSIONS.createProcurementPlan;
const SUBMIT_PERMISSION = PERMISSIONS.submitProcurementPlan;
const APPROVE_PERMISSION = PERMISSIONS.decideProcurementPlan;
const LIST_PERMISSION = PERMISSIONS.listProcurementPlans;
const PACKAGES_PERMISSION = PERMISSIONS.get_resources_procurement_package;
const PACKAGE_PERMISSION = PERMISSIONS.get_resources_procurement_package_id;
const STATUS_VALUES: readonly string[] = BID_PLAN_STATUSES;

/** The package ids and the budget lines a plan made, as the audit trail and the event keep them: ids and exact amounts, nothing of the text. */
const packagesDiff = (plan: BidCreatedPlan): Array<Record<string, unknown>> =>
  plan.packages.map((item) => ({ package_id: item.id, code: item.code, budget_vnd: item.budgetVnd, allocation_line_id: item.allocationLineId }));

const allocationsDiff = (allocations: BidSubmittedPlan['allocations']): Array<Record<string, unknown>> =>
  allocations.map((use) => ({ allocation_line_id: use.allocationLineId, allocated_vnd: use.allocatedVnd, packages_vnd: use.packagesVnd }));

/**
 * The procurement plan (ST-BID-001, BID 3 F1): a planner drafts a plan of packages for a project of their scope, each package paid from one
 * published line of capital; the plan is submitted only when, line by line, the packages cost no more than the line was given; an authority
 * of the scope who is neither the maker nor the submitter approves it on a decision in force, which replaces the plan in force of the project.
 * Status, approver, version and totals are written by no body: the plan starts as a DRAFT and the commands move it.
 */
@Controller('procurement-plans')
export class ProcurementPlanController {
  private readonly plans = new BidPlanStore();

  @Post()
  @HttpCode(200)
  @OperationId('createProcurementPlan')
  @Command({ operation: 'createProcurementPlan', ttl: 'extended' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidPlanCreate']): Promise<CommandResult> {
    const now = new Date();
    const created = await this.plans.createPlan(
      scope.tx,
      { projectId: body.project_id, title: body.title, legalBasis: body.legal_basis, packages: readPackages(body.packages) },
      scope.tenant.membershipId,
      projectScope(access, MANAGE_PERMISSION, now),
    );
    await scope.audit({
      action: 'procurement_plan.drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: {
        project_id: created.projectId,
        revision: created.revision,
        supersedes_id: created.supersedesId,
        replaced_plan_id: created.replacedPlanId,
        total_value_vnd: created.totalVnd,
        packages: packagesDiff(created),
      },
    });
    await this.emitDrafted(scope, created, now);
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @OperationId('submitProcurementPlan')
  @Command({ operation: 'submitProcurementPlan', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const sent = await this.plans.submit(scope.tx, id.toLowerCase(), expected, scope.tenant.membershipId, projectScope(access, SUBMIT_PERMISSION, now));
    await scope.audit({
      action: 'procurement_plan.submitted',
      resourceType: RESOURCE_TYPE,
      resourceId: sent.id,
      diff: { project_id: sent.projectId, revision: sent.revision, plan_version_before: expected, plan_version_after: sent.version, total_value_vnd: sent.totalVnd, allocations: allocationsDiff(sent.allocations) },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: sent.id,
      aggregateVersion: sent.version,
      type: 'bid.plan.submitted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: sent.id,
        project_id: sent.projectId,
        revision: sent.revision,
        version: sent.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        total_value_vnd: sent.totalVnd,
      },
      eventKey: `${RESOURCE_TYPE}:${sent.id}:${sent.version}`,
    });
    return commandResult(scope, sent.status, sent.version, sent.id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @OperationId('decideProcurementPlan')
  @Command({ operation: 'decideProcurementPlan', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidPlanDecision'],
  ): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const decided = await this.plans.decide(
      scope.tx,
      id.toLowerCase(),
      expected,
      { decision: body.decision, decisionDocumentId: body.decision_document_id, comment: body.comment },
      scope.tenant.membershipId,
      projectScope(access, APPROVE_PERMISSION, now),
    );
    await scope.audit({
      action: `procurement_plan.${decided.decision === 'APPROVE' ? 'approved' : decided.decision === 'REJECT' ? 'rejected' : 'returned'}`,
      resourceType: RESOURCE_TYPE,
      resourceId: decided.id,
      ...(decided.comment === null ? {} : { reason: decided.comment }),
      diff: {
        project_id: decided.projectId,
        revision: decided.revision,
        plan_version_before: expected,
        plan_version_after: decided.version,
        decision: decided.decision,
        decision_document_id: decided.decisionDocumentId,
        superseded_plan_id: decided.supersededPlanId,
        total_value_vnd: decided.totalVnd,
        allocations: allocationsDiff(decided.allocations),
      },
    });
    // The contract names one event for the decision: the approval, which the contracts and the tenders of the packages wait for.
    if (decided.decision === 'APPROVE') await this.emitApproved(scope, decided, now);
    return commandResult(scope, decided.status, decided.version, decided.id);
  }

  private async emitDrafted(scope: CommandScope, created: BidCreatedPlan, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bid.plan.drafted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: created.id,
        project_id: created.projectId,
        revision: created.revision,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        total_value_vnd: created.totalVnd,
        package_count: created.packages.length,
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
  }

  private async emitApproved(scope: CommandScope, decided: BidDecidedPlan, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: decided.id,
      aggregateVersion: decided.version,
      type: 'bid.plan.approved.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: decided.id,
        project_id: decided.projectId,
        revision: decided.revision,
        version: decided.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        decision_document_id: decided.decisionDocumentId,
        superseded_plan_id: decided.supersededPlanId,
        total_value_vnd: decided.totalVnd,
        package_ids: decided.packageIds,
      },
      eventKey: `${RESOURCE_TYPE}:${decided.id}:${decided.version}`,
    });
  }
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

function optionalStatus(value: unknown): BidPlanStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STATUS_VALUES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value as BidPlanStatus;
}

/**
 * The plans for reading (BID-15, BID-16): the plans of the projects in the scope of the caller, the newest first. A plan in work is shown to
 * the people who plan and approve only; the words of a decision with it.
 */
@Controller('procurement-plans')
export class ProcurementPlanReadsController {
  private readonly reads = new BidPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listProcurementPlans')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { projectId: optionalUuid(projectId, 'project_id'), status: optionalStatus(status) };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.listPlans(tx, bidReadScope(access, LIST_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(planView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}

/**
 * The packages for reading (BID-03, and the lines of BID-15): the packages of the projects in the scope of the caller. A package of a plan
 * in work is shown to the people who plan and approve only; a package awarded outside a plan is shown like one in force.
 */
@Controller('resources/procurement_package')
export class ProcurementPackageReadsController {
  private readonly reads = new BidPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_procurement_package')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.listPackages(tx, bidReadScope(access, PACKAGES_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(packageView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_procurement_package_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.reads.findPackage(tx, id.toLowerCase(), bidReadScope(access, PACKAGE_PERMISSION, new Date())));
    // A package of another tenant, outside the scope of the caller or in a plan in work that the caller does not see does not exist for them.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return packageView(found);
  }
}
