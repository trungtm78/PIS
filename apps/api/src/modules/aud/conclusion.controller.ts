import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AudConclusionStore, AudEngagementStore, TenantDatabase, engagementScope } from '@machvon/db';
import type { ConclusionLine, FindingLine } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.listAuditEngagements;
const RECORD_PERMISSION = PERMISSIONS.recordAuditConclusion;
const CONCLUSION_TYPE = 'audit_conclusion';
const FINDING_TYPE = 'audit_finding';
const RECOMMENDATION_TYPE = 'audit_recommendation';
/** AUD data are CONFIDENTIAL (AUD 2): the trail and the events carry codes, ids and amounts, never what a conclusion, a finding or a recommendation says in words. */
const CLASSIFICATION = 'CONFIDENTIAL';

/** A conclusion as AUD-04 reads it: what was received, the total it holds the recommendations to, what they add up to and what is left. */
export function conclusionView(line: ConclusionLine): Record<string, unknown> {
  return {
    id: line.id,
    engagement_id: line.engagementId,
    conclusion_kind: line.conclusionKind,
    document: { id: line.document.id, title: line.document.title, symbol: line.document.symbol },
    revision: line.revision,
    supersedes_id: line.supersedesId,
    issued_on: line.issuedOn,
    received_on: line.receivedOn,
    implementation_due_on: line.implementationDueOn,
    report_due_on: line.reportDueOn,
    summary: line.summary,
    total_financial_vnd: line.totalFinancialVnd,
    recommended_vnd: line.recommendedVnd,
    shortfall_vnd: line.shortfallVnd,
    is_public: line.isPublic,
    status: line.status,
    finding_count: line.findingCount,
    recommendation_count: line.recommendationCount,
    version: line.version,
  };
}

/** A finding as AUD-05 reads it: an allowlist of what a finding is, with the codes and names of the places it is about. */
export function findingView(line: FindingLine): Record<string, unknown> {
  return {
    id: line.id,
    conclusion_id: line.conclusionId,
    finding_code: line.findingCode,
    category: line.category,
    project: line.project === null ? null : { id: line.project.id, code: line.project.code, name: line.project.name },
    contract: line.contract === null ? null : { id: line.contract.id, code: line.contract.code },
    organization_unit: line.unit === null ? null : { id: line.unit.id, code: line.unit.code, name: line.unit.name },
    description: line.description,
    legal_basis_cited: line.legalBasisCited,
    amount_vnd: line.amountVnd,
    severity: line.severity,
    created_at: line.createdAt,
  };
}

/**
 * The commands that record what an authority concluded (ST-AUD-002, AUD 3.2): the conclusion, which moves the engagement to FOLLOW_UP; the findings in it; and the recommendations on it, whose
 * financial amounts never add up to more than the total of the conclusion (BR-AUD-05). A caller acts on an engagement only through a grant of `aud.conclusion.record` that meets its scope; one
 * who sees it and may not act is told so (403), and an engagement outside every scope is not found (404). The words are the authority's: the trail and the events keep codes, ids and amounts.
 */
@Controller()
export class AuditConclusionController {
  private readonly engagements = new AudEngagementStore();
  private readonly conclusions = new AudConclusionStore();

  @Post('audit-engagements/:id/conclusions')
  @HttpCode(200)
  @OperationId('recordAuditConclusion')
  @Command({ operation: 'recordAuditConclusion', versioned: true })
  async record(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudConclusionRecord'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.engagements.lock(scope.tx, id, engagementScope(access, READ_PERMISSION, now), engagementScope(access, RECORD_PERMISSION, now), scope.expectedVersion ?? 0);
    const recorded = await this.conclusions.record(
      scope.tx,
      row,
      {
        conclusionKind: body.conclusion_kind,
        conclusionDocumentId: body.conclusion_document_id,
        issuedOn: body.issued_on,
        receivedOn: body.received_on,
        implementationDueOn: body.implementation_due_on,
        reportDueOn: body.report_due_on,
        summary: body.summary,
        totalFinancialVnd: body.total_financial_vnd,
        isPublic: body.is_public ?? false,
        supersedesId: body.supersedes_id,
      },
      vietnamDateOf(now),
      scope.tenant.membershipId,
    );
    const facts = {
      engagement_id: id,
      engagement_code: row.engagementCode,
      conclusion_kind: body.conclusion_kind,
      conclusion_document_id: body.conclusion_document_id,
      issued_on: body.issued_on,
      received_on: body.received_on,
      implementation_due_on: body.implementation_due_on ?? null,
      report_due_on: body.report_due_on ?? null,
      total_financial_vnd: body.total_financial_vnd.replace(/^0+(?=\d)/, ''),
      is_public: body.is_public ?? false,
      revision: 1,
    };
    await scope.audit({
      action: 'aud.conclusion_recorded',
      resourceType: CONCLUSION_TYPE,
      resourceId: recorded.id,
      classification: CLASSIFICATION,
      diff: { ...facts, engagement_from_status: row.status, engagement_to_status: 'FOLLOW_UP' },
    });
    await scope.emit({
      aggregateType: CONCLUSION_TYPE,
      aggregateId: recorded.id,
      aggregateVersion: 1,
      type: 'aud.conclusion.recorded.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, conclusion_id: recorded.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CONCLUSION_TYPE}:${recorded.id}:1`,
    });
    return commandResult(scope, 'RECEIVED', 1, recorded.id);
  }

