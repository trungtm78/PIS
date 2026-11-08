import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, EgpConnectionStore, EgpImportAdapter, EgpMappingStore, FileImportStore, previewFileImport } from '@machvon/db';
import type { EgpMappingRow, FileImportPreview } from '@machvon/db';
import {
  DomainError,
  EGP_LAYOUT_VERSION,
  EGP_MAX_ROWS,
  EGP_POSITIONS,
  NOOP_METRICS,
  assertEgpApplyAllowed,
  assertEgpLayoutKnown,
  effectivePermissions,
  egpAcceptance,
  egpKindOf,
  egpMappingRequestOf,
  egpReasonOf,
  fileSha256,
  holdsPermission,
  readTabularFile,
  validateUpload,
} from '@machvon/kernel';
import type { EffectiveAccess, EgpLayoutKind, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { kindsFittingHeaders, mappingDto, rowErrorDto } from './egp-view';
import { BID_METRICS } from './tokens';

const CONNECTION_RESOURCE = 'egp_connection';
const IMPORT_RESOURCE = 'file_import';
const MAPPING_RESOURCE = 'master_crosswalk';
const RESTRICTION_RESOURCE = 'contractor_restriction';
/** The position of the connector the framework keeps in step: the one the connection gives each tenant. */
const CURSOR_SCOPE = 'DEFAULT';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;
const CLASSIFICATION = 'INTERNAL';

const people = new BidWorkflowReads();

/** The connection `egp.muasamcong` (BID-22): switched on and off with a reason. The registry entry stays Draft: only a VERIFIED adapter may be Active, and the adapter is PROPOSED (the layouts are working assumptions). */
@Controller()
export class EgpConnectionController {
  private readonly connections = new EgpConnectionStore();

  @Post('egp/connection/state')
  @HttpCode(200)
  @OperationId('setEgpConnectionState')
  @Command({ operation: 'setEgpConnectionState', versioned: true })
  async setState(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpConnectionState']): Promise<CommandResult> {
    // The connection decides what the whole tenant may import: a grant on a subtree does not reach it.
    if (!holdsOnWholeTenant(access, PERMISSIONS.setEgpConnectionState)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.connections.setState(scope.tx, scope.expectedVersion ?? 0, { enabled: body.enabled, reason: body.reason }, scope.tenant.membershipId);
    const id = done.row.id as string;
    await scope.audit({
      action: 'bid.egp_connection_switched',
      resourceType: CONNECTION_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.stateReason ?? body.reason,
      diff: { connector_code: done.row.connectorCode, from_enabled: done.before.enabled, to_enabled: done.row.enabled, layout_version: done.row.layoutVersion },
    });
    await scope.emit({
      aggregateType: CONNECTION_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'bid.egp.connection.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, connection_id: id, connector_code: done.row.connectorCode, enabled: done.row.enabled, version: done.row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CONNECTION_RESOURCE}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.enabled ? 'ENABLED' : 'DISABLED', done.row.version, id);
  }
}

/**
 * The files of the national procurement network (BID-24, BR-BID-13, BR-BID-16): a person downloads a file from the network and hands it over; the door judges it by its bytes, scans it and stores it; the dry run
 * reads it exactly as the apply will and writes nothing; the apply goes through the file import framework once per hash. No call goes to the network: the adapter is the file reader, and the API reader is a stub
 * that refuses (EGP_API_UNAVAILABLE) until the operator publishes a specification.
 */
@Controller()
export class EgpImportController {
  private readonly connections = new EgpConnectionStore();
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(BID_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  @Post('egp/imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadEgpFile')
  @Command({ operation: 'uploadEgpFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['EgpFileUpload']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The table reader inflates a workbook: it reads only a file the scan found clean. A file that is not a table, or has no row, is 422 IMPORT_SCHEMA_INVALID or IMPORT_EMPTY.
    const table = readTabularFile(file.bytes);
    if (table.rows.length === 0) throw new DomainError('IMPORT_EMPTY', 422, 'file');
    const matching = kindsFittingHeaders(table.headers);
    await scope.audit({
      action: 'bid.egp_file_uploaded',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length, matching_kinds: matching },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length, matching_kinds: matching };
  }

  @Post('egp/imports/preview')
  @HttpCode(200)
  @OperationId('previewEgpFile')
  @Command({ operation: 'previewEgpFile' })
  async preview(@Scope() scope: CommandScope, @Body() body: Schemas['EgpImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    const kind = egpKindOf(body.kind);
    // The layout of the file is versioned: another layout than the ones the module reads is refused before the file is opened, naming the version.
    const connection = await this.connections.current(scope.tx);
    const layout = assertEgpLayoutKnown(body.mapping_version ?? connection.layoutVersion);
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = new EgpImportAdapter(kind, { actor: scope.tenant.membershipId, now });
    const preview: FileImportPreview = await previewFileImport(scope.tx, adapter, bytes, { maxRows: EGP_MAX_ROWS });
    await scope.audit({
      action: 'bid.egp_import_previewed',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { kind, connector_code: preview.connectorCode, layout_version: layout, file_sha256: preview.fileSha256, already_applied: preview.alreadyApplied, counts: preview.counts },
    });
    return {
      operation_id: scope.requestId,
      status: 'DRY_RUN',
      resource_version: 0,
      mode: 'DRY_RUN',
      kind,
      layout_version: layout,
      acceptance: egpAcceptance(layout),
      file_sha256: preview.fileSha256,
      already_applied: preview.alreadyApplied,
      connection_enabled: connection.enabled,
      counts: { total: preview.counts.total, valid: preview.counts.valid, errors: preview.counts.errors, duplicate: preview.counts.duplicate, conflict: preview.counts.conflict },
      rows: preview.rows.slice(0, ROW_CAP).map((row) => ({
        line: row.line,
        business_key: row.businessKey,
        status: row.status,
        code: row.code ?? null,
        field: row.field ?? null,
        outcome: row.outcome ?? null,
        preview: row.preview ?? null,
      })),
      rows_truncated: preview.rows.length > ROW_CAP,
    };
  }

  @Post('egp/imports')
  @HttpCode(200)
  @OperationId('importEgpFile')
  @Command({ operation: 'importEgpFile' })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    // The file spans every package and contractor of the tenant and its hash is used once: applying it is for whoever holds the right on the whole tenant.
    if (!holdsOnWholeTenant(access, PERMISSIONS.importEgpFile)) throw new DomainError('SCOPE_DENIED', 403);
    const kind: EgpLayoutKind = egpKindOf(body.kind);
    const layout = assertEgpLayoutKnown(body.mapping_version ?? EGP_LAYOUT_VERSION);
    // The file comes first: one that is not the caller's tenant's is not found, whatever the state of the connection.
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    // The tenant has the connection from its first apply: the switch, the entry of the registry and the five positions. A connection that was switched off does not take a file.
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertEgpApplyAllowed(connection);
    const adapter = new EgpImportAdapter(kind, { actor: scope.tenant.membershipId, now });
    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      cursorScope: CURSOR_SCOPE,
      maxRows: EGP_MAX_ROWS,
      metrics: this.metrics,
      now,
    });
    // The same file is never applied twice; a file that cannot be read is told as the framework tells it. Both leave nothing behind (the command rolls back).
    if (result.outcome === 'ALREADY_IMPORTED') throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file');
    if (result.outcome === 'FAILED') throw new DomainError(result.errorCode ?? 'IMPORT_SCHEMA_INVALID', 422, 'file');
    const refused = await this.imports.quarantined(scope.tx, result.importId, ROW_CAP + 1);
    const errors = refused.slice(0, ROW_CAP).map(rowErrorDto);
    // A file none of whose rows can be taken is refused as a whole, with the line of each fault: the person corrects it and sends it again.
    if (result.counts.applied === 0 && result.counts.duplicate === 0 && refused.length > 0) {
      throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { counts: result.counts, errors, errors_truncated: refused.length > ROW_CAP } });
    }
    const counts = {
      total: result.counts.total,
      applied: result.counts.applied,
      duplicate: result.counts.duplicate,
      conflict: result.counts.conflict,
      quarantined: result.counts.quarantined,
      differences_opened: result.counts.differencesOpened,
    };
    const written = adapter.written;
    await scope.audit({
      action: 'bid.egp_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: result.importId,
      classification: CLASSIFICATION,
      diff: {
        kind,
        connector_code: EGP_POSITIONS[kind],
        layout_version: layout,
        acceptance: egpAcceptance(layout),
        file_sha256: body.file_sha256,
        counts,
        records_written: written.records,
        mappings_proposed: written.proposals.length,
        restrictions_written: written.restrictions.length,
      },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: result.importId,
      aggregateVersion: 1,
      type: 'bid.egp.import.applied.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        import_id: result.importId,
        kind,
        layout_version: layout,
        acceptance: egpAcceptance(layout),
        file_sha256: body.file_sha256,
        rows_total: counts.total,
        rows_applied: counts.applied,
        rows_quarantined: counts.quarantined,
        mappings_proposed: written.proposals.length,
        restrictions_written: written.restrictions.length,
        differences_opened: counts.differences_opened,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${IMPORT_RESOURCE}:${result.importId}:egp-applied`,
    });
    // A restriction the file wrote into the register of contractors is a legal record of the register: it has its own audit row and event, as one made by hand does.
    for (const restriction of written.restrictions) {
      await scope.audit({
        action: 'bid.contractor_restriction_recorded',
        resourceType: RESTRICTION_RESOURCE,
        resourceId: restriction.restrictionId,
        classification: CLASSIFICATION,
        diff: { contractor_id: restriction.contractorId, kind: restriction.kind, source: 'NATIONAL_E_PROCUREMENT_IMPORT', effective_from: restriction.effectiveFrom, effective_until: restriction.effectiveUntil, import_id: result.importId, restriction_code: restriction.restrictionCode },
      });
      await scope.emit({
        aggregateType: RESTRICTION_RESOURCE,
        aggregateId: restriction.restrictionId,
        aggregateVersion: 1,
        type: 'bid.egp.restriction.recorded.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, restriction_id: restriction.restrictionId, contractor_id: restriction.contractorId, kind: restriction.kind, effective_from: restriction.effectiveFrom, effective_until: restriction.effectiveUntil, import_id: result.importId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${RESTRICTION_RESOURCE}:${restriction.restrictionId}:recorded`,
      });
    }
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 1,
      resource_id: result.importId,
      mode: 'APPLY',
      kind,
      layout_version: layout,
      acceptance: egpAcceptance(layout),
      file_sha256: body.file_sha256,
      counts,
      mappings_proposed: written.proposals.length,
      restrictions_written: written.restrictions.length,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }
}

/**
 * The codes of the national network on `master_crosswalk` (BID-23, BR-BID-15): a mapping is proposed by one person (or by the import of a file) and approved by another; one code stands for one subject at a time;
 * a retired mapping stays as history. Every command is audited (ADM-11) and announced in the outbox with ids and codes, never the words of a person.
 */
@Controller()
export class EgpMappingController {
  private readonly mappings = new EgpMappingStore();

  private async dto(scope: CommandScope, access: EffectiveAccess, row: EgpMappingRow, now: Date): Promise<Record<string, unknown>> {
    const held = effectivePermissions(access, now);
    const names = await people.names(scope.tx, [row.proposedBy, row.approvedBy, row.retiredBy]);
    return mappingDto(row, names, { membershipId: scope.tenant.membershipId, mayDecide: holdsPermission(held, PERMISSIONS.decideEgpMapping), mayRetire: holdsPermission(held, PERMISSIONS.retireEgpMapping) });
  }

  private async announce(scope: CommandScope, row: EgpMappingRow, action: string, type: string, now: Date, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    await scope.audit({
      action,
      resourceType: MAPPING_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason,
      diff: { subject_type: row.subjectType, subject_id: row.subjectId, our_code: row.ourCode, external_type: row.externalType, external_code: row.externalCode, match_method: row.matchMethod, status: row.status, valid_from: row.validFrom, valid_until: row.validUntil, ...extra },
    });
    await scope.emit({
      aggregateType: MAPPING_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        mapping_id: row.id,
        subject_type: row.subjectType,
        subject_id: row.subjectId,
        external_type: row.externalType,
        external_code: row.externalCode,
        status: row.status,
        version: row.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        ...extra,
      },
      eventKey: `${MAPPING_RESOURCE}:${row.id}:${row.version}:${type}`,
    });
  }

  @Post('egp/mappings')
  @HttpCode(200)
  @OperationId('proposeEgpMapping')
  @Command({ operation: 'proposeEgpMapping' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpMappingPropose']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.proposeEgpMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const request = egpMappingRequestOf(body as unknown as Record<string, unknown>);
    const reason = egpReasonOf(body.reason);
    const done = await this.mappings.propose(scope.tx, { ...request, reason }, scope.tenant.membershipId, now);
    await this.announce(scope, done.row, 'bid.egp_mapping_proposed', 'bid.egp.mapping.proposed.v1', now, reason);
    return this.dto(scope, access, done.row, now);
  }

  @Post('egp/mappings/:id/decision')
  @HttpCode(200)
  @OperationId('decideEgpMapping')
  @Command({ operation: 'decideEgpMapping', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpMappingDecision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.decideEgpMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const done = await this.mappings.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    const approved = body.decision === 'APPROVE';
    // The event is the hook for the workflow of the procurement package: an approved mapping of a package says which notice and result of the network are ours.
    await this.announce(scope, done.row, approved ? 'bid.egp_mapping_approved' : 'bid.egp_mapping_rejected', 'bid.egp.mapping.decided.v1', now, done.row.decisionReason ?? body.reason, { decision: body.decision, proposed_by: done.row.proposedBy });
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('egp/mappings/:id/retire')
  @HttpCode(200)
  @OperationId('retireEgpMapping')
  @Command({ operation: 'retireEgpMapping', versioned: true })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpMappingRetire']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.retireEgpMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.mappings.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: 'RETIRE', reason: body.reason }, scope.tenant.membershipId, now);
    await this.announce(scope, done.row, 'bid.egp_mapping_retired', 'bid.egp.mapping.retired.v1', now, done.row.retireReason ?? body.reason);
    return commandResult(scope, done.row.status, done.row.version, id);
  }
}
