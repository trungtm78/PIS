import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MNE_REPORT_RESOURCE, MNE_UNIT_COLUMNS, MneReportIssueStore, MneReportStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { MneReportChange, ScopeBuilder } from '@machvon/db';
import { DomainError, MNE_SOURCE_MODULE, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from '../doc/file-port';
import type { DocumentFilePort } from '../doc/file-port';
import { reportDiffOf, reportViewOf } from './mne-views';

/** The units a permission reaches, compiled over the unit columns of the report queries. */
const unitScope =
  (access: EffectiveAccess, permission: string, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, permission, now, MNE_UNIT_COLUMNS, first);

/** The event DOC reads as a request to issue a document (DOC 9): the members of `DocIssueRequest`, MNE named by the type of the event. */
export const MNE_REPORT_ISSUE_REQUESTED_EVENT = 'mne.report.issue_requested.v1';
/** What the administrator of the forms is told when a form names a template DOC does not have. */
export const MNE_CONFIGURATION_ALERT_EVENT = 'mne.configuration_alert.v1';
const PAYLOAD_MIME = 'application/json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The periodic report of monitoring and evaluation (ST-MNE-002, MNE F3, MNE-03): `createMneReport` opens a report on the form revision in force on the last day of its period, from a frozen snapshot;
 * `editMneReport` writes the text cells and the attachments of a draft (the cells that have a source are locked); `submitMneReport` hands it in for review; `getMneReport` reads it in the units the caller
 * reaches (a report outside them does not exist for the caller, and neither does the report of another tenant).
 */
@Controller()
export class MneReportsController {
  private readonly reports = new MneReportStore();
  private readonly issue = new MneReportIssueStore();

  /** The file store of DOC holds the payload; an application that mounts MNE without it cannot ask DOC to issue anything. */
  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOCUMENT_FILE_PORT) private readonly files?: DocumentFilePort,
  ) {}

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

  @Post('mne-reports/:id/decision')
  @HttpCode(200)
  @OperationId('decideMneReport')
  @Command({ operation: 'decideMneReport', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.issue.decide(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      decision: body.decision,
      reason: body.reason,
      actor: scope.tenant.membershipId,
      now,
      unitScope: unitScope(access, PERMISSIONS.decideMneReport, now),
    });
    const action = body.decision === 'approve' ? 'approved' : 'returned';
    await scope.audit({
      action: `mne.report.${action}`,
      resourceType: MNE_REPORT_RESOURCE,
      resourceId: done.row.id,
      diff: { ...reportDiffOf(done.row), from_status: done.previousStatus, reason: body.reason.trim() },
    });
    await scope.emit({
      aggregateType: MNE_REPORT_RESOURCE,
      aggregateId: done.row.id,
      aggregateVersion: done.row.version,
      type: `mne.report.${action}.v1`,
      schemaVersion: 1,
      payload: { report_id: done.row.id, ...reportDiffOf(done.row), decided_by: scope.tenant.membershipId },
      eventKey: `${MNE_REPORT_RESOURCE}:${done.row.id}:${action}:${done.row.version}`,
    });
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('mne-reports/:id/issue-requests')
  @HttpCode(200)
  @OperationId('requestMneReportIssue')
  @Command({ operation: 'requestMneReportIssue', versioned: true })
  async requestIssue(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const files = this.files;
    if (files === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_file_store');
    const now = new Date();
    const asked = await this.issue.requestIssue(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      now,
      tenantId: scope.tenant.tenantId,
      unitScope: unitScope(access, PERMISSIONS.requestMneReportIssue, now),
    });
    if (asked.kind === 'TEMPLATE_MISSING') {
      // The form names a template the library of DOC does not have: the report stays APPROVED, the finding is recorded and the administrator of the forms is told, then the caller is refused.
      const facts = { ...reportDiffOf(asked.row), template_code: asked.templateCode, reason: 'DOC_TEMPLATE_MISSING' };
      await scope.audit({ action: 'mne.report_issue_blocked', resourceType: MNE_REPORT_RESOURCE, resourceId: asked.row.id, diff: facts });
      await scope.emit({
        aggregateType: MNE_REPORT_RESOURCE,
        aggregateId: asked.row.id,
        aggregateVersion: asked.row.version,
        type: MNE_CONFIGURATION_ALERT_EVENT,
        schemaVersion: 1,
        payload: { report_id: asked.row.id, form_code: asked.row.formCode, template_code: asked.templateCode, reason: 'DOC_TEMPLATE_MISSING', audience: 'FORM_ADMINISTRATOR', occurred_at: now.toISOString() },
        eventKey: `${MNE_REPORT_RESOURCE}:${asked.row.id}:configuration_alert:${asked.row.version}:${asked.templateCode}`,
      });
      scope.refuseAfterCommit(new DomainError('DOC_TEMPLATE_MISSING', 422, 'doc_template_code', { extensions: { template_code: asked.templateCode } }));
      return commandResult(scope, asked.row.status, asked.row.version, asked.row.id);
    }
    // An object is written once: a retry after a failure after this point writes the same bytes under the same key, which the port accepts.
    // A request that follows a refusal of DOC asks again for the payload that was frozen and written the first time.
    if (asked.payload !== null) await files.put(asked.payloadRef, Buffer.from(JSON.stringify(asked.payload), 'utf8'), PAYLOAD_MIME);
    await scope.audit({
      action: 'mne.report.issue_requested',
      resourceType: MNE_REPORT_RESOURCE,
      resourceId: asked.row.id,
      diff: { ...reportDiffOf(asked.row), from_status: asked.previousStatus, template_code: asked.templateCode, payload_sha256: asked.payloadSha256, source_ref: asked.sourceRef },
    });
    await scope.emit({
      aggregateType: MNE_REPORT_RESOURCE,
      aggregateId: asked.row.id,
      aggregateVersion: asked.row.version,
      type: MNE_REPORT_ISSUE_REQUESTED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        source_module: MNE_SOURCE_MODULE,
        source_ref: asked.sourceRef,
        template_code: asked.templateCode,
        payload_ref: asked.payloadRef,
        payload_sha256: asked.payloadSha256,
        event_id: asked.eventId,
        // The day the template is looked up for is the day DOC issues it, not the day the figures are as of.
        as_of_date: vietnamDateOf(now),
        signer_hint: { drafting_unit_id: asked.row.scopeUnitId },
        report_id: asked.row.id,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${MNE_REPORT_RESOURCE}:${asked.row.id}:issue_requested:${asked.eventId}`,
    });
    return commandResult(scope, asked.row.status, asked.row.version, asked.row.id);
  }

  @Get('mne-reports/:id')
  @OperationId('getMneReport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.reports.find(tx, id.toLowerCase(), unitScope(access, PERMISSIONS.getMneReport, now));
      return row === undefined ? undefined : { row, options: await this.reports.snapshotOptions(tx, row, vietnamDateOf(now)), document: await this.issue.documentState(tx, row) };
    });
    if (read === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reportViewOf(read.row, read.options, vietnamDateOf(now), read.document);
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
