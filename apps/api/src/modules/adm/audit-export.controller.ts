import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditExportStore } from '@machvon/db';
import type { ExportFormat } from '@machvon/db';
import { DomainError, NOOP_METRICS, UPLOAD_PURPOSES, assertLinkable, parseObjectKey } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { createHash } from 'node:crypto';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { instantOf } from './audit-filters';
import { ADM_CLOCK, ADM_METRICS } from './tokens';
import { holdsOnWholeTenant } from './tenant-authority';

const PERMISSION = PERMISSIONS.exportAuditLog;
const RESOURCE_TYPE = 'audit_export';
/** ADM 3.11: one export covers at most this many days; a longer period is asked for in several exports. */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const MAX_RESOURCE_TYPES = 50;
const RESOURCE_TYPE_NAME = /^[a-z][a-z0-9_]{0,79}$/;
const MEDIA_TYPE: Readonly<Record<ExportFormat, string>> = { CSV: 'text/csv', JSONL: 'text/plain' };
/** The metric of every export; the labels carry the tenant and the format, never a person. */
export const AUDIT_EXPORT_METRIC = 'adm_audit_export_total';

function resourceTypesOf(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const names = [...new Set(value)];
  if (names.length === 0 || names.length > MAX_RESOURCE_TYPES || !names.every((name) => RESOURCE_TYPE_NAME.test(name))) {
    throw new DomainError('VALIDATION_FAILED', 422, 'resource_types');
  }
  return names.sort();
}

/**
 * The sealed export of the audit trail (ST-ADM-016, ADM 3.11): a file with the events of a period, the seals that cover them and the
 * hashes of the other rows of those seal windows, so that the recipient verifies the chain alone. It is built in the command and
 * written to the object store of the tenant as a CLEAN file; the answer is 202 as the contract says and names the export. The seal
 * windows are tenant wide, so the export needs a grant on the whole tenant: a grant on a subtree does not reach it.
 */
@Controller('audit-exports')
export class AuditExportsController {
  private readonly store = new AuditExportStore();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(ADM_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(ADM_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? (() => new Date());
  }

  @Post()
  @HttpCode(202)
  @OperationId('exportAuditLog')
  @Command({ operation: 'exportAuditLog' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AuditExportRequest']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    const from = instantOf(body.from, 'from');
    const to = instantOf(body.to, 'to');
    if (from === undefined || to === undefined || Date.parse(to) <= Date.parse(from)) throw new DomainError('VALIDATION_FAILED', 422, 'to');
    if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * DAY_MS) throw new DomainError('EXPORT_RANGE_TOO_LARGE', 422, 'to');
    const resourceTypes = resourceTypesOf(body.resource_types);
    const file = await this.store.build(scope.tx, {
      tenantId: scope.tenant.tenantId,
      from: new Date(from),
      to: new Date(to),
      resourceTypes,
      format: body.format,
      maxBytes: UPLOAD_PURPOSES.audit_export.maxBytes,
      generatedAt: this.clock(),
    });
    const stored = await this.files.upload(scope.tenant, { purpose: 'audit_export', declaredType: MEDIA_TYPE[body.format], bytes: file.bytes });
    // Only a file the antivirus has passed is ever offered (SCAN_PENDING, FILE_NOT_CLEAN).
    assertLinkable(stored.scanStatus);
    const exportId = parseObjectKey(stored.key)?.id;
    if (exportId === undefined) throw new Error('the object store returned a key that is not a tenant key');
    await scope.audit({
      action: 'audit.exported',
      resourceType: RESOURCE_TYPE,
      resourceId: exportId,
      classification: 'CONFIDENTIAL',
      diff: {
        from,
        to,
        format: body.format,
        resource_types: resourceTypes ?? null,
        events: file.events,
        leaf_only: file.leafOnly,
        seals: file.seals,
        unsealed_events: file.unsealedEvents,
        size_bytes: file.bytes.length,
        file_sha256: createHash('sha256').update(file.bytes).digest('hex'),
      },
    });
    scope.afterCommit(() => this.metrics.increment(AUDIT_EXPORT_METRIC, { tenant_id: scope.tenant.tenantId, format: body.format }));
    return commandResult(scope, 'READY', 1, exportId);
  }
}
