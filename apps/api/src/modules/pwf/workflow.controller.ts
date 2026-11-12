import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfWorkflowReads, PwfWorkflowStore, TenantDatabase, projectScope } from '@machvon/db';
import type { AdoptOutcome } from '@machvon/db';
import { DomainError, pwfQuality, pwfWorkflow, validateRuleParams } from '@machvon/kernel';
import type { pwfSchedule } from '@machvon/kernel';
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
import { WORKFLOW_RESOURCE, announce, canOf, queryText, scopesOf } from './pwf-support';

const READ = PERMISSIONS.getProjectWorkflow;

type Facts = Schemas['PwfWorkflowStart']['facts'];

/** The facts of a request as the plain record the store takes (only the three fields of the contract). */
const factsOf = (facts: Facts): Record<string, string> => Object.fromEntries(Object.entries(facts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** The schedule of a computation as the contract says it (PwfSchedulePreview): the days, floats, critical path and findings of each task, with its name and phase. */
export function schedulePreviewOf(
  result: pwfSchedule.ScheduleResult,
  context: { names: Record<string, string>; phases: Record<string, string>; ids?: Record<string, string>; plannedStart: string; excluded: readonly string[]; now: Date },
): Schemas['PwfSchedulePreview'] {
  return {
    planned_start_date: context.plannedStart,
    project_start: result.projectStart,
    project_finish: result.projectFinish,
    critical_path: result.criticalPath,
    longest_path: result.longestPath,
    calendar_versions: result.calendarVersions,
    tasks: result.tasks.map((task) => ({
      task_id: context.ids?.[task.code] ?? null,
      task_code: task.code,
      name: context.names[task.code] ?? task.code,
      phase_code: context.phases[task.code] ?? '',
      kind: task.kind,
      state: task.state,
      start: task.start,
      finish: task.finish,
      late_start: task.lateStart,
      late_finish: task.lateFinish,
      total_float: task.totalFloat,
      free_float: task.freeFloat,
      critical: task.critical,
      driving_predecessor: task.drivingPredecessor,
      missing_year: task.missingYear,
      start_variance_days: task.startVarianceDays,
      finish_variance_days: task.finishVarianceDays,
      findings: task.findings.map((one) => ({ code: one.code, task: one.task, ...(one.year === undefined ? {} : { year: one.year }) })),
    })),
    excluded_tasks: [...context.excluded],
    findings: result.findings.map((one) => ({ code: one.code, task: one.task, ...(one.year === undefined ? {} : { year: one.year }) })),
    result_hash: result.hash,
    as_of: context.now.toISOString(),
  };
}

const namesOf = (template: pwfWorkflow.ProjectWorkflowTemplate): { names: Record<string, string>; phases: Record<string, string> } => ({
  names: Object.fromEntries(template.tasks.map((one) => [one.code, one.name])),
  phases: Object.fromEntries(template.tasks.map((one) => [one.code, one.phase])),
});

/** The checks of a template that the person who writes it sees live (F1): the schema and the graph (the first defect), the references to document types and evidence kinds, and the quality flags that never block. */
export function validateTemplate(params: unknown, now: Date): Schemas['PwfTemplateValidation'] {
  const findings: Schemas['PwfTemplateValidation']['findings'] = [];
  let template: pwfWorkflow.ProjectWorkflowTemplate | undefined;
  try {
    validateRuleParams(pwfWorkflow.PROJECT_WORKFLOW_RULE_TYPE, params);
    template = pwfWorkflow.parseProjectWorkflowTemplate(params);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    findings.push({ code: error.code, path: error.detail ?? '', severity: 'ERROR' });
  }
  if (template !== undefined) {
    for (const one of pwfWorkflow.checkTemplateReferences(template, {})) findings.push({ code: one.code, path: one.field, severity: 'ERROR' });
  }
  const flags = template === undefined ? [] : pwfQuality.templateQualityFlags(template);
  return {
    valid: findings.length === 0,
    findings,
    quality_flags: flags.map((flag) => ({ code: flag.code, task: flag.task, detail: flag.detail })),
    task_count: template?.tasks.length ?? 0,
    phase_count: template?.phases.length ?? 0,
    longest_chain: template === undefined ? 0 : pwfWorkflow.dependencyDepth(template.tasks.map((one) => ({ code: one.code, predecessors: one.predecessors }))),
    template_hash: template === undefined ? null : pwfWorkflow.templateHash(template),
    as_of: now.toISOString(),
  };
}

/** The templates of the workflow and the check of a project's schedule, then starting and adopting the workflow of a project (F1, F2, F3). */
@Controller()
export class ProjectWorkflowController {
  private readonly workflows = new PwfWorkflowStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('project-workflow/templates/validate')
  @HttpCode(200)
  @OperationId('validateProjectWorkflowTemplate')
  validate(@Body() body: Schemas['PwfTemplateParams']): Schemas['PwfTemplateValidation'] {
    return validateTemplate(body, new Date());
  }

  @Post('project-workflow/templates/preview')
  @HttpCode(200)
  @OperationId('previewProjectWorkflowTemplate')
  async preview(@CurrentTenant() tenant: TenantContext, @Body() body: Schemas['PwfTemplatePreviewRequest']): Promise<Schemas['PwfSchedulePreview']> {
    const now = new Date();
    const checked = validateTemplate(body.params, now);
    const failure = checked.findings[0];
    if (failure !== undefined) throw new DomainError(failure.code === 'PWF_DEPENDENCY_CYCLE' ? 'PWF_DEPENDENCY_CYCLE' : 'PROJECT_WORKFLOW_TEMPLATE_INVALID', 422, failure.path);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(body.params);
    const facts = factsOf(body.facts);
    const planned = await this.database.withTenant(tenant, (tx) => this.workflows.previewTemplate(tx, template, body.planned_start_date, facts));
    return schedulePreviewOf(planned.result, { ...namesOf(template), plannedStart: body.planned_start_date, excluded: planned.excluded, now });
  }

  @Post('projects/:project_id/workflow')
  @HttpCode(200)
  @OperationId('startProjectWorkflow')
  @Command({ operation: 'startProjectWorkflow' })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Body() body: Schemas['PwfWorkflowStart']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.workflows.start(scope.tx, {
      projectId: projectId.toLowerCase(),
      templateCode: body.template_code,
      templateVersion: body.template_version,
      plannedStartDate: body.planned_start_date,
      facts: factsOf(body.facts),
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.startProjectWorkflow, now),
      now,
    });
    await announce(
      scope,
      { resource: WORKFLOW_RESOURCE, id: done.id, version: done.version, action: 'workflow.started', type: 'pwf.workflow.started.v1', fromStatus: null, status: done.status, facts: { project_id: done.projectId, template_code: done.templateCode, template_hash: done.templateHash, schedule_version: done.scheduleVersion } },
      now,
    );
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('projects/:project_id/workflow/adopt')
  @HttpCode(200)
  @OperationId('adoptProjectWorkflow')
  @Command({ operation: 'adoptProjectWorkflow' })
  async adopt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Body() body: Schemas['PwfWorkflowAdopt']): Promise<Schemas['PwfAdoptResult']> {
    const now = new Date();
    const outcome = await this.workflows.adopt(scope.tx, {
      projectId: projectId.toLowerCase(),
      templateCode: body.template_code,
      templateVersion: body.template_version,
      plannedStartDate: body.planned_start_date,
      effectiveDate: body.effective_date,
      dryRun: body.dry_run,
      facts: factsOf(body.facts),
      pastTasks: (body.past_tasks ?? []).map((one) => ({
        taskCode: one.task_code,
        treatment: one.treatment,
        actualStart: one.actual_start,
        actualFinish: one.actual_finish,
        evidence: (one.evidence ?? []).map((item) => ({ evidenceKind: item.evidence_kind, legalDocType: item.legal_doc_type, documentId: item.document_id, formTemplateCode: item.form_template_code, externalRef: item.external_ref, note: item.note })),
      })),
      inProgressTasks: (body.in_progress_tasks ?? []).map((one) => ({ taskCode: one.task_code, actualStart: one.actual_start, remainingWorkingDays: one.remaining_working_days, percentComplete: one.percent_complete })),
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.adoptProjectWorkflow, now),
      now,
    });
    if (outcome.workflow !== null) {
      await announce(
        scope,
        { resource: WORKFLOW_RESOURCE, id: outcome.workflow.id, version: outcome.workflow.version, action: 'workflow.adopted', type: 'pwf.workflow.adopted.v1', fromStatus: null, status: outcome.workflow.status, facts: { project_id: outcome.workflow.projectId, template_code: outcome.templateCode, template_hash: outcome.templateHash, schedule_version: outcome.workflow.scheduleVersion, effective_date: outcome.effectiveDate } },
        now,
      );
    }
    return adoptView(outcome, now);
  }
}

