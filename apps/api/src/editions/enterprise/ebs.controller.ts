import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, FileImportStore, TenantDatabase, previewFileImport } from '@machvon/db';
import type { FileImportPreview } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, fileSha256, holdsPermission, readTabularFile, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import {
  EBS_COLUMNS,
  EBS_CONNECTION,
  EBS_FILE_POSITION,
  EBS_LAYOUT_VERSIONS,
  EBS_MAX_ROWS,
  EbsConnectionReads,
  EbsImportAdapter,
  EbsReconciliationStore,
  EntConnectionStore,
  assertEbsApplyAllowed,
  assertEbsLayoutKnown,
  ebsAcceptance,
  ebsHeaderOf,
  isEbsPeriod,
} from '@machvon/edition-enterprise/src/server.ts';
import type { EbsItemRow } from '@machvon/edition-enterprise/src/server.ts';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { FileService } from '../../modules/files';
import { ImportFileUploadGuard, UploadedBytes } from '../../modules/sas/theme-assets';
import type { UploadedFile } from '../../modules/sas/theme-assets';
import { ENTERPRISE_METRICS } from './tokens';
import { differenceDto, pendingExternalDto, rowErrorDto, ruleDto, runDto } from './views';
import type { Caller } from './views';

const CONNECTION_RESOURCE = 'ent_connection';
const IMPORT_RESOURCE = 'file_import';
const ITEM_RESOURCE = 'ebs_reconciliation_item';
/** The position of the connector the framework keeps in step: the one the connection gives each tenant. */
const CURSOR_SCOPE = 'DEFAULT';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;
const LAST_RUNS = 5;
const HISTORY = 10;
const CLASSIFICATION = 'INTERNAL';
/** The right of the people who answer for a difference; the holders of it over the whole tenant are the candidates for the owner. */
const RECONCILE_PERMISSION = PERMISSIONS.reconcileEbs;

const people = new BidWorkflowReads();

/** A query value that must be one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

const callerOf = (tenant: TenantContext, access: EffectiveAccess): Caller => ({
  membershipId: tenant.membershipId,
  mayRetry: false,
  mayRecordReceipt: false,
  mayDecideCorrection: false,
  mayResolve: holdsOnWholeTenant(access, PERMISSIONS.resolveEbsDifference),
  mayReassign: holdsOnWholeTenant(access, PERMISSIONS.reassignEbsDifference),
});

/**
 * The reads of the connection to Oracle EBS (EBS-01, EBS-02). The status and the health are read by anyone who may read EBS; the differences span the whole tenant, so they are read on a grant over the whole tenant.
 * A read never writes. Everything on it is PENDING-EXTERNAL while the layout of the file is a working assumption.
 */
