import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { CONTRACTOR_EXPORT_PERMISSION, CtrExportStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractorExportBatch } from '@machvon/db';
import { DomainError, EXPORT_ADAPTER, assertExportRequest, assertSubmission, buildContractorExport, objectKey, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { Public } from '../../public.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { FileService } from '../files';

const RESOURCE_TYPE = 'contractor_export_batch';
const FILE_KIND = 'contractor_export';
/** A signed link is good for five minutes, the most the kernel allows; the permission is judged again each time one is asked for. */
const LINK_TTL_SECONDS = 300;
const SIGNATURE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION = { CSV: 'csv', JSON: 'json' } as const;

/**
 * The export of the records of the contractors for the national database (ST-CTR-015, CTR 3.6, CTR-24). The approved evaluations and the confirmed violations of a period, of the contracts the caller holds `contractor.export` over,
 * are written as one file whose SHA-256 names the batch: asking again for the same records gives the same batch (UAT-AC315), and a period with nothing in it is 422 `EXPORT_EMPTY`. There is no interface to the national system, so
 * the file is submitted by hand and the receipt number is written down (`markContractorExportSubmitted`); the adapter says it is PROPOSED and its API MISSING (CXN-EXE-01). The trail and the events carry the figures of the
 * batch and never a name or a tax number of a contractor; those are in the file, which is stored for the tenant and downloaded by a signed link.
 */
@Controller()
export class ContractorExportController {
  private readonly exports = new CtrExportStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('contractor-exports')
  @HttpCode(200)
  @OperationId('exportContractorRecords')
  @Command({ operation: 'exportContractorRecords' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CtrExportContractorRecords']): Promise<CommandResult> {
    const request = assertExportRequest(body);
    const read = await this.exports.records(scope.tx, request, contractScope(access, CONTRACTOR_EXPORT_PERMISSION, new Date()));
    if (read.overflow) throw new DomainError('EXPORT_ROW_CAP_EXCEEDED', 422, 'period_to');
    if (read.records.length === 0) throw new DomainError('EXPORT_EMPTY', 422, 'period_to');
    const file = buildContractorExport(read.records, request.format);
    const existing = await this.exports.findByFile(scope.tx, request, file.sha256);
    let batch = existing;
    let created = false;
    if (batch === undefined) {
      // The file is named by its hash: the same bytes are the same object, so two requests that race, or one that is rolled back, never leave a second copy.
      const key = await this.files.storeGenerated(scope.tenant, FILE_KIND, file.sha256, file.bytes, file.contentType);
      ({ batch, created } = await this.exports.insert(scope.tx, randomUUID(), request, file, key, scope.tenant.membershipId));
    }
    // Whoever asks for the file may read the batch, also when it was made for someone else before: the same records are the same file.
    await this.exports.grant(scope.tx, batch.id, scope.tenant.membershipId);
    await scope.audit({
      action: 'ctr.contractor_export.generated',
      resourceType: RESOURCE_TYPE,
      resourceId: batch.id,
      classification: 'CONFIDENTIAL',
      diff: { scope: request.scope, period_from: request.periodFrom, period_to: request.periodTo, format: request.format, rows: file.rows, file_sha256: file.sha256, size_bytes: file.bytes.length, repeated: !created },
    });
    // A file that was made already is not announced a second time.
    if (created) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: batch.id,
        aggregateVersion: batch.version,
        type: 'ctr.contractor_export.generated.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, export_id: batch.id, scope: request.scope, period_from: request.periodFrom, period_to: request.periodTo, format: request.format, rows: file.rows, file_sha256: file.sha256 },
        eventKey: `${RESOURCE_TYPE}:${batch.id}:${batch.version}`,
      });
    }
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post('contractor-exports/:id/mark-submitted')
  @HttpCode(200)
  @OperationId('markContractorExportSubmitted')
  @Command({ operation: 'markContractorExportSubmitted' })
  async markSubmitted(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrMarkContractorExportSubmitted']): Promise<CommandResult> {
    const submission = assertSubmission(body, vietnamDateOf(new Date()));
    const batch = await this.exports.markSubmitted(scope.tx, id.toLowerCase(), submission, scope.tenant.membershipId, contractScope(access, CONTRACTOR_EXPORT_PERMISSION, new Date()), holdsOnWholeTenant(access, CONTRACTOR_EXPORT_PERMISSION));
    await scope.audit({
      action: 'ctr.contractor_export.submitted',
      resourceType: RESOURCE_TYPE,
      resourceId: batch.id,
      classification: 'INTERNAL',
      diff: { scope: batch.scope, period_from: batch.periodFrom, period_to: batch.periodTo, file_sha256: batch.fileSha256, submitted_ref: submission.ref, submitted_on: submission.on },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: batch.id,
      aggregateVersion: batch.version,
      type: 'ctr.contractor_export.submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, export_id: batch.id, file_sha256: batch.fileSha256, submitted_ref: submission.ref, submitted_on: submission.on },
      eventKey: `${RESOURCE_TYPE}:${batch.id}:${batch.version}`,
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }
}

function batchView(batch: ContractorExportBatch): Schemas['ContractorExportBatch'] {
  return {
    id: batch.id,
    scope: batch.scope,
    period_from: batch.periodFrom,
    period_to: batch.periodTo,
    format: batch.format,
    row_count: batch.rowCount,
    file_sha256: batch.fileSha256,
    status: batch.status,
    submitted_ref: batch.submittedRef,
    submitted_on: batch.submittedOn,
    created_at: batch.createdAt,
    version: batch.version,
  };
}

/**
 * The batches of the exports and the signed link of a file. A file holds what the person who asked for it was allowed to read, so a batch is listed and handed out to the people who asked for its file (the same records are the same
 * batch, whoever asks) and to whoever holds the permission over the whole tenant, and only while their scope, as it is now, covers every contract the file names: a caller whose scope is narrower, or was narrowed since, never reads the
 * file of someone with a wider one (404, as for a file that is not there).
 */
@Controller()
export class ContractorExportReadsController {
  private readonly exports = new CtrExportStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  @Get('contractor-exports')
  @OperationId('listContractorExports')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('cursor') cursor?: unknown, @Query('limit') limit?: unknown): Promise<Schemas['ContractorExportPage']> {
    const request = parsePageRequest(limit, cursor);
    const readBy = holdsOnWholeTenant(access, CONTRACTOR_EXPORT_PERMISSION) ? undefined : tenant.membershipId;
    const rows = await this.database.withTenant(tenant, (tx) => this.exports.list(tx, { limit: request.limit + 1, after: request.after, readBy, scope: contractScope(access, CONTRACTOR_EXPORT_PERMISSION, new Date()) }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(batchView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      adapter: { state: EXPORT_ADAPTER.state, api: EXPORT_ADAPTER.api, cxn: EXPORT_ADAPTER.cxn },
      as_of: new Date().toISOString(),
    };
  }

  @Get('contractor-exports/:id/download')
  @OperationId('getContractorExportDownload')
  async download(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['ContractorExportDownload']> {
    const batch = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.exports.find(tx, id.toLowerCase());
      return found !== undefined && (await this.exports.mayRead(tx, found.id, tenant.membershipId, contractScope(access, CONTRACTOR_EXPORT_PERMISSION, new Date()), holdsOnWholeTenant(access, CONTRACTOR_EXPORT_PERMISSION))) ? found : undefined;
    });
    if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const grant = await this.files.presignDownload(tenant, batch.objectKey, LINK_TTL_SECONDS);
    const query = new URLSearchParams({ tenant: tenant.tenantId, expires: String(grant.expires), signature: grant.signature });
    return { export_id: batch.id, url: `/contractor-exports/files/${batch.fileSha256}?${query.toString()}`, expires_at: new Date(grant.expires * 1000).toISOString(), format: batch.format, rows: batch.rowCount, file_sha256: batch.fileSha256 };
  }

  /**
   * The signed link of the download: it serves the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401 `SIGNATURE_INVALID`).
   */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get('contractor-exports/files/:sha256')
  async file(
    @Param('sha256') sha256: string,
    @Query('tenant') tenantId: unknown,
    @Query('expires') expires: unknown,
    @Query('signature') signature: unknown,
  ): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires)) throw invalid();
    if (!SIGNATURE.test(sha256)) throw invalid();
    const key = objectKey(tenantId, FILE_KIND, sha256);
    const { object, bytes } = await this.files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    const format = object.contentType === 'application/json' ? 'JSON' : 'CSV';
    return new StreamableFile(bytes, { type: object.contentType, disposition: `attachment; filename="contractor-records-${sha256}.${EXTENSION[format]}"`, length: bytes.length });
  }
}
