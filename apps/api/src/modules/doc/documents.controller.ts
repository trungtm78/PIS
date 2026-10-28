import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, DocumentStore, TenantDatabase, versionScope } from '@machvon/db';
import type { DocTypeRecord, DocumentVersionRecord } from '@machvon/db';
import { DomainError, NOOP_METRICS } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, PdfRenderer, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { DocumentRenderService } from './render-service';
import { DOC_CLOCK, DOC_METRICS, DOC_STATE_TEXT, DOWNLOAD_URL_TTL_SECONDS, PDF_RENDERER } from './tokens';
import type { StateText } from './pdf-renderer';

const DOWNLOAD_PERMISSION = PERMISSIONS.getDocumentVersionDownload;
const VERSION_READ_PERMISSION = PERMISSIONS.get_resources_document_version;
const VERSION_TYPE = 'document_version';

/** openapi.json get_resources_document_version item (exposure dto): the storage key of the file is internal and never leaves. */
function versionView(row: DocumentVersionRecord): Record<string, unknown> {
  return {
    id: row.id,
    document_id: row.documentId,
    version: row.version,
    checksum: row.checksum,
    mime: row.mime,
    page_count: row.pageCount,
    classification: row.classification,
    scan_status: row.scanStatus,
    stage: row.stage,
    byte_length: row.byteLength,
    renderer_version: row.rendererVersion,
    created_at: row.createdAt.toISOString(),
  };
}

function typeView(row: DocTypeRecord): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    abbreviation: row.abbreviation,
    symbol_kind: row.symbolKind,
    symbol_pattern: row.symbolPattern,
    register_code: row.registerCode,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    status: row.status,
    version: row.version,
  };
}

/** The document types of a tenant, as the registers list shows them next to the registers (no list operation of their own exists). */
export function docTypeViews(rows: readonly DocTypeRecord[]): Array<Record<string, unknown>> {
  return rows.map(typeView);
}

/**
 * Rendering, document types and the reads and download of document versions (ST-DOC-001). A stored version never
 * changes; a download needs a clean scan (BR-DOC-19) and the URL lives at most 300 seconds.
 */
