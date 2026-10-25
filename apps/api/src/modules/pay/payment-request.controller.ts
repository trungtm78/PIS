import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, PayPaymentStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { placeRefs, reaches } from '../ctr/contract.controller';
import { CLASSIFICATION, RESOURCE_TYPE, answer, recordPayment } from './payment-record';
import type { PaymentCommandResult } from './payment-record';
import { paymentActionsOf, paymentView } from './payment-request-view';
import type { PaymentPermissions } from './payment-request-view';

const CREATE_PERMISSION = PERMISSIONS.createPaymentRequest;
const ATTACH_PERMISSION = PERMISSIONS.attachPaymentDocument;
const CANCEL_PERMISSION = PERMISSIONS.cancelPaymentRequest;
const OVERRIDE_PERMISSION = PERMISSIONS.verifyPaymentRequest;
const READ_PERMISSION = PERMISSIONS.get_resources_payment_request;

const PERMISSIONS_OF_ACTIONS: PaymentPermissions = {
  create: CREATE_PERMISSION,
  attach: ATTACH_PERMISSION,
  cancel: CANCEL_PERMISSION,
  submit: PERMISSIONS.post_payment_requests_id_submit,
  verify: PERMISSIONS.verifyPaymentRequest,
  return: PERMISSIONS.returnPaymentRequest,
  generateForms: PERMISSIONS.generatePaymentForms,
  sendTreasury: PERMISSIONS.markPaymentSentToTreasury,
  override: OVERRIDE_PERMISSION,
};

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The draft of a payment request (ST-PAY-002, PAY 3.1 steps 1 and 2). An accountant draws a request up from an approved acceptance with the number of the file, the line of capital, a tax
 * adjustment with its basis and, if wanted, an extra recovery of the advance; the server computes gross, recovery, retention and net (BR-PAY-03..07) and no API takes gross, net, status or the
 * claim from the client (BR-PAY-17, the allowlist of the request schemas). A draft takes no claim on the acceptance; it can be revised, given documents (an invoice used before in the contract is
 * blocked unless an approver other than the drafter lets it through with a reason) and cancelled. Sending is a later step.
 */
@Controller()
export class PaymentRequestController {
  private readonly payments = new PayPaymentStore();

  @Post('payment-requests')
  @HttpCode(200)
  @OperationId('createPaymentRequest')
  @Command({ operation: 'createPaymentRequest' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PayCreatePaymentRequest']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.payments.create(
      scope.tx,
      {
        contractId: body.contract_id,
        requestKind: body.request_kind,
        acceptanceId: body.acceptance_id,
        advanceId: body.advance_id,
        settlementRevisionId: body.settlement_revision_id,
        allocationLineId: body.allocation_line_id,
        requestNo: body.request_no,
        taxAdjustmentVnd: body.tax_adjustment_vnd,
        taxAdjustmentBasis: body.tax_adjustment_basis,
        advanceRecoveryExtraVnd: body.advance_recovery_extra_vnd,
      },
      scope.tenant.membershipId,
      scopesFor(access, CREATE_PERMISSION, now),
      vietnamDateOf(now),
    );
    await recordPayment(scope, done, 'payment_request.drafted', 'pay.payment_request.drafted.v1', now);
    return answer(scope, done);
  }

  @Post('payment-requests/:id/draft')
  @HttpCode(200)
  @OperationId('revisePaymentDraft')
  @Command({ operation: 'revisePaymentDraft', versioned: true })
  async revise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRevisePaymentDraft']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.payments.revise(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        allocationLineId: body.allocation_line_id,
        requestNo: body.request_no,
        taxAdjustmentVnd: body.tax_adjustment_vnd,
        taxAdjustmentBasis: body.tax_adjustment_basis,
        advanceRecoveryExtraVnd: body.advance_recovery_extra_vnd,
      },
      scope.tenant.membershipId,
      scopesFor(access, CREATE_PERMISSION, now),
      vietnamDateOf(now),
    );
    await recordPayment(scope, done, 'payment_request.revised', 'pay.payment_request.revised.v1', now);
    return answer(scope, done);
  }

  @Post('payment-requests/:id/documents')
  @HttpCode(200)
  @OperationId('attachPaymentDocument')
  @Command({ operation: 'attachPaymentDocument' })
  async attach(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayAttachPaymentDocument']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.payments.attachDocument(
      scope.tx,
      id.toLowerCase(),
      {
        documentVersionId: body.document_version_id,
        docKind: body.doc_kind,
        invoiceNo: body.invoice_no,
        invoiceDate: body.invoice_date,
        signed: body.signed,
        duplicateOverrideReason: body.duplicate_override_reason,
      },
      scope.tenant.membershipId,
      scopesFor(access, ATTACH_PERMISSION, now),
      // An exception is let through by someone who holds the right to approve over this contract (the scope of the permission is the contract, not the tenant).
      { mayOverride: (place) => reaches(access, OVERRIDE_PERMISSION, placeRefs(place), now) },
    );
    // The audit row keeps the document and, for an exception, the reason and who allowed it; an invoice used in another contract is told to the caller and kept in the audit row too.
    await scope.audit({
      action: 'payment_request.document_attached',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(body.duplicate_override_reason === undefined ? {} : { reason: body.duplicate_override_reason }),
      diff: {
        contract_id: done.contractId,
        doc_kind: body.doc_kind,
        document_version_id: body.document_version_id.toLowerCase(),
        invoice_no: body.invoice_no ?? null,
        override_by: body.duplicate_override_reason === undefined ? null : scope.tenant.membershipId,
        warnings: done.warnings.map((warning) => warning.code),
      },
    });
    return answer(scope, done);
  }

  @Post('payment-requests/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelPaymentRequest')
  @Command({ operation: 'cancelPaymentRequest', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayCancelPaymentRequest']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.payments.cancel(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, CANCEL_PERMISSION, now));
    await recordPayment(scope, done, 'payment_request.cancelled', 'pay.payment_request.cancelled.v1', now, body.reason.trim());
    return answer(scope, done);
  }

}

/** The payment requests in the scope of the caller (the right to read them is `payment_request.read`). */
@Controller('resources/payment_request')
export class PaymentRequestReadsController {
  private readonly payments = new PayPaymentStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_payment_request')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('request_kind') requestKind?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    if ((status !== undefined && typeof status !== 'string') || (requestKind !== undefined && typeof requestKind !== 'string')) throw new DomainError('VALIDATION_FAILED', 422, status === undefined ? 'request_kind' : 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.payments.list(tx, contractScope(access, READ_PERMISSION, now), {
        contractId: filter?.toLowerCase(),
        status: status as string | undefined,
        requestKind: requestKind as string | undefined,
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => paymentView(row, paymentActionsOf(row, access, now, PERMISSIONS_OF_ACTIONS, tenant.membershipId), guest)),
      // The ordering key of the page is the creation time and the id, which the store compares as a pair.
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_payment_request_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => ({
      view: await this.payments.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    // A request in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found.view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return paymentView(found.view, paymentActionsOf(found.view, access, now, PERMISSIONS_OF_ACTIONS, tenant.membershipId), found.guest);
  }
}
