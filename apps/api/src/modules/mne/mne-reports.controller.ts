import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MNE_REPORT_RESOURCE, MNE_UNIT_COLUMNS, MneReportStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { MneReportChange, ScopeBuilder } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reportDiffOf, reportViewOf } from './mne-views';

/** The units a permission reaches, compiled over the unit columns of the report queries. */
const unitScope =
  (access: EffectiveAccess, permission: string, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, permission, now, MNE_UNIT_COLUMNS, first);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The periodic report of monitoring and evaluation (ST-MNE-002, MNE F3, MNE-03): `createMneReport` opens a report on the form revision in force on the last day of its period, from a frozen snapshot;
 * `editMneReport` writes the text cells and the attachments of a draft (the cells that have a source are locked); `submitMneReport` hands it in for review; `getMneReport` reads it in the units the caller
 * reaches (a report outside them does not exist for the caller, and neither does the report of another tenant).
 */
@Controller()
export class MneReportsController {
  private readonly reports = new MneReportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('mne-reports')
  @HttpCode(200)
  @OperationId('createMneReport')
  @Command({ operation: 'createMneReport' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MneReportCreate']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.reports.create(scope.tx, {
      formId: body.form_id,
      reportYear: body.report_year,
      periodLabel: body.period_label,
      periodId: body.period_id,
      scopeUnitId: body.scope_unit_id,
      projectId: body.project_id,
      snapshotId: body.snapshot_id,
      obligationRuleId: body.obligation_rule_id,
      today: vietnamDateOf(now),
      actor: scope.tenant.membershipId,
      unitScope: unitScope(access, PERMISSIONS.createMneReport, now),
    });
    await this.record(scope, 'created', made);
    return commandResult(scope, made.row.status, made.row.version, made.row.id);
  }

  @Post('mne-reports/:id/revisions')
  @HttpCode(200)
  @OperationId('editMneReport')
  @Command({ operation: 'editMneReport', versioned: true })
  async edit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneReportEdit']): Promise<CommandResult> {
    if (body.narrative !== undefined && !isRecord(body.narrative)) throw new DomainError('VALIDATION_FAILED', 422, 'narrative');
    const now = new Date();
    const done = await this.reports.edit(scope.tx, {
      id: id.toLowerCase(),
      today: vietnamDateOf(now),
      expectedVersion: scope.expectedVersion ?? 0,
      narrative: body.narrative,
      attachments: body.attachments,
      snapshotId: body.snapshot_id,
      actor: scope.tenant.membershipId,
      unitScope: unitScope(access, PERMISSIONS.editMneReport, now),
    });
    await this.record(scope, 'edited', done);
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('mne-reports/:id/submit')
  @HttpCode(200)
  @OperationId('submitMneReport')
  @Command({ operation: 'submitMneReport', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.reports.submit(scope.tx, { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, now, unitScope: unitScope(access, PERMISSIONS.submitMneReport, now) });
    await this.record(scope, 'submitted', done);
    // The approver's queue is read from this event: the report waits for someone other than its preparer.
    await scope.emit({
      aggregateType: MNE_REPORT_RESOURCE,
      aggregateId: done.row.id,
      aggregateVersion: done.row.version,
      type: 'mne.report.submitted.v1',
      schemaVersion: 1,
      payload: { report_id: done.row.id, ...reportDiffOf(done.row), submitted_by: scope.tenant.membershipId },
      eventKey: `${MNE_REPORT_RESOURCE}:${done.row.id}:submitted:${done.row.version}`,
    });
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Get('mne-reports/:id')
  @OperationId('getMneReport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.reports.find(tx, id.toLowerCase(), unitScope(access, PERMISSIONS.getMneReport, now));
      return row === undefined ? undefined : { row, options: await this.reports.snapshotOptions(tx, row, vietnamDateOf(now)) };
    });
    if (read === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reportViewOf(read.row, read.options, vietnamDateOf(now));
  }

  private async record(scope: CommandScope, action: string, change: MneReportChange): Promise<void> {
    await scope.audit({
      action: `mne.report.${action}`,
      resourceType: MNE_REPORT_RESOURCE,
      resourceId: change.row.id,
      diff: { ...reportDiffOf(change.row), from_status: change.previousStatus, snapshot_attached: change.snapshotAttached },
    });
  }
}
