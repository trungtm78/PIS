import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidReportStore, DocumentStore, TenantDatabase } from '@machvon/db';
import type { BidReportLine, BidReportViewer, BidSignedReport } from '@machvon/db';
import { DomainError, EVALUATION_REPORT_SOURCE_MODULE, EVALUATION_REPORT_TEMPLATE_CODE, asUuid, reportConclusionOf, reportDissentOf, reportRunIdsOf, vietnamDateOf } from '@machvon/kernel';
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
import { viewerOf } from './analysis.controller';

const REPORT_TYPE = 'evaluation_report';
/** The members of the evaluation team are the holders of the permission to evaluate over the project of the package. */
const TEAM_PERMISSION = PERMISSIONS.listAnalysisFindings;
/** The event DOC reads as a request to issue a document (DOC 9): the members of `DocIssueRequest`, BID named by the type of the event. */
export const BID_REPORT_ISSUE_REQUESTED_EVENT = 'bid.report.issue_requested.v1';
/** The minutes are CONFIDENTIAL until the result is decided: the trail and the events carry ids, codes, counts and the hash; the words live in the report and the payload in the file store. */
const CLASSIFICATION = 'CONFIDENTIAL';
const PAYLOAD_MIME = 'application/json';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
};

const reportViewerOf = (tenant: TenantContext, access: EffectiveAccess, permission: string, now: Date): BidReportViewer => ({ ...viewerOf(tenant, access, permission, now), teamPermission: TEAM_PERMISSION });

const person = (who: { membershipId: string; displayName: string }): Record<string, unknown> => ({ membership_id: who.membershipId, display_name: who.displayName });

/** A report as BID-13 reads it: what it froze, who signed with what dissent, who it still waits for, and where the minutes stand at DOC. */
export function reportDto(line: BidReportLine): Record<string, unknown> {
  return {
    id: line.id,
    package: line.package,
    project_id: line.projectId,
    criteria_version_id: line.criteriaVersionId,
    run_ids: line.runIds,
    status: line.status,
    summary: line.summary,
    signed_off_by: line.signedOffBy.map((signature) => ({ ...person(signature), signed_at: signature.signedAt, dissent: signature.withDissent })),
    awaiting: line.awaiting.map((member) => ({ ...person(member), standing: member.standing })),
    dissenting_opinions: line.dissentingOpinions.map((opinion) => ({ ...person(opinion), text: opinion.text, recorded_at: opinion.recordedAt })),
    payload_sha256: line.payloadSha256,
    report_document_id: line.reportDocumentId,
    document_status: line.documentStatus,
    stale: line.stale,
    actions: { sign_off: line.mayChange },
    created_by: person(line.createdBy),
    created_at: line.createdAt,
    issue_requested_at: line.issueRequestedAt,
    issued_at: line.issuedAt,
    recalled_at: line.recalledAt,
    version: line.version,
  };
}

/**
 * The evaluation report and its sign-off (ST-BID-012, BID 3 F6, BR-BID-03/09, BID-13). A member of the evaluation team makes the report from analyses whose findings the experts all decided; it freezes what they decided (never
 * what the model said) with the conclusion its author wrote. Each member signs, with the dissent they hold in their own words; the signature that leaves nobody to wait for asks DOC to issue the minutes, and the report is
 * ISSUED only when DOC says so (the consumer of this module). The award stays a decision of someone with the authority.
 */
@Controller()
export class ReportController {
  private readonly store = new BidReportStore();
  private readonly documents = new DocumentStore();

