import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, PayLedgerStore, TenantDatabase, contractScope } from '@machvon/db';
import type { LedgerLineView, LedgerPage } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { SHARED_LEDGER_CACHE, ledgerCacheKey } from './ledger-cache';

const LEDGER_PERMISSION = PERMISSIONS.getCumulativeLedger;

type Ledger = Schemas['PayCumulativeLedger'];
type Line = Schemas['PayLedgerLine'];

const lineView = (line: LedgerLineView): Line => ({
  id: line.id,
  boq_item_id: line.boqItemId,
  boq_item_key: line.boqItemKey,
  description: line.description,
  unit_code: line.unitCode,
  acceptance_id: line.acceptanceId,
  acceptance_no: line.acceptanceNo,
  party_id: line.partyId,
  accepted_vnd: line.acceptedVnd,
  requested_vnd: line.requestedVnd,
  paid_vnd: line.paidVnd,
  advance_recovered_vnd: line.advanceRecoveredVnd,
  retention_held_vnd: line.retentionHeldVnd,
  version: line.version,
  entries: line.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    accepted_delta_vnd: entry.acceptedDeltaVnd,
    requested_delta_vnd: entry.requestedDeltaVnd,
    paid_delta_vnd: entry.paidDeltaVnd,
    advance_recovery_delta_vnd: entry.advanceRecoveryDeltaVnd,
    retention_delta_vnd: entry.retentionDeltaVnd,
    advance_outstanding_after_vnd: entry.advanceOutstandingAfterVnd,
    reversal_of_id: entry.reversalOfId,
    payment_request_id: entry.paymentRequestId,
    reason: entry.reason,
    posted_at: entry.postedAt,
  })),
});

/** The page as the contract describes it; the cursor resumes after the last balance of the page. */
export function ledgerView(page: LedgerPage, asOf: Date): Ledger {
  const last = page.items[page.items.length - 1];
  return {
    contract: {
      id: page.header.contractId,
      code: page.header.contractCode,
      version: page.header.contractVersion,
      contract_value_vnd: page.header.contractValueVnd,
      accepted_total_vnd: page.header.acceptedTotalVnd,
      requested_total_vnd: page.header.requestedTotalVnd,
      paid_total_vnd: page.header.paidTotalVnd,
      advance_paid_vnd: page.header.advancePaidVnd,
      advance_recovered_vnd: page.header.advanceRecoveredVnd,
      advance_outstanding_vnd: page.header.advanceOutstandingVnd,
      retention_held_vnd: page.header.retentionHeldVnd,
      retention_released_vnd: page.header.retentionReleasedVnd,
    },
    items: page.items.map(lineView),
    total: {
      accepted_vnd: page.total.acceptedVnd,
      requested_vnd: page.total.requestedVnd,
      paid_vnd: page.total.paidVnd,
      advance_recovered_vnd: page.total.advanceRecoveredVnd,
      retention_held_vnd: page.total.retentionHeldVnd,
    },
    reconciled: page.reconciled,
    next_cursor: page.hasMore && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
    as_of: asOf.toISOString(),
  };
}

const optionalId = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? asUuid(value) : undefined;
  if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed.toLowerCase();
};

/**
 * The cumulative ledger of a contract (ST-PAY-001, PAY 3.1, UC-PAY-01): for each BOQ item of each acceptance what was accepted, requested, paid, recovered from the advance and held back, with
 * the entries that make each balance. It is for the staff who hold `ledger.read` over the contract; a contractor of the contract (a guest of the tenant) never receives it (403 `SCOPE_DENIED`),
 * and a contract outside the scope is 404. A page is the same for every reader of the same version of the contract, and every entry moves that version, so the page kept by version is never
 * stale (the key carries the tenant, the contract, the version and the question), and a `pay.*` event about the contract drops what is kept for it.
 */
@Controller()
export class CumulativeLedgerController {
  private readonly ledger = new PayLedgerStore();
  private readonly contractors = new BidContractorStore();
  private readonly cache = SHARED_LEDGER_CACHE;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contracts/:id/cumulative-ledger')
  @OperationId('getCumulativeLedger')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('boq_item_id') boqItemId?: unknown,
    @Query('acceptance_id') acceptanceId?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Ledger> {
    const item = optionalId(boqItemId, 'boq_item_id');
    const acceptance = optionalId(acceptanceId, 'acceptance_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const contractId = id.toLowerCase();
    const page = await this.database.withTenant(tenant, async (tx) => {
      const scope = contractScope(access, LEDGER_PERMISSION, now);
      const version = await this.ledger.versionOf(tx, contractId, scope);
      if (version === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      // The contractor of the contract sees its own contract elsewhere, never what the owner holds against it.
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const key = ledgerCacheKey(tenant.tenantId, contractId, version, `${item ?? ''}:${acceptance ?? ''}:${request.limit}:${request.after === undefined ? '' : `${request.after.code}|${request.after.id}`}`);
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;
      const fresh = await this.ledger.page(tx, contractId, scope, {
        boqItemId: item,
        acceptanceId: acceptance,
        limit: request.limit,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      });
      this.cache.set(key, fresh);
      return fresh;
    });
    return ledgerView(page, now);
  }
}
