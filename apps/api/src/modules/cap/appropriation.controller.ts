import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { APPROPRIATION_ORIGINS, BUDGET_LEVELS, CapAppropriationStore, TenantDatabase } from '@machvon/db';
import type { AppropriationFilter, AppropriationOrigin, AppropriationRow, BudgetLevel } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { appropriationView } from './appropriation-view';

const RESOURCE_TYPE = 'appropriation';
const PLAN_YEAR = /^\d{4}$/;
const ORIGINS: readonly string[] = APPROPRIATION_ORIGINS;
const LEVELS: readonly string[] = BUDGET_LEVELS;

/** A uuid of the body in its canonical lower-case form; anything else is 422 naming the field. */
function uuidOf(value: string, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

function optionalUuidOf(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : uuidOf(value, field);
}

/** The event that tells the other modules a source of capital is published: the plan, the disbursement snapshots and the home screens read it. */
function publishedEvent(scope: CommandScope, row: AppropriationRow, version: number, supersededId: string | null, occurredAt: Date) {
  return {
    aggregateType: RESOURCE_TYPE,
    aggregateId: row.id,
    aggregateVersion: version,
    type: 'capital.appropriation_published.v1',
    schemaVersion: 1,
    payload: {
      tenant_id: scope.tenant.tenantId,
      appropriation_id: row.id,
      version,
      actor_id: scope.tenant.membershipId,
      occurred_at: occurredAt.toISOString(),
      fund_source_version_id: row.fundSource.versionId,
      program_master_version_id: row.program?.versionId ?? null,
      plan_year: row.planYear,
      origin: row.origin,
      budget_level: row.budgetLevel,
      amount_vnd: row.amountVnd,
      decision_document_id: row.decisionDocumentId,
      revision: row.revision,
      supersedes_id: supersededId,
    },
    eventKey: `${RESOURCE_TYPE}:${row.id}:published`,
  };
}

/**
 * The appropriation register (ST-CAP-001, CAP 3.1 F1): the planner registers the capital assigned by a decision, an approver who is not
 * the planner publishes it, and a change of the amount is a new revision. No generic write exists for the status, the approver or the
 * allocated total (the allocation command is the only writer of the last).
 */
@Controller()
export class AppropriationController {
  private readonly appropriations = new CapAppropriationStore();

  @Post('appropriations')
  @HttpCode(200)
  @OperationId('registerAppropriation')
  @Command({ operation: 'registerAppropriation', ttl: 'extended' })
  async register(@Scope() scope: CommandScope, @Body() body: Schemas['CapAppropriation']): Promise<CommandResult> {
    const registered = await this.appropriations.register(
      scope.tx,
      {
        fundSourceVersionId: uuidOf(body.fund_source_version_id, 'fund_source_version_id'),
        planYear: body.plan_year,
        origin: body.origin,
        budgetLevel: body.budget_level,
        programMasterVersionId: optionalUuidOf(body.program_master_version_id, 'program_master_version_id'),
        amountVnd: body.amount_vnd,
        decisionDocumentId: uuidOf(body.decision_document_id, 'decision_document_id'),
        issuingAuthority: body.issuing_authority,
        sourceYear: body.source_year,
        extendedTo: body.extended_to,
        extensionDocumentId: optionalUuidOf(body.extension_document_id, 'extension_document_id'),
        supersedesId: optionalUuidOf(body.supersedes_id, 'supersedes_id'),
        capitalPlanId: optionalUuidOf(body.capital_plan_id, 'capital_plan_id'),
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'capital.appropriation_registered',
      resourceType: RESOURCE_TYPE,
      resourceId: registered.id,
      diff: {
        fund_source_version_id: body.fund_source_version_id,
        plan_year: body.plan_year,
        origin: body.origin,
        budget_level: body.budget_level,
        amount_vnd: body.amount_vnd,
        decision_document_id: body.decision_document_id,
        source_year: body.source_year,
        revision: registered.revision,
        supersedes_id: body.supersedes_id ?? null,
      },
    });
    return commandResult(scope, registered.status, registered.version, registered.id);
  }

  @Post('appropriations/:id/decision')
  @HttpCode(200)
  @OperationId('decideAppropriation')
  @Command({ operation: 'decideAppropriation', versioned: true, ttl: 'extended' })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    const now = new Date();
    const decided = await this.appropriations.decide(scope.tx, id, scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    const { row } = decided;
    await scope.audit({
      action: decided.status === 'PUBLISHED' ? 'capital.appropriation_published' : 'capital.appropriation_rejected',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: {
        decision: body.decision,
        status: decided.status,
        origin: row.origin,
        plan_year: row.planYear,
        amount_vnd: row.amountVnd,
        revision: row.revision,
        superseded_id: decided.supersededId,
        moved_allocation_lines: decided.movedLines,
        ledger_entry_ids: decided.ledgerEntryIds,
      },
    });
    if (decided.status === 'PUBLISHED') await scope.emit(publishedEvent(scope, row, decided.version, decided.supersededId, now));
    return commandResult(scope, decided.status, decided.version, id);
  }
}

function filterOf(planYear: unknown, origin: unknown, budgetLevel: unknown): AppropriationFilter {
  if (planYear !== undefined && (typeof planYear !== 'string' || !PLAN_YEAR.test(planYear))) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
  if (origin !== undefined && (typeof origin !== 'string' || !ORIGINS.includes(origin))) throw new DomainError('VALIDATION_FAILED', 422, 'origin');
  if (budgetLevel !== undefined && (typeof budgetLevel !== 'string' || !LEVELS.includes(budgetLevel))) throw new DomainError('VALIDATION_FAILED', 422, 'budget_level');
  return {
    planYear: planYear === undefined ? undefined : Number(planYear),
    origin: origin as AppropriationOrigin | undefined,
    budgetLevel: budgetLevel as BudgetLevel | undefined,
  };
}

/** The register by year, origin and budget level (CAP-16, and the fund and support views CAP-04 and CAP-14 read it too). */
@Controller()
export class AppropriationReadsController {
  private readonly appropriations = new CapAppropriationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('appropriations')
  @OperationId('listAppropriations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('plan_year') planYear?: unknown,
    @Query('origin') origin?: unknown,
    @Query('budget_level') budgetLevel?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf(planYear, origin, budgetLevel);
    const rows = await this.database.withTenant(tenant, (tx) => this.appropriations.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(appropriationView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }
}