@Controller()
export class DocumentsController {
  private readonly store = new DocumentStore();
  private readonly audit: AuditWriter;
  private readonly rendering: DocumentRenderService;
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DOCUMENT_FILE_PORT) private readonly files: DocumentFilePort,
    @Inject(PDF_RENDERER) renderer: PdfRenderer,
    @Inject(DOC_STATE_TEXT) text: StateText,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
    this.audit = new AuditWriter(database);
    this.rendering = new DocumentRenderService({ files, renderer, text, metrics: this.metrics, documents: this.store });
  }

  @Post('document-renders')
  @HttpCode(200)
  @OperationId('renderDocumentPreview')
  @Command({ operation: 'renderDocumentPreview' })
  async render(@Scope() scope: CommandScope, @Body() body: Schemas['DocRenderRequest']): Promise<CommandResult & Record<string, unknown>> {
    const outcome = await this.rendering.render(scope.tx, scope.tenant.tenantId, {
      templateCode: body.template_code,
      formCode: body.form_code,
      layoutProfileCode: body.layout_profile_code,
      requireConfirmed: body.require_confirmed ?? false,
      asOfDate: body.as_of_date,
      payload: body.payload,
      payloadSha256: body.payload_sha256,
      output: body.output ?? 'PDF',
      actor: scope.tenant.membershipId,
    });
    const { version } = outcome;
    await scope.audit({
      action: 'document.render',
      resourceType: VERSION_TYPE,
      resourceId: version.id,
      classification: version.classification,
      diff: {
        template_code: body.template_code,
        form_code: body.form_code,
        as_of_date: body.as_of_date,
        input_sha256: outcome.inputSha256,
        file_sha256: version.checksum,
        page_count: version.pageCount,
        watermarked: outcome.watermarked,
      },
    });
    return {
      ...commandResult(scope, 'RENDERED', version.version, version.id),
      document_id: outcome.documentId,
      version_id: version.id,
      sha256: version.checksum,
      page_count: version.pageCount,
      watermarked: outcome.watermarked,
    };
  }

  @Post('document-types')
  @HttpCode(200)
  @OperationId('defineDocumentType')
  @Command({ operation: 'defineDocumentType' })
  async defineType(@Scope() scope: CommandScope, @Body() body: Schemas['DocTypeDefinition']): Promise<CommandResult> {
    const defined = await this.store.defineDocType(scope.tx, {
      code: body.code,
      name: body.name,
      abbreviation: body.abbreviation,
      symbolKind: body.symbol_kind,
      symbolPattern: body.symbol_pattern,
      registerCode: body.register_code,
      legalBasis: body.legal_basis,
      legalConfirmationRef: body.legal_confirmation_ref,
      effectiveFrom: body.effective_from,
      effectiveUntil: body.effective_until,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'doc_type.define',
      resourceType: 'doc_type',
      resourceId: defined.id,
      diff: { code: defined.code, symbol_kind: defined.symbolKind, symbol_pattern: defined.symbolPattern, register_code: defined.registerCode, effective_from: defined.effectiveFrom, effective_until: defined.effectiveUntil },
    });
    return commandResult(scope, 'DEFINED', defined.version, defined.id);
  }

  @Get('document-versions/:id/download')
  @OperationId('getDocumentVersionDownload')
  async download(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const now = this.clock();
    // A version the caller cannot see is indistinguishable from one that does not exist.
    const version = await this.database.withTenant(tenant, (tx) =>
      this.store.findVersion(tx, id, versionScope(access, DOWNLOAD_PERMISSION, now, tenant.membershipId)),
    );
    if (version === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (version.scanStatus === 'PENDING') throw new DomainError('SCAN_PENDING', 409);
    const entry = { resourceType: VERSION_TYPE, resourceId: version.id, correlationId: randomUUID(), requestId: randomUUID(), classification: version.classification };
    if (version.scanStatus === 'INFECTED') {
      this.metrics.increment('doc_download_total', { outcome: 'infected' });
      await this.audit.recordDenied(tenant, { ...entry, action: 'document.download', diff: { reason: 'INFECTED_FILE_BLOCKED', file_sha256: version.checksum } });
      throw new DomainError('SCOPE_DENIED', 403);
    }
    const signed = await this.files.signedUrl(version.objectKey, DOWNLOAD_URL_TTL_SECONDS, now);
    await this.database.withTenant(tenant, (tx) =>
      this.audit.recordInTx(tx, tenant.membershipId, { ...entry, action: 'document.download', diff: { file_sha256: version.checksum, expires_at: signed.expiresAt.toISOString() } }),
    );
    this.metrics.increment('doc_download_total', { outcome: 'issued' });
    return { version_id: version.id, url: signed.url, expires_at: signed.expiresAt.toISOString(), mime: version.mime, checksum: version.checksum, page_count: version.pageCount };
  }
}

/** Reads of document versions (get_resources_document_version and its id form), scoped to the issuer unit of the document. */
@Controller('resources/document_version')
export class DocumentVersionReadsController {
  private readonly store = new DocumentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_document_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.listVersions(
        tx,
        { limit: request.limit + 1, after: request.after === undefined ? undefined : { sortKey: request.after.code, id: request.after.id } },
        versionScope(access, VERSION_READ_PERMISSION, now, tenant.membershipId),
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(versionView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
    };
  }

  @Get(':id')
  @OperationId('get_resources_document_version_id')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const row = await this.database.withTenant(tenant, (tx) =>
      this.store.findVersion(tx, id, versionScope(access, VERSION_READ_PERMISSION, now, tenant.membershipId)),
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return versionView(row);
  }
}
