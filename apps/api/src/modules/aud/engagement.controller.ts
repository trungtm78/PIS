import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AUD_SCOPE_KINDS, AudEngagementStore, TenantDatabase, WORKER_MEMBERSHIP_ID, engagementScope, engagementTargetRef } from '@machvon/db';
import type { AudScopeTarget, EngagementDetail, EngagementLine } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { reaches } from '../lnd/reach';

const READ_PERMISSION = PERMISSIONS.listAuditEngagements;
const MANAGE_PERMISSION = PERMISSIONS.createAuditEngagement;
const RESOURCE_TYPE = 'audit_engagement';
/** AUD data are CONFIDENTIAL (AUD 2): the trail and the events carry codes and ids, never the title, the authority or the reason in words. */
const CLASSIFICATION = 'CONFIDENTIAL';
const MAX_SCOPE_ITEMS = 500;

/** An engagement as the list reads it (AUD-02): an allowlist of what an engagement is. */
export function engagementLineView(line: EngagementLine): Record<string, unknown> {
  return {
    id: line.id,
    engagement_code: line.engagementCode,
    engagement_type: line.engagementType,
    authority_kind: line.authorityKind,
    authority_name: line.authorityName,
    title: line.title,
    period_from: line.periodFrom,
    period_to: line.periodTo,
    status: line.status,
    coordinator: { id: line.coordinatorId, display_name: line.coordinatorName },
    legal_hold: line.legalHoldId === null ? null : { id: line.legalHoldId, status: line.holdStatus },
    scope_count: line.scopeCount,
    version: line.version,
  };
}

/** An engagement as its file reads it (AUD-03): the line, the decision, the dates, the reason of a cancellation and the scope with names. */
export function engagementDetailView(detail: EngagementDetail): Record<string, unknown> {
  return {
    ...engagementLineView(detail),
    decision: {
      document_id: detail.decision.documentId,
      title: detail.decision.title,
      symbol: detail.decision.symbol,
      issued_on: detail.decision.issuedOn,
      effect_status: detail.decision.effectStatus,
    },
    started_on: detail.startedOn,
    fieldwork_ended_on: detail.fieldworkEndedOn,
    closed_on: detail.closedOn,
    cancel_reason: detail.cancelReason,
    classification: detail.classification,
    scope: detail.scope.map((item) => ({ kind: item.kind, id: item.id, code: item.code, name: item.name })),
    created_at: detail.createdAt,
  };
}

/** The scope of the request as targets: one to 500 distinct units, projects or contracts; anything else is a field problem. */
function scopeOf(items: ReadonlyArray<unknown>): AudScopeTarget[] {
  if (items.length === 0 || items.length > MAX_SCOPE_ITEMS) throw new DomainError('VALIDATION_FAILED', 422, 'scope');
  return items.map((item) => {
    const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const id = typeof entry.id === 'string' ? asUuid(entry.id) : undefined;
    const kind = AUD_SCOPE_KINDS.find((candidate) => candidate === entry.kind);
    if (id === undefined || kind === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'scope');
    return { kind, id };
  });
}

/**
 * The commands of an audit or inspection engagement (ST-AUD-001, AUD 3.1): register it against an effective decision with its scope, start it (with a legal hold that covers the scope in the
 * same transaction, BR-AUD-10), end the fieldwork, and cancel it before any conclusion (the hold is released). The data are CONFIDENTIAL: whoever has no grant that meets a scope item does not
 * find the engagement (404), whichever tenant it is in; one who sees it and may not act on it is told so (403).
 */
@Controller()
export class AuditEngagementController {
  private readonly engagements = new AudEngagementStore();