@Controller()
export class EbsReadsController {
  private readonly connections = new EntConnectionStore(EBS_CONNECTION);
  private readonly reads = new EbsConnectionReads();
  private readonly items = new EbsReconciliationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('ebs/connection')
  @OperationId('getEbsConnection')
  async connection(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const held = effectivePermissions(access, now);
    return this.database.withTenant(tenant, async (tx) => {
      const current = await this.connections.current(tx);
      const reading = await this.reads.health(tx, now, current.layoutVersion);
      const registry = await this.connections.registryEntry(tx);
      const positions = await this.connections.positions(tx);
      const runs = await this.reads.lastRuns(tx, LAST_RUNS);
      const recordCounts = await this.reads.recordCounts(tx);
      const itemCounts = await this.items.counts(tx, now);
      const due = await this.items.dueRule(tx, now);
      const events = await this.connections.events(tx, HISTORY);
      const names = await people.names(tx, [current.stateChangedBy, ...runs.map((run) => run.importedBy), ...events.map((event) => event.actorId)]);
      const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
      const health = reading.health;
      return {
        connector_code: current.connectorCode,
        mode: 'FILE_IMPORT',
        adapter_status: health.adapterStatus,
        registry_status: registry?.status ?? 'Draft',
        registered: current.id !== null,
        enabled: current.enabled,
        state_reason: current.stateReason,
        state_changed_at: current.stateChangedAt,
        state_changed_by_name: nameOf(current.stateChangedBy),
        layout_version: current.layoutVersion,
        supported_layouts: [...EBS_LAYOUT_VERSIONS],
        acceptance: ebsAcceptance(current.layoutVersion),
        version: current.version,
        api_adapter: { status: 'MISSING', reason: 'EBS_ACCESS_PENDING' },
        health: {
          status: health.status,
          age_hours: health.ageHours,
          last_import_at: reading.lastImportAt,
          alert: health.alert === null ? null : { code: health.alert.code, severity: health.alert.severity },
          figures_blocked: health.figuresBlocked,
          apply_blocked: !current.enabled,
          rule: {
            ...ruleDto(reading.rule),
            warn_after_hours: reading.rule.params.warn_after_hours,
            max_age_hours: reading.rule.params.max_age_hours,
            stale_severity: reading.rule.params.stale_severity,
            figures_blocked_when_stale: reading.rule.params.figures_blocked_when_stale,
          },
        },
        pending_external: pendingExternalDto('ebs'),
        columns: [...EBS_COLUMNS],
        positions: positions.map((position) => ({
          connector_code: position.connectorCode,
          cursor_status: position.cursorStatus,
          adapter_status: position.adapterStatus,
          last_success_at: position.lastSuccessAt,
          last_error_code: position.lastErrorCode,
          last_file_sha256: position.lastFileSha256,
        })),
        last_runs: runs.map((run) => runDto(run, names)),
        record_counts: recordCounts,
        item_counts: { open: itemCounts.open, resolved: itemCounts.resolved, overdue: itemCounts.overdue, reviews_due: itemCounts.reviewsDue, by_resolution: itemCounts.byResolution },
        due_rule: { ...ruleDto(due), due_in_working_days: due.days },
        history: events.map((event) => ({ id: event.id, action: event.action, reason: event.reason, actor_name: nameOf(event.actorId), version: event.version, occurred_at: event.occurredAt })),
        actions: {
          may_switch: holdsOnWholeTenant(access, PERMISSIONS.setEbsConnectionState),
          may_preview: holdsPermission(held, PERMISSIONS.previewEbsFile),
          may_import: holdsOnWholeTenant(access, PERMISSIONS.importEbsFile),
          may_reconcile: holdsOnWholeTenant(access, PERMISSIONS.reconcileEbs),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('ebs/differences')
  @OperationId('listEbsDifferences')
  async differences(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEbsDifferences)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const state = text(query.state, 'state', 20);
    if (state !== undefined && state !== 'OPEN' && state !== 'RESOLVED') throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const ownerId = text(query.owner_id, 'owner_id', 36);
    if (ownerId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
    const projectCode = text(query.project_code, 'project_code', 60);
    const period = text(query.period, 'period', 7);
    if (period !== undefined && !isEbsPeriod(period)) throw new DomainError('VALIDATION_FAILED', 422, 'period');
    const overdue = text(query.overdue, 'overdue', 5);
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'overdue');
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = callerOf(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const current = await this.connections.current(tx);
      const acceptance = ebsAcceptance(current.layoutVersion);
      const rows = await this.items.list(tx, { state: state as 'OPEN' | 'RESOLVED' | undefined, ownerId, projectCode, period, overdue: overdue === 'true' }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } }, now);
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await people.names(tx, shown.flatMap((row) => [row.ownerId, row.resolvedBy]));
      const counts = await this.items.counts(tx, now);
      return {
        items: shown.map((row) => differenceDto(row, names, caller, now, acceptance)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueAtKey, id: last.id }) : null,
        counts: { open: counts.open, resolved: counts.resolved, overdue: counts.overdue, reviews_due: counts.reviewsDue },
        as_of: now.toISOString(),
      };
    });
  }
}

/**
 * The connection to Oracle EBS and its files (EBS-01): switched on and off with a reason; a file handed over by a person, judged by its bytes, scanned and stored; the dry run that reads it exactly as the apply will and writes nothing;
 * the apply through the file import framework once per hash. No call goes to EBS: the adapter is the file reader. Every command is audited (ADM-11) and announced in the outbox with ids, codes and hashes.
 */
