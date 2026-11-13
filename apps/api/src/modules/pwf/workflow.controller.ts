import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjProjectStore, PwfAssignmentReads, PwfWorkflowReads, PwfWorkflowStore, TenantDatabase, approvedFormRevision, projectInScope, projectScope } from '@machvon/db';
import type { AdoptOutcome, LegalDocumentView, PwfSelectionRecord, TenantTx } from '@machvon/db';
import { DomainError, legalDocument, pwfQuality, pwfSchedule, pwfWorkflow, validateRuleParams, vietnamDateOf } from '@machvon/kernel';
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
import { reaches } from '../prj/reach';
import { WORKFLOW_RESOURCE, announce, canOf, idOf, queryText, scopesOf } from './pwf-support';

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

/** What the tenant can answer for about the references of a template (R45, R46): the catalogue of legal documents as it is today, and the pinned revisions of forms that are approved. */
export interface TemplateReferenceFacts {
  documents: ReadonlyMap<string, LegalDocumentView>;
  formRevisions: ReadonlySet<string>;
}

/** Reads what a template refers to from the tenant: the catalogue of legal documents, and each pinned revision of a form. */
export async function referenceFactsOf(tx: TenantTx, params: unknown, now: Date): Promise<TemplateReferenceFacts> {
  const documents = await new PwfAssignmentReads().legalDocuments(tx, vietnamDateOf(now));
  const formRevisions = new Set<string>();
  const tasks = typeof params === 'object' && params !== null && Array.isArray((params as { tasks?: unknown }).tasks) ? ((params as { tasks: unknown[] }).tasks as unknown[]) : [];
  for (const raw of tasks) {
    const policies = typeof raw === 'object' && raw !== null && Array.isArray((raw as { form_policies?: unknown }).form_policies) ? (raw as { form_policies: unknown[] }).form_policies : [];
    for (const entry of policies) {
      const policy = entry as { form?: unknown; revision?: unknown };
      if (typeof policy.form !== 'string' || typeof policy.revision !== 'number' || !Number.isInteger(policy.revision) || policy.revision < 1) continue;
      if ((await approvedFormRevision(tx, policy.form, policy.revision)) !== undefined) formRevisions.add(`${policy.form}#${policy.revision}`);
    }
  }
  return { documents, formRevisions };
}

/**
 * The checks of a template that the person who writes it sees live (F1): the schema and the graph (the first defect), the references to document types and evidence kinds, and the quality flags that never block. With the facts of the
 * tenant (R45, R46) a legal ground that cites a document the catalogue does not have and a form pinned to a revision that is not approved are errors, and a ground whose document lapsed is a warning that never blocks.
 */
export function validateTemplate(params: unknown, now: Date, facts?: TemplateReferenceFacts): Schemas['PwfTemplateValidation'] {
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
    const references: pwfWorkflow.TemplateReferences = facts === undefined ? {} : { legalDocument: (code) => facts.documents.has(code), formRevision: (form, revision) => facts.formRevisions.has(`${form}#${revision}`) };
    for (const one of pwfWorkflow.checkTemplateReferences(template, references)) findings.push({ code: one.code, path: one.field, severity: 'ERROR' });
    if (facts !== undefined) {
      const lapsed = (basis: readonly pwfWorkflow.TemplateLegalBasis[], at: string): void =>
        basis.forEach((one, position) => {
          const document = facts.documents.get(one.document);
          if (document !== undefined && legalDocument.isLapsed(document.state)) findings.push({ code: 'LEGAL_BASIS_LAPSED', path: `${at}.legal_basis[${position}].document`, severity: 'WARNING', detail: document.supersededBy ?? document.state });
        });
      (template.steps ?? []).forEach((step, index) => lapsed(step.legalBasis, `steps[${index}]`));
      template.tasks.forEach((one, index) => lapsed(one.legalBasis ?? [], `tasks[${index}]`));
    }
  }
  const flags = template === undefined ? [] : pwfQuality.templateQualityFlags(template);
  return {
    valid: findings.every((one) => one.severity !== 'ERROR'),
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
  @Command({ operation: 'validateProjectWorkflowTemplate' })
  async validate(@Scope() scope: CommandScope, @Body() body: Schemas['PwfTemplateParams']): Promise<Schemas['PwfTemplateValidation']> {
    const now = new Date();
    const checked = validateTemplate(body, now, await referenceFactsOf(scope.tx, body, now));
    await this.record(scope, 'workflow.template_validated', checked);
    return checked;
  }

  /** What a check of a template leaves: who checked which template (by its hash) and what came of it; the template itself is not copied. */
  private async record(scope: CommandScope, action: string, checked: Schemas['PwfTemplateValidation']): Promise<void> {
    await scope.audit({ action, resourceType: 'project_workflow_template', resourceId: scope.requestId, classification: 'INTERNAL', diff: { template_hash: checked.template_hash, valid: checked.valid, task_count: checked.task_count, findings: checked.findings.length } });
  }

  @Post('project-workflow/templates/preview')
  @HttpCode(200)
  @OperationId('previewProjectWorkflowTemplate')
  @Command({ operation: 'previewProjectWorkflowTemplate' })
  async preview(@Scope() scope: CommandScope, @Body() body: Schemas['PwfTemplatePreviewRequest']): Promise<Schemas['PwfSchedulePreview']> {
    const now = new Date();
    const checked = validateTemplate(body.params, now, await referenceFactsOf(scope.tx, body.params, now));
    await this.record(scope, 'workflow.template_previewed', checked);
    const failure = checked.findings.find((one) => one.severity === 'ERROR');
    if (failure !== undefined) throw new DomainError(failure.code === 'PWF_DEPENDENCY_CYCLE' ? 'PWF_DEPENDENCY_CYCLE' : 'PROJECT_WORKFLOW_TEMPLATE_INVALID', 422, failure.path);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(body.params);
    const facts = factsOf(body.facts);
    const planned = await this.workflows.previewTemplate(scope.tx, template, body.planned_start_date, facts);
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
      selectionReason: body.selection_reason,
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.startProjectWorkflow, now),
      now,
    });
    await announceStarted(scope, done, now);
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
      selectionReason: body.selection_reason,
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
        { resource: WORKFLOW_RESOURCE, id: outcome.workflow.id, version: outcome.workflow.version, action: 'workflow.adopted', type: 'pwf.workflow.adopted.v1', fromStatus: null, status: outcome.workflow.status, facts: { project_id: outcome.workflow.projectId, template_code: outcome.templateCode, template_hash: outcome.templateHash, schedule_version: outcome.workflow.scheduleVersion, effective_date: outcome.effectiveDate, ...selectionFacts(outcome.selection) } },
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
    selection: outcome.selection,
    as_of: now.toISOString(),
  };
}

