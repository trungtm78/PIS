import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmFinopsStore, TenantDatabase } from '@machvon/db';
import type { BudgetWithCounter, PriceRow, ReservationRow } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const BUDGET = 'ai_budget';
const PRICE = 'pricing_version';
const RESERVATION_STATUSES: readonly string[] = ['RESERVED', 'SETTLED', 'RELEASED', 'PENDING_RECONCILE', 'EXCEPTION'];

/** What is left in a counter, in whole dong. */
const leftOf = (limit: string, settled: string, reserved: string): string => (BigInt(limit) - BigInt(settled) - BigInt(reserved)).toString();

export function budgetView(row: BudgetWithCounter): Record<string, unknown> {
  const counter = row.counter;
  return {
    id: row.id,
    scope_kind: row.scopeKind,
    scope_ref_id: row.scopeRefId,
    period: row.period,
    limit_vnd: row.limitVnd,
    soft_threshold_pct: row.softThresholdPct,
    hard_stop: row.hardStop,
    max_requests_per_day: row.maxRequestsPerDay,
    max_concurrent: row.maxConcurrent,
    effective_from: row.effectiveFrom,
    status: row.status,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
    // The counter of the period that holds today: what was settled, what is held for requests in flight and what is left. None yet when no request has used the budget this period.
    counter:
      counter === null
        ? null
        : {
            id: counter.id,
            period_start: counter.periodStart,
            limit_vnd: counter.limitVnd,
            settled_vnd: counter.settledVnd,
            reserved_open_vnd: counter.reservedOpenVnd,
            available_vnd: leftOf(counter.limitVnd, counter.settledVnd, counter.reservedOpenVnd),
            request_count: counter.requestCount,
            exception_count: counter.exceptionCount,
            blocked: counter.blocked,
          },
  };
}

export function priceView(row: PriceRow): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    model_id: row.modelId,
    model_ref_id: row.modelRefId,
    currency: row.currency,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    input_per_million: row.inputPerMillion,
    cached_per_million: row.cachedPerMillion,
    output_per_million: row.outputPerMillion,
    cached_semantics: row.cachedSemantics,
    reasoning_in_output: row.reasoningInOutput,
    fx_rate_to_vnd: row.fxRateToVnd,
    fx_source: row.fxSource,
    source_url: row.sourceUrl,
    verified_by: row.verifiedBy,
    verified_at: row.verifiedAt,
    // A price nobody has verified yet says so; the figure is the one the declarer gave.
    verified: row.verifiedBy !== null,
  };
}

export function reservationView(row: ReservationRow): Record<string, unknown> {
  return {
    id: row.id,
    request_id: row.requestId,
    scope: row.scope.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
    reserved_amount: row.reservedAmount,
    currency: row.currency,
    status: row.status,
    expires_at: row.expiresAt,
    settled_amount: row.settledAmount,
    released_amount: row.releasedAmount,
    settled_at: row.settledAt,
    reconcile_note: row.reconcileNote,
    created_at: row.createdAt,
    version: row.version,
  };
}

/**
 * The money of the AI gateway (ST-LLM-003, LLM F3, LLM-07, LLM-08, LLM-09): the budgets of the tenant by scope and period, the price versions of the models, the spend of a budget and the reservations that hold it. All of it is
 * the tenant's: who holds the right over a unit only is refused. The reservation, the settlement and the reconciliation themselves are done by the gateway through the store; here they are read.
 */
@Controller()
export class LlmFinopsController {
  private readonly finops = new LlmFinopsStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  // ---- budgets -----------------------------------------------------------------------------------------------------------------------------