function adoptView(outcome: AdoptOutcome, now: Date): Schemas['PwfAdoptResult'] {
  const names = Object.fromEntries(outcome.tasks.map((one) => [one.taskCode, one.name]));
  return {
    dry_run: outcome.dryRun,
    applied: outcome.applied,
    workflow_id: outcome.workflow?.id ?? null,
    template_code: outcome.templateCode,
    template_hash: outcome.templateHash,
    effective_date: outcome.effectiveDate,
    tasks: outcome.tasks.map((one) => ({ task_code: one.taskCode, name: one.name, treatment: one.treatment, planned_start: one.plannedStart, planned_finish: one.plannedFinish, needs_decision: one.needsDecision })),
    schedule: schedulePreviewOf(outcome.schedule, { names, phases: {}, plannedStart: outcome.workflow?.plannedStartDate ?? outcome.effectiveDate, excluded: outcome.excluded, now }),
    findings: outcome.findings,
    as_of: now.toISOString(),
  };
}

/** The reads of the workflow of a project: the workflow, its tasks, the schedule, a gate (PWF-03, PWF-06): the scope of `pwf.read`, the official colour only. */
@Controller()
export class ProjectWorkflowReadsController {
  private readonly reads = new PwfWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:project_id/workflow')
  @OperationId('getProjectWorkflow')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string): Promise<Schemas['PwfWorkflowDetail']> {
    const now = new Date();
    const id = projectId.toLowerCase();
    return this.database.withTenant(tenant, async (tx) => this.reads.detail(tx, projectScope(access, READ, now), id, now, await canOf(tx, access, id, now))) as Promise<Schemas['PwfWorkflowDetail']>;
  }

  @Get('projects/:project_id/workflow/tasks')
  @OperationId('listProjectTasks')
  async tasks(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Query() query: Record<string, unknown>): Promise<Schemas['PwfTaskPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.reads.listTasks(
        tx,
        projectScope(access, READ, now),
        projectId.toLowerCase(),
        { phase: queryText(query.phase, 'phase'), band: queryText(query.band, 'band'), status: queryText(query.status, 'status'), assigneeId: queryText(query.assignee_id, 'assignee_id') },
        { limit: page.limit, after: page.after },
        now,
      ),
    );
    return { items: found.items as unknown as Schemas['PwfTaskPage']['items'], next_cursor: found.next === null ? null : encodeCursor(found.next), total: found.total, as_of: found.asOf };
  }

  @Get('projects/:project_id/workflow/schedule')
  @OperationId('getProjectSchedule')
  async schedule(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string): Promise<Schemas['PwfSchedule']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) => this.reads.schedule(tx, projectScope(access, READ, now), projectId.toLowerCase())) as Promise<Schemas['PwfSchedule']>;
  }

  @Get('projects/:project_id/workflow/gates/:target')
  @OperationId('evaluateProjectGate')
  async gate(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Param('target') target: string): Promise<Schemas['PwfGateAssessment']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) => this.reads.evaluateGate(tx, projectScope(access, READ, now), projectId.toLowerCase(), target, now)) as Promise<Schemas['PwfGateAssessment']>;
  }
}

