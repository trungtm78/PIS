import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Public } from '../../public.decorator';
import { AuditWriter, ControlDatabase, TenantDatabase, TenantExportStore, enqueueOutbox, offboardingOf } from '@machvon/db';
import type { ApprovalEffects, ExportJobRow } from '@machvon/db';
import { DomainError, bytesSha256, objectKey, versionConflict } from '@machvon/kernel';
import type { ExportManifest, TenantContext } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files/file.service';
import { EXPORT_OBJECT_KIND, exportObjectId } from './tenant-export.job';

/** The manifest is a file of the export like the others: the last one to download. */
export const EXPORT_MANIFEST_PATH = 'manifest.json';

export function exportView(job: ExportJobRow): Schemas['TenantExport'] {
  return {
    id: job.id,
    status: job.status,
    scope: job.scope,
    reason: job.reason,
    requested_at: job.requestedAt.toISOString(),
    snapshot_at: job.snapshotAt?.toISOString() ?? null,
    ready_at: job.readyAt?.toISOString() ?? null,
    expires_at: job.expiresAt?.toISOString() ?? null,
    delivered_at: job.deliveredAt?.toISOString() ?? null,
    file_count: job.fileCount,
    total_bytes: job.totalBytes,
    manifest_sha256: job.manifestSha256,
    row_counts: job.rowCounts,
    files_downloaded: job.filesDownloaded,
    encrypted: job.encryptionKeyFingerprint !== null,
    encryption_key_fingerprint: job.encryptionKeyFingerprint,
    error_code: job.errorCode,
    version: job.version,
  };
}

const notFound = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

/** How long the link to one file lives. */
const LINK_TTL_SECONDS = 300;
/** The internal caller of a redeemed link: the bearer of the link acts for the tenant that signed it, as no one in particular. */
const LINK_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{16,128}$/;
/** A path of a manifest: plain segments, no dots that climb, no spaces. */
const SAFE_PATH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,300}$/;

/**
 * The export of the data of the caller's own tenant (ST-SAS-016, SAS-17), permission `tenant.export`, allowed in the read-only state of a suspended or offboarding tenant. The path names the tenant and is the caller's own or
 * not found. The request waits for the worker (`tenant-export`, every minute); a file is served only while the export is Ready or Delivered and its 72 hours are not over, and the right to export is asked again on each download.
 */
@Controller('tenants')
export class TenantExportController {
  private readonly store = new TenantExportStore();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.audit = new AuditWriter(database);
  }

  /**
   * Asks for an export of everything (FULL) or of the business data only, optionally encrypted for the customer's RSA key. The If-Match is the number of exports the caller saw (`exports_version` of the list): when somebody
   * asked meanwhile it is 409 VERSION_CONFLICT. One export at a time (409 EXPORT_ALREADY_RUNNING).
   */
  @Post(':id/export')
  @HttpCode(202)
  @OperationId('post_tenants_id_export')
  @Command({ operation: 'post_tenants_id_export', versioned: true })
  async request(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['TenantExportRequest']): Promise<CommandResult> {
    if (id !== scope.tenant.tenantId) throw notFound();
    const current = await this.store.count(scope.tx);
    if ((scope.expectedVersion ?? 0) !== current) throw versionConflict(current);
    const effects: ApprovalEffects = { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
    const job = await this.store.request(scope.tx, effects, { requestedBy: scope.tenant.membershipId, scope: body.scope, ...(body.encryption_public_key_pem === undefined ? {} : { publicKeyPem: body.encryption_public_key_pem }), reason: body.reason }, new Date());
    return commandResult(scope, 'REQUESTED', job.version, job.id);
  }

  @Get(':id/exports')
  @OperationId('listTenantExports')
  async list(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['TenantExportPage']> {
    if (id !== tenant.tenantId) throw notFound();
    const page = parsePageRequest(limit, cursor);
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const { rows, count } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { requestedAt: page.after.code, id: page.after.id } }),
      count: await this.store.count(tx),
    }));
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(exportView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.requestedAt.toISOString(), id: last.id }) : null, exports_version: count };
  }

}

