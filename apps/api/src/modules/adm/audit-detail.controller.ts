import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditDetailPolicyStore, AuditDetailReads, LogCapacityStore, TenantDatabase } from '@machvon/db';
import type { AuditDetailPolicyRow, AuditDetailView, LogCapacityPolicyRow, LogCapacityReadingRow } from '@machvon/db';
import { DomainError, capacityKindOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const POLICY_RESOURCE = 'audit_detail_policy';
const CAPACITY_RESOURCE = 'log_capacity_policy';
const BATCHES_SHOWN = 20;

/** The audit settings are tenant administration (HT.06): a grant on the whole tenant reaches them, a grant on a subtree does not. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

const policyView = (row: AuditDetailPolicyRow): Record<string, unknown> => ({
  id: row.id,
  resource_type: row.resourceType,
  enabled: row.enabled,
  max_bytes: row.maxBytes,
  sensitive_keys: row.sensitiveKeys,
  reason: row.reason,
  version: row.version,
  updated_at: row.updatedAt,
  updated_by: row.updatedBy,
});

const detailView = (view: AuditDetailView): Record<string, unknown> => ({
  audit_event_id: view.auditEventId,
  resource_type: view.resourceType,
  resource_id: view.resourceId,
  before: view.before,
  after: view.after,
  sha256: view.sha256,
  bytes: view.bytes,
  redacted_paths: view.redactedPaths,
  truncated: view.truncated,
  changed_paths: view.changedPaths,
  matches_sealed_row: view.matchesSealedRow,
  created_at: view.createdAt,
});

/**
 * The opt-in to keep the full before and after of the business objects of a class in the audit trail (HT.06, ADM-29). Off by default. A policy names the class (`resource_type`), the most bytes a row may keep and extra sensitive keys;
 * each change is a versioned command with a reason and a row in an append-only history. The writer redacts and bounds the values; the sealed audit row carries their SHA-256.
 */
@Controller('audit-detail-policies')
export class AuditDetailPoliciesController {
  private readonly store = new AuditDetailPolicyStore();
  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  @Get()
  @OperationId('listAuditDetailPolicies')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    assertHolds(access, PERMISSIONS.listAuditDetailPolicies);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx));
    return { items: rows.map(policyView), as_of: new Date().toISOString() };
  }

  @Post()
  @HttpCode(200)
  @OperationId('saveAuditDetailPolicy')
  @Command({ operation: 'saveAuditDetailPolicy' })
  async save(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SaveAuditDetailPolicy']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.saveAuditDetailPolicy);
    const saved = await this.store.save(
      scope.tx,
      scope.tenant.membershipId,
      { resourceType: body.resource_type, enabled: body.enabled, maxBytes: body.max_bytes, sensitiveKeys: body.sensitive_keys ?? [], reason: body.reason },
      body.expected_version,
    );
    await scope.audit({
      action: 'adm.audit_detail_policy_saved',
      resourceType: POLICY_RESOURCE,
      resourceId: saved.row.id,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: {
        change: saved.action,
        resource_type: saved.row.resourceType,
        from_enabled: saved.before?.enabled ?? null,
        to_enabled: saved.row.enabled,
        from_max_bytes: saved.before?.maxBytes ?? null,
        to_max_bytes: saved.row.maxBytes,
        sensitive_key_count: saved.row.sensitiveKeys.length,
      },
    });
    return commandResult(scope, saved.action, saved.row.version, saved.row.id);
  }
}

/**
 * The full before and after of one audit row that kept them, with the check against the hash the sealed row carries. The detail is as confidential as the trail it completes and may hold the values of any unit, so it is read on a grant
 * over the whole tenant.
 */
@Controller('audit-events')
export class AuditEventDetailController {
  private readonly reads = new AuditDetailReads();
  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  @Get(':id/detail')
  @OperationId('getAuditEventDetail')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertHolds(access, PERMISSIONS.getAuditEventDetail);
    const view = await this.database.withTenant(tenant, (tx) => this.reads.forEvent(tx, id));
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return detailView(view);
  }
}

const capPolicyView = (row: LogCapacityPolicyRow): Record<string, unknown> => ({
  id: row.id,
  record_class: row.recordClass,
  max_rows: row.maxRows,
  max_bytes: row.maxBytes,
  warn_pct: row.warnPct,
  active: row.active,
  reason: row.reason,
  version: row.version,
  updated_at: row.updatedAt,
  updated_by: row.updatedBy,
});

const readingView = (row: LogCapacityReadingRow): Record<string, unknown> => ({
  record_class: row.recordClass,
  kind: capacityKindOf(row.recordClass) ?? 'MONITOR_ONLY',
  rows: row.rows,
  bytes: row.bytes,
  bytes_estimated: row.bytesEstimated,
  eligible_rows: row.eligibleRows,
  protected_rows: row.protectedRows,
  state: row.state,
  measured_at: row.measuredAt,
});

/**
 * The caps on the number and the size of the log classes (HT.06, ADM-30): the caps of the tenant, the last measure of each class and the archive batches. A technical class over its cap is archived to a hashed file and then purged
 * by the nightly run, never below the retention rule; the audit trail is only measured and alerted. Each change of a cap is a versioned command with a reason.
 */
@Controller('log-capacity')
export class LogCapacityController {
  private readonly store = new LogCapacityStore();
  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  @Get()
  @OperationId('getLogCapacity')
  async overview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHolds(access, PERMISSIONS.getLogCapacity);
    const found = await this.database.withTenant(tenant, async (tx) => ({
      policies: await this.store.policies(tx),
      readings: await this.store.readings(tx),
      batches: await this.store.recentBatches(tx, BATCHES_SHOWN),
    }));
    return {
      policies: found.policies.map(capPolicyView),
      readings: found.readings.map(readingView),
      batches: found.batches.map((batch) => ({
        id: batch.id,
        record_class: batch.recordClass,
        status: batch.status,
        rows: batch.rows,
        bytes: batch.bytes,
        oldest_at: batch.oldestAt,
        newest_at: batch.newestAt,
        file_sha256: batch.fileSha256,
        created_at: batch.createdAt,
        purged_at: batch.purgedAt,
      })),
      as_of: new Date().toISOString(),
    };
  }

  @Post()
  @HttpCode(200)
  @OperationId('saveLogCapacityPolicy')
  @Command({ operation: 'saveLogCapacityPolicy' })
  async save(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SaveLogCapacityPolicy']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.saveLogCapacityPolicy);
    const saved = await this.store.save(
      scope.tx,
      scope.tenant.membershipId,
      { recordClass: body.record_class, maxRows: body.max_rows ?? null, maxBytes: body.max_bytes ?? null, warnPct: body.warn_pct, active: body.active, reason: body.reason },
      body.expected_version,
    );
    await scope.audit({
      action: 'adm.log_capacity_policy_saved',
      resourceType: CAPACITY_RESOURCE,
      resourceId: saved.row.id,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: {
        record_class: saved.row.recordClass,
        from_max_rows: saved.before?.maxRows ?? null,
        to_max_rows: saved.row.maxRows,
        from_max_bytes: saved.before?.maxBytes ?? null,
        to_max_bytes: saved.row.maxBytes,
        warn_pct: saved.row.warnPct,
        from_active: saved.before?.active ?? null,
        to_active: saved.row.active,
      },
    });
    return commandResult(scope, saved.before === undefined ? 'CREATED' : 'CHANGED', saved.row.version, saved.row.id);
  }
}
