import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, fileSha256, holdsPermission, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import {
  EntConnectionStore,
  HPM_CONNECTION,
  HPM_PACKAGE_FORMATS,
  HpmAdjustmentStore,
  HpmCorrectionStore,
  HpmPushStore,
  hpmAdjustmentLineOf,
  assertHpmPushAllowed,
  hpmAcceptance,
  hpmCopyRequestOf,
  hpmKeyOf,
  requestOfRow,
} from '@machvon/edition-enterprise/src/server.ts';
import type { HpmCopyRequest, HpmPort, HpmPushRow, HpmSendResult, IssuedReportPort, PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ApprovalHoldService } from '../../modules/adm/approval-hold.service';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { FileService } from '../../modules/files';
import { ENTERPRISE_METRICS, HPM_ISSUED_REPORTS, HPM_PERIOD_REOPEN, HPM_PORT } from './tokens';
import { adjustmentDto, correctionDto, pendingExternalDto, pushDto, ruleDto } from './views';
import type { Caller } from './views';

const CONNECTION_RESOURCE = 'ent_connection';
const PUSH_RESOURCE = 'hpm_push';
const CORRECTION_RESOURCE = 'hpm_correction';
const ADJUSTMENT_RESOURCE = 'hpm_adjustment';
const CLASSIFICATION = 'INTERNAL';
const HISTORY = 10;
/** The kinds of report file the object store holds for an issued copy, and the extension the package gives the file inside it. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const people = new BidWorkflowReads();

/** The push as the audit keeps it when the tenant opted in for the full before and after (HT.06): the facts of the row, never the attempts or the file. */
const pushDetail = (row: HpmPushRow): Record<string, unknown> => ({
  key: row.key,
  layout_code: row.layoutCode,
  period: row.period,
  revision: row.revision,
  sha256: row.sha256,
  status: row.status,
  attempts: row.attempts,
  last_error_code: row.lastErrorCode,
  overwrites: row.overwrites,
  correction_id: row.correctionId,
  package_format: row.packageFormat,
});

/** A query value that must be one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

const callerOf = (tenant: TenantContext, access: EffectiveAccess): Caller => ({
  membershipId: tenant.membershipId,
  mayRetry: holdsOnWholeTenant(access, PERMISSIONS.retryHpmPush),
  mayRecordReceipt: holdsOnWholeTenant(access, PERMISSIONS.recordHpmReceipt),
  mayDecideCorrection: holdsOnWholeTenant(access, PERMISSIONS.decideHpmCorrection),
  mayResolve: false,
  mayReassign: false,
});

/**
 * The reads of the push to HPM (HPM-01, HPM-02). The status and the health of the connection are read by anyone who may read HPM; the push log and the corrections span the whole tenant (a report is not owned by one unit),
 * so they are read on a grant over the whole tenant. A read never writes: a tenant that never used the connection sees it as it will be created. Everything on it is PENDING-EXTERNAL while the adapter is the file writer.
 */
