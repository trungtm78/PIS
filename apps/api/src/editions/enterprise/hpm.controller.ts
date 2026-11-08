import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, fileSha256, holdsPermission, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import {
  EntConnectionStore,
  HPM_CONNECTION,
  HPM_PACKAGE_FORMATS,
  HpmCorrectionStore,
  HpmPushStore,
  assertHpmPushAllowed,
  hpmAcceptance,
  hpmCopyRequestOf,
  requestOfRow,
} from '@machvon/edition-enterprise/src/server.ts';
import type { HpmCopyRequest, HpmPort, HpmPushRow, HpmSendResult, PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
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
import { ENTERPRISE_METRICS, HPM_PERIOD_REOPEN, HPM_PORT } from './tokens';
import { correctionDto, pendingExternalDto, pushDto, ruleDto } from './views';
import type { Caller } from './views';

const CONNECTION_RESOURCE = 'ent_connection';
const PUSH_RESOURCE = 'hpm_push';
const CORRECTION_RESOURCE = 'hpm_correction';
const CLASSIFICATION = 'INTERNAL';
const HISTORY = 10;
/** The kinds of report file the object store holds for an issued copy, and the extension the package gives the file inside it. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const people = new BidWorkflowReads();

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
    if (state !== undefined && !['PROPOSED', 'APPROVED', 'REJECTED', 'CONSUMED'].includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const layoutCode = text(query.layout_code, 'layout_code', 60);
    const period = text(query.period, 'period', 10);
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = callerOf(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.corrections.list(tx, { state: state as 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | undefined, layoutCode, period }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await people.names(tx, shown.flatMap((row) => [row.proposedBy, row.decidedBy]));
      return { items: shown.map((row) => correctionDto(row, names, caller)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
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
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(HPM_PORT) private readonly port: HpmPort,
    @Inject(HPM_PERIOD_REOPEN) private readonly reopen: PeriodReopenPort,
    @Optional() @Inject(ENTERPRISE_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** The report from the object store: it must still be the file whose hash the caller names (a key of another tenant is not found). */
  private async reportOf(tenant: TenantContext, request: HpmCopyRequest): Promise<{ bytes: Uint8Array; fileName: string }> {
    const { object, bytes } = await this.files.download(tenant, request.fileObjectKey);
    if (fileSha256(bytes) !== request.sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    const extension = EXTENSIONS[object.contentType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin';
    return { bytes, fileName: `${request.layoutCode}_${request.period}_r${request.revision}.${extension}` };
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
    const request = hpmCopyRequestOf(body as unknown as Record<string, unknown>, scope.tenant.tenantId);
    // The file comes first: one that is not the caller's tenant's is not found, whatever the state of the connection.
    const report = await this.reportOf(scope.tenant, request);
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertHpmPushAllowed(connection);
    const done = await this.pushes.send(scope.tx, request, 'SUBMIT', { tenantId: scope.tenant.tenantId, actor: scope.tenant.membershipId, now, port: this.port, reopen: this.reopen, bytes: report.bytes, fileName: report.fileName });
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
    // A retry re-sends what the key stands for, exactly: the same request, the same key; the number of the attempt is the only thing that moves.
    const request = requestOfRow(before);
    const report = await this.reportOf(scope.tenant, request);
    const { row: connection } = await this.connections.ensure(scope.tx, scope.tenant.membershipId);
    assertHpmPushAllowed(connection);
    const done = await this.pushes.send(scope.tx, request, 'RETRY', { tenantId: scope.tenant.tenantId, actor: scope.tenant.membershipId, now, port: this.port, reopen: this.reopen, bytes: report.bytes, fileName: report.fileName });
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

  constructor(@Inject(HPM_PERIOD_REOPEN) private readonly reopen: PeriodReopenPort) {}

  @Post('hpm/corrections')
  @HttpCode(200)
  @OperationId('proposeHpmCorrection')
  @Command({ operation: 'proposeHpmCorrection' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['HpmCorrectionPropose']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.proposeHpmCorrection)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
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
}
