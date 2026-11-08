import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LESSON_RESOURCE, LESSON_WAIVER_RESOURCE, PrjLessonsStore, TenantDatabase, projectScope } from '@machvon/db';
import type { LessonRow, LessonWaiverRow, LessonsView } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { snakeKeys } from '../../snake-case';
import { CurrentTenant } from '../../tenant-context.decorator';

const CLASSIFICATION = 'INTERNAL';

export function lessonsViewOf(view: LessonsView, now: Date): Record<string, unknown> {
  return {
    project: view.project,
    lessons: snakeKeys(view.lessons),
    waiver: view.waiver === null ? null : snakeKeys(view.waiver),
    gate: snakeKeys(view.gate),
    rule: {
      version: view.rule.version,
      source: view.rule.source,
      unverified: view.rule.unverified,
      params: snakeKeys(view.rule.policy),
      provenance: view.rule.provenance === null ? null : { formula: view.rule.provenance.formula, source: view.rule.provenance.source, as_of: view.rule.provenance.asOf, legal_status: view.rule.provenance.legalStatus },
    },
    as_of: now.toISOString(),
  };
}

/**
 * The lessons learned of a project and the waiver of them (G1-19, PRJ closing gate): proposed by one person, decided by another; the closing of the project is refused until the gate is met (the stage store of
 * PRJ asks the same store). Every command is audited and idempotent, and the maker is never the checker.
 */
@Controller()
export class LessonsController {
  private readonly store = new PrjLessonsStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/lessons')
  @OperationId('listLessons')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, (tx) => this.store.view(tx, projectScope(access, PERMISSIONS.listLessons, now), id.toLowerCase(), now));
    return lessonsViewOf(view, now);
  }

  @Post('projects/:id/lessons')
  @HttpCode(200)
  @OperationId('proposeLesson')
  @Command({ operation: 'proposeLesson' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLessonDraft']): Promise<CommandResult> {
    const now = new Date();
    const lesson = await this.store.propose(scope.tx, projectScope(access, PERMISSIONS.proposeLesson, now), { projectId: id.toLowerCase(), draft: { category: body.category, title: body.title, situation: body.situation, recommendation: body.recommendation }, actor: scope.tenant.membershipId, now });
    await this.record(scope, 'project.lesson_proposed', 'project.lesson_proposed.v1', LESSON_RESOURCE, lesson, now, { category: lesson.category });
    return commandResult(scope, lesson.status, lesson.version, lesson.id);
  }

  @Post('lessons/:id/decision')
  @HttpCode(200)
  @OperationId('decideLesson')
  @Command({ operation: 'decideLesson', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLessonDecision']): Promise<CommandResult> {
    const now = new Date();
    const lesson = await this.store.decide(scope.tx, projectScope(access, PERMISSIONS.decideLesson, now), { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, decision: body.decision, note: body.note, actor: scope.tenant.membershipId, now });
    await this.record(scope, 'project.lesson_decided', 'project.lesson_decided.v1', LESSON_RESOURCE, lesson, now, { decision: body.decision, category: lesson.category }, body.note);
    return commandResult(scope, lesson.status, lesson.version, lesson.id);
  }

  @Post('projects/:id/lesson-waivers')
  @HttpCode(200)
  @OperationId('requestLessonWaiver')
  @Command({ operation: 'requestLessonWaiver' })
  async requestWaiver(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLessonWaiverRequest']): Promise<CommandResult> {
    const now = new Date();
    const waiver = await this.store.requestWaiver(scope.tx, projectScope(access, PERMISSIONS.requestLessonWaiver, now), { projectId: id.toLowerCase(), reason: body.reason, actor: scope.tenant.membershipId, now });
    await this.record(scope, 'project.lesson_waiver_requested', 'project.lesson_waiver_requested.v1', LESSON_WAIVER_RESOURCE, waiver, now, { gate: waiver.gate });
    return commandResult(scope, waiver.status, waiver.version, waiver.id);
  }

  @Post('lesson-waivers/:id/decision')
  @HttpCode(200)
  @OperationId('decideLessonWaiver')
  @Command({ operation: 'decideLessonWaiver', versioned: true })
  async decideWaiver(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLessonDecision']): Promise<CommandResult> {
    const now = new Date();
    const waiver = await this.store.decideWaiver(scope.tx, projectScope(access, PERMISSIONS.decideLessonWaiver, now), { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, decision: body.decision, note: body.note, actor: scope.tenant.membershipId, now });
    await this.record(scope, 'project.lesson_waiver_decided', 'project.lesson_waiver_decided.v1', LESSON_WAIVER_RESOURCE, waiver, now, { decision: body.decision, gate: waiver.gate }, body.note);
    return commandResult(scope, waiver.status, waiver.version, waiver.id);
  }

  private async record(scope: CommandScope, action: string, type: string, resource: string, row: LessonRow | LessonWaiverRow, now: Date, facts: Record<string, unknown>, reason?: string): Promise<void> {
    await scope.audit({ action, resourceType: resource, resourceId: row.id, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff: { project_id: row.projectId, status: row.status, ...facts } });
    await scope.emit({
      aggregateType: resource,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: row.projectId, status: row.status, ...facts, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${resource}:${row.id}:${row.version}:${action}`,
    });
  }
}
