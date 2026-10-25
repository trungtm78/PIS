import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayFormStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, FormView } from '@machvon/db';
import { DomainError, NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, PdfRenderer, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from '../doc/file-port';
import type { DocumentFilePort } from '../doc/file-port';
import type { StateText } from '../doc/pdf-renderer';
import { DOC_METRICS, DOC_STATE_TEXT, PDF_RENDERER } from '../doc/tokens';
import { answer, recordPayment } from './payment-record';
import type { PaymentCommandResult } from './payment-record';
import { PaymentFormService } from './payment-form.service';

const GENERATE_PERMISSION = PERMISSIONS.generatePaymentForms;
const SEND_PERMISSION = PERMISSIONS.markPaymentSentToTreasury;
const READ_PERMISSION = PERMISSIONS.listPaymentForms;

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** A form as openapi.json exposes it (x-exposure dto): an allowlist. */
export function formView(form: FormView, guest = false): Record<string, unknown> {
  return {
    id: form.id,
    payment_request_id: form.paymentRequestId,
    form_code: form.formCode,
    status: form.status,
    template_code: form.templateCode,
    template_revision: form.templateRevision,
    legal_basis: form.legalBasis,
    document_id: form.documentId,
    document_version_id: form.documentVersionId,
    file_sha256: form.fileSha256,
    payload_sha256: form.payloadSha256,
    generated_at: form.generatedAt,
    generated_by: guest ? null : form.generatedBy,
  };
}

/**
 * The Treasury forms of a payment request (ST-PAY-005, PAY 3.3 steps 1 and 2): drawn by DOC from the confirmed template in force when the request has been checked, kept with the proof of
 * what they were drawn from, and the record that the file went to the Treasury on a day and under a number that the person enters (no call is made to the Treasury).
 */
@Controller()
export class PaymentFormController {
  private readonly forms = new PayFormStore();
  /** The drawing of the forms is DOC's: without its file store, renderer and fixed texts bound (an application that mounts PAY alone) no form can be drawn. */
  private readonly service: PaymentFormService | undefined;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOCUMENT_FILE_PORT) files?: DocumentFilePort,
    @Optional() @Inject(PDF_RENDERER) renderer?: PdfRenderer,
    @Optional() @Inject(DOC_STATE_TEXT) text?: StateText,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
  ) {
    this.service = files === undefined || renderer === undefined || text === undefined ? undefined : new PaymentFormService(files, renderer, text, metrics ?? NOOP_METRICS);
  }

  @Post('payment-requests/:id/forms')
  @HttpCode(200)
  @OperationId('generatePaymentForms')
  @Command({ operation: 'generatePaymentForms' })
  async generate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayGeneratePaymentForms']): Promise<PaymentCommandResult & { forms: Array<Record<string, unknown>> }> {
    const now = new Date();
    if (this.service === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_renderer');
    const done = await this.service.generate(
      scope.tx,
      scope.tenant.tenantId,
      id.toLowerCase(),
      { formCodes: body.form_codes, place: body.place },
      scope.tenant.membershipId,
      scopesFor(access, GENERATE_PERMISSION, now),
      vietnamDateOf(now),
    );
    const result = await this.forms.resultOf(scope.tx, done.request.id);
    // One audit row and one event for the call: which forms were drawn, from which template revisions, with which hashes. The figures of the request did not move.
    await recordPayment(scope, result, 'payment_request.forms_generated', 'pay.payment_form.generated.v1', now, undefined, {
      facts: { forms: done.forms.map((form) => ({ form_code: form.formCode, template_code: form.templateCode, template_revision: form.templateRevision, file_sha256: form.fileSha256, payload_sha256: form.payloadSha256 })) },
      eventKey: `payment_request:${result.id}:forms:${scope.requestId}`,
    });
    return { ...answer(scope, result), forms: done.forms.map((form) => formView(form)) };
  }

  @Post('payment-requests/:id/send-treasury')
  @HttpCode(200)
  @OperationId('markPaymentSentToTreasury')
  @Command({ operation: 'markPaymentSentToTreasury', versioned: true })
  async send(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayMarkPaymentSentToTreasury']): Promise<PaymentCommandResult> {
    const now = new Date();
    const done = await this.forms.markSent(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { sentOn: body.treasury_submitted_on, treasuryRef: body.treasury_ref, formInstanceIds: body.form_instance_ids },
      scope.tenant.membershipId,
      scopesFor(access, SEND_PERMISSION, now),
      vietnamDateOf(now),
    );
    await recordPayment(scope, done, 'payment_request.sent_treasury', 'pay.payment_request.sent_treasury.v1', now, undefined, {
      facts: { treasury_submitted_on: body.treasury_submitted_on, treasury_ref: body.treasury_ref?.trim() ?? null, form_instance_ids: body.form_instance_ids.map((formId) => formId.toLowerCase()) },
    });
    return answer(scope, done);
  }

  @Get('payment-requests/:id/forms')
  @OperationId('listPaymentForms')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.forms.list(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)));
    // A request in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { items: found.map((form) => formView(form)) };
  }
}
