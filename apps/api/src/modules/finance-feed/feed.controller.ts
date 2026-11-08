import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, FeedConnectionStore, FeedDifferenceStore, FeedImportAdapter, FeedMappingStore, FeedRecordStore, FileImportStore, previewFileImport, feedStateOf, storedGeneratorParams } from '@machvon/db';
import type { FeedMappingRow, FileImportPreview } from '@machvon/db';
import {
  DomainError,
  FEED_LAYOUT_VERSION,
  FEED_MAX_ROWS,
  FEED_POSITIONS,
  NOOP_METRICS,
  assertFeedApplyAllowed,
  assertFeedLayoutKnown,
  effectivePermissions,
  feedAcceptance,
  feedGeneratorMove,
  feedGeneratorParamsJson,
  feedKindOf,
  feedMappingRequestOf,
  feedReasonOf,
  fileSha256,
  financeFeedPortFor,
  holdsPermission,
  readTabularFile,
  validateFeedRecords,
  validateUpload,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, FeedGeneratorAction, FeedGeneratorParams, FeedKind, FeedProjectRecord, MetricsSink, TenantContext } from '@machvon/kernel';
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
import { differenceDto, kindsFittingHeaders, mappingDto, rowErrorDto, runDto } from './feed-view';
import { FEED_METRICS } from './tokens';

const CONNECTION_RESOURCE = 'finance_feed_connection';
const IMPORT_RESOURCE = 'file_import';
const RUN_RESOURCE = 'finance_feed_run';
const MAPPING_RESOURCE = 'master_crosswalk';
const DIFFERENCE_RESOURCE = 'finance_feed_difference';
const RECONCILIATION_RESOURCE = 'finance_feed_reconciliation';
/** The position of the connector the framework keeps in step: the one the connection gives each tenant. */
const CURSOR_SCOPE = 'DEFAULT';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;
const CLASSIFICATION = 'INTERNAL';

const people = new BidWorkflowReads();

/** The connection `fin.sotaichinh` (FEED-01): switched on and off with a reason; the data generator (FEED-05): started, stopped, reseeded and moved on a month with a reason. */
@Controller()
export class FeedConnectionController {
  private readonly connections = new FeedConnectionStore();
  private readonly records = new FeedRecordStore();
  private readonly mappings = new FeedMappingStore();