/**
 * The files of an export, named by the export alone (`/tenant-exports/{id}`), of the caller's own tenant: an export of another tenant is not found. Permission `tenant.export`, asked again on every download.
 */
@Controller('tenant-exports')
export class TenantExportFilesController {
  private readonly store = new TenantExportStore();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Get(':id/manifest')
  @Header('Cache-Control', 'no-store')
  @OperationId('getTenantExportManifest')
  async manifest(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) exportId: string): Promise<ExportManifest> {
    const job = await this.servable(tenant, exportId, new Date());
    return (await this.manifestOf(tenant, job)).manifest;
  }

  /**
   * A link to one file of the export, valid for five minutes, with the size and the hash the bytes must have. The right to export, the state of the export and its 72 hours are judged again each time a link is asked for. The
   * file is counted as downloaded when the link is redeemed (the bytes went out), and the export is Delivered once every file, the manifest included, was.
   */
  @Get(':id/file')
  @Header('Cache-Control', 'no-store')
  @OperationId('downloadTenantExportFile')
  async download(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) exportId: string, @Query('path') path?: unknown): Promise<Schemas['TenantExportLink']> {
    if (typeof path !== 'string' || !SAFE_PATH.test(path)) throw new DomainError('VALIDATION_FAILED', 422, 'path');
    const job = await this.servable(tenant, exportId, new Date());
    const { manifest, bytes: manifestBytes } = await this.manifestOf(tenant, job);
    const entry = path === EXPORT_MANIFEST_PATH ? { bytes: manifestBytes.length, sha256: bytesSha256(manifestBytes) } : manifest.files.find((file) => file.path === path);
    if (entry === undefined) throw notFound();
    const grant = await this.files.presignDownload(tenant, objectKey(tenant.tenantId, EXPORT_OBJECT_KIND, exportObjectId(job.id, path)), LINK_TTL_SECONDS);
    const query = new URLSearchParams({ tenant: tenant.tenantId, path, expires: String(grant.expires), signature: grant.signature });
    await this.audit.record(tenant, {
      action: 'tenant.export_link_issued',
      resourceType: 'tenant_export_job',
      resourceId: job.id,
      classification: 'CONFIDENTIAL',
      diff: { path, expires_at: new Date(grant.expires * 1000).toISOString() },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    return { export_id: job.id, path, url: `/tenant-exports/${job.id}/content?${query.toString()}`, expires_at: new Date(grant.expires * 1000).toISOString(), bytes: entry.bytes, sha256: entry.sha256 };
  }

  /**
   * The signed link of a file: it serves the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401 SIGNATURE_INVALID). The
   * permission was judged when the link was issued. The bytes are checked against the manifest before they go out, and the download is recorded.
   */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get(':id/content')
  async content(
    @Req() request: { method: string },
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('id', ParseUUIDPipe) exportId: string,
    @Query('tenant') tenantId: unknown,
    @Query('path') path: unknown,
    @Query('expires') expires: unknown,
    @Query('signature') signature: unknown,
  ): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof path !== 'string' || typeof expires !== 'string' || typeof signature !== 'string') throw invalid();
    if (!UUID.test(tenantId) || !SAFE_PATH.test(path) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires)) throw invalid();
    const key = objectKey(tenantId, EXPORT_OBJECT_KIND, exportObjectId(exportId, path));
    const { bytes } = await this.files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    const link: TenantContext = { tenantId, membershipId: LINK_MEMBERSHIP_ID, scopeVersion: 0 };
    const now = new Date();
    const job = await this.servable(link, exportId, now);
    const { manifest, bytes: manifestBytes } = await this.manifestOf(link, job);
    const entry = path === EXPORT_MANIFEST_PATH ? { bytes: manifestBytes.length, sha256: bytesSha256(manifestBytes) } : manifest.files.find((file) => file.path === path);
    if (entry === undefined) throw notFound();
    // What is served is what the manifest says; a file that was changed in the store is not handed over as the export.
    if (bytes.length !== entry.bytes || bytesSha256(bytes) !== entry.sha256) throw new Error('an export file does not match its manifest');
    const paths = [EXPORT_MANIFEST_PATH, ...manifest.files.map((file) => file.path)];
    // A file counts as downloaded only once the response has gone out whole: a client that drops the connection leaves the export as it was, and the last file cannot make it Delivered (and the tenant archivable) unseen.
    // A HEAD request runs the same handler and ends without a body: it delivers nothing.
    if (request.method === 'GET') response.once('finish', () => {
      void this.database
        .withTenant(link, async (tx) => {
          const correlationId = randomUUID();
          const effects: ApprovalEffects = {
            actor: LINK_MEMBERSHIP_ID,
            audit: (auditEntry) => this.audit.recordInTx(tx, LINK_MEMBERSHIP_ID, { ...auditEntry, correlationId, requestId: randomUUID() }),
            emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
          };
          await this.store.recordDownload(tx, effects, job.id, path, paths, new Date());
        })
        .catch(() => undefined);
    });
    return new StreamableFile(Buffer.from(bytes), { type: 'application/octet-stream', disposition: `attachment; filename="${path.replaceAll('/', '_')}"`, length: bytes.length });
  }

  // The export of the caller's tenant that can be read now: Ready or Delivered, inside its 72 hours.
  private async servable(tenant: TenantContext, exportId: string, now: Date): Promise<ExportJobRow> {
    const job = await this.database.withTenant(tenant, (tx) => this.store.find(tx, exportId));
    if (job === undefined) throw notFound();
    if (job.status === 'Expired' || ((job.status === 'Ready' || job.status === 'Delivered') && job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime())) throw new DomainError('EXPORT_EXPIRED', 422);
    if ((job.status !== 'Ready' && job.status !== 'Delivered') || job.manifestStorageKey === null) throw new DomainError('EXPORT_STATE_INVALID', 409, job.status);
    return job;
  }

  private async manifestOf(tenant: TenantContext, job: ExportJobRow): Promise<{ manifest: ExportManifest; bytes: Uint8Array }> {
    const stored = await this.files.readStored(tenant, job.manifestStorageKey as string);
    if (job.manifestSha256 !== null && bytesSha256(stored.bytes) !== job.manifestSha256) throw new Error('an export manifest does not match its record');
    return { manifest: JSON.parse(Buffer.from(stored.bytes).toString('utf8')) as ExportManifest, bytes: stored.bytes };
  }
}

