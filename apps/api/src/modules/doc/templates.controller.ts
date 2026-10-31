import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentTemplateStore, TenantDatabase, rendersWatermarked } from '@machvon/db';
import type { TemplateDetail, TemplateSummary } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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

const RESOURCE_TYPE = 'document_template';
const GROUPS: ReadonlySet<string> = new Set(['DECISION', 'OFFICIAL_LETTER', 'REPORT_DISBURSEMENT', 'REPORT_MONITORING', 'TREASURY_FORM', 'SETTLEMENT_FORM', 'AUDIT_FOLLOWUP', 'OTHER']);
const STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'RETIRED']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The legal confirmations a text names, as the ledger writes them: `[CXN-10]`, `[CXN-DOC-06]`. */
const CXN_TAG = /\[(CXN-[A-Z0-9-]+)\]/g;
const REVISION_PART = /^[1-9][0-9]{0,8}$/;

/**
 * The library belongs to the whole tenant (DOC 2: the template administrator and the legal officer act over the whole tenant): a grant on a
 * branch of the organisation tree does not reach the drafting, publication, legal confirmation or retirement of a template.
 */
function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function dateFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  const date = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (match === null || date === undefined || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as string;
}

function choice(value: unknown, allowed: ReadonlySet<string>, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/** The confirmations the legal basis and the watermark of a revision refer to: the label the library shows next to the status. */
function cxnRefsOf(row: TemplateSummary): string[] {
  const found = new Set<string>();
  for (const source of [row.legalBasis, row.watermarkText ?? '']) {
    for (const match of source.matchAll(CXN_TAG)) found.add(match[1] ?? '');
  }
  return [...found].sort();
}

/** openapi.json lists the revisions of the library; the body is left to the detail. */
function summaryView(row: TemplateSummary): Record<string, unknown> {
  return {
    id: row.id,
    template_code: row.templateCode,
    revision: row.revision,
    group_code: row.groupCode,
    doc_type_code: row.docTypeCode,
    form_code: row.formCode,
    title: row.title,
    source_module: row.sourceModule,
    legal_basis: row.legalBasis,
    legal_confirmation_ref: row.legalConfirmationRef,
    confirmation_status: row.confirmationStatus,
    watermark_text: row.watermarkText,
    cxn_refs: cxnRefsOf(row),
    origin: row.origin,
    pack_version: row.packVersion,
    layout_profile_id: row.layoutProfileId,
    layout_confirmation_status: row.layoutConfirmationStatus,
    // A render carries the watermark while the template or its layout profile waits for its confirmation (BR-DOC-10).
    renders_watermarked: rendersWatermarked(row),
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    status: row.status,
    version: row.version,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
  };
}

function detailView(row: TemplateDetail, revisions: readonly TemplateSummary[]): Record<string, unknown> {
  return {
    ...summaryView(row),
    body_blocks: { blocks: row.bodyBlocks },
    placeholder_schema: row.placeholderSchema,
    content_sha256: row.contentSha256,
    published_at: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    legal_confirmed_by: row.legalConfirmedBy,
    legal_confirmed_at: row.legalConfirmedAt === null ? null : row.legalConfirmedAt.toISOString(),
    legal_evidence_document_id: row.legalEvidenceDocumentId,
    legal_confirmation_note: row.legalConfirmationNote,
    created_by_name: row.createdByName,
    approved_by_name: row.approvedByName,
    legal_confirmed_by_name: row.legalConfirmedByName,
    retired_at: row.retiredAt === null ? null : row.retiredAt.toISOString(),
    retirement_reason: row.retirementReason,
    revisions: revisions.map((revision) => ({
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      confirmation_status: revision.confirmationStatus,
      effective_from: revision.effectiveFrom,
      effective_until: revision.effectiveUntil,
    })),
  };
}

/** The API carries the body as `{ blocks: [...] }` (openapi.json types it as an object); the table keeps the bare list. */
function blocksOf(body: unknown): unknown {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'blocks')) throw new DomainError('VALIDATION_FAILED', 422, 'body_blocks');
  return body.blocks;
}