  @Post('audit-conclusions/:id/findings')
  @HttpCode(200)
  @OperationId('recordAuditFinding')
  @Command({ operation: 'recordAuditFinding' })
  async recordFinding(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudFindingRecord'],
  ): Promise<CommandResult> {
    const now = new Date();
    const conclusion = await this.conclusions.lock(scope.tx, id, engagementScope(access, READ_PERMISSION, now), engagementScope(access, RECORD_PERMISSION, now));
    const created = await this.conclusions.recordFinding(
      scope.tx,
      conclusion,
      {
        findingCode: body.finding_code,
        category: body.category,
        projectId: body.project_id,
        contractId: body.contract_id,
        organizationUnitId: body.organization_unit_id,
        description: body.description,
        legalBasisCited: body.legal_basis_cited,
        amountVnd: body.amount_vnd,
        severity: body.severity,
      },
      scope.tenant.membershipId,
    );
    const facts = {
      conclusion_id: id,
      engagement_id: conclusion.engagementId,
      finding_code: body.finding_code.trim(),
      category: body.category,
      severity: body.severity,
      project_id: body.project_id ?? null,
      contract_id: body.contract_id ?? null,
      organization_unit_id: body.organization_unit_id ?? null,
      amount_vnd: body.amount_vnd === undefined ? null : body.amount_vnd.replace(/^0+(?=\d)/, ''),
    };
    await scope.audit({ action: 'aud.finding_recorded', resourceType: FINDING_TYPE, resourceId: created.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: FINDING_TYPE,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: 'aud.finding.recorded.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, finding_id: created.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${FINDING_TYPE}:${created.id}:1`,
    });
    return commandResult(scope, 'RECORDED', 1, created.id);
  }

  @Post('audit-conclusions/:id/recommendations')
  @HttpCode(200)
  @OperationId('createAuditRecommendation')
  @Command({ operation: 'createAuditRecommendation' })
  async createRecommendation(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudRecommendationCreate'],
  ): Promise<CommandResult> {
    const now = new Date();
    const conclusion = await this.conclusions.lock(scope.tx, id, engagementScope(access, READ_PERMISSION, now), engagementScope(access, RECORD_PERMISSION, now));
    const created = await this.conclusions.createRecommendation(
      scope.tx,
      conclusion,
      { findingId: body.finding_id, recCode: body.rec_code, recType: body.rec_type, description: body.description, amountVnd: body.amount_vnd, projectId: body.project_id },
      scope.tenant.membershipId,
    );
    const facts = {
      conclusion_id: id,
      engagement_id: conclusion.engagementId,
      finding_id: body.finding_id ?? null,
      rec_code: body.rec_code.trim(),
      rec_type: body.rec_type,
      amount_vnd: body.amount_vnd === undefined ? null : body.amount_vnd.replace(/^0+(?=\d)/, ''),
      project_id: body.project_id ?? null,
      recommended_vnd: created.recommendedVnd,
      shortfall_vnd: created.shortfallVnd,
    };
    await scope.audit({ action: 'aud.recommendation_created', resourceType: RECOMMENDATION_TYPE, resourceId: created.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: 'aud.recommendation.created.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: created.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${created.id}:1`,
    });
    return commandResult(scope, 'OPEN', 1, created.id);
  }
}

/** The conclusions, findings and recommendations the caller may see (AUD-04, AUD-05): all of them through the scope of the engagement, so what is outside it is not found (404, or an empty list). */
@Controller()
export class AuditConclusionReadsController {
  private readonly engagements = new AudEngagementStore();
  private readonly conclusions = new AudConclusionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-engagements/:id/conclusions')
  @OperationId('listAuditConclusions')
  async listConclusions(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const scope = engagementScope(access, READ_PERMISSION, new Date());
    const items = await this.database.withTenant(tenant, async (tx) => {
      // An engagement of another tenant, or outside the scope of the caller, is indistinguishable from one that does not exist.
      if ((await this.engagements.find(tx, id, scope)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.conclusions.listConclusions(tx, id, scope);
    });
    return { items: items.map(conclusionView) };
  }

  @Get('audit-conclusions/:id/findings')
  @OperationId('listAuditFindings')
  async listFindings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const scope = engagementScope(access, READ_PERMISSION, new Date());
    const rows = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.conclusions.findConclusion(tx, id, scope)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.conclusions.listFindings(tx, id, scope, { limit: request.limit + 1, after: request.after });
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(findingView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.findingCode, id: last.id }) : null };
  }
}