  /** The file store of DOC holds the payload; an application that mounts BID without it cannot ask DOC to issue anything. */
  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOCUMENT_FILE_PORT) private readonly files?: DocumentFilePort,
  ) {}

  @Post('evaluation-reports')
  @HttpCode(200)
  @OperationId('createEvaluationReport')
  @Command({ operation: 'createEvaluationReport' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidReportCreate']): Promise<CommandResult> {
    const now = new Date();
    const conclusion = reportConclusionOf(body.summary);
    const runIds = reportRunIdsOf(body.run_ids);
    const made = await this.store.create(
      scope.tx,
      { packageId: idOf(body.package_id, 'package_id'), criteriaVersionId: idOf(body.criteria_version_id, 'criteria_version_id'), runIds, conclusion },
      reportViewerOf(scope.tenant, access, PERMISSIONS.createEvaluationReport, now),
      scope.tenant.membershipId,
    );
    const { report } = made;
    const facts = {
      package_id: report.package.id,
      package_code: report.package.code,
      criteria_version_id: report.criteriaVersionId,
      run_ids: report.runIds,
      proposal_count: report.summary.proposals.length,
      not_covered_count: report.summary.not_covered.length,
      decisions_sha256: report.summary.decisions_sha256,
    };
    await scope.audit({ action: 'bid.report_drafted', resourceType: REPORT_TYPE, resourceId: report.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: REPORT_TYPE,
      aggregateId: report.id,
      aggregateVersion: report.version,
      type: 'bid.report.drafted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, report_id: report.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REPORT_TYPE}:${report.id}:drafted`,
    });
    return commandResult(scope, report.status, report.version, report.id);
  }

  @Post('evaluation-reports/:id/sign-off')
  @HttpCode(200)
  @OperationId('signOffEvaluationReport')
  @Command({ operation: 'signOffEvaluationReport', versioned: true })
  async signOff(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidReportSignOff']): Promise<CommandResult> {
    const now = new Date();
    const dissent = reportDissentOf(body.dissent);
    const signed = await this.store.signOff(
      scope.tx,
      { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, dissent, tenantId: scope.tenant.tenantId },
      reportViewerOf(scope.tenant, access, PERMISSIONS.signOffEvaluationReport, now),
      scope.tenant.membershipId,
    );
    const { report } = signed;
    const signatures = report.signedOffBy.length;
    const facts = {
      package_id: report.package.id,
      package_code: report.package.code,
      criteria_version_id: report.criteriaVersionId,
      signed_by: scope.tenant.membershipId,
      signatures,
      with_dissent: dissent !== null,
      awaiting_before: signed.awaitedBefore,
      complete: signed.issue !== undefined,
    };
    // The audit row and the event say who signed and whether the team is complete; the dissent is in the report, in the words of the member.
    await scope.audit({ action: 'bid.report_signed_off', resourceType: REPORT_TYPE, resourceId: report.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: REPORT_TYPE,
      aggregateId: report.id,
      aggregateVersion: report.version,
      type: 'bid.report.signed_off.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, report_id: report.id, ...facts, status: report.status, version: report.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REPORT_TYPE}:${report.id}:signed_off:${signatures}`,
    });
    if (signed.issue !== undefined) await this.askDoc(scope, signed, signed.issue, now);
    return commandResult(scope, report.status, report.version, report.id);
  }

  @Get('procurement-packages/:id/evaluation-reports')
  @OperationId('listEvaluationReports')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const now = new Date();
    const viewer = reportViewerOf(tenant, access, PERMISSIONS.listEvaluationReports, now);
    const lines = await this.database.withTenant(tenant, (tx) => this.store.list(tx, id.toLowerCase(), viewer));
    if (lines === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { items: lines.map(reportDto), as_of: now.toISOString() };
  }

  @Get('evaluation-reports/:id')
  @OperationId('getEvaluationReport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = reportViewerOf(tenant, access, PERMISSIONS.getEvaluationReport, new Date());
    const line = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id.toLowerCase(), viewer));
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reportDto(line);
  }

  /**
   * The signature that completed the team: the payload DOC prints is written to the file store and DOC is asked to issue it with the template of the library and the SHA-256 of the payload. Without the file store
   * (503) or the template (422) nothing is signed: the transaction is undone, and the member signs again once the cause is mended.
   */
  private async askDoc(scope: CommandScope, signed: BidSignedReport, issue: NonNullable<BidSignedReport['issue']>, now: Date): Promise<void> {
    const files = this.files;
    if (files === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_file_store');
    if (!(await this.documents.templateCodeExists(scope.tx, EVALUATION_REPORT_TEMPLATE_CODE))) throw new DomainError('DOC_TEMPLATE_MISSING', 422, 'template_code');
    // An object is written once: a retry after a failure after this point writes the same bytes under the same key, which the port accepts.
    await files.put(issue.payloadRef, Buffer.from(JSON.stringify(issue.payload), 'utf8'), PAYLOAD_MIME);
    const { report } = signed;
    await scope.audit({
      action: 'bid.report_issue_requested',
      resourceType: REPORT_TYPE,
      resourceId: report.id,
      classification: CLASSIFICATION,
      diff: { package_id: report.package.id, package_code: report.package.code, template_code: EVALUATION_REPORT_TEMPLATE_CODE, payload_sha256: issue.payloadSha256, source_ref: issue.sourceRef, signatures: report.signedOffBy.length },
    });
    await scope.emit({
      aggregateType: REPORT_TYPE,
      aggregateId: report.id,
      aggregateVersion: report.version,
      type: BID_REPORT_ISSUE_REQUESTED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        source_module: EVALUATION_REPORT_SOURCE_MODULE,
        source_ref: issue.sourceRef,
        template_code: EVALUATION_REPORT_TEMPLATE_CODE,
        payload_ref: issue.payloadRef,
        payload_sha256: issue.payloadSha256,
        event_id: issue.eventId,
        // The day the template is looked up for is the day DOC issues it.
        as_of_date: vietnamDateOf(now),
        signer_hint: { drafting_unit_id: issue.draftingUnitId },
        report_id: report.id,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${REPORT_TYPE}:${report.id}:issue_requested:${issue.eventId}`,
    });
  }
}
