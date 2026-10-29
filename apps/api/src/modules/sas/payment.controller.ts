import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BillingPaymentStore, ControlDatabase, PLATFORM_TENANT_ID } from '@machvon/db';
import type { ApprovalEffects } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { paymentView } from './payment-view';

const STATUSES = ['Unmatched', 'PendingReview'] as const;

/**
 * The reconciliation of the payments that come in, on the control plane (ST-SAS-012, SAS-10): a Billing Operator or a System Admin sees the payments that wait (the transfer note names no invoice, or names
 * one that the amount does not fit) and matches one with an invoice. Matching moves the payment to the tenant of the invoice and settles the invoice, and only for exactly what is still to be paid: another
 * amount is 422 AMOUNT_MISMATCH and nothing moves. The payments wait under the platform tenant, so the reads are the platform's.
 */
@Controller('system')
export class PaymentController {
  private readonly payments = new BillingPaymentStore();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  @Get('payments')
  @OperationId('listBillingPayments')
  async list(@Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['BillingPaymentList']> {
    if (status !== undefined && !STATUSES.some((candidate) => candidate === status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const page = parsePageRequest(limit, cursor);
    // The cursor of this list is a time and an id: a text that is not an instant never reaches the query.
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await this.control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      this.payments.list(tx, { status: status as (typeof STATUSES)[number] | undefined, limit: page.limit + 1, after: page.after === undefined ? undefined : { receivedAt: page.after.code, id: page.after.id } }),
    );
    // The two statuses of a queue; a payment that was matched is the tenant's and is read with its invoice.
    const waiting = rows.filter((row) => row.status === 'Unmatched' || row.status === 'PendingReview');
    const shown = waiting.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(paymentView), next_cursor: waiting.length > page.limit && last !== undefined ? encodeCursor({ code: last.receivedAt.toISOString(), id: last.id }) : null };
  }

  /**
   * Matches a payment that waits with an invoice (any tenant). The reason says why a person did it; the amount must be what is still to be paid of the invoice (422 AMOUNT_MISMATCH, with the amounts in the
   * problem); the payment must be waiting (409 PAYMENT_STATE_INVALID) and the invoice payable (409 EINVOICE_STATE_INVALID); a stale `If-Match` is 409 VERSION_CONFLICT.
   */
  @Post('payments/:paymentId/match')
  @HttpCode(200)
  @OperationId('matchBillingPayment')
  @Command({ operation: 'matchBillingPayment', plane: 'control', versioned: true })
  async match(@Scope() scope: CommandScope, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Body() body: Schemas['PaymentMatch']): Promise<CommandResult> {
    const effects: ApprovalEffects = { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
    const { payment } = await this.payments.match(scope.tx, effects, {
      platformTenantId: scope.tenant.tenantId,
      paymentId,
      invoiceId: body.invoice_id,
      matchedBy: scope.tenant.membershipId,
      reason: body.reason,
      expectedVersion: scope.expectedVersion ?? undefined,
      now: new Date(),
    });
    return commandResult(scope, 'MATCHED', payment.version, payment.id);
  }
}
