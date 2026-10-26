import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AudEngagementStore, AudReportStore, DocumentStore, TenantDatabase, engagementScope } from '@machvon/db';
import type { ReportLine } from '@machvon/db';
import { DomainError, REPORT_SOURCE_MODULE, REPORT_TEMPLATE_CODE, assertAsOf, asUuid, payloadSha256, reportPayload, reportSourceRef, reportTotals, vietnamDateOf } from '@machvon/kernel';
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

const READ_PERMISSION = PERMISSIONS.listAuditEngagements;
const REPORT_PERMISSION = PERMISSIONS.requestAuditFollowUpReport;
const REPORT_TYPE = 'audit_follow_up_report';
/** The event DOC reads as a request to issue a document (DOC 9): the members of `DocIssueRequest`, AUD named by the type of the event. */
export const AUD_REPORT_ISSUE_REQUESTED_EVENT = 'aud.report.issue_requested.v1';
/** AUD data are CONFIDENTIAL (AUD 2): the trail and the events carry ids, codes, days, counts and the hash; the figures live in the report and the payload lives in the file store. */
const CLASSIFICATION = 'CONFIDENTIAL';
const PAYLOAD_MIME = 'application/json';
/** What the head of the document carries when nobody said the place of issue. */
const NO_PLACE = '-';

/** A report as AUD-10 reads it. */
export function reportView(line: ReportLine): Record<string, unknown> {
  return {
    id: line.id,
    conclusion_id: line.conclusionId,
    conclusion_symbol: line.conclusionSymbol,
    as_of_date: line.asOfDate,
    revision: line.revision,
    status: line.status,
    totals: line.totals,
    payload_sha256: line.payloadSha256,
    source_ref: line.sourceRef,
    report_document_id: line.reportDocumentId,
    reject_code: line.rejectCode,
    requested_by: { id: line.requestedBy.id, display_name: line.requestedBy.displayName },
    approved_by: line.approvedBy === null ? null : { id: line.approvedBy.id, display_name: line.approvedBy.displayName },
    requested_at: line.requestedAt,
    issued_at: line.issuedAt,
    version: line.version,
  };
}

/**
 * The request for the report of the results of the recommendations (ST-AUD-005, AUD 3.6 F6): the figures of a conclusion as of a day are computed once and frozen with the report, the payload
 * that carries them is kept in the file store under the tenant, and DOC is asked to issue it with the template of the library and the SHA-256 of that payload. The report waits for DOC in
 * ISSUE_REQUESTED; DOC's events move it (the consumer of this module). An engagement that is not being followed up has nothing to report (409), a conclusion that is not one of it is not found
 * (404) and a conclusion that was replaced is 409. The trail and the events keep ids, codes, days and the hash.
 */
@Controller()
export class AuditReportController {
  private readonly engagements = new AudEngagementStore();
  private readonly reports = new AudReportStore();
  private readonly documents = new DocumentStore();

  /** The file store of DOC holds the payload; an application that mounts AUD without it cannot ask DOC to issue anything. */
  constructor(@Optional() @Inject(DOCUMENT_FILE_PORT) private readonly files?: DocumentFilePort) {}