@Controller()
export class HpmReadsController {
  private readonly connections = new EntConnectionStore(HPM_CONNECTION);
  private readonly pushes = new HpmPushStore();
  private readonly corrections = new HpmCorrectionStore();
  private readonly adjustments = new HpmAdjustmentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('hpm/connection')
  @OperationId('getHpmConnection')
  async connection(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const held = effectivePermissions(access, now);
    return this.database.withTenant(tenant, async (tx) => {
      const current = await this.connections.current(tx);
      const reading = await this.pushes.health(tx, now, current.enabled);
      const registry = await this.connections.registryEntry(tx);
      const counts = await this.pushes.counts(tx);
      const series = await this.pushes.acceptedSeries(tx, 50);
      const events = await this.connections.events(tx, HISTORY);
      const names = await people.names(tx, [current.stateChangedBy, ...events.map((event) => event.actorId)]);
      const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
      const health = reading.health;
      return {
        connector_code: current.connectorCode,
        mode: 'FILE_EXPORT',
        adapter_status: 'PROPOSED',
        registry_status: registry?.status ?? 'Draft',
        registered: current.id !== null,
        enabled: current.enabled,
        state_reason: current.stateReason,
        state_changed_at: current.stateChangedAt,
        state_changed_by_name: nameOf(current.stateChangedBy),
        package_format: current.layoutVersion,
        supported_formats: [...HPM_PACKAGE_FORMATS],
        acceptance: hpmAcceptance(current.layoutVersion),
        version: current.version,
        api_adapter: { status: 'MISSING', reason: 'HPM_INTERFACE_PENDING' },
        health: {
          status: health.status,
          age_hours: health.ageHours === null ? null : Math.round(health.ageHours * 10) / 10,
          last_delivery_at: reading.lastDeliveryAt,
          failed_pushes: health.failedPushes,
          awaiting_receipt: health.awaitingReceipt,
          alert: health.alert === null ? null : { code: health.alert.code, severity: health.alert.severity },
          push_blocked: !current.enabled,
          rule: { ...ruleDto(reading.rule), max_attempts: reading.rule.params.max_attempts, warn_after_hours: reading.rule.params.warn_after_hours, max_age_hours: reading.rule.params.max_age_hours, stale_severity: reading.rule.params.stale_severity },
        },
        pending_external: pendingExternalDto('hpm'),
        accepted_series: series.map((entry) => ({ layout_code: entry.layoutCode, period: entry.period, revision: entry.revision, accepted_at: entry.acceptedAt })),
        counts,
        history: events.map((event) => ({ id: event.id, action: event.action, reason: event.reason, actor_name: nameOf(event.actorId), version: event.version, occurred_at: event.occurredAt })),
        actions: {
          may_switch: holdsOnWholeTenant(access, PERMISSIONS.setHpmConnectionState),
          may_push: holdsOnWholeTenant(access, PERMISSIONS.submitHpmPush),
          may_record_receipt: holdsOnWholeTenant(access, PERMISSIONS.recordHpmReceipt),
          may_propose_correction: holdsPermission(held, PERMISSIONS.proposeHpmCorrection) && holdsOnWholeTenant(access, PERMISSIONS.proposeHpmCorrection),
          may_decide_correction: holdsOnWholeTenant(access, PERMISSIONS.decideHpmCorrection),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('hpm/pushes')
  @OperationId('listHpmPushes')
  async listPushes(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listHpmPushes)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !['PENDING', 'WRITTEN', 'FAILED', 'ACCEPTED', 'REJECTED'].includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const layoutCode = text(query.layout_code, 'layout_code', 60);
    const period = text(query.period, 'period', 10);
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = callerOf(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.pushes.list(tx, { status: status as HpmPushRow['status'] | undefined, layoutCode, period }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await people.names(tx, shown.flatMap((row) => [row.pushedBy, row.receiptBy, ...row.attemptRows.map((attempt) => attempt.actorId)]));
      return {
        items: shown.map((row) => pushDto(row, names, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.lastAttemptAtKey, id: last.id }) : null,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('hpm/corrections')
  @OperationId('listHpmCorrections')
  async listCorrections(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listHpmCorrections)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const state = text(query.state, 'state', 20);
    if (state !== undefined && !['PROPOSED', 'APPROVED', 'REJECTED', 'CONSUMED', 'APPLIED'].includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const layoutCode = text(query.layout_code, 'layout_code', 60);
    const period = text(query.period, 'period', 10);
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = callerOf(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const after = request.after === undefined ? undefined : { key: request.after.code, id: request.after.id };
      // Both modes of a correction (overwrite after a reopening, adjustment in the next period) are one list, newest first; each table is paged by the same keyset, so the merge of the first page of each is the first page of both.
      const overwrites = state === 'APPLIED' ? [] : await this.corrections.list(tx, { state: state as 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | undefined, layoutCode, period }, { limit: request.limit + 1, after });
      const adjustments = state === 'CONSUMED' ? [] : await this.adjustments.list(tx, { state: state as 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLIED' | undefined, layoutCode, ...(period === undefined ? {} : { sourcePeriod: period }) }, { limit: request.limit + 1, after });
      const merged = [...overwrites.map((row) => ({ kind: 'OVERWRITE' as const, key: row.createdAtKey, id: row.id, row })), ...adjustments.map((row) => ({ kind: 'ADJUST' as const, key: row.createdAtKey, id: row.id, row }))].sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : left.id < right.id ? 1 : -1));
      const shown = merged.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await people.names(tx, shown.flatMap((one) => [one.row.proposedBy, one.row.decidedBy]));
      return {
        items: shown.map((one) => (one.kind === 'OVERWRITE' ? correctionDto(one.row, names, caller) : adjustmentDto(one.row, names, caller))),
        next_cursor: merged.length > request.limit && last !== undefined ? encodeCursor({ code: last.key, id: last.id }) : null,
        as_of: now.toISOString(),
      };
    });
  }
}

/**
 * The connection to HPM and the pushes (HPM-01): switched on and off with a reason, a report pushed under its key, a push retried under the same key, the receipt of the receiver recorded by somebody other than the pusher.
 * The adapter is the file writer (`HPM_PORT`); no call goes to HPM. Every command is audited (ADM-11) and announced in the outbox with ids, codes and hashes, never the report.
 */
@Controller()
export class HpmPushController {
  private readonly connections = new EntConnectionStore(HPM_CONNECTION);
  private readonly pushes = new HpmPushStore();
  private readonly adjustments = new HpmAdjustmentStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(HPM_PORT) private readonly port: HpmPort,
    @Inject(HPM_PERIOD_REOPEN) private readonly reopen: PeriodReopenPort,
    @Inject(HPM_ISSUED_REPORTS) private readonly issued: IssuedReportPort,
    @Optional() @Inject(ENTERPRISE_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(ApprovalHoldService) private readonly holds?: ApprovalHoldService,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /**
   * The report a push carries. A push that names an issued copy of the report engine (`issue_id`) takes everything from the copy: its files, its snapshot and the marks of its form; what the caller wrote about its layout, period,
   * revision and hash must be the copy's (422 `VALIDATION_FAILED` naming the field), and the newest revision issued for the series is the head the staleness is judged against. Without `issue_id` the report is the file of the object
   * store whose hash the caller names (a key of another tenant is not found).
   */
  private async reportOf(scope: CommandScope, asked: HpmCopyRequest): Promise<{ request: HpmCopyRequest; bytes: Uint8Array; fileName: string; attachments: Array<{ name: string; bytes: Uint8Array }>; issuedHeadRevision: number | undefined }> {
    if (asked.issueId !== null) {
      const issued = await this.issued.load(scope.tx, asked.issueId);
      if (issued === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'issue_id');
      const wrong = asked.layoutCode !== issued.layoutCode ? 'layout_code' : asked.period !== issued.period ? 'period' : asked.revision !== issued.revision ? 'revision' : asked.sha256 !== issued.sha256 ? 'sha256' : undefined;
      if (wrong !== undefined) throw new DomainError('VALIDATION_FAILED', 422, wrong);
      const [first, ...rest] = issued.files;
      if (first === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'issue_id');
      return { request: { ...asked, snapshot: issued.snapshot, marks: issued.marks }, bytes: first.bytes, fileName: first.name, attachments: rest.map((file) => ({ name: file.name, bytes: file.bytes })), issuedHeadRevision: issued.headRevision };
    }
    const { object, bytes } = await this.files.download(scope.tenant, asked.fileObjectKey as string);
    if (fileSha256(bytes) !== asked.sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    const extension = EXTENSIONS[object.contentType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin';
    return { request: asked, bytes, fileName: `${asked.layoutCode}_${asked.period}_r${asked.revision}.${extension}`, attachments: [], issuedHeadRevision: undefined };
  }

  /**
   * The adjustments in the next period that ride on this push (TH.01): the first push of a period takes the ones approved for it, a retry of the key carries exactly the ones its first try used. They travel as one more file
   * of the package, so the report itself is not touched; the file is absent when there is none.
   */
  private async carried(scope: CommandScope, request: HpmCopyRequest, pushId: string | undefined): Promise<{ rows: Awaited<ReturnType<HpmAdjustmentStore['approvedFor']>>; attachments: Array<{ name: string; bytes: Uint8Array }> }> {
    const rows = pushId === undefined ? await this.adjustments.approvedFor(scope.tx, request.layoutCode, request.period, true) : await this.adjustments.appliedBy(scope.tx, pushId);
    if (rows.length === 0) return { rows, attachments: [] };
    return { rows, attachments: [{ name: 'adjustments.json', bytes: new TextEncoder().encode(JSON.stringify({ target_period: request.period, adjustments: rows.map(hpmAdjustmentLineOf) })) }] };
  }

  /** What the push did, in the delivery log of the report engine: a copy that was written to HPM for the first time is delivered to it there. */
  private async mirrorDelivery(scope: CommandScope, done: HpmSendResult): Promise<void> {
    if (done.outcome !== 'SENT' || done.row.issueId === null || done.before?.status === 'WRITTEN') return;
    await this.issued.delivered(scope.tx, done.row.issueId, scope.tenant.membershipId, done.row.key);
  }

  private async announce(scope: CommandScope, done: HpmSendResult, action: string, now: Date): Promise<void> {
    const { row } = done;
    await scope.audit({
      action,
      resourceType: PUSH_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: {
        key: row.key,
        layout_code: row.layoutCode,
        period: row.period,
        revision: row.revision,
        sha256: row.sha256,
        outcome: done.outcome,
        status: row.status,
        attempts: row.attempts,
        last_error_code: row.lastErrorCode,
        overwrites: row.overwrites,
        correction_id: row.correctionId,
        package_format: row.packageFormat,
        acceptance: hpmAcceptance(row.packageFormat),
      },
      // HT.06: with the opt-in for `hpm_push` the audit keeps the whole push before and after this step (the state it left, and the push as it now stands).
      detail: { before: done.before === null ? null : pushDetail(done.before), after: { ...pushDetail(row), outcome: done.outcome } },
    });
    if (done.outcome === 'ALREADY_DELIVERED') return;
    this.metrics.increment('hpm_push_total', { outcome: done.outcome });
    await scope.emit({
      aggregateType: PUSH_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.push.sent.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        push_id: row.id,
        key: row.key,
        layout_code: row.layoutCode,
        period: row.period,
        revision: row.revision,
        sha256: row.sha256,
        outcome: done.outcome,
        status: row.status,
        attempts: row.attempts,
        error_code: row.lastErrorCode,
        overwrites: row.overwrites,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${PUSH_RESOURCE}:${row.id}:attempt:${row.attempts}`,
    });
    if (done.consumed !== null) {
      await scope.audit({
        action: 'hpm.correction_consumed',
        resourceType: CORRECTION_RESOURCE,
        resourceId: done.consumed.id,
        classification: CLASSIFICATION,
        diff: { push_id: row.id, layout_code: done.consumed.layoutCode, period: done.consumed.period, from_revision: done.consumed.fromRevision, to_revision: row.revision, period_reopen_id: done.consumed.periodReopenId },
      });
    }
  }

  private async resultOf(scope: CommandScope, done: HpmSendResult, access: EffectiveAccess): Promise<Record<string, unknown>> {
    const names = await people.names(scope.tx, [done.row.pushedBy, done.row.receiptBy, ...done.row.attemptRows.map((attempt) => attempt.actorId)]);
    return { operation_id: scope.requestId, status: done.outcome, resource_version: done.row.version, resource_id: done.row.id, push: pushDto(done.row, names, callerOf(scope.tenant, access)) };
  }

  @Post('hpm/connection/state')
  @HttpCode(200)
  @OperationId('setHpmConnectionState')
  @Command({ operation: 'setHpmConnectionState', versioned: true })
  async setState(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EntConnectionState']): Promise<CommandResult> {
    // The connection decides what the whole tenant may push: a grant on a subtree does not reach it.
    if (!holdsOnWholeTenant(access, PERMISSIONS.setHpmConnectionState)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.connections.setState(scope.tx, scope.expectedVersion ?? 0, { enabled: body.enabled, reason: body.reason }, scope.tenant.membershipId);
    const id = done.row.id as string;
    await scope.audit({
      action: 'hpm.connection_switched',
      resourceType: CONNECTION_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.stateReason ?? body.reason,
      diff: { connector_code: done.row.connectorCode, from_enabled: done.before.enabled, to_enabled: done.row.enabled, package_format: done.row.layoutVersion },
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

  @Post('hpm/pushes')
  @HttpCode(200)
  @OperationId('submitHpmPush')
  @Command({ operation: 'submitHpmPush' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['HpmPushRequest']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.submitHpmPush)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const asked = hpmCopyRequestOf(body as unknown as Record<string, unknown>, scope.tenant.tenantId);
    // The report comes first: a copy or a file that is not the caller's tenant's is not found, whatever the state of the connection.
    const report = await this.reportOf(scope, asked);
    const request = report.request;
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertHpmPushAllowed(connection);
    const before = await this.pushes.findByKey(scope.tx, hpmKeyOf(request));
    const carried = await this.carried(scope, request, before?.id);
    const done = await this.pushes.send(scope.tx, request, 'SUBMIT', { tenantId: scope.tenant.tenantId, actor: scope.tenant.membershipId, now, port: this.port, reopen: this.reopen, bytes: report.bytes, fileName: report.fileName, attachments: [...report.attachments, ...carried.attachments], ...(report.issuedHeadRevision === undefined ? {} : { issuedHeadRevision: report.issuedHeadRevision }) });
    if (before === undefined && carried.rows.length > 0) await this.adjustments.apply(scope.tx, carried.rows, done.row.id, scope.tenant.membershipId, now);
    await this.mirrorDelivery(scope, done);
    await this.announce(scope, done, 'hpm.push_submitted', now);
    return this.resultOf(scope, done, access);
  }

  @Post('hpm/pushes/:id/retry')
  @HttpCode(200)
  @OperationId('retryHpmPush')
  @Command({ operation: 'retryHpmPush', versioned: true })
  async retry(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.retryHpmPush)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const before = await this.pushes.find(scope.tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== (scope.expectedVersion ?? 0)) throw versionConflict(before.version);
    if (before.status !== 'FAILED' && before.status !== 'WRITTEN') throw new DomainError('HPM_PUSH_STATE_INVALID', 409, 'status');
    // The push of a step of an approval is tried again by approving the step again: the package is built from the record, not from a file of the object store (ENT-3c).
    if (before.fileObjectKey?.startsWith('approval:') === true) throw new DomainError('HPM_PUSH_STATE_INVALID', 409, 'origin');
    // A retry re-sends what the key stands for, exactly: the same request, the same key; the number of the attempt is the only thing that moves.
    const report = await this.reportOf(scope, requestOfRow(before));
    const request = report.request;
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertHpmPushAllowed(connection);
    const carried = await this.carried(scope, request, before.id);
    const done = await this.pushes.send(scope.tx, request, 'RETRY', { tenantId: scope.tenant.tenantId, actor: scope.tenant.membershipId, now, port: this.port, reopen: this.reopen, bytes: report.bytes, fileName: report.fileName, attachments: [...report.attachments, ...carried.attachments], ...(report.issuedHeadRevision === undefined ? {} : { issuedHeadRevision: report.issuedHeadRevision }) });
    await this.mirrorDelivery(scope, done);
    await this.announce(scope, done, 'hpm.push_retried', now);
    return this.resultOf(scope, done, access);
  }

  @Post('hpm/pushes/:id/receipt')
  @HttpCode(200)
  @OperationId('recordHpmReceipt')
  @Command({ operation: 'recordHpmReceipt', versioned: true })
  async receipt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['HpmReceiptRequest']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.recordHpmReceipt)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.pushes.recordReceipt(scope.tx, id, scope.expectedVersion ?? 0, { outcome: body.outcome, reference: body.reference, note: body.note }, scope.tenant.membershipId, now);
    const { row } = done;
    // The PUSH step of an approval waits for this answer (R22): an acceptance finishes the decision of the person who held the step, a rejection ends the hold. A push that is not a step of an approval has no hold.
    await this.holds?.receive(scope, { pushId: row.id, outcome: row.status as 'ACCEPTED' | 'REJECTED', reference: row.receiptReference as string, now });
    // A rejected package gives back the adjustments in the next period it carried (TH.01): the receiver did not take them, so the next push of the period carries them again.
    if (row.status === 'REJECTED') {
      for (const released of await this.adjustments.release(scope.tx, row.id, scope.tenant.membershipId, now)) {
        await scope.audit({ action: 'hpm.adjustment_released', resourceType: ADJUSTMENT_RESOURCE, resourceId: released.id, classification: CLASSIFICATION, diff: { push_id: row.id, layout_code: released.layoutCode, target_period: released.targetPeriod, subject_code: released.subjectCode } });
      }
    }
    // The answer of HPM is also the answer in the delivery log of the report engine, for the copy the push delivered.
    if (row.issueId !== null) await this.issued.answered(scope.tx, row.issueId, row.status as 'ACCEPTED' | 'REJECTED', scope.tenant.membershipId, row.receiptReference as string, row.receiptNote);
    await scope.audit({
      action: row.status === 'ACCEPTED' ? 'hpm.receipt_accepted' : 'hpm.receipt_rejected',
      resourceType: PUSH_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.receiptNote ?? undefined,
      diff: { key: row.key, layout_code: row.layoutCode, period: row.period, revision: row.revision, sha256: row.sha256, status: row.status, receipt_reference: row.receiptReference, pushed_by: row.pushedBy },
    });
    await scope.emit({
      aggregateType: PUSH_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.push.receipt.recorded.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, push_id: row.id, key: row.key, layout_code: row.layoutCode, period: row.period, revision: row.revision, status: row.status, receipt_reference: row.receiptReference, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${PUSH_RESOURCE}:${row.id}:receipt`,
    });
    return commandResult(scope, row.status, row.version, row.id);
  }
}

/** The corrections that let an accepted period be replaced (HPM-02): proposed by one person, decided by another, used once. Every command is audited (ADM-11) and announced in the outbox. */
@Controller()
export class HpmCorrectionController {
  private readonly corrections = new HpmCorrectionStore();
  private readonly adjustments = new HpmAdjustmentStore();

  constructor(@Inject(HPM_PERIOD_REOPEN) private readonly reopen: PeriodReopenPort) {}

  @Post('hpm/corrections')
  @HttpCode(200)
  @OperationId('proposeHpmCorrection')
  @Command({ operation: 'proposeHpmCorrection' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['HpmCorrectionPropose']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.proposeHpmCorrection)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    if (body.mode === 'ADJUST_NEXT_PERIOD') return this.proposeAdjustment(scope, access, body, now);
    const row = await this.corrections.propose(scope.tx, body as unknown as Record<string, unknown>, scope.tenant.membershipId, now, this.reopen);
    await scope.audit({
      action: 'hpm.correction_proposed',
      resourceType: CORRECTION_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.reason,
      diff: { layout_code: row.layoutCode, period: row.period, from_revision: row.fromRevision, period_reopen_id: row.periodReopenId, state: row.state },
    });
    await scope.emit({
      aggregateType: CORRECTION_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.correction.proposed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, correction_id: row.id, layout_code: row.layoutCode, period: row.period, from_revision: row.fromRevision, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CORRECTION_RESOURCE}:${row.id}:proposed`,
    });
    const names = await people.names(scope.tx, [row.proposedBy]);
    return correctionDto(row, names, callerOf(scope.tenant, access));
  }

  @Post('hpm/corrections/:id/decision')
  @HttpCode(200)
  @OperationId('decideHpmCorrection')
  @Command({ operation: 'decideHpmCorrection', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['HpmCorrectionDecision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.decideHpmCorrection)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    // The id names a correction by overwrite or an adjustment in the next period: the two modes share the family of operations.
    if ((await this.corrections.find(scope.tx, id)) === undefined && (await this.adjustments.find(scope.tx, id)) !== undefined) return this.decideAdjustment(scope, id, body, now);
    const done = await this.corrections.decide(scope.tx, id, scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason }, scope.tenant.membershipId, now, this.reopen);
    const { row } = done;
    await scope.audit({
      action: row.state === 'APPROVED' ? 'hpm.correction_approved' : 'hpm.correction_rejected',
      resourceType: CORRECTION_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.decisionReason ?? body.reason,
      diff: { layout_code: row.layoutCode, period: row.period, from_revision: row.fromRevision, period_reopen_id: row.periodReopenId, state: row.state, proposed_by: row.proposedBy },
    });
    await scope.emit({
      aggregateType: CORRECTION_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.correction.decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, correction_id: row.id, layout_code: row.layoutCode, period: row.period, from_revision: row.fromRevision, state: row.state, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CORRECTION_RESOURCE}:${row.id}:${row.version}`,
    });
    return commandResult(scope, row.state, row.version, row.id);
  }

  /**
   * The adjustment in the next period (TH.01): the second mode of a correction. The accepted period stays as it is; a signed amount for a subject is booked in the next period of the same layout, proposed here, decided
   * by somebody else, and used once by the push of the next period. The proposer and the decider are two people (the table says so); every move is on the trail (ADM-11) and in the journal of the adjustment.
   */
  private async proposeAdjustment(scope: CommandScope, access: EffectiveAccess, body: Schemas['HpmCorrectionPropose'], now: Date): Promise<Record<string, unknown>> {
    const row = await this.adjustments.propose(scope.tx, { layout_code: body.layout_code, source_period: body.period, source_revision: body.from_revision, subject_code: body.subject_code, amount_vnd: body.amount_vnd, reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'hpm.adjustment_proposed',
      resourceType: ADJUSTMENT_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.reason,
      diff: { layout_code: row.layoutCode, source_period: row.sourcePeriod, source_revision: row.sourceRevision, target_period: row.targetPeriod, subject_code: row.subjectCode, state: row.state },
    });
    await scope.emit({
      aggregateType: ADJUSTMENT_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.adjustment.proposed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, adjustment_id: row.id, layout_code: row.layoutCode, source_period: row.sourcePeriod, target_period: row.targetPeriod, subject_code: row.subjectCode, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ADJUSTMENT_RESOURCE}:${row.id}:proposed`,
    });
    const names = await people.names(scope.tx, [row.proposedBy]);
    return adjustmentDto(row, names, callerOf(scope.tenant, access));
  }

  private async decideAdjustment(scope: CommandScope, id: string, body: Schemas['HpmCorrectionDecision'], now: Date): Promise<CommandResult> {
    const { row } = await this.adjustments.decide(scope.tx, id, scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: row.state === 'APPROVED' ? 'hpm.adjustment_approved' : 'hpm.adjustment_rejected',
      resourceType: ADJUSTMENT_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.decisionReason ?? body.reason,
      diff: { layout_code: row.layoutCode, source_period: row.sourcePeriod, target_period: row.targetPeriod, subject_code: row.subjectCode, state: row.state, proposed_by: row.proposedBy },
    });
    await scope.emit({
      aggregateType: ADJUSTMENT_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hpm.adjustment.decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, adjustment_id: row.id, layout_code: row.layoutCode, source_period: row.sourcePeriod, target_period: row.targetPeriod, state: row.state, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ADJUSTMENT_RESOURCE}:${row.id}:${row.version}`,
    });
    return commandResult(scope, row.state, row.version, row.id);
  }
}