function pageAnchor(cursor: ReturnType<typeof parsePageRequest>['after']): { templateCode: string; revision: number } | undefined {
  if (cursor === undefined) return undefined;
  const cut = cursor.code.lastIndexOf('|');
  const revision = cursor.code.slice(cut + 1);
  if (cut <= 0 || !REVISION_PART.test(revision)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { templateCode: cursor.code.slice(0, cut), revision: Number(revision) };
}

/**
 * The template library (ST-DOC-006, DOC F12): revisions with an effective period, drafted by one person, published by a second
 * and legally confirmed by a third. The permissions are separate (`doc.template.manage`, `.approve`, `.confirm_legal`), and
 * the store refuses the same person twice on one revision. Rendering reads the library at render time, so a command here is
 * seen by the next render and there is nothing to invalidate.
 */
@Controller()
export class DocumentTemplatesController {
  private readonly templates = new DocumentTemplateStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('document-templates')
  @HttpCode(200)
  @OperationId('createDocumentTemplateRevision')
  @Command({ operation: 'createDocumentTemplateRevision' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocTemplateRevision']): Promise<CommandResult & { revision: number }> {
    assertWholeTenant(access, PERMISSIONS.createDocumentTemplateRevision);
    const created = await this.templates.create(scope.tx, {
      templateCode: body.template_code,
      groupCode: body.group_code,
      docTypeCode: body.doc_type_code,
      formCode: body.form_code,
      title: body.title,
      sourceModule: body.source_module,
      layoutProfileId: body.layout_profile_id,
      bodyBlocks: blocksOf(body.body_blocks),
      placeholderSchema: body.placeholder_schema,
      legalBasis: body.legal_basis,
      legalConfirmationRef: body.legal_confirmation_ref,
      effectiveFrom: body.effective_from,
      effectiveUntil: body.effective_until,
      watermarkText: body.watermark_text,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'document_template.draft',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { template_code: created.templateCode, revision: created.revision, group_code: created.groupCode, effective_from: created.effectiveFrom, effective_until: created.effectiveUntil, content_sha256: created.contentSha256 },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'doc.template_drafted.v1',
      schemaVersion: 1,
      payload: { template_id: created.id, template_code: created.templateCode, revision: created.revision, group_code: created.groupCode },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('document-templates/:id/publish')
  @HttpCode(200)
  @OperationId('publishDocumentTemplate')
  @Command({ operation: 'publishDocumentTemplate', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.publishDocumentTemplate);
    const { record, closed } = await this.templates.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const closedRevisions = closed.map((revision) => ({ template_id: revision.id, revision: revision.revision, effective_until: revision.effectiveUntil }));
    await scope.audit({
      action: 'document_template.publish',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { template_code: record.templateCode, revision: record.revision, effective_from: record.effectiveFrom, effective_until: record.effectiveUntil, closed_revisions: closedRevisions },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: record.version,
      type: 'doc.template_published.v1',
      schemaVersion: 1,
      payload: { template_id: id, template_code: record.templateCode, revision: record.revision, effective_from: record.effectiveFrom, effective_until: record.effectiveUntil, confirmation_status: record.confirmationStatus },
      eventKey: `${RESOURCE_TYPE}:${id}:${record.version}`,
    });
    return commandResult(scope, 'PUBLISHED', record.version, id);
  }

  @Post('document-templates/:id/legal-confirmation')
  @HttpCode(200)
  @OperationId('confirmDocumentTemplateLegalBasis')
  @Command({ operation: 'confirmDocumentTemplateLegalBasis', versioned: true })
  async confirm(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocTemplateLegalConfirmation'],
  ): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.confirmDocumentTemplateLegalBasis);
    const confirmed = await this.templates.confirmLegalBasis(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { reference: body.legal_confirmation_ref, evidenceDocumentId: body.evidence_document_id, note: body.note },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'document_template.confirm_legal',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { template_code: confirmed.templateCode, revision: confirmed.revision, legal_confirmation_ref: confirmed.legalConfirmationRef, evidence_document_id: confirmed.legalEvidenceDocumentId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: confirmed.version,
      type: 'doc.template_confirmed.v1',
      schemaVersion: 1,
      payload: { template_id: id, template_code: confirmed.templateCode, revision: confirmed.revision, legal_confirmation_ref: confirmed.legalConfirmationRef },
      eventKey: `${RESOURCE_TYPE}:${id}:${confirmed.version}`,
    });
    return commandResult(scope, 'CONFIRMED', confirmed.version, id);
  }

  @Post('document-templates/:id/retirement')
  @HttpCode(200)
  @OperationId('retireDocumentTemplate')
  @Command({ operation: 'retireDocumentTemplate', versioned: true })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocReason']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.retireDocumentTemplate);
    const retired = await this.templates.retire(scope.tx, id, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId);
    await scope.audit({
      action: 'document_template.retire',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: { template_code: retired.templateCode, revision: retired.revision },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: retired.version,
      type: 'doc.template_retired.v1',
      schemaVersion: 1,
      payload: { template_id: id, template_code: retired.templateCode, revision: retired.revision },
      eventKey: `${RESOURCE_TYPE}:${id}:${retired.version}`,
    });
    return commandResult(scope, 'RETIRED', retired.version, id);
  }

  @Get('document-templates')
  @OperationId('listDocumentTemplates')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('group_code') groupCode?: unknown,
    @Query('status') status?: unknown,
    @Query('as_of_date') asOfDate?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { groupCode: choice(groupCode, GROUPS, 'group_code'), status: choice(status, STATUSES, 'status'), asOfDate: dateFilter(asOfDate, 'as_of_date') };
    const after = pageAnchor(request.after);
    const rows = await this.database.withTenant(tenant, (tx) => this.templates.list(tx, filter, { limit: request.limit + 1, after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(summaryView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.templateCode}|${last.revision}`, id: last.id }) : null,
    };
  }

  @Get('document-templates/:id')
  @OperationId('getDocumentTemplate')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.templates.find(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return detailView(row, await this.templates.revisionsOf(tx, row.templateCode));
    });
  }
}