  @Post('audit-engagements/:id/follow-up-reports')
  @HttpCode(200)
  @OperationId('requestAuditFollowUpReport')
  @Command({ operation: 'requestAuditFollowUpReport', versioned: true })
  async request(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudFollowUpReport'],
  ): Promise<CommandResult> {
    const files = this.files;
    if (files === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_file_store');
    const now = new Date();
    const today = vietnamDateOf(now);
    const engagement = await this.engagements.lock(scope.tx, id, engagementScope(access, READ_PERMISSION, now), engagementScope(access, REPORT_PERMISSION, now), scope.expectedVersion ?? 0);
    if (engagement.status !== 'FOLLOW_UP') throw new DomainError('ENGAGEMENT_STATE_INVALID', 409, `${engagement.status}->report`);
    const context = await this.reports.context(scope.tx, id, body.conclusion_id);
    if (context === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (context.conclusion.status === 'SUPERSEDED') throw new DomainError('CONCLUSION_REVISION_INVALID', 409);
    assertAsOf(body.as_of_date, today, context.conclusion.receivedOn);
    const unit = await this.draftingUnit(scope, context.scopeUnitIds, body.drafting_unit_id);
    // The template has to be in the library: DOC would refuse the request later, and the caller is better told now.
    if (!(await this.documents.templateCodeExists(scope.tx, REPORT_TEMPLATE_CODE))) throw new DomainError('DOC_TEMPLATE_MISSING', 422, 'template_code');

    const totals = reportTotals(body.as_of_date, await this.reports.recommendationsAsOf(scope.tx, body.conclusion_id, body.as_of_date));
    const payload = reportPayload({
      agency: unit.name,
      // The place of issue is not in any record of the tenant: the person who asks says it, and DOC's drafter completes a dash before the report goes out.
      place: body.place?.trim() || NO_PLACE,
      title: context.engagement.title,
      engagementCode: context.engagement.code,
      authorityName: context.engagement.authorityName,
      conclusionSymbol: context.conclusion.symbol ?? '-',
      conclusionIssuedOn: context.conclusion.issuedOn,
      totals,
    });
    const sha256 = payloadSha256(payload);
    const eventId = randomUUID();
    const created = await this.reports.create(scope.tx, { engagementId: id, conclusionId: body.conclusion_id, asOfDate: body.as_of_date, totals, draftingUnitId: unit.id, payloadSha256: sha256, issueEventId: eventId }, scope.tenant.membershipId);
    // An object is written once: a retry after a failure after this point writes the same bytes under the same key, which the port accepts.
    await files.put(created.payloadRef, Buffer.from(JSON.stringify(payload), 'utf8'), PAYLOAD_MIME);
    const sourceRef = reportSourceRef(created.id, created.revision);
    await scope.audit({
      action: 'aud.report_requested',
      resourceType: REPORT_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        engagement_code: engagement.engagementCode,
        conclusion_id: body.conclusion_id,
        as_of_date: body.as_of_date,
        revision: created.revision,
        payload_sha256: sha256,
        source_ref: sourceRef,
        drafting_unit_id: unit.id,
        recommendations_total: totals.total,
        recommendations_closed: totals.closed,
      },
    });
    await scope.emit({
      aggregateType: REPORT_TYPE,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: AUD_REPORT_ISSUE_REQUESTED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        source_module: REPORT_SOURCE_MODULE,
        source_ref: sourceRef,
        template_code: REPORT_TEMPLATE_CODE,
        payload_ref: created.payloadRef,
        payload_sha256: sha256,
        event_id: eventId,
        // The day the template is looked up for is the day DOC issues it, not the day the figures are as of.
        as_of_date: today,
        signer_hint: { drafting_unit_id: unit.id },
        recipients: [{ kind: 'EXTERNAL_AGENCY', name: context.engagement.authorityName }],
        engagement_id: id,
        report_id: created.id,
        report_as_of_date: body.as_of_date,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${REPORT_TYPE}:${created.id}:issue_requested`,
    });
    return commandResult(scope, 'ISSUE_REQUESTED', 1, created.id);
  }

  /** The unit that drafts the report: the one the caller names, or the only unit the engagement is about. A unit that is not in the tenant is not found (404). */
  private async draftingUnit(scope: CommandScope, scopeUnits: readonly string[], named: string | undefined): Promise<{ id: string; name: string }> {
    const id = named !== undefined ? asUuid(named) : scopeUnits.length === 1 ? scopeUnits[0] : undefined;
    if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'drafting_unit_id');
    const name = await this.reports.unitName(scope.tx, id);
    if (name === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id, name };
  }
}

/** The reports of an engagement the caller may see (AUD-10), through the scope of the engagement: what lies outside it is not found. */
@Controller()
export class AuditReportReadsController {
  private readonly engagements = new AudEngagementStore();
  private readonly reports = new AudReportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-engagements/:id/follow-up-reports')
  @OperationId('listAuditFollowUpReports')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const scope = engagementScope(access, READ_PERMISSION, new Date());
    const items = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.engagements.find(tx, id, scope)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.reports.list(tx, id);
    });
    return { items: items.map(reportView) };
  }
}
