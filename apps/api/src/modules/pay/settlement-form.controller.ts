import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PaySettlementFormStore, TenantDatabase, projectScope } from '@machvon/db';
import type { SettlementFormView } from '@machvon/db';
import { DomainError, NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, PdfRenderer, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from '../doc/file-port';
import type { DocumentFilePort } from '../doc/file-port';
import type { StateText } from '../doc/pdf-renderer';
import { DOC_METRICS, DOC_STATE_TEXT, PDF_RENDERER } from '../doc/tokens';
import { SettlementFormService } from './settlement-form.service';

const GENERATE_PERMISSION = PERMISSIONS.generateSettlementForms;
const READ_PERMISSION = PERMISSIONS.listSettlementForms;
const RESOURCE_TYPE = 'settlement_revision';
const CLASSIFICATION = 'CONFIDENTIAL';
const GENERATED_EVENT = 'pay.settlement_form.generated.v1';

/** A form of a settlement as openapi.json exposes it (x-exposure dto): an allowlist. */
export function settlementFormView(form: SettlementFormView): Record<string, unknown> {
  return {
    id: form.id,
    settlement_id: form.settlementId,
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
    generated_by: form.generatedBy,
  };
}

/**
 * The forms of a settlement of a year or of a completed project (ST-PAY-012, PAY 3.5 step 3, CXN-09): drawn by DOC from the confirmed template in force when the settlement is verified, and kept with the
 * proof of what they were drawn from. The decision 10/QTDA is drawn as the draft of a document that DOC issues by its own steps; the closing of the settlement needs that document issued (ST-PAY-009).
 */
@Controller()
export class SettlementFormController {
  private readonly forms = new PaySettlementFormStore();
  /** The drawing of the forms is DOC's: without its file store, renderer and fixed texts bound (an application that mounts PAY alone) no form can be drawn. */
  private readonly service: SettlementFormService | undefined;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOCUMENT_FILE_PORT) files?: DocumentFilePort,
    @Optional() @Inject(PDF_RENDERER) renderer?: PdfRenderer,
    @Optional() @Inject(DOC_STATE_TEXT) text?: StateText,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
  ) {
    this.service = files === undefined || renderer === undefined || text === undefined ? undefined : new SettlementFormService(files, renderer, text, metrics ?? NOOP_METRICS);
  }

  @Post('settlements/:id/forms')
  @HttpCode(200)
  @OperationId('generateSettlementForms')
  @Command({ operation: 'generateSettlementForms' })
  async generate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayGenerateSettlementForms']): Promise<CommandResult & { forms: Array<Record<string, unknown>>; decision_draft_id: string | null }> {
    const now = new Date();
    if (this.service === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_renderer');
    const done = await this.service.generate(scope.tx, scope.tenant.tenantId, id.toLowerCase(), { formCodes: body.form_codes, place: body.place }, scope.tenant.membershipId, projectScope(access, GENERATE_PERMISSION, now), vietnamDateOf(now));
    const { request } = done;
    // One audit row and one event for the call: which forms were drawn, from which template revisions, with which hashes. The figures of the settlement did not move.
    const facts = {
      project_id: request.projectId,
      settlement_scope: request.scope,
      fiscal_year: request.facts.fiscalYear,
      revision: request.facts.revision,
      forms: done.forms.map((form) => ({ form_code: form.formCode, template_code: form.templateCode, template_revision: form.templateRevision, file_sha256: form.fileSha256, payload_sha256: form.payloadSha256 })),
      decision_draft_id: done.decisionDraft?.id ?? null,
    };
    await scope.audit({ action: 'settlement_revision.forms_generated', resourceType: RESOURCE_TYPE, resourceId: request.id, classification: CLASSIFICATION, diff: facts });
    if (done.decisionDraft !== undefined) {
      // The decision is a document of DOC from here on: its own trail starts with the draft.
      await scope.audit({
        action: 'outgoing_document.create',
        resourceType: 'outgoing_document',
        resourceId: done.decisionDraft.id,
        diff: { doc_type_code: done.decisionDraft.docTypeCode, subject_module: 'PAY', subject_id: request.id, drafting_unit_id: request.draftingUnitId, payload_sha256: done.decisionDraft.payloadSha256 },
      });
    }
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: request.id,
      aggregateVersion: request.version,
      type: GENERATED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, settlement_id: request.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${request.id}:forms:${scope.requestId}`,
    });
    return { ...commandResult(scope, request.status, request.version, request.id), forms: done.forms.map(settlementFormView), decision_draft_id: done.decisionDraft?.id ?? null };
  }

  @Get('settlements/:id/forms')
  @OperationId('listSettlementForms')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.forms.list(tx, id.toLowerCase(), projectScope(access, READ_PERMISSION, now)));
    // A settlement in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { items: found.map(settlementFormView) };
  }
}