  @Post('audit-engagements')
  @HttpCode(200)
  @OperationId('createAuditEngagement')
  @Command({ operation: 'createAuditEngagement' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AudEngagementCreate']): Promise<CommandResult> {
    const now = new Date();
    const targets = await this.engagements.resolveTargets(scope.tx, scopeOf(body.scope));
    // The caller may register an engagement only about places that they manage: every item of the scope lies in a grant of theirs.
    if (!targets.every((target) => reaches(access, MANAGE_PERMISSION, [engagementTargetRef(target)], now))) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.engagements.create(
      scope.tx,
      {
        engagementCode: body.engagement_code.trim(),
        engagementType: body.engagement_type,
        authorityKind: body.authority_kind,
        authorityName: body.authority_name.trim(),
        decisionDocumentId: body.decision_document_id,
        title: body.title.trim(),
        periodFrom: body.period_from,
        periodTo: body.period_to,
        coordinatorId: body.coordinator_user_id,
        scope: targets,
      },
      targets,
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'aud.engagement_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        engagement_code: body.engagement_code.trim(),
        engagement_type: body.engagement_type,
        authority_kind: body.authority_kind,
        decision_document_id: body.decision_document_id,
        period_from: body.period_from,
        period_to: body.period_to,
        coordinator_id: body.coordinator_user_id,
        scope: targets.map((target) => ({ kind: target.kind, id: target.id })),
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'aud.engagement.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        engagement_id: created.id,
        engagement_code: body.engagement_code.trim(),
        engagement_type: body.engagement_type,
        decision_document_id: body.decision_document_id,
        scope: targets.map((target) => ({ kind: target.kind, id: target.id })),
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'PLANNED', created.version, created.id);
  }

  @Post('audit-engagements/:id/start')
  @HttpCode(200)
  @OperationId('startAuditEngagement')
  @Command({ operation: 'startAuditEngagement', versioned: true })
  async start(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudEngagementStart'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.locked(scope, access, id, now);
    const done = await this.engagements.start(scope.tx, row, { startedOn: body.started_on, placeLegalHold: body.place_legal_hold, today: vietnamDateOf(now) }, scope.tenant.membershipId);
    await scope.audit({
      action: 'aud.engagement_started',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { engagement_code: row.engagementCode, from_status: row.status, to_status: 'ONGOING', started_on: body.started_on, legal_hold_id: done.legalHoldId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.engagement.started.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        engagement_id: id,
        engagement_code: row.engagementCode,
        started_on: body.started_on,
        legal_hold_id: done.legalHoldId,
        scope: (await this.engagements.holdScope(scope.tx, id)).ids,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'ONGOING', done.version, id);
  }

  @Post('audit-engagements/:id/fieldwork-end')
  @HttpCode(200)
  @OperationId('endAuditFieldwork')
  @Command({ operation: 'endAuditFieldwork', versioned: true })
  async endFieldwork(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudStatusNote'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.locked(scope, access, id, now);
    const done = await this.engagements.endFieldwork(scope.tx, row, { onDate: body.on_date, today: vietnamDateOf(now) }, scope.tenant.membershipId);
    await scope.audit({
      action: 'aud.engagement_fieldwork_ended',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { engagement_code: row.engagementCode, from_status: row.status, to_status: 'AWAITING_CONCLUSION', fieldwork_ended_on: body.on_date },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.engagement.fieldwork_ended.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, engagement_id: id, engagement_code: row.engagementCode, fieldwork_ended_on: body.on_date, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'AWAITING_CONCLUSION', done.version, id);
  }

  @Post('audit-engagements/:id/cancellation')
  @HttpCode(200)
  @OperationId('cancelAuditEngagement')
  @Command({ operation: 'cancelAuditEngagement', versioned: true })
  async cancel(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudStatusNote'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.locked(scope, access, id, now);
    if (body.on_date > vietnamDateOf(now)) throw new DomainError('VALIDATION_FAILED', 422, 'on_date');
    const done = await this.engagements.cancel(scope.tx, row, { reason: body.reason ?? '', releasedBy: WORKER_MEMBERSHIP_ID }, scope.tenant.membershipId);
    await scope.audit({
      action: 'aud.engagement_cancelled',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { engagement_code: row.engagementCode, from_status: row.status, to_status: 'CANCELLED', on_date: body.on_date, legal_hold_id: row.legalHoldId, legal_hold_released: done.holdReleased },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.engagement.cancelled.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        engagement_id: id,
        engagement_code: row.engagementCode,
        cancelled_on: body.on_date,
        legal_hold_id: row.legalHoldId,
        legal_hold_released: done.holdReleased,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'CANCELLED', done.version, id);
  }

  /** The engagement locked for a command: 404 when the caller does not see it, 403 when they see it and may not act on it, 409 for a stale version. */
  private locked(scope: CommandScope, access: EffectiveAccess, id: string, now: Date) {
    return this.engagements.lock(scope.tx, id, engagementScope(access, READ_PERMISSION, now), engagementScope(access, MANAGE_PERMISSION, now), scope.expectedVersion ?? 0);
  }
}

/** The engagements the caller may see (AUD-02, AUD-03): a read is limited to the engagements whose scope meets a grant of the caller. */
@Controller()
export class AuditEngagementReadsController {
  private readonly engagements = new AudEngagementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-engagements')
  @OperationId('listAuditEngagements')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('engagement_type') type?: unknown,
    @Query('project_id') project?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (project !== undefined && projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.engagements.list(tx, engagementScope(access, READ_PERMISSION, new Date()), {
        limit: request.limit + 1,
        after: request.after,
        status: typeof status === 'string' ? status : undefined,
        type: typeof type === 'string' ? type : undefined,
        projectId: projectId?.toLowerCase(),
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(engagementLineView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.engagementCode, id: last.id }) : null };
  }

  @Get('audit-engagements/:id')
  @OperationId('getAuditEngagement')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const detail = await this.database.withTenant(tenant, (tx) => this.engagements.find(tx, id, engagementScope(access, READ_PERMISSION, new Date())));
    // An engagement of another tenant, or outside the scope of the caller, is indistinguishable from one that does not exist.
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return engagementDetailView(detail);
  }
}