  @Post('finance-feed/connection/state')
  @HttpCode(200)
  @OperationId('setFinanceFeedConnectionState')
  @Command({ operation: 'setFinanceFeedConnectionState', versioned: true })
  async setState(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FinanceFeedConnectionState']): Promise<CommandResult> {
    // The connection decides what the whole tenant may take in: a grant on a subtree does not reach it.
    if (!holdsOnWholeTenant(access, PERMISSIONS.setFinanceFeedConnectionState)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.connections.setState(scope.tx, scope.expectedVersion ?? 0, { enabled: body.enabled, reason: body.reason }, scope.tenant.membershipId);
    const id = done.row.id as string;
    await scope.audit({
      action: 'fin.feed_connection_switched',
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
      type: 'fin.feed.connection.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, connection_id: id, connector_code: done.row.connectorCode, enabled: done.row.enabled, version: done.row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CONNECTION_RESOURCE}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.enabled ? 'ENABLED' : 'DISABLED', done.row.version, id);
  }

  @Post('finance-feed/generator')
  @HttpCode(200)
  @OperationId('controlFinanceFeedGenerator')
  @Command({ operation: 'controlFinanceFeedGenerator', versioned: true })
  async control(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FinanceFeedGeneratorControl']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.controlFinanceFeedGenerator)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const today = vietnamDateOf(now);
    const actor = scope.tenant.membershipId;
    const action = body.action as FeedGeneratorAction;
    const { row: connection } = await this.connections.ensure(scope.tx, actor);
    const stored = storedGeneratorParams(connection, today);
    const decision = feedGeneratorMove(feedStateOf(connection), { action, reason: body.reason, body: body as unknown as Record<string, unknown>, today, stored });
    // A start or a reseed may anchor the generated projects on projects of ours that have a frozen DIS snapshot, so that the exact mapping and the reconciliation have something to work on.
    let params: FeedGeneratorParams | null = decision.params;
    let anchors: unknown[] | undefined;
    if (params !== null && (action === 'START' || action === 'RESEED')) {
      const wanted = body.anchor_count ?? (action === 'RESEED' ? (stored?.anchors?.length ?? 0) : 0);
      const found = wanted > 0 ? (await this.records.anchors(scope.tx, params.fiscalYear, wanted)).map((one) => ({ ...one, month: params?.currentMonth })) : [];
      anchors = found;
      params = { ...params, anchors: found };
    }
    const done = await this.connections.applyGenerator(scope.tx, scope.expectedVersion ?? 0, { action, decision, anchors }, actor);
    const id = done.row.id as string;
    let run: { runId: string; written: number; skipped: number } | null = null;
    let proposals = 0;
    if (decision.produces && params !== null) {
      const batch = await financeFeedPortFor('GENERATOR').read({ generator: params });
      // The generator goes through the same judgement as a file row: what the layouts would not accept is a defect of the generator and stops the command.
      const verdict = validateFeedRecords(batch.records);
      if (verdict.rejected.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'generator', { extensions: { rejected: verdict.rejected.slice(0, 5) } });
      run = await this.records.writeRun(
        scope.tx,
        { channel: 'GENERATOR', kind: null, action: action === 'START' ? 'GENERATOR_START' : action === 'RESEED' ? 'GENERATOR_RESEED' : 'GENERATOR_TICK', layoutVersion: batch.layoutVersion, records: batch.records, rejected: 0, epoch: decision.epoch, seed: params.seed, parameters: feedGeneratorParamsJson(params), digest: batch.digest },
        actor,
      );
      for (const one of batch.records) {
        if (one.kind !== 'PROJECT') continue;
        const project = one.record as FeedProjectRecord;
        if (project.ourProjectCode === null) continue;
        const proposed = await this.mappings.proposeFromRecord(scope.tx, { feedProjectCode: project.feedProjectCode, ourCode: project.ourProjectCode, importId: null, reason: `Generator ${action} seed ${params.seed}`, now }, actor);
        if (proposed.outcome === 'PROPOSED') proposals += 1;
      }
    }
    await scope.audit({
      action: 'fin.feed_generator_moved',
      resourceType: CONNECTION_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: decision.reason,
      diff: { move: action, state: decision.state, epoch: decision.epoch, seed: params?.seed ?? null, current_month: params?.currentMonth ?? null, records_written: run?.written ?? 0, mappings_proposed: proposals },
    });
    await scope.emit({
      aggregateType: CONNECTION_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'fin.feed.generator.moved.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, connection_id: id, move: action, state: decision.state, epoch: decision.epoch, records_written: run?.written ?? 0, actor_id: actor, occurred_at: now.toISOString() },
      eventKey: `${CONNECTION_RESOURCE}:${id}:${done.row.version}:generator`,
    });
    return {
      operation_id: scope.requestId,
      status: decision.state,
      resource_version: done.row.version,
      resource_id: id,
      generator: { state: decision.state, epoch: decision.epoch, current_month: params?.currentMonth ?? (done.row.generatorParams?.current_month ?? null), seed: params?.seed ?? null },
      run: run === null ? null : { id: run.runId, records_written: run.written, records_skipped: run.skipped },
      mappings_proposed: proposals,
    };
  }
}

/**
 * The records of the Finance Department that a person hands over as a file (FEED-02): the door judges the file by its bytes, scans it and stores it; the dry run reads it exactly as the apply will and writes
 * nothing; the apply goes through the file import framework once per hash. The push of the Finance application goes to the port of the channel API_PUSH, a stub that refuses until the machine account exists.
 * No call leaves the machine.
 */
@Controller()
export class FeedImportController {
  private readonly connections = new FeedConnectionStore();
  private readonly records = new FeedRecordStore();
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(FEED_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  @Post('finance-feed/imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadFinanceFeedFile')
  @Command({ operation: 'uploadFinanceFeedFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['FinanceFeedFileUpload']> {
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
      action: 'fin.feed_file_uploaded',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length, matching_kinds: matching },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length, matching_kinds: matching };
  }

  @Post('finance-feed/imports/preview')
  @HttpCode(200)
  @OperationId('previewFinanceFeedFile')
  @Command({ operation: 'previewFinanceFeedFile' })
  async preview(@Scope() scope: CommandScope, @Body() body: Schemas['FinanceFeedImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    const kind = feedKindOf(body.kind);
    // The layout of the file is versioned: another layout than the ones the module reads is refused before the file is opened, naming the version.
    const connection = await this.connections.current(scope.tx);
    const layout = assertFeedLayoutKnown(body.mapping_version ?? connection.layoutVersion);
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = new FeedImportAdapter(kind, { actor: scope.tenant.membershipId, now });
    const preview: FileImportPreview = await previewFileImport(scope.tx, adapter, bytes, { maxRows: FEED_MAX_ROWS });
    await scope.audit({
      action: 'fin.feed_import_previewed',
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
      acceptance: feedAcceptance(layout),
      file_sha256: preview.fileSha256,
      already_applied: preview.alreadyApplied,
      connection_enabled: connection.enabled,
      counts: { total: preview.counts.total, valid: preview.counts.valid, errors: preview.counts.errors, duplicate: preview.counts.duplicate, conflict: preview.counts.conflict },
      rows: preview.rows.slice(0, ROW_CAP).map((row) => ({ line: row.line, business_key: row.businessKey, status: row.status, code: row.code ?? null, field: row.field ?? null, outcome: row.outcome ?? null, preview: row.preview ?? null })),
      rows_truncated: preview.rows.length > ROW_CAP,
    };
  }

  @Post('finance-feed/imports')
  @HttpCode(200)
  @OperationId('importFinanceFeedFile')
  @Command({ operation: 'importFinanceFeedFile' })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FinanceFeedImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    // The file spans every project of the tenant and its hash is used once: applying it is for whoever holds the right on the whole tenant.
    if (!holdsOnWholeTenant(access, PERMISSIONS.importFinanceFeedFile)) throw new DomainError('SCOPE_DENIED', 403);
    const kind: FeedKind = feedKindOf(body.kind);
    const layout = assertFeedLayoutKnown(body.mapping_version ?? FEED_LAYOUT_VERSION);
    // The file comes first: one that is not the caller's tenant's is not found, whatever the state of the connection.
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertFeedApplyAllowed(connection);
    const adapter = new FeedImportAdapter(kind, { actor: scope.tenant.membershipId, now });
    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      cursorScope: CURSOR_SCOPE,
      maxRows: FEED_MAX_ROWS,
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
    const runId = await this.records.writeFileRun(
      scope.tx,
      { kind, layoutVersion: layout, fileSha256: body.file_sha256, importId: result.importId, counts: { total: counts.total, written: counts.applied, skipped: counts.duplicate + counts.conflict, rejected: counts.quarantined }, asOfLatest: adapter.written.asOfLatest },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'fin.feed_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: result.importId,
      classification: CLASSIFICATION,
      diff: { kind, connector_code: FEED_POSITIONS[kind], layout_version: layout, acceptance: feedAcceptance(layout), file_sha256: body.file_sha256, run_id: runId, counts, records_written: adapter.written.records, mappings_proposed: adapter.written.proposals },
    });
    await scope.emit({
      aggregateType: RUN_RESOURCE,
      aggregateId: runId,
      aggregateVersion: 1,
      type: 'fin.feed.import.applied.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, run_id: runId, import_id: result.importId, kind, layout_version: layout, file_sha256: body.file_sha256, rows_total: counts.total, rows_applied: counts.applied, rows_quarantined: counts.quarantined, mappings_proposed: adapter.written.proposals, differences_opened: counts.differences_opened, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RUN_RESOURCE}:${runId}:applied`,
    });
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 1,
      resource_id: runId,
      mode: 'APPLY',
      kind,
      layout_version: layout,
      acceptance: feedAcceptance(layout),
      file_sha256: body.file_sha256,
      counts,
      mappings_proposed: adapter.written.proposals,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }

  @Post('finance-feed/push')
  @HttpCode(200)
  @OperationId('pushFinanceFeedBatch')
  @Command({ operation: 'pushFinanceFeedBatch' })
  async push(@Body() body: Schemas['FinanceFeedPushRequest']): Promise<CommandResult> {
    feedKindOf(body.kind);
    assertFeedLayoutKnown(body.mapping_version);
    // The port of the channel API_PUSH is a stub until the machine account of the integration gateway exists: it refuses with 503 FEED_API_UNAVAILABLE and nothing is written.
    await financeFeedPortFor('API_PUSH').read({ kind: body.kind, rows: body.rows });
    throw new DomainError('FEED_API_UNAVAILABLE', 503, 'adapter');
  }
}

/**
 * The project codes of the Finance Department on `master_crosswalk` (FEED-03): a mapping is proposed by one person (or by the import of a record that names our code) and approved by another; one code stands
 * for one project at a time; a retired mapping stays as history. Every command is audited (ADM-11) and announced in the outbox with ids and codes, never the words of a person.
 */
@Controller()
export class FeedMappingController {
  private readonly mappings = new FeedMappingStore();

  private async dto(scope: CommandScope, access: EffectiveAccess, row: FeedMappingRow, now: Date): Promise<Record<string, unknown>> {
    const held = effectivePermissions(access, now);
    const names = await people.names(scope.tx, [row.proposedBy, row.approvedBy, row.retiredBy]);
    return mappingDto(row, names, { membershipId: scope.tenant.membershipId, mayDecide: holdsPermission(held, PERMISSIONS.decideFinanceFeedMapping), mayRetire: holdsPermission(held, PERMISSIONS.retireFinanceFeedMapping) });
  }

  private async announce(scope: CommandScope, row: FeedMappingRow, action: string, type: string, now: Date, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    await scope.audit({
      action,
      resourceType: MAPPING_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason,
      diff: { subject_id: row.subjectId, our_code: row.ourCode, external_code: row.externalCode, match_method: row.matchMethod, status: row.status, valid_from: row.validFrom, valid_until: row.validUntil, ...extra },
    });
    await scope.emit({
      aggregateType: MAPPING_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, mapping_id: row.id, subject_id: row.subjectId, external_code: row.externalCode, status: row.status, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${MAPPING_RESOURCE}:${row.id}:${row.version}:${type}`,
    });
  }

  @Post('finance-feed/mappings')
  @HttpCode(200)
  @OperationId('proposeFinanceFeedMapping')
  @Command({ operation: 'proposeFinanceFeedMapping' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FinanceFeedMappingPropose']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.proposeFinanceFeedMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const request = feedMappingRequestOf(body as unknown as Record<string, unknown>);
    const reason = feedReasonOf(body.reason);
    const done = await this.mappings.propose(scope.tx, { ...request, reason }, scope.tenant.membershipId, now);
    await this.announce(scope, done.row, 'fin.feed_mapping_proposed', 'fin.feed.mapping.proposed.v1', now, reason);
    return this.dto(scope, access, done.row, now);
  }

  @Post('finance-feed/mappings/:id/decision')
  @HttpCode(200)
  @OperationId('decideFinanceFeedMapping')
  @Command({ operation: 'decideFinanceFeedMapping', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['FinanceFeedMappingDecision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.decideFinanceFeedMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const done = await this.mappings.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    const approved = body.decision === 'APPROVE';
    await this.announce(scope, done.row, approved ? 'fin.feed_mapping_approved' : 'fin.feed_mapping_rejected', 'fin.feed.mapping.decided.v1', now, done.row.decisionReason ?? body.reason, { decision: body.decision, proposed_by: done.row.proposedBy });
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('finance-feed/mappings/:id/retire')
  @HttpCode(200)
  @OperationId('retireFinanceFeedMapping')
  @Command({ operation: 'retireFinanceFeedMapping', versioned: true })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['FinanceFeedMappingRetire']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.retireFinanceFeedMapping)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.mappings.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: 'RETIRE', reason: body.reason }, scope.tenant.membershipId, now);
    await this.announce(scope, done.row, 'fin.feed_mapping_retired', 'fin.feed.mapping.retired.v1', now, done.row.retireReason ?? body.reason);
    return commandResult(scope, done.row.status, done.row.version, id);
  }
}

/** The comparison of the feed with our own figures (FEED-04) and the settling of each difference by someone who did not make the figures. */
@Controller()
export class FeedDifferenceController {
  private readonly connections = new FeedConnectionStore();
  private readonly differences = new FeedDifferenceStore();

  @Post('finance-feed/reconciliations')
  @HttpCode(200)
  @OperationId('runFinanceFeedReconciliation')
  @Command({ operation: 'runFinanceFeedReconciliation' })
  async reconcile(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FinanceFeedReconciliationRequest']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.runFinanceFeedReconciliation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const actor = scope.tenant.membershipId;
    const { row: connection } = await this.connections.ensure(scope.tx, actor);
    const { policy } = await this.connections.rules(scope.tx, now);
    const result = await this.differences.reconcile(scope.tx, { fiscalYear: body.fiscal_year, epoch: connection.generatorEpoch, policy: policy.params, ownerId: body.owner_id ?? actor, actor, now });
    await scope.audit({
      action: 'fin.feed_reconciliation_run',
      resourceType: RECONCILIATION_RESOURCE,
      resourceId: result.id,
      classification: CLASSIFICATION,
      diff: { fiscal_year: result.fiscalYear, projects_compared: result.projectsCompared, figures_compared: result.figuresCompared, differences_opened: result.opened.length, differences_existing: result.existing, skipped_owner_is_maker: result.skippedOwnerIsMaker.length, owner_id: body.owner_id ?? actor },
    });
    await scope.emit({
      aggregateType: RECONCILIATION_RESOURCE,
      aggregateId: result.id,
      aggregateVersion: 1,
      type: 'fin.feed.reconciliation.completed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reconciliation_id: result.id, fiscal_year: result.fiscalYear, figures_compared: result.figuresCompared, differences_opened: result.opened.length, large_opened: result.opened.filter((row) => row.large).length, actor_id: actor, occurred_at: now.toISOString() },
      eventKey: `${RECONCILIATION_RESOURCE}:${result.id}:completed`,
    });
    const names = await people.names(scope.tx, result.opened.map((row) => row.ownerId));
    const held = effectivePermissions(access, now);
    return {
      operation_id: scope.requestId,
      status: 'COMPLETED',
      resource_version: 1,
      resource_id: result.id,
      fiscal_year: result.fiscalYear,
      projects_compared: result.projectsCompared,
      figures_compared: result.figuresCompared,
      existing: result.existing,
      skipped_owner_is_maker: result.skippedOwnerIsMaker,
      opened: result.opened.map((row) => differenceDto(row, names, { membershipId: actor, mayResolve: holdsPermission(held, PERMISSIONS.resolveFinanceFeedDifference) })),
    };
  }

  @Post('finance-feed/differences/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveFinanceFeedDifference')
  @Command({ operation: 'resolveFinanceFeedDifference', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['FinanceFeedResolution']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.resolveFinanceFeedDifference)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.differences.resolve(scope.tx, id, scope.expectedVersion ?? 0, { kind: body.kind, reason: body.reason, evidenceRef: body.evidence_ref ?? null, reviewOn: body.review_on ?? null }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'fin.feed_difference_resolved',
      resourceType: DIFFERENCE_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.resolutionReason ?? body.reason,
      diff: { feed_project_code: done.row.feedProjectCode, fiscal_year: done.row.fiscalYear, field: done.row.field, resolution: done.row.resolutionKind, large: done.row.large, owner_id: done.row.ownerId, review_on: done.row.reviewOn },
    });
    await scope.emit({
      aggregateType: DIFFERENCE_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'fin.feed.difference.resolved.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, difference_id: id, field: done.row.field, resolution: done.row.resolutionKind, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${DIFFERENCE_RESOURCE}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.state, done.row.version, id);
  }
}
