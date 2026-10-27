import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjExplanationStore, TenantDatabase, WARNING_RESOURCE, explanationRequestedRecord, explanationRespondedRecord, explanationReviewedRecord, explanationScope, explanationUnitScope, projectScope } from '@machvon/db';
import type { ExplanationRow } from '@machvon/db';
import { DomainError, MANUAL_EXPLANATION_TRIGGER, asUuid } from '@machvon/kernel';
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

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
/** The anchor of a page is the instant a request was made, with the microseconds the database keeps. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function queryText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(name);
  return value;
}

function queryId(value: unknown, name: string): string | undefined {
  const text = queryText(value, name);
  if (text === undefined) return undefined;
  const id = asUuid(text);
  if (id === undefined) throw invalid(name);
  return id;
}

/** The request as the contract exposes it (an allowlist, so a column added to the table later is not shown until it is listed here). */
export function explanationView(row: ExplanationRow): Record<string, unknown> {
  return {
    id: row.id,
    subject_kind: row.subjectKind,
    project: row.projectId === null ? null : { id: row.projectId, code: row.projectCode, name: row.projectName },
    unit: row.unitId === null ? null : { id: row.unitId, name: row.unitName },
    period_id: row.periodId,
    warning_id: row.warningId,
    trigger_code: row.triggerCode,
    question: row.question,
    requested_from_membership_id: row.requestedFromMembershipId,
    due_at: row.dueAt,
    original_due_at: row.originalDueAt,
    response_text: row.responseText,
    response_document_id: row.responseDocumentId,
    responded_by: row.respondedBy,
    responded_at: row.respondedAt,
    is_late: row.isLate,
    reviewed_by: row.reviewedBy,
    review_note: row.reviewNote,
    status: row.status,
    created_at: row.createdAt,
    created_by: row.createdBy,
    version: row.version,
  };
}

/**
 * The explanation requests (ST-PRJ-006, PRJ 3.1 F10, BR-PRJ-08, PRJ-19): a leader asks for an explanation of a project or a unit in their scope, the person asked answers (late is taken, and told late), and someone
 * else accepts the answer or returns it; an acceptance resolves the early warning the request was for. The list shows the requests in the scope of the reader and the ones addressed to them.
 */
@Controller()
export class ExplanationController {
  private readonly store = new PrjExplanationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('explanation-requests')
  @OperationId('listExplanationRequests')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw invalid('cursor');
    const state = queryText(status, 'status');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(
        tx,
        { status: state, projectId: queryId(projectId, 'project_id'), unitId: queryId(unitId, 'unit_id') },
        { scope: explanationScope(access, PERMISSIONS.listExplanationRequests, now), membershipId: tenant.membershipId },
        { limit: request.limit, after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id } },
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(explanationView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Post('explanation-requests')
  @HttpCode(200)
  @OperationId('requestExplanation')
  @Command({ operation: 'requestExplanation' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PrjExplanationRequest']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.store.request(scope.tx, {
      subjectKind: body.subject_kind,
      projectId: body.project_id,
      unitId: body.unit_id,
      periodId: body.period_id,
      warningId: body.warning_id,
      triggerCode: body.trigger_code === '' ? MANUAL_EXPLANATION_TRIGGER : body.trigger_code,
      question: body.question,
      requestedFromMembershipId: body.requested_from_membership_id,
      dueAt: body.due_at,
      actor: scope.tenant.membershipId,
      now,
      scope: { project: projectScope(access, PERMISSIONS.requestExplanation, now), unit: explanationUnitScope(access, PERMISSIONS.requestExplanation, now) },
    });
    const record = explanationRequestedRecord(made, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    return commandResult(scope, made.row.status, made.row.version, made.row.id);
  }

  @Post('explanation-requests/:id/response')
  @HttpCode(200)
  @OperationId('submitExplanation')
  @Command({ operation: 'submitExplanation', versioned: true })
  async respond(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjExplanationResponse']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.submit(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      now,
      responseText: body.response_text,
      responseDocumentId: body.response_document_id,
    });
    const record = explanationRespondedRecord(done, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('explanation-requests/:id/decision')
  @HttpCode(200)
  @OperationId('reviewExplanation')
  @Command({ operation: 'reviewExplanation', versioned: true })
  async review(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjExplanationReview']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.review(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      now,
      decision: body.decision,
      reviewNote: body.review_note,
      newDueAt: body.new_due_at,
      scope: explanationScope(access, PERMISSIONS.reviewExplanation, now),
    });
    const record = explanationReviewedRecord(done, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    // The warning that the accepted explanation was for is resolved in the same transaction, and says so on its own trail.
    if (done.warning !== undefined) {
      await scope.audit({ action: 'dis.warning_resolved_by_explanation', resourceType: WARNING_RESOURCE, resourceId: done.warning.id, diff: { rule_code: done.warning.ruleCode, explanation_request_id: done.row.id, resolution_reason: done.warning.resolutionReason } });
    }
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }
}
