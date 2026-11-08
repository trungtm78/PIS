import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AnaBottleneckStore, HALT_RESOURCE, TenantDatabase, projectScope } from '@machvon/db';
import type { BottleneckSourceRead, HaltDossierRow, HaltStepRow } from '@machvon/db';
import {
  BOTTLENECK_RULE_TYPE,
  DomainError,
  allStepsClosed,
  analyseBottlenecks,
  assertPlanApprover,
  bucketCodes,
  checkHalt,
  checkHaltClose,
  checkPlanDecision,
  checkRestartPlan,
  checkStepUpdate,
  describeRuleType,
  haltCan,
  planState,
  vietnamDateOf,
} from '@machvon/kernel';
import type { BottleneckItem, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const LIST_MAX = 100;
const HALT_STATUS_FILTERS = ['HALTED', 'RESTART_PLANNED', 'RESTARTED', 'CANCELLED'] as const;

const itemView = (item: ReturnType<typeof analyseBottlenecks>['items'][number]): Record<string, unknown> => ({
  key: item.key,
  source: item.source,
  source_id: item.sourceId,
  project: { id: item.projectId, code: item.projectCode },
  unit_id: item.unitId,
  cause_code: item.causeCode,
  cause_known: item.causeKnown,
  owner_module: item.ownerModule,
  amount_vnd: item.amountVnd,
  amount_null_reason: item.amountNullReason,
  since: item.since,
  age_days: item.ageDays,
  bucket: item.bucket,
  holder: { kind: item.holder.kind, id: item.holder.id, name: item.holder.name, code: item.holder.code },
  merged_keys: item.mergedKeys,
});

const stepView = (step: HaltStepRow): Record<string, unknown> => ({
  id: step.id,
  plan_version: step.planVersion,
  ordinal: step.ordinal,
  title: step.title,
  owner: step.ownerId === null ? null : { id: step.ownerId, name: step.ownerName },
  owner_unit: step.ownerUnitId === null ? null : { id: step.ownerUnitId, name: step.ownerUnitName },
  due_on: step.dueOn,
  status: step.status,
  closed_by: step.closedBy,
  closed_at: step.closedAt,
  close_note: step.closeNote,
});

function dossierView(row: HaltDossierRow, steps: readonly HaltStepRow[], today: string): Record<string, unknown> {
  const current = steps.filter((step) => step.planVersion === row.planVersion);
  return {
    id: row.id,
    project: { id: row.projectId, code: row.projectCode, name: row.projectName, status: row.projectStatus },
    unit: { id: row.unitId, name: row.unitName },
    reason_code: row.reasonCode,
    reason_text: row.reasonText,
    halted_on: row.haltedOn,
    age_days: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.haltedOn}T00:00:00Z`)) / 86_400_000)),
    order_ref: row.orderRef,
    expected_restart_on: row.expectedRestartOn,
    status: row.status,
    plan: {
      version: row.planVersion,
      state: planState(row.status, row.planVersion > 0, current.map((step) => ({ status: step.status, dueOn: step.dueOn })), today),
      saved_by: row.planSavedBy,
      saved_at: row.planSavedAt,
      decision: row.planDecision,
      decided_by: row.planDecidedBy,
      decided_at: row.planDecidedAt,
      decision_note: row.planDecisionNote,
      steps_total: current.length,
      steps_open: current.filter((step) => step.status === 'OPEN').length,
      steps_overdue: current.filter((step) => step.status === 'OPEN' && step.dueOn < today).length,
    },
    closed_by: row.closedBy,
    closed_at: row.closedAt,
    close_note: row.closeNote,
    restarted_on: row.restartedOn,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

/**
 * The bottlenecks and the halted projects (G3-9): what holds money and work up, with the amount held (none, said, where the source has none), a standard cause, the age of the debt and who holds it; and the dossier of
 * each halted project with the reason and a restart plan that a different person approved. Sources are read in the scope of the reader from the tables of their modules; one amount two sources describe is counted once.
 */
@Controller()
export class AnaBottleneckController {
  private readonly store = new AnaBottleneckStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/bottlenecks')
  @OperationId('getBottleneckAnalysis')
  async analysis(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('cause') cause?: unknown, @Query('unit_id') unitId?: unknown, @Query('bucket') bucket?: unknown): Promise<Record<string, unknown>> {
    if (cause !== undefined && (typeof cause !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(cause))) throw invalid('cause');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    if (bucket !== undefined && (typeof bucket !== 'string' || !/^(LE|GT)_\d{1,4}$/.test(bucket))) throw invalid('bucket');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scope = projectScope(access, HOME_READ_PERMISSION, now);
    const rule = describeRuleType(BOTTLENECK_RULE_TYPE);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.store.policy(tx, today);
      const sources: Array<[string, BottleneckSourceRead]> = [
        ['PAYMENT', await this.store.payments(tx, scope)],
        ['LAND', await this.store.land(tx, scope, today)],
        ['ISSUE', await this.store.issues(tx, scope, policy.model.issueMinSeverity)],
        ['HALT', await this.store.halts(tx, scope)],
      ];
      return { policy, sources };
    });
    const { model } = read.policy;
    const items: BottleneckItem[] = read.sources.flatMap(([, source]) => source.items).filter((item) => unitId === undefined || item.unitId === unitId);
    const result = analyseBottlenecks(model, items, today);
    const shown = result.items.filter((item) => (cause === undefined || item.causeCode === cause) && (bucket === undefined || item.bucket === bucket));
    return {
      as_of: today,
      model: {
        rule_version: read.policy.version,
        unverified: read.policy.unverified,
        causes: model.causes.map((one) => ({ code: one.code, owner_module: one.ownerModule })),
        buckets: bucketCodes(model),
        issue_min_severity: model.issueMinSeverity,
      },
      info: { formula: rule.formula, source: rule.source, as_of: rule.asOf, rule_version: read.policy.version, unverified: read.policy.unverified },
      held_vnd: result.heldVnd,
      no_amount: result.noAmount,
      merged: result.merged,
      sources: read.sources.map(([name, source]) => ({ source: name, items: source.items.length, skipped: source.skipped, cut: source.cut })),
      by_cause: result.byCause.map((total) => ({ key: total.key, count: total.count, amount_vnd: total.amountVnd, no_amount: total.noAmount })),
      by_bucket: result.byBucket.map((total) => ({ key: total.key, count: total.count, amount_vnd: total.amountVnd, no_amount: total.noAmount })),
      by_holder: result.byHolder.map((total) => ({ key: total.key, holder: total.holder, count: total.count, amount_vnd: total.amountVnd, no_amount: total.noAmount })),
      by_unit: result.byUnit.map((total) => ({ unit_id: total.key === '' ? null : total.key, count: total.count, amount_vnd: total.amountVnd, no_amount: total.noAmount })),
      items_total: result.items.length,
      items: shown.map(itemView),
    };
  }

  @Get('home/halted-projects')
  @OperationId('listHaltedProjects')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('open') open?: unknown, @Query('limit') limitText?: unknown): Promise<Record<string, unknown>> {
    if (status !== undefined && (typeof status !== 'string' || !(HALT_STATUS_FILTERS as readonly string[]).includes(status))) throw invalid('status');
    if (open !== undefined && open !== 'true' && open !== 'false') throw invalid('open');
    if (limitText !== undefined && (typeof limitText !== 'string' || !/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > LIST_MAX)) throw invalid('limit');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scope = projectScope(access, HOME_READ_PERMISSION, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const rows = await this.store.dossiers(tx, scope, { status: status as string | undefined, open: open === undefined ? undefined : open === 'true' }, limitText === undefined ? 50 : Number(limitText));
      const withSteps = [];
      for (const row of rows) withSteps.push({ row, steps: await this.store.steps(tx, row.id, row.planVersion === 0 ? undefined : row.planVersion) });
      return { withSteps, undocumented: await this.store.undocumented(tx, scope), policy: await this.store.policy(tx, today) };
    });
    return {
      as_of: today,
      items: read.withSteps.map(({ row, steps }) => dossierView(row, row.planVersion === 0 ? [] : steps, today)),
      undocumented: read.undocumented.map((one) => ({ project: { id: one.projectId, code: one.projectCode, name: one.projectName }, unit: { id: one.unitId, name: one.unitName } })),
      causes: read.policy.model.causes.map((one) => ({ code: one.code, owner_module: one.ownerModule })),
      plan_min_steps: read.policy.model.planMinSteps,
      rule_version: read.policy.version,
      unverified: read.policy.unverified,
    };
  }

  @Get('home/halted-projects/:id')
  @OperationId('getHaltedProject')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scope = projectScope(access, HOME_READ_PERMISSION, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.findDossier(tx, scope, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
      return { row, steps: await this.store.steps(tx, id) };
    });
    return { ...dossierView(read.row, read.steps, today), steps: read.steps.map(stepView) };
  }

  @Post('home/halted-projects')
  @HttpCode(200)
  @OperationId('recordProjectHalt')
  @Command({ operation: 'recordProjectHalt' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RecordProjectHalt']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const { model } = await this.store.policy(scope.tx, today);
    const draft = checkHalt(body, model, today);
    const project = await this.store.projectStatus(scope.tx, projectScope(access, HOME_READ_PERMISSION, now), draft.projectId);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
    if (project.status !== 'SUSPENDED') throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { project_status: project.status } });
    if (await this.store.hasOpenDossier(scope.tx, draft.projectId)) throw new DomainError('PROJECT_HALT_OPEN_EXISTS', 409, 'project_id');
    const recorded = await this.store.insertDossier(scope.tx, { ...draft, actor: scope.tenant.membershipId });
    const facts = { project_id: draft.projectId, reason_code: draft.reasonCode, halted_on: draft.haltedOn, expected_restart_on: draft.expectedRestartOn };
    await scope.audit({ action: 'home.project_halted', resourceType: HALT_RESOURCE, resourceId: recorded.id, reason: draft.reasonText, diff: facts });
    await scope.emit({ aggregateType: HALT_RESOURCE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.project_halted.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), dossier_id: recorded.id, ...facts }, eventKey: `project_halt:${recorded.id}:1` });
    return commandResult(scope, 'HALTED', 1, recorded.id);
  }

  @Post('home/halted-projects/:id/plan')
  @HttpCode(200)
  @OperationId('saveRestartPlan')
  @Command({ operation: 'saveRestartPlan' })
  async plan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SaveRestartPlan']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const row = await this.store.findDossier(scope.tx, projectScope(access, HOME_READ_PERMISSION, now), id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (!haltCan(row.status, 'PLAN')) throw new DomainError('PROJECT_HALT_STATE', 409, 'id');
    const { model } = await this.store.policy(scope.tx, today);
    const draft = checkRestartPlan(body, model, today, row.haltedOn);
    for (const step of draft.steps) {
      if (step.ownerId !== null && !(await this.store.memberExists(scope.tx, step.ownerId))) throw invalid('steps.owner_id');
      if (step.ownerUnitId !== null && !(await this.store.unitExists(scope.tx, step.ownerUnitId))) throw invalid('steps.owner_unit_id');
    }
    const version = row.planVersion + 1;
    await this.store.savePlan(scope.tx, id, version, draft.steps, draft.expectedRestartOn, scope.tenant.membershipId);
    const facts = { project_id: row.projectId, plan_version: version, steps: draft.steps.length };
    await scope.audit({ action: 'home.restart_plan_saved', resourceType: HALT_RESOURCE, resourceId: id, diff: facts });
    await scope.emit({ aggregateType: HALT_RESOURCE, aggregateId: id, aggregateVersion: 1 + version, type: 'home.restart_plan_saved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), dossier_id: id, ...facts }, eventKey: `project_halt:${id}:plan:${version}` });
    return commandResult(scope, 'PLAN_SAVED', 1 + version, id);
  }

  @Post('home/halted-projects/:id/plan-decision')
  @HttpCode(200)
  @OperationId('decideRestartPlan')
  @Command({ operation: 'decideRestartPlan' })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DecideRestartPlan']): Promise<CommandResult> {
    const now = this.clock();
    const row = await this.store.findDossier(scope.tx, projectScope(access, HOME_READ_PERMISSION, now), id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const draft = checkPlanDecision(body);
    if (!haltCan(row.status, 'DECIDE') || row.planVersion === 0 || row.planDecision !== null || row.planSavedBy === null) throw new DomainError('PROJECT_HALT_STATE', 409, 'id');
    assertPlanApprover(row.planSavedBy.id, scope.tenant.membershipId);
    const { model } = await this.store.policy(scope.tx, vietnamDateOf(now));
    const steps = await this.store.steps(scope.tx, id, row.planVersion);
    if (draft.decision === 'APPROVE' && steps.length < model.planMinSteps) throw new DomainError('PROJECT_HALT_STATE', 409, 'id');
    await this.store.decidePlan(scope.tx, id, draft.decision === 'APPROVE' ? 'APPROVED' : 'RETURNED', scope.tenant.membershipId, draft.note);
    const facts = { project_id: row.projectId, plan_version: row.planVersion, decision: draft.decision };
    await scope.audit({ action: 'home.restart_plan_decided', resourceType: HALT_RESOURCE, resourceId: id, reason: draft.note, diff: facts });
    await scope.emit({ aggregateType: HALT_RESOURCE, aggregateId: id, aggregateVersion: 2 + row.planVersion, type: 'home.restart_plan_decided.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), dossier_id: id, ...facts }, eventKey: `project_halt:${id}:decision:${row.planVersion}` });
    return commandResult(scope, draft.decision === 'APPROVE' ? 'RESTART_PLANNED' : 'RETURNED', 2 + row.planVersion, id);
  }

  @Post('home/halted-projects/:id/steps/:step_id/closure')
  @HttpCode(200)
  @OperationId('closeRestartStep')
  @Command({ operation: 'closeRestartStep' })
  async closeStep(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Param('step_id', ParseUUIDPipe) stepId: string, @Body() body: Schemas['CloseRestartStep']): Promise<CommandResult> {
    const now = this.clock();
    const row = await this.store.findDossier(scope.tx, projectScope(access, HOME_READ_PERMISSION, now), id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const step = await this.store.findStep(scope.tx, id, stepId);
    if (step === undefined || step.planVersion !== row.planVersion) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'step_id');
    if (!haltCan(row.status, 'UPDATE_STEP') || step.status !== 'OPEN') throw new DomainError('PROJECT_HALT_STATE', 409, 'step_id');
    const draft = checkStepUpdate(body);
    await this.store.closeStep(scope.tx, stepId, draft.status, scope.tenant.membershipId, draft.note);
    const facts = { project_id: row.projectId, step_id: stepId, ordinal: step.ordinal, status: draft.status };
    await scope.audit({ action: 'home.restart_step_closed', resourceType: HALT_RESOURCE, resourceId: id, reason: draft.note, diff: facts });
    await scope.emit({ aggregateType: HALT_RESOURCE, aggregateId: id, aggregateVersion: 3 + row.planVersion, type: 'home.restart_step_closed.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), dossier_id: id, ...facts }, eventKey: `project_halt:${id}:step:${stepId}` });
    return commandResult(scope, draft.status, 3 + row.planVersion, id);
  }

  @Post('home/halted-projects/:id/closure')
  @HttpCode(200)
  @OperationId('closeProjectHalt')
  @Command({ operation: 'closeProjectHalt' })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CloseProjectHalt']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const row = await this.store.findDossier(scope.tx, projectScope(access, HOME_READ_PERMISSION, now), id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const draft = checkHaltClose(body, today, row.haltedOn);
    if (!haltCan(row.status, draft.outcome)) throw new DomainError('PROJECT_HALT_STATE', 409, 'outcome');
    if (draft.outcome === 'RESTARTED') {
      const steps = await this.store.steps(scope.tx, id, row.planVersion);
      if (!allStepsClosed(steps)) throw new DomainError('PROJECT_HALT_STEPS_OPEN', 409, 'outcome');
    }
    await this.store.closeDossier(scope.tx, id, draft.outcome, scope.tenant.membershipId, draft.note, draft.restartedOn);
    const facts = { project_id: row.projectId, outcome: draft.outcome, restarted_on: draft.restartedOn };
    const type = draft.outcome === 'RESTARTED' ? 'home.project_restarted.v1' : 'home.project_halt_cancelled.v1';
    await scope.audit({ action: draft.outcome === 'RESTARTED' ? 'home.project_restarted' : 'home.project_halt_cancelled', resourceType: HALT_RESOURCE, resourceId: id, reason: draft.note, diff: facts });
    await scope.emit({ aggregateType: HALT_RESOURCE, aggregateId: id, aggregateVersion: 100, type, schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), dossier_id: id, ...facts }, eventKey: `project_halt:${id}:${draft.outcome}` });
    return commandResult(scope, draft.outcome, 100, id);
  }
}