@Controller()
export class EbsImportController {
  private readonly connections = new EntConnectionStore(EBS_CONNECTION);
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(ENTERPRISE_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  @Post('ebs/connection/state')
  @HttpCode(200)
  @OperationId('setEbsConnectionState')
  @Command({ operation: 'setEbsConnectionState', versioned: true })
  async setState(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EntConnectionState']): Promise<CommandResult> {
    // The connection decides what the whole tenant may import: a grant on a subtree does not reach it.
    if (!holdsOnWholeTenant(access, PERMISSIONS.setEbsConnectionState)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.connections.setState(scope.tx, scope.expectedVersion ?? 0, { enabled: body.enabled, reason: body.reason }, scope.tenant.membershipId);
    const id = done.row.id as string;
    await scope.audit({
      action: 'ebs.connection_switched',
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
      type: 'ent.connection.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, connection_id: id, connector_code: done.row.connectorCode, enabled: done.row.enabled, version: done.row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CONNECTION_RESOURCE}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.enabled ? 'ENABLED' : 'DISABLED', done.row.version, id);
  }

  @Post('ebs/imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadEbsFile')
  @Command({ operation: 'uploadEbsFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['EbsFileUpload']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The table reader inflates a workbook: it reads only a file the scan found clean. A file that is not a table, or has no row, is 422 IMPORT_SCHEMA_INVALID or IMPORT_EMPTY.
    const table = readTabularFile(file.bytes);
    if (table.rows.length === 0) throw new DomainError('IMPORT_EMPTY', 422, 'file');
    const headers = table.headers.map(ebsHeaderOf);
    const missing = EBS_COLUMNS.filter((column) => !headers.includes(column));
    await scope.audit({
      action: 'ebs.file_uploaded',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length, matches_layout: missing.length === 0 },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length, matches_layout: missing.length === 0, missing_columns: missing };
  }

  @Post('ebs/imports/preview')
  @HttpCode(200)
  @OperationId('previewEbsFile')
  @Command({ operation: 'previewEbsFile' })
  async preview(@Scope() scope: CommandScope, @Body() body: Schemas['EbsImportRequest']): Promise<Record<string, unknown>> {
    const layout = assertEbsLayoutKnown(body.mapping_version);
    const connection = await this.connections.current(scope.tx);
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = new EbsImportAdapter(scope.tenant.membershipId);
    const preview: FileImportPreview = await previewFileImport(scope.tx, adapter, bytes, { maxRows: EBS_MAX_ROWS });
    await scope.audit({
      action: 'ebs.import_previewed',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { connector_code: preview.connectorCode, layout_version: layout, file_sha256: preview.fileSha256, already_applied: preview.alreadyApplied, counts: preview.counts },
    });
    return {
      operation_id: scope.requestId,
      status: 'DRY_RUN',
      resource_version: 0,
      mode: 'DRY_RUN',
      layout_version: layout,
      acceptance: ebsAcceptance(layout),
      file_sha256: preview.fileSha256,
      already_applied: preview.alreadyApplied,
      connection_enabled: connection.enabled,
      counts: { total: preview.counts.total, valid: preview.counts.valid, errors: preview.counts.errors, duplicate: preview.counts.duplicate, conflict: preview.counts.conflict },
      rows: preview.rows.slice(0, ROW_CAP).map((row) => ({ line: row.line, business_key: row.businessKey, status: row.status, code: row.code ?? null, field: row.field ?? null, outcome: row.outcome ?? null, preview: row.preview ?? null })),
      rows_truncated: preview.rows.length > ROW_CAP,
    };
  }

  @Post('ebs/imports')
  @HttpCode(200)
  @OperationId('importEbsFile')
  @Command({ operation: 'importEbsFile' })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EbsImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    // The file spans every project of the tenant and its hash is used once: applying it is for whoever holds the right on the whole tenant.
    if (!holdsOnWholeTenant(access, PERMISSIONS.importEbsFile)) throw new DomainError('SCOPE_DENIED', 403);
    const layout = assertEbsLayoutKnown(body.mapping_version);
    // The file comes first: one that is not the caller's tenant's is not found, whatever the state of the connection.
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    // The tenant has the connection from its first apply; a connection that was switched off does not take a file.
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertEbsApplyAllowed(connection);
    const adapter = new EbsImportAdapter(scope.tenant.membershipId);
    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      cursorScope: CURSOR_SCOPE,
      maxRows: EBS_MAX_ROWS,
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
    const counts = { total: result.counts.total, applied: result.counts.applied, duplicate: result.counts.duplicate, conflict: result.counts.conflict, quarantined: result.counts.quarantined, differences_opened: result.counts.differencesOpened };
    const written = adapter.written;
    await scope.audit({
      action: 'ebs.import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: result.importId,
      classification: CLASSIFICATION,
      diff: { connector_code: EBS_FILE_POSITION, layout_version: layout, acceptance: ebsAcceptance(layout), file_sha256: body.file_sha256, counts, records_written: written.records, unknown_projects: written.unknownProjects },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: result.importId,
      aggregateVersion: 1,
      type: 'ebs.import.applied.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        import_id: result.importId,
        layout_version: layout,
        acceptance: ebsAcceptance(layout),
        file_sha256: body.file_sha256,
        rows_total: counts.total,
        rows_applied: counts.applied,
        rows_quarantined: counts.quarantined,
        unknown_projects: written.unknownProjects,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${IMPORT_RESOURCE}:${result.importId}:ebs-applied`,
    });
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 1,
      resource_id: result.importId,
      mode: 'APPLY',
      layout_version: layout,
      acceptance: ebsAcceptance(layout),
      file_sha256: body.file_sha256,
      counts,
      unknown_projects: written.unknownProjects,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }
}

/**
 * The differences between our figures and the statement of Oracle EBS, by project code (EBS-02): a run of the comparison opens an item for each difference, owned by somebody who is not one of the people who made the figures;
 * the owner explains it (our figure is wrong, EBS is wrong, a timing difference, accepted with a reason) and the item closes; an item can be handed to another person who is not a maker. Every command is audited (ADM-11) and
 * announced in the outbox with ids, codes and numbers, never the words of a person.
 */
@Controller()
export class EbsReconciliationController {
  private readonly items = new EbsReconciliationStore();
  private readonly connections = new EntConnectionStore(EBS_CONNECTION);

  private async announce(scope: CommandScope, row: EbsItemRow, action: string, type: string, now: Date, reason: string | undefined, extra: Record<string, unknown> = {}): Promise<void> {
    await scope.audit({
      action,
      resourceType: ITEM_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { project_code: row.projectCode, period: row.period, measure: row.measure, difference_kind: row.differenceKind, ours: row.ours, theirs: row.theirs, delta: row.delta, state: row.state, owner_id: row.ownerId, ...extra },
    });
    await scope.emit({
      aggregateType: ITEM_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, item_id: row.id, project_code: row.projectCode, period: row.period, measure: row.measure, state: row.state, owner_id: row.ownerId, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${ITEM_RESOURCE}:${row.id}:${row.version}:${type}`,
    });
  }

  @Post('ebs/reconciliations')
  @HttpCode(200)
  @OperationId('reconcileEbs')
  @Command({ operation: 'reconcileEbs' })
  async reconcile(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EbsReconcileRequest']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.reconcileEbs)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const holders = await this.items.holdersOf(scope.tx, RECONCILE_PERMISSION, now);
    const done = await this.items.reconcile(scope.tx, { period: body.period, ownerId: body.owner_id ?? scope.tenant.membershipId, holders }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'ebs.reconciliation_run',
      resourceType: ITEM_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { period: body.period ?? null, examined: done.examined, differences: done.differences, opened: done.opened, refreshed: done.refreshed, unchanged: done.unchanged, settled_already: done.settledAlready, no_owner: done.noOwner },
    });
    for (const row of done.rows) {
      await scope.emit({
        aggregateType: ITEM_RESOURCE,
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: 'ebs.reconciliation.run.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, item_id: row.id, project_code: row.projectCode, period: row.period, measure: row.measure, owner_id: row.ownerId, due_at: row.dueAt, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${ITEM_RESOURCE}:${row.id}:${row.version}:run`,
      });
    }
    const current = await this.connections.current(scope.tx);
    const names = await people.names(scope.tx, done.rows.flatMap((row) => [row.ownerId, row.resolvedBy]));
    const caller = callerOf(scope.tenant, access);
    return {
      operation_id: scope.requestId,
      status: 'RECONCILED',
      resource_version: 0,
      examined: done.examined,
      differences: done.differences,
      opened: done.opened,
      refreshed: done.refreshed,
      unchanged: done.unchanged,
      settled_already: done.settledAlready,
      no_owner: done.noOwner,
      items: done.rows.map((row) => differenceDto(row, names, caller, now, ebsAcceptance(current.layoutVersion))),
    };
  }

  @Post('ebs/differences/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveEbsDifference')
  @Command({ operation: 'resolveEbsDifference', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EbsDifferenceResolution']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.resolveEbsDifference)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.items.resolve(scope.tx, id, scope.expectedVersion ?? 0, { kind: body.kind, reason: body.reason, evidenceRef: body.evidence_ref, reviewOn: body.review_on }, scope.tenant.membershipId, now);
    await this.announce(scope, done.row, 'ebs.difference_resolved', 'ebs.difference.resolved.v1', now, done.row.reason ?? body.reason, {
      resolution_kind: done.row.resolutionKind,
      evidence_ref: done.row.evidenceRef,
      review_on: done.row.reviewOn,
      maker_ids: done.row.makerIds,
    });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('ebs/differences/:id/owner')
  @HttpCode(200)
  @OperationId('reassignEbsDifference')
  @Command({ operation: 'reassignEbsDifference', versioned: true })
  async reassign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EbsDifferenceReassign']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.reassignEbsDifference)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.items.reassign(scope.tx, id, scope.expectedVersion ?? 0, body.owner_id, now);
    await this.announce(scope, done.row, 'ebs.difference_reassigned', 'ebs.difference.reassigned.v1', now, undefined, { from_owner_id: done.before.ownerId });
    return commandResult(scope, done.row.state, done.row.version, id);
  }
}