  @Post('ai-budgets')
  @HttpCode(200)
  @OperationId('createAiBudget')
  @Command({ operation: 'createAiBudget' })
  async createBudget(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmBudgetCreate']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.createAiBudget);
    const ref = body.scope_ref_id === undefined ? null : (asUuid(body.scope_ref_id) ?? null);
    if (body.scope_ref_id !== undefined && ref === null) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref_id');
    const created = await this.finops.createBudget(scope.tx, {
      scopeKind: body.scope_kind,
      scopeRefId: ref,
      period: body.period,
      limitVnd: body.limit_vnd,
      softThresholdPct: body.soft_threshold_pct ?? 80,
      hardStop: body.hard_stop,
      maxRequestsPerDay: body.max_requests_per_day ?? null,
      maxConcurrent: body.max_concurrent ?? null,
      effectiveFrom: body.effective_from,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({ action: 'llm.budget_created', resourceType: BUDGET, resourceId: created.id, diff: { scope_kind: created.scopeKind, scope_ref_id: created.scopeRefId, period: created.period, limit_vnd: created.limitVnd, hard_stop: created.hardStop } });
    await scope.emit({
      aggregateType: BUDGET,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.budget.created.v1',
      schemaVersion: 1,
      payload: { budget_id: created.id, scope_kind: created.scopeKind, scope_ref_id: created.scopeRefId, period: created.period, limit_vnd: created.limitVnd },
      eventKey: `${BUDGET}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'ACTIVE', created.version, created.id);
  }

  @Get('ai-budgets')
  @OperationId('listAiBudgets')
  async budgets(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiBudgets);
    const rows = await this.database.withTenant(tenant, (tx) => this.finops.budgets(tx, vietnamDateOf(new Date())));
    return { items: rows.map(budgetView), next_cursor: null, as_of: new Date().toISOString() };
  }

  @Get('ai-budgets/:id/spend')
  @OperationId('getAiSpendSummary')
  async spend(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiSpendSummary);
    const day = vietnamDateOf(new Date());
    const spend = await this.database.withTenant(tenant, (tx) => this.finops.spend(tx, id, day));
    if (spend === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const counter = spend.current.counter;
    return {
      budget: budgetView({ ...spend.budget, counter }),
      as_of_day: day,
      // The tokens and the cost of the attempts settled against the counter of the period, the cached and the uncached input apart (the cost is not given as the sum of the figures shown: the price of each differs).
      current: {
        attempts: spend.current.attempts,
        input_total: spend.current.inputTotal,
        cached_input: spend.current.cachedInput,
        noncached_input: spend.current.noncachedInput,
        output_total: spend.current.outputTotal,
        cost_vnd: spend.current.costVnd,
        pending_reconcile: spend.current.pendingReconcile,
      },
      periods: spend.counters.map((entry) => ({
        period_start: entry.periodStart,
        limit_vnd: entry.limitVnd,
        settled_vnd: entry.settledVnd,
        reserved_open_vnd: entry.reservedOpenVnd,
        available_vnd: leftOf(entry.limitVnd, entry.settledVnd, entry.reservedOpenVnd),
        request_count: entry.requestCount,
        exception_count: entry.exceptionCount,
        blocked: entry.blocked,
      })),
    };
  }

  // ---- prices ------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-pricing-versions')
  @HttpCode(200)
  @OperationId('registerPricingVersion')
  @Command({ operation: 'registerPricingVersion' })
  async registerPrice(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmPricingRegister']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.registerPricingVersion);
    const modelRef = asUuid(body.model_ref_id);
    if (modelRef === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'model_ref_id');
    const effectiveFrom = new Date(body.effective_from);
    if (Number.isNaN(effectiveFrom.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    const created = await this.finops.registerPrice(scope.tx, {
      provider: body.provider.trim(),
      modelId: body.model_id.trim(),
      modelRefId: modelRef,
      currency: body.currency,
      effectiveFrom,
      inputPerMillion: body.input_per_million,
      cachedPerMillion: body.cached_per_million,
      outputPerMillion: body.output_per_million,
      cachedSemantics: body.cached_semantics,
      reasoningInOutput: body.reasoning_in_output,
      sourceUrl: body.source_url,
      fxRateToVnd: body.fx_rate_to_vnd,
      fxSource: body.fx_source.trim(),
    });
    await scope.audit({ action: 'llm.pricing_registered', resourceType: PRICE, resourceId: created.id, diff: { provider: created.provider, model_id: created.modelId, currency: created.currency, effective_from: created.effectiveFrom, source_url: created.sourceUrl } });
    await scope.emit({
      aggregateType: PRICE,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: 'llm.pricing.registered.v1',
      schemaVersion: 1,
      payload: { pricing_version_id: created.id, model_ref_id: modelRef, effective_from: created.effectiveFrom },
      eventKey: `${PRICE}:${created.id}:1`,
    });
    return commandResult(scope, 'IN_FORCE', 1, created.id);
  }

  @Get('ai-pricing-versions')
  @OperationId('listAiPricingVersions')
  async prices(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiPricingVersions);
    const rows = await this.database.withTenant(tenant, (tx) => this.finops.prices(tx));
    return { items: rows.map(priceView), next_cursor: null, as_of: new Date().toISOString() };
  }

  // ---- reservations ------------------------------------------------------------------------------------------------------------------------

  @Get('resources/budget_reservation')
  @OperationId('get_resources_budget_reservation')
  async reservations(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('request_id') requestId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    this.whole(access, PERMISSIONS.get_resources_budget_reservation);
    const page = parsePageRequest(limit, cursor);
    // The key of the cursor orders the rows by the moment they were made: it must be one.
    if (page.after !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(page.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    if (status !== undefined && (typeof status !== 'string' || !RESERVATION_STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = requestId === undefined ? undefined : asUuid(String(requestId));
    if (requestId !== undefined && request === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'request_id');
    const rows = await this.database.withTenant(tenant, (tx) => this.finops.reservations(tx, { status: status as string | undefined, requestId: request }, { limit: page.limit, after: page.after === undefined ? undefined : { key: page.after.code, id: page.after.id } }));
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(reservationView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.pageKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('resources/budget_reservation/:id')
  @OperationId('get_resources_budget_reservation_id')
  async reservation(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.get_resources_budget_reservation_id);
    const row = await this.database.withTenant(tenant, (tx) => this.finops.findReservation(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reservationView(row);
  }
}