/**
 * What the System Admin reads of the exports of a tenant that leaves (ST-SAS-016, SAS-17): the window to export, whether an export was delivered, the legal holds in force, and the exports. It reads the rows of the
 * tenant by acting as it, on the control plane (`system.tenant.read`).
 */
@Controller('system/tenants')
export class SystemTenantExportsController {
  private readonly store = new TenantExportStore();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  @Get(':tenantId/exports')
  @OperationId('listSystemTenantExports')
  async list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['SystemTenantExports']> {
    const page = parsePageRequest(limit, cursor);
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    return this.control.withTenantOf(tenantId, async (tx) => {
      const state = await offboardingOf(tx, tenantId, tenantId);
      if (state === undefined) throw notFound();
      const rows = await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { requestedAt: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return {
        tenant_status: state.status,
        tenant_version: state.version,
        contract_end_date: state.contractEndDate,
        export_window_days: state.exportWindowDays,
        export_window_ends_at: state.exportWindowEndsAt?.toISOString() ?? null,
        offboarding_started_at: state.offboardingStartedAt?.toISOString() ?? null,
        archived_at: state.archivedAt?.toISOString() ?? null,
        legal_holds_active: state.legalHoldsActive,
        export_delivered: state.exportDelivered,
        items: shown.map(exportView),
        next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.requestedAt.toISOString(), id: last.id }) : null,
      };
    });
  }
}