/** What the audit row and the event say of how the template was chosen (R47): codes, the version of the rule and the mode, never the words of the reason (the reason is the reason of the audit row). */
export const selectionFacts = (selection: PwfSelectionRecord): Record<string, unknown> => ({
  selection_mode: selection.mode,
  suggested_template_code: selection.suggested_template_code,
  selection_basis: selection.basis,
  selection_line: selection.line,
  assignment_rule_version: selection.rule_version,
});

/** The audit row and the event of a workflow that started, whoever started it (PWF-05, or the registration of a project). */
export async function announceStarted(scope: CommandScope, done: Awaited<ReturnType<PwfWorkflowStore['start']>>, now: Date): Promise<void> {
  await announce(
    scope,
    {
      resource: WORKFLOW_RESOURCE,
      id: done.id,
      version: done.version,
      action: 'workflow.started',
      type: 'pwf.workflow.started.v1',
      fromStatus: null,
      status: done.status,
      facts: { project_id: done.projectId, template_code: done.templateCode, template_hash: done.templateHash, schedule_version: done.scheduleVersion, ...selectionFacts(done.selection) },
      ...(done.selection.reason === null ? {} : { reason: done.selection.reason }),
    },
    now,
  );
}

/** The reads of the workflow of a project: the workflow, its tasks, the schedule, a gate (PWF-03, PWF-06): the scope of `pwf.read`, the official colour only. */
@Controller()
export class ProjectWorkflowReadsController {
  private readonly reads = new PwfWorkflowReads();
  private readonly assignment = new PwfAssignmentReads();
  private readonly workflows = new PwfWorkflowStore();
  private readonly projects = new PrjProjectStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  /**
   * Which kind of workflow the rule suggests (R47) for a project that exists (`project_id`, PWF-05) or for one that is being registered (the unit, the type and the facts the form holds, PRJ-02), the templates the tenant has, and
   * the schedule the chosen (or suggested) template gives from the planned start: the total of working days, the steps and what stops the schedule from being told (a fact a branch needs, a year without a calendar). It writes nothing.
   */
  @Get('project-workflow/suggestion')
  @OperationId('suggestProjectWorkflow')
  async suggestion(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfWorkflowSuggestion']> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const text = (name: string): string | undefined => queryText(query[name], name);
    const projectId = query.project_id === undefined ? undefined : idOf(query.project_id, 'project_id');
    const typeVersion = query.project_type_master_version_id === undefined ? undefined : idOf(query.project_type_master_version_id, 'project_type_master_version_id');
    const plannedStart = text('planned_start_date');
    const chosen = text('template_code');
    return this.database.withTenant(tenant, async (tx) => {
      const facts: Record<string, string | undefined> = {};
      let unitId: string | null = query.owner_unit_id === undefined ? null : idOf(query.owner_unit_id, 'owner_unit_id');
      let canStart = false;
      if (projectId !== undefined) {
        // A project out of the scope of `pwf.read` does not exist for the caller.
        if (!(await projectInScope(tx, projectId, projectScope(access, READ, now)))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        const own = await this.assignment.projectFacts(tx, projectId);
        Object.assign(facts, own.facts);
        unitId = own.ownerUnitId;
        canStart = await projectInScope(tx, projectId, projectScope(access, PERMISSIONS.startProjectWorkflow, now));
      } else if (unitId !== null) {
        const unit = await this.projects.unitRef(tx, unitId);
        if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'owner_unit_id');
        canStart = reaches(access, PERMISSIONS.startProjectWorkflow, unit, now);
      }
      if (typeVersion !== undefined) {
        const rows = await tx.query<{ business_key: string }>('select r.business_key from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.id = $1::uuid', [typeVersion]);
        if (rows[0] !== undefined && /^[A-Za-z0-9_.-]{1,40}$/.test(rows[0].business_key)) facts.project_type = rows[0].business_key;
      }
      for (const field of pwfWorkflow.CONDITION_FIELDS) {
        const said = text(field);
        if (said !== undefined) facts[field] = said;
      }
      const view = await this.assignment.suggest(tx, { facts, unitId, asOf: today });
      const code = chosen ?? view.suggestion.templateCode;
      let preview: Schemas['PwfWorkflowSuggestion']['preview'] = null;
      if (code !== null && plannedStart !== undefined) {
        const resolved = await this.workflows.resolveTemplate(tx, code, undefined, today);
        const template = resolved.template;
        const steps = pwfWorkflow.stepsOf(template);
        const needed = [...new Set(template.tasks.flatMap((one) => one.when.map((condition) => condition.field)))].sort();
        const missing = needed.filter((field) => view.facts[field] === undefined);
        const base = { template_code: resolved.code, template_version: resolved.version, template_hash: resolved.hash, planned_start_date: plannedStart, phase_count: template.phases.length };
        if (missing.length > 0) {
          // A fact a branch reads is not known: the schedule is not guessed, the template is still described.
          preview = { ...base, project_start: null, project_finish: null, total_working_days: null, standard_working_days: null, step_count: steps.length, task_count: template.tasks.length, excluded_tasks: [], missing_facts: missing, findings: [], steps: steps.map((step) => ({ code: step.code, name: step.name, phase_code: step.phase, order: step.order, implicit: step.implicit, start: null, finish: null, duration_working_days: 0, task_count: 0 })) };
        } else {
          const planned = await this.workflows.previewTemplate(tx, template, plannedStart, view.facts);
          const scheduled = planned.result.tasks.map((one) => ({ code: one.code, start: one.start, finish: one.finish, startSlot: one.startSlot, endSlot: one.endSlot, passThrough: one.state === 'PASS_THROUGH' }));
          const live = scheduled.filter((one) => !one.passThrough);
          const spans = new Map(pwfWorkflow.stepSpans(template, scheduled).map((one) => [`${one.phase}/${one.step}`, one] as const));
          const complete = planned.result.projectFinish !== null && live.length > 0;
          preview = {
            ...base,
            project_start: planned.result.projectStart,
            project_finish: planned.result.projectFinish,
            total_working_days: complete ? Math.max(...live.map((one) => one.endSlot)) - Math.min(...live.map((one) => one.startSlot)) : null,
            standard_working_days: pwfSchedule.standardTimes(template, view.facts).totalWorkingDays,
            step_count: [...spans.values()].filter((one) => one.taskCount > 0).length,
            task_count: live.length,
            excluded_tasks: planned.excluded,
            missing_facts: [],
            findings: planned.result.findings.map((one) => ({ code: one.code, task: one.task, ...(one.year === undefined ? {} : { year: one.year }) })),
            steps: steps.map((step) => {
              const span = spans.get(`${step.phase}/${step.code}`);
              return { code: step.code, name: step.name, phase_code: step.phase, order: step.order, implicit: step.implicit, start: span?.start ?? null, finish: span?.finish ?? null, duration_working_days: span?.durationWorkingDays ?? 0, task_count: span?.taskCount ?? 0 };
            }),
          };
        }
      }
      return {
        suggested_template_code: view.suggestion.templateCode,
        basis: view.suggestion.basis,
        line: view.suggestion.line,
        rule: { rule_id: view.rule.ruleId, version: view.rule.version, unit_id: view.rule.unitId, unverified: view.rule.unverified },
        candidates: view.suggestion.candidates.map((one) => ({ template_code: one.templateCode, basis: one.basis, line: one.line })),
        unknown_templates: view.suggestion.unknownTemplates,
        templates: view.templates.map((one) => ({ code: one.code, name: one.name, project_type: one.projectType, version: one.version, unverified: one.unverified, phase_count: one.phaseCount, step_count: one.stepCount, task_count: one.taskCount, fact_fields: one.factFields as Array<'project_group' | 'funding_source' | 'project_type'> })),
        facts: view.facts,
        preview,
        can_start: canStart,
        as_of: now.toISOString(),
      };
    });
  }

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

