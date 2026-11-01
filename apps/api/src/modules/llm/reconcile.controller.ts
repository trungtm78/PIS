import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { INVOICE_RECONCILIATION_RESOURCE, LlmReconcileStore, TenantDatabase } from '@machvon/db';
import type { InvoiceReconciliation } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const FINOPS = PERMISSIONS.reconcileAiInvoice;
const BUDGET = 'ai_budget';
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The money of a tenant is reconciled for the whole tenant: a grant on a subtree does not reach it. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, FINOPS)) throw new DomainError('SCOPE_DENIED', 403);
}

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return Number(value);
}

/** openapi.json listAiInvoiceReconciliations item: the report of a run, with the attempts that still wait for their usage. */
export function reconciliationView(row: InvoiceReconciliation): Record<string, unknown> {
  return {
    id: row.id,
    provider_id: row.providerId,
    provider_code: row.providerCode,
    invoice_ref: row.invoiceRef,
    invoice_amount: row.invoiceAmount,
    currency: row.currency,
    period_from: row.periodFrom,
    period_to: row.periodTo,
    attempts_total: row.attemptsTotal,
    variance: row.variance,
    tolerance_pct: row.tolerancePct,
    attempt_count: row.attemptCount,
    pending_attempt_ids: row.pendingAttemptIds,
    reconciled_attempt_ids: row.reconciledAttemptIds,
    reservations_settled: row.reservationsSettled,
    status: row.status,
    owner_id: row.ownerId,
    run_count: row.runCount,
    last_run_at: row.lastRunAt,
    created_at: row.createdAt,
    version: row.version,
  };
}

/**
 * The reconciliation of the invoices of the providers of AI (ST-LLM-008, LLM.md F3, BR-LLM-06, LLM-21): the invoice is set against the sum of the attempts of the provider in the period; a difference inside the
 * tolerance is RECONCILED, one outside it is a VARIANCE with an owner that lists the attempts still waiting for their usage. No attempt is edited to make the figures agree. The decision on the reservations that
 * wait for usage is the owner of the budget's.
 */
@Controller()
export class LlmReconcileController {
  private readonly store = new LlmReconcileStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('ai-invoices/reconciliations')
  @HttpCode(200)
  @OperationId('reconcileAiInvoice')
  @Command({ operation: 'reconcileAiInvoice' })
  async reconcile(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['LlmReconcile'],
  ): Promise<CommandResult & { variance: string; attempts_total: string; pending_attempt_ids: string[]; reservations_settled: number }> {
    assertHolds(access);
    const done = await this.store.reconcile(
      scope.tx,
      { invoiceRef: body.invoice_ref, invoiceAmount: body.invoice_amount, currency: body.currency, periodFrom: body.period_from, periodTo: body.period_to },
      scope.tenant.membershipId,
      new Date(),
    );
    const row = done.reconciliation;
    await scope.audit({
      action: 'llm.invoice_reconciled',
      resourceType: INVOICE_RECONCILIATION_RESOURCE,
      resourceId: row.id,
      diff: {
        provider_code: row.providerCode,
        invoice_ref: row.invoiceRef,
        invoice_amount: row.invoiceAmount,
        attempts_total: row.attemptsTotal,
        variance: row.variance,
        status: row.status,
        run: row.runCount,
        pending_attempts: row.pendingAttemptIds.length,
        owner_id: row.ownerId,
        replayed: done.replayed,
      },
    });
    // A reconciled invoice that is asked again says what it said: there is nothing new to tell.
    if (!done.replayed) {
      await scope.emit({
        aggregateType: INVOICE_RECONCILIATION_RESOURCE,
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: row.status === 'RECONCILED' ? 'llm.invoice.reconciled.v1' : 'llm.invoice.variance.v1',
        schemaVersion: 1,
        payload: { reconciliation_id: row.id, provider_id: row.providerId, invoice_ref: row.invoiceRef, variance: row.variance, status: row.status, owner_id: row.ownerId },
        eventKey: `${INVOICE_RECONCILIATION_RESOURCE}:${row.id}:${row.version}`,
      });
    }
    return {
      ...commandResult(scope, row.status, row.version, row.id),
      variance: row.variance,
      attempts_total: row.attemptsTotal,
      pending_attempt_ids: row.pendingAttemptIds,
      reservations_settled: row.reservationsSettled,
    };
  }

  @Get('ai-invoices/reconciliations')
  @OperationId('listAiInvoiceReconciliations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertHolds(access);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, { status: typeof status === 'string' ? status : undefined, cursor: typeof cursor === 'string' ? cursor : undefined, limit: limitOf(limit) }),
    );
    return { items: page.items.map(reconciliationView), next_cursor: page.next };
  }

  @Post('budgets/:id/reconcile')
  @HttpCode(200)
  @OperationId('post_budgets_id_reconcile')
  @Command({ operation: 'post_budgets_id_reconcile', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['Decision'],
  ): Promise<CommandResult & { released: string[]; kept: string[] }> {
    assertHolds(access);
    const reservationIds = body.evidence_ids.map((one) => asUuid(one) ?? '');
    if (reservationIds.includes('')) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    const done = await this.store.decideBudget(scope.tx, id, scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason, reservationIds }, scope.tenant.membershipId);
    await scope.audit({
      action: 'llm.budget_reconciled',
      resourceType: BUDGET,
      resourceId: id,
      diff: { decision: body.decision, reason: body.reason.trim(), released: done.released, kept: done.kept },
    });
    return { ...commandResult(scope, body.decision === 'approve' ? 'RECONCILED' : 'WAITING', done.version, id), released: done.released, kept: done.kept };
  }
}
