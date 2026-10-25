import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayReconciliationStore, PaySettlementStore, contractScope } from '@machvon/db';
import type { ContractScopes, Mismatch, Settled } from '@machvon/db';
import { DomainError, NOOP_METRICS } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { PAY_METRICS } from './tokens';

const MATCH_PERMISSION = PERMISSIONS.matchTreasuryTransaction;
const READ_PERMISSION = PERMISSIONS.get_resources_payment_request;
const CLASSIFICATION = 'CONFIDENTIAL';
const SETTLED_V1 = 'pay.payment.settled.v1';
const SETTLED_V2 = 'pay.payment.settled.v2';
const MATCHED_EVENT = 'pay.treasury_transaction.matched.v1';

const scopesFor = (access: EffectiveAccess, now: Date): ContractScopes => ({ update: contractScope(access, MATCH_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * Matching a Treasury transaction to a payment request (ST-PAY-007, PAY 3.3 step 4). Equal amounts settle the request and tell CAP, DIS and MNE by `pay.payment.settled.v1` (and v2, which also says the
 * day the Treasury confirmed it); unequal amounts leave the request with the Treasury, open a difference with both figures, an owner and a due day, and answer 422 `AMOUNT_MISMATCH_OPENED` after the
 * difference has been committed: the refusal is itself a record.
 */
@Controller()
export class TreasuryMatchController {
  private readonly settlements: PaySettlementStore;
  private readonly reconciliations: PayReconciliationStore;

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink) {
    this.settlements = new PaySettlementStore(metrics ?? NOOP_METRICS);
    this.reconciliations = new PayReconciliationStore(metrics ?? NOOP_METRICS);
  }

  @Post('treasury-transactions/:id/match')
  @HttpCode(200)
  @OperationId('matchTreasuryTransaction')
  @Command({ operation: 'matchTreasuryTransaction' })
  async match(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayMatchTreasuryTransaction'],
  ): Promise<Schemas['PayMatchResult']> {
    const now = new Date();
    const done = await this.settlements.match(scope.tx, {
      transactionId: id,
      paymentRequestId: body.payment_request_id,
      actor: scope.tenant.membershipId,
      requestId: scope.requestId,
      scopes: scopesFor(access, now),
      now,
    });
    const note = body.note?.trim();
    if (done.kind === 'SETTLED') {
      await this.recordSettled(scope, done, now, note);
      return {
        ...commandResult(scope, done.result.status, done.result.version, done.result.id),
        resource_id: done.result.id,
        transaction_id: done.transactionId,
        payment_request_id: done.result.id,
        amount_vnd: done.amountVnd,
        treasury_paid_on: done.treasuryPaidOn,
        confirmed_at: done.confirmedAt,
      };
    }
    await this.recordMismatch(scope, done, note);
    await this.reconciliations.refreshGauges(scope.tx, now);
    // The difference is committed with the audit row; the answer is the refusal, with both figures and the owner, so the screen can show them without a second call.
    scope.refuseAfterCommit(
      new DomainError('AMOUNT_MISMATCH_OPENED', 422, 'payment_request_id', {
        extensions: {
          reconciliation_item_id: done.itemId,
          internal_amount_vnd: done.internalVnd,
          confirmed_amount_vnd: done.confirmedVnd,
          difference_vnd: done.differenceVnd,
          owner_membership_id: done.ownerMembershipId,
          due_at: done.dueAt,
        },
      }),
    );
    return {
      ...commandResult(scope, done.result.status, done.result.version, done.result.id),
      resource_id: done.result.id,
      transaction_id: done.transactionId,
      payment_request_id: done.result.id,
      amount_vnd: done.confirmedVnd,
      treasury_paid_on: now.toISOString().slice(0, 10),
      confirmed_at: now.toISOString(),
    };
  }

  /** The audit row of the settlement, and the three events: the match, and the settlement in the two forms (v1 for the consumers that exist, v2 with the day the Treasury paid). */
  private async recordSettled(scope: CommandScope, done: Settled, now: Date, note: string | undefined): Promise<void> {
    const result = done.result;
    await scope.audit({
      action: 'payment_request.settled',
      resourceType: 'payment_request',
      resourceId: result.id,
      classification: CLASSIFICATION,
      ...(note === undefined ? {} : { reason: note }),
      diff: {
        from_status: 'SENT_TREASURY',
        to_status: result.status,
        transaction_id: done.transactionId,
        request_kind: result.requestKind,
        contract_id: result.contractId,
        project_id: result.projectId,
        allocation_line_id: result.allocationLineId,
        plan_year: result.planYear,
        gross_vnd: result.grossVnd,
        net_vnd: result.netVnd,
        amount_vnd: done.amountVnd,
        treasury_paid_on: done.treasuryPaidOn,
        confirmed_at: done.confirmedAt,
        ledger_entries: done.ledgerEntries,
        advance_id: done.advanceId,
      },
    });
    const base = { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() };
    await scope.emit({
      aggregateType: 'treasury_transaction',
      aggregateId: done.transactionId,
      aggregateVersion: 1,
      type: MATCHED_EVENT,
      schemaVersion: 1,
      payload: { ...base, transaction_id: done.transactionId, payment_request_id: result.id, project_id: result.projectId, amount_vnd: done.amountVnd, document_no: done.documentNo },
      eventKey: `treasury_transaction:${done.transactionId}:matched`,
    });
    // The minimum a consumer needs, no more: CAP records the DISBURSE from it and DIS and MNE count the disbursement from `confirmed_at`.
    const settled = {
      ...base,
      payment_request_id: result.id,
      contract_id: result.contractId,
      project_id: result.projectId,
      amount_vnd: result.netVnd,
      allocation_line_id: result.allocationLineId,
      plan_year: result.planYear,
      confirmed_at: done.confirmedAt,
    };
    await scope.emit({ aggregateType: 'payment_request', aggregateId: result.id, aggregateVersion: result.version, type: SETTLED_V1, schemaVersion: 1, payload: settled, eventKey: `payment_request:${result.id}:settled` });
    await scope.emit({
      aggregateType: 'payment_request',
      aggregateId: result.id,
      aggregateVersion: result.version,
      type: SETTLED_V2,
      schemaVersion: 2,
      payload: { ...settled, treasury_paid_on: done.treasuryPaidOn, request_kind: result.requestKind, transaction_id: done.transactionId },
      eventKey: `payment_request:${result.id}:settled:v2`,
    });
  }

  private async recordMismatch(scope: CommandScope, done: Mismatch, note: string | undefined): Promise<void> {
    await scope.audit({
      action: 'treasury_transaction.mismatch_opened',
      resourceType: 'reconciliation_item',
      resourceId: done.itemId,
      classification: CLASSIFICATION,
      ...(note === undefined ? {} : { reason: note }),
      diff: {
        transaction_id: done.transactionId,
        payment_request_id: done.result.id,
        project_id: done.result.projectId,
        internal_amount_vnd: done.internalVnd,
        confirmed_amount_vnd: done.confirmedVnd,
        difference_vnd: done.differenceVnd,
        owner_membership_id: done.ownerMembershipId,
        due_at: done.dueAt,
        item_opened: done.itemOpened,
      },
    });
  }
}
