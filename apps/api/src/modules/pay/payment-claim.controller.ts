import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayClaimStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import { enforceSod } from '../../sod-gate';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { PaymentIntegrityGuard } from './payment-integrity.controller';
import { answer, recordPayment } from './payment-record';
import type { PaymentCommandResult } from './payment-record';
import { PAY_METRICS } from './tokens';

const SUBMIT_PERMISSION = PERMISSIONS.post_payment_requests_id_submit;
const VERIFY_PERMISSION = PERMISSIONS.verifyPaymentRequest;
const RETURN_PERMISSION = PERMISSIONS.returnPaymentRequest;
const READ_PERMISSION = PERMISSIONS.get_resources_payment_request;

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * Sending a payment request and what follows it (ST-PAY-003, PAY 3.1 steps 3 to 5). Sending takes the claim on the acceptance, puts the request on the books of the contract (the cumulative
 * ledger, the tranches of the advance, the retention) under the lock of the contract and refuses, as a conflict, a request whose acceptance another one already holds; a person other than the
 * one who drew it up and the one who sent it checks it; and a request is given back (inside, or by the Treasury) with a reason, which gives every one of these back by entries that reverse them.
 */
@Controller()
export class PaymentClaimController {
  private readonly claims: PayClaimStore;
  private readonly integrity = new PaymentIntegrityGuard();

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink, @Optional() @Inject(TenantDatabase) private readonly database?: TenantDatabase) {
    this.claims = new PayClaimStore(metrics ?? NOOP_METRICS);
  }

  @Post('payment-requests/:id/submit')
  @HttpCode(200)
  @OperationId('post_payment_requests_id_submit')
  @Command({ operation: 'post_payment_requests_id_submit', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayPaymentSubmit']): Promise<PaymentCommandResult> {
    const now = new Date();
    // G4-2: the payment integrity checks run first, in this transaction; a blocking finding commits its run and refuses (the request stays a draft).
    const checked = await this.integrity.beforeSubmit(scope, access, id.toLowerCase(), now);
    if (checked.blocked !== undefined) return checked.blocked;
    const done = await this.claims.submit(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { expectedGrossVnd: body.expected_gross_vnd, expectedNetVnd: body.expected_net_vnd, requestId: scope.requestId, planWaiverVnd: checked.planWaiverVnd },
      scope.tenant.membershipId,
      scopesFor(access, SUBMIT_PERMISSION, now),
      vietnamDateOf(now),
    );
    // G4-1: sending a request is the requesting duty of the separation-of-duties matrix (a refusal rolls the submission back).
    await enforceSod(scope, this.database, { taking: done.requestKind === 'ADVANCE' ? 'advance.request' : 'payment.request', subjectKind: 'payment_request', recordId: done.id, command: 'post_payment_requests_id_submit' }, now);
    await recordPayment(scope, done, 'payment_request.submitted', 'pay.payment_request.submitted.v1', now);
    return answer(scope, done);
  }

  @Post('payment-requests/:id/verify')
  @HttpCode(200)
  @OperationId('verifyPaymentRequest')
  @Command({ operation: 'verifyPaymentRequest', versioned: true })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayVerifyPaymentRequest']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.claims.verify(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId, scopesFor(access, VERIFY_PERMISSION, now));
    await enforceSod(scope, this.database, { taking: done.requestKind === 'ADVANCE' ? 'advance.approve' : 'payment.verify', subjectKind: 'payment_request', recordId: done.id, command: 'verifyPaymentRequest' }, now);
    await recordPayment(scope, done, 'payment_request.verified', 'pay.payment_request.verified.v1', now, body.note?.trim());
    return answer(scope, done);
  }

  @Post('payment-requests/:id/return')
  @HttpCode(200)
  @OperationId('returnPaymentRequest')
  @Command({ operation: 'returnPaymentRequest', versioned: true })
  async returnRequest(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayReturnPaymentRequest']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.claims.returnRequest(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, returnedByTreasury: body.returned_by_treasury, requestId: scope.requestId },
      scope.tenant.membershipId,
      scopesFor(access, RETURN_PERMISSION, now),
    );
    await recordPayment(scope, done, 'payment_request.returned', 'pay.payment_request.returned.v1', now, body.reason.trim());
    return answer(scope, done);
  }
}
