import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayClaimStore, contractScope } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { NOOP_METRICS } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { PAY_METRICS } from './tokens';

const REVERSE_PERMISSION = PERMISSIONS.reversePayment;
const READ_PERMISSION = PERMISSIONS.get_resources_payment_request;
const CLASSIFICATION = 'CONFIDENTIAL';
const REVERSED_EVENT = 'pay.payment.reversed.v1';

const scopesFor = (access: EffectiveAccess, now: Date): ContractScopes => ({ update: contractScope(access, REVERSE_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * Reversing a payment that was settled (ST-PAY-008, PAY 3.4, UAT-AC331): against the refund the Treasury confirmed, with the reason and the document that approves it, by someone other than whoever
 * matched the payment. Every effect is undone by new entries that name the ones they undo; the claim on the acceptance is let go, so it can be claimed again. CAP, DIS and MNE learn of it by
 * `pay.payment.reversed.v1`, which says the day the Treasury first confirmed the payment so each can take it back from the right day.
 */
@Controller()
export class PaymentReversalController {
  private readonly claims: PayClaimStore;

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink) {
    this.claims = new PayClaimStore(metrics ?? NOOP_METRICS);
  }

  @Post('payment-requests/:id/reverse')
  @HttpCode(200)
  @OperationId('reversePayment')
  @Command({ operation: 'reversePayment', versioned: true })
  async reverse(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayReversePayment'],
  ): Promise<Schemas['PayReversalResult']> {
    const now = new Date();
    const done = await this.claims.reverse(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, approvalDocumentVersionId: body.approval_document_version_id, refundTransactionId: body.refund_treasury_transaction_id, requestId: scope.requestId },
      scope.tenant.membershipId,
      scopesFor(access, now),
    );
    const request = done.result;
    const facts = {
      contract_id: request.contractId,
      project_id: request.projectId,
      request_kind: request.requestKind,
      request_no: request.requestNo,
      acceptance_id: request.acceptanceId,
      allocation_line_id: request.allocationLineId,
      plan_year: request.planYear,
      gross_vnd: request.grossVnd,
      advance_recovery_vnd: request.advanceRecoveryVnd,
      retention_vnd: request.retentionVnd,
      net_vnd: request.netVnd,
      refund_transaction_id: done.refundTransactionId,
      treasury_paid_on: done.originalPaidOn,
    };
    // The words of the person stay in the audit row; the entries and the event carry identifiers and figures.
    await scope.audit({
      action: 'payment_request.reversed',
      resourceType: 'payment_request',
      resourceId: request.id,
      classification: CLASSIFICATION,
      ...(body.reason === undefined ? {} : { reason: body.reason.trim() }),
      diff: { from_status: 'SETTLED', to_status: request.status, ...facts, approval_document_version_id: body.approval_document_version_id ?? null, payment_entries: done.paymentEntries, advance_id: done.advanceId },
    });
    await scope.emit({
      aggregateType: 'payment_request',
      aggregateId: request.id,
      aggregateVersion: request.version,
      type: REVERSED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        payment_request_id: request.id,
        ...facts,
        amount_vnd: request.netVnd,
        refund_confirmed_at: done.refundConfirmedAt,
        approval_document_version_id: body.approval_document_version_id ?? null,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `payment_request:${request.id}:reversed`,
    });
    return {
      ...commandResult(scope, request.status, request.version, request.id),
      resource_id: request.id,
      refund_transaction_id: done.refundTransactionId,
      treasury_paid_on: done.originalPaidOn,
      payment_entries: done.paymentEntries,
    };
  }
}
