import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AiAssistStore, TenantDatabase } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { checklistView, criteriaSetView } from './assist-view';
import { oneOf } from './assist-paging';

const CHECKLIST = 'ai_review_checklist';
const CRITERIA = 'ai_eval_criteria_set';
const STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'];
const CODE = /^[A-Z][A-Z0-9_.-]{1,59}$/;
const APPLIES = /^[A-Z][A-Z0-9_]{1,39}$/;

const titleOf = (raw: unknown): string => {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (title.length < 2 || title.length > 300) throw new DomainError('VALIDATION_FAILED', 422, 'title');
  return title;
};
const codeOf = (raw: unknown): string => {
  if (typeof raw !== 'string' || !CODE.test(raw)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
  return raw;
};

/**
 * The configuration of the assistant (lane AI-2; AI.02, AI.04; LLM-26): the checklists a file is reviewed against and the sets of criteria a contract is evaluated against. Both are the tenant's, not a unit's. A revision is
 * drafted by one person and published by another, and once published it is frozen: a change is a new revision, and the one in force is retired when the new one is published. The weights of a set add up to 10000 basis points.
 */
@Controller()
export class AiAssistConfigController {
  private readonly store = new AiAssistStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  // ---- checklists --------------------------------------------------------------------------------------------------------------------------

  @Post('ai/review-checklists')
  @HttpCode(200)
  @OperationId('createAiReviewChecklist')
  @Command({ operation: 'createAiReviewChecklist' })
  async createChecklist(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AiReviewChecklistCreate']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.createAiReviewChecklist);
    if (typeof body.applies_to !== 'string' || !APPLIES.test(body.applies_to)) throw new DomainError('VALIDATION_FAILED', 422, 'applies_to');
    const created = await this.store.createChecklist(scope.tx, { code: codeOf(body.code), title: titleOf(body.title), appliesTo: body.applies_to, items: body.items, actor: scope.tenant.membershipId });
    await scope.audit({ action: 'llm.assist_checklist_drafted', resourceType: CHECKLIST, resourceId: created.id, diff: { code: created.code, revision: created.revision, applies_to: created.appliesTo, items: created.items.length } });
    await scope.emit({
      aggregateType: CHECKLIST,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.assist.checklist.drafted.v1',
      schemaVersion: 1,
      payload: { checklist_id: created.id, code: created.code, revision: created.revision },
      eventKey: `${CHECKLIST}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('ai/review-checklists/:id/publish')
  @HttpCode(200)
  @OperationId('publishAiReviewChecklist')
  @Command({ operation: 'publishAiReviewChecklist', versioned: true })
  async publishChecklist(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.publishAiReviewChecklist);
    const done = await this.store.publishChecklist(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'llm.assist_checklist_published', resourceType: CHECKLIST, resourceId: id, diff: { code: done.row.code, revision: done.row.revision, retired_id: done.retiredId } });
    await scope.emit({
      aggregateType: CHECKLIST,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'llm.assist.checklist.published.v1',
      schemaVersion: 1,
      payload: { checklist_id: id, code: done.row.code, revision: done.row.revision, retired_id: done.retiredId },
      eventKey: `${CHECKLIST}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Get('ai/review-checklists')
  @OperationId('listAiReviewChecklists')
  async checklists(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('applies_to') appliesTo?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiReviewChecklists);
    const applies = appliesTo === undefined ? undefined : String(appliesTo);
    if (applies !== undefined && !APPLIES.test(applies)) throw new DomainError('VALIDATION_FAILED', 422, 'applies_to');
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listChecklists(tx, { status: oneOf(status, STATUSES, 'status'), appliesTo: applies }));
    return { items: rows.map(checklistView), next_cursor: null, as_of: new Date().toISOString() };
  }

  @Get('ai/review-checklists/:id')
  @OperationId('getAiReviewChecklist')
  async checklist(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiReviewChecklist);
    const row = await this.database.withTenant(tenant, (tx) => this.store.findChecklist(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return checklistView(row);
  }

  // ---- sets of criteria --------------------------------------------------------------------------------------------------------------------

  @Post('ai/evaluation-criteria')
  @HttpCode(200)
  @OperationId('createAiEvalCriteriaSet')
  @Command({ operation: 'createAiEvalCriteriaSet' })
  async createCriteria(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AiEvalCriteriaSetCreate']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.createAiEvalCriteriaSet);
    const created = await this.store.createCriteriaSet(scope.tx, { code: codeOf(body.code), title: titleOf(body.title), scaleMax: body.scale_max ?? 100, criteria: body.criteria, actor: scope.tenant.membershipId });
    await scope.audit({ action: 'llm.assist_criteria_drafted', resourceType: CRITERIA, resourceId: created.id, diff: { code: created.code, revision: created.revision, scale_max: created.scaleMax, criteria: created.criteria.length } });
    await scope.emit({
      aggregateType: CRITERIA,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.assist.criteria.drafted.v1',
      schemaVersion: 1,
      payload: { criteria_set_id: created.id, code: created.code, revision: created.revision },
      eventKey: `${CRITERIA}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('ai/evaluation-criteria/:id/publish')
  @HttpCode(200)
  @OperationId('publishAiEvalCriteriaSet')
  @Command({ operation: 'publishAiEvalCriteriaSet', versioned: true })
  async publishCriteria(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.publishAiEvalCriteriaSet);
    const done = await this.store.publishCriteriaSet(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'llm.assist_criteria_published', resourceType: CRITERIA, resourceId: id, diff: { code: done.row.code, revision: done.row.revision, retired_id: done.retiredId } });
    await scope.emit({
      aggregateType: CRITERIA,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'llm.assist.criteria.published.v1',
      schemaVersion: 1,
      payload: { criteria_set_id: id, code: done.row.code, revision: done.row.revision, retired_id: done.retiredId },
      eventKey: `${CRITERIA}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Get('ai/evaluation-criteria')
  @OperationId('listAiEvalCriteriaSets')
  async criteriaSets(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiEvalCriteriaSets);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listCriteriaSets(tx, { status: oneOf(status, STATUSES, 'status') }));
    return { items: rows.map(criteriaSetView), next_cursor: null, as_of: new Date().toISOString() };
  }

  @Get('ai/evaluation-criteria/:id')
  @OperationId('getAiEvalCriteriaSet')
  async criteriaSet(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiEvalCriteriaSet);
    const row = await this.database.withTenant(tenant, (tx) => this.store.findCriteriaSet(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return criteriaSetView(row);
  }
}
