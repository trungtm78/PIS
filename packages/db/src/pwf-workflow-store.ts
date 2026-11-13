import { randomUUID } from 'node:crypto';
import { DomainError, pwfSchedule, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import type { ResolvedGovernanceRule } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { PrjBaselineStore } from './prj-baseline-store.ts';
import { TERMINAL_STAGES } from './prj-stage-machine.ts';
import { dateOf, lockProject } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import { PwfAssignmentReads, selectionRecordOf } from './pwf-assignment.ts';
import type { SelectionRecord, SuggestionView } from './pwf-assignment.ts';
import { resolveFormRevision } from './pwf-form-revision.ts';
import { DEFAULT_ASSIGNMENT_REASON, earliestYear, inputHashOf, pinPublishedCalendars } from './pwf-schedule-support.ts';
import type { PinnedCalendar } from './pwf-schedule-support.ts';
import { logWorkflow, publishSchedule } from './pwf-publish.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Starting and adopting the workflow of a project (PWF-1, docs PWF 3 F2 and F3, BR-PWF-01, 02, 10, 16, 17, R36): the approved template of the kind of project is read through the governance port (the rule in force, or the
 * built-in default), FROZEN into the row with its version and hash, the tasks, their links and checklists are made from it, the schedule is laid on the calendars pinned by version and published as version 1 with the first
 * baseline, and the milestones of the template become milestones of the project. A running project is taken in by the same path with an effective date: what ended before it is `NOT_TRACKED` or done with evidence, what is under
 * way keeps its real start and remaining days; a dry run answers all of it and writes nothing.
 */

const FACT_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export type Treatment = 'TRACKED' | 'NOT_TRACKED' | 'DONE' | 'IN_PROGRESS' | 'EXCLUDED';

export interface EvidenceDraft {
  evidenceKind: string;
  legalDocType?: string | undefined;
  documentId?: string | undefined;
  formTemplateCode?: string | undefined;
  externalRef?: string | undefined;
  note?: string | undefined;
}

export interface StartRequest {
  projectId: string;
  /** The template the person chose; left out, the rule `PROJECT_WORKFLOW_ASSIGNMENT` chooses (R47). */
  templateCode?: string | undefined;
  templateVersion?: number | undefined;
  plannedStartDate: string;
  facts?: Record<string, string> | undefined;
  /** Why the person chose another template than the rule suggests. */
  selectionReason?: string | undefined;
  /** Whether choosing against the rule needs a reason (the registration of a project asks for one; the older commands record one when it is given). */
  reasonRequired?: boolean | undefined;
  /** Facts the caller already knows of the project and the row does not say yet (the group the register suggests for a project that is being created). */
  knownFacts?: Record<string, string> | undefined;
  actor: string;
  scopes: StageScopes;
  now: Date;
}

export interface AdoptRequest extends StartRequest {
  effectiveDate: string;
  dryRun: boolean;
  pastTasks?: ReadonlyArray<{ taskCode: string; treatment: 'NOT_TRACKED' | 'DONE'; actualStart?: string | null | undefined; actualFinish?: string | null | undefined; evidence?: readonly EvidenceDraft[] | undefined }> | undefined;
  inProgressTasks?: ReadonlyArray<{ taskCode: string; actualStart: string; remainingWorkingDays: number; percentComplete?: number | undefined }> | undefined;
}

export interface WorkflowResult {
  id: string;
  projectId: string;
  projectCode: string;
  templateCode: string;
  templateHash: string;
  templateRuleVersion: number;
  status: string;
  version: number;
  scheduleVersion: number;
  plannedStartDate: string;
  taskCount: number;
  facts: Record<string, unknown>;
  selection: SelectionRecord;
}

export interface AdoptTaskView {
  taskCode: string;
  name: string;
  treatment: Treatment;
  plannedStart: string | null;
  plannedFinish: string | null;
  needsDecision: boolean;
}

export interface AdoptOutcome {
  dryRun: boolean;
  applied: boolean;
  workflow: WorkflowResult | null;
  templateCode: string;
  templateHash: string;
  effectiveDate: string;
  tasks: AdoptTaskView[];
  schedule: pwfSchedule.ScheduleResult;
  calendars: readonly PinnedCalendar[];
  excluded: string[];
  findings: Array<{ code: string; task: string | null }>;
  selection: SelectionRecord;
}

export interface ResolvedTemplate {
  code: string;
  ruleId: string | null;
  version: number;
  template: pwfWorkflow.ProjectWorkflowTemplate;
  hash: string;
  unverified: boolean;
}

interface Plan {
  resolved: ResolvedTemplate;
  facts: pwfWorkflow.ProjectFacts;
  tasks: pwfSchedule.ScheduleTask[];
  excluded: string[];
  calendars: PinnedCalendar[];
  result: pwfSchedule.ScheduleResult;
  inputHash: string;
  statusDate: string | null;
  selection: SelectionRecord;
}

const checkedDay = (value: string, field: string): string => dateOf(value, field);

/** The facts of the branches as the request gives them and the project knows them; a field a branch reads that is still unknown is 422 `PWF_FACTS_REQUIRED` (never a guess). */
export function factsOf(template: pwfWorkflow.ProjectWorkflowTemplate, project: Pick<LockedProject, 'projectGroup'>, given: Record<string, string> | undefined, known: Record<string, string> = {}): pwfWorkflow.ProjectFacts {
  const facts: Record<string, string> = {};
  // What the project is known by (its type in the master data, the group the register suggests) comes first, the group the project was decided to be next, and what the person says last.
  for (const [field, value] of Object.entries(known)) if ((pwfWorkflow.CONDITION_FIELDS as readonly string[]).includes(field) && FACT_VALUE.test(value)) facts[field] = value;
  if (project.projectGroup !== null) facts.project_group = project.projectGroup;
  for (const [field, value] of Object.entries(given ?? {})) {
    if (!(pwfWorkflow.CONDITION_FIELDS as readonly string[]).includes(field) || !FACT_VALUE.test(value)) throw invalid(`facts.${field}`);
    facts[field] = value;
  }
  const needed = new Set(template.tasks.flatMap((one) => one.when.map((condition) => condition.field)));
  const missing = [...needed].filter((field) => facts[field] === undefined).sort();
  if (missing.length > 0) throw new DomainError('PWF_FACTS_REQUIRED', 422, 'facts', { extensions: { fields: missing } });
  return facts;
}

export class PwfWorkflowStore {
  private readonly policy: GovernancePolicyPort;
  private readonly baseline: PrjBaselineStore;
  private readonly assignment: PwfAssignmentReads;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort(), baseline: PrjBaselineStore = new PrjBaselineStore()) {
    this.policy = policy;
    this.baseline = baseline;
    this.assignment = new PwfAssignmentReads(policy);
  }

  /**
   * The template of a request (R47): what the rule `PROJECT_WORKFLOW_ASSIGNMENT` suggests for the project (its type in the master data, its group, the facts the person gives, the rule of the nearest unit), what the person chose
   * and how. With no template chosen and none suggested: 422 `PWF_TEMPLATE_NOT_ASSIGNED` (never a guess).
   */
  private async select(tx: TenantTx, project: LockedProject, request: StartRequest, today: string): Promise<{ selection: SelectionRecord; known: Record<string, string>; view: SuggestionView }> {
    const own = await this.assignment.projectFacts(tx, project.id);
    const known = { ...own.facts, ...(request.knownFacts ?? {}) };
    // A fact that is not one is refused where it always was (`factsOf`, after the template is found): the suggestion reads only what can be a fact.
    const said = Object.fromEntries(Object.entries(request.facts ?? {}).filter(([field, value]) => (pwfWorkflow.CONDITION_FIELDS as readonly string[]).includes(field) && FACT_VALUE.test(value)));
    const view = await this.assignment.suggest(tx, { facts: { ...known, ...(project.projectGroup === null ? {} : { project_group: project.projectGroup }), ...said }, unitId: own.ownerUnitId, asOf: today });
    return { selection: selectionRecordOf(view, request.templateCode, request.selectionReason, request.reasonRequired === true), known, view };
  }

  /** The template of a code: the version asked for (approved), else the rule in force on the day, else the built-in default; 404 `PWF_TEMPLATE_NOT_FOUND` when there is none. */
  async resolveTemplate(tx: TenantTx, code: string, version: number | undefined, asOf: string): Promise<ResolvedTemplate> {
    let resolved: Pick<ResolvedGovernanceRule, 'ruleId' | 'version' | 'params' | 'unverified'> | undefined;
    if (version !== undefined) {
      const rows = await tx.query<{ id: string; version: number; params: Record<string, unknown> }>(
        `select id, version, params from machvon.governance_rule where rule_type = $1 and code = $2 and version = $3::int and unit_id is null and approved_at is not null and status in ('APPROVED', 'RETIRED')`,
        [pwfWorkflow.PROJECT_WORKFLOW_RULE_TYPE, code, version],
      );
      const row = rows[0];
      resolved = row === undefined ? undefined : { ruleId: row.id, version: row.version, params: row.params, unverified: false };
    } else {
      resolved = await this.policy.get(tx, pwfWorkflow.PROJECT_WORKFLOW_RULE_TYPE, code, asOf);
    }
    if (resolved === undefined) throw new DomainError('PWF_TEMPLATE_NOT_FOUND', 404, 'template_code');
    const template = pwfWorkflow.parseProjectWorkflowTemplate(resolved.params);
    return { code, ruleId: resolved.ruleId, version: resolved.version, template, hash: pwfWorkflow.templateHash(template), unverified: resolved.unverified };
  }

  /** The schedule a template gives a project that starts on a day with these facts, on the calendars as published now: for the screen that previews a template and for the commands below. */
  async previewTemplate(tx: TenantTx, template: pwfWorkflow.ProjectWorkflowTemplate, plannedStart: string, facts: pwfWorkflow.ProjectFacts): Promise<{ result: pwfSchedule.ScheduleResult; calendars: PinnedCalendar[]; excluded: string[] }> {
    const day = checkedDay(plannedStart, 'planned_start_date');
    const calendars = await pinPublishedCalendars(tx, Number(day.slice(0, 4)));
    const tasks = pwfSchedule.tasksFromTemplate(template, facts);
    return { result: pwfSchedule.scheduleProject({ tasks, plannedStart: day, calendars }), calendars, excluded: pwfWorkflow.activeTasks(template, facts).excluded };
  }

  /** Starts the workflow of a project that has none (F2). 404 outside the scope, 409 `PWF_WORKFLOW_EXISTS`, 404 `PWF_TEMPLATE_NOT_FOUND`, 422 `PWF_FACTS_REQUIRED`. */
  async start(tx: TenantTx, request: StartRequest): Promise<WorkflowResult> {
    const project = await this.lockFreeProject(tx, request);
    const today = vietnamDateOf(request.now);
    const { selection, known } = await this.select(tx, project, request, today);
    const resolved = await this.resolveTemplate(tx, selection.chosen_template_code, request.templateVersion, today);
    const facts = factsOf(resolved.template, project, request.facts, known);
    const plan = await this.plan(tx, resolved, facts, checkedDay(request.plannedStartDate, 'planned_start_date'), {}, null, selection);
    return this.write(tx, project, request, plan, { progress: {} }, 'INITIAL', today);
  }

  /** Takes in a project that is already running (F3, R36); with `dryRun` nothing is written. */
  async adopt(tx: TenantTx, request: AdoptRequest): Promise<AdoptOutcome> {
    const project = await this.lockFreeProject(tx, request);
    const today = vietnamDateOf(request.now);
    const effectiveDate = checkedDay(request.effectiveDate, 'effective_date');
    const plannedStart = checkedDay(request.plannedStartDate, 'planned_start_date');
    const { selection, known } = await this.select(tx, project, request, today);
    const resolved = await this.resolveTemplate(tx, selection.chosen_template_code, request.templateVersion, today);
    const facts = factsOf(resolved.template, project, request.facts, known);
    // What would have ended before the effective date if the project had run to plan: those tasks need a decision (BR-PWF-17), and a task taken in as past without its real dates ends where the plan put it.
    const planned = await this.previewTemplate(tx, resolved.template, plannedStart, facts);
    const decisions = this.decisionsOf(resolved.template, facts, request, new Map(planned.result.tasks.map((one) => [one.code, { start: one.start, finish: one.finish }] as const)));
    const past = new Set(planned.result.tasks.filter((one) => one.state !== 'PASS_THROUGH' && one.finish !== null && one.finish < effectiveDate).map((one) => one.code));
    const undecided = [...past].filter((code) => !decisions.progress[code] && !decisions.notTracked.has(code));
    const plan = await this.plan(tx, resolved, facts, plannedStart, decisions.progress, effectiveDate, selection);
    const byTemplate = new Map(resolved.template.tasks.map((one) => [one.code, one] as const));
    const tasks: AdoptTaskView[] = plan.result.tasks.map((scheduled) => {
      const code = scheduled.code;
      const excluded = plan.excluded.includes(code);
      const treatment: Treatment = excluded ? 'EXCLUDED' : decisions.notTracked.has(code) ? 'NOT_TRACKED' : decisions.progress[code]?.status === 'DONE' ? 'DONE' : decisions.progress[code]?.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'TRACKED';
      return { taskCode: code, name: byTemplate.get(code)?.name ?? code, treatment, plannedStart: scheduled.start, plannedFinish: scheduled.finish, needsDecision: !excluded && undecided.includes(code) };
    });
    // What apply would refuse is told by the dry run, task by task: undecided past tasks and tasks taken in as done without the evidence the template asks for.
    const short = this.evidenceShortfalls(resolved.template, decisions.evidence);
    const findings = [...plan.result.findings.map((one) => ({ code: one.code, task: one.task })), ...undecided.map((code) => ({ code: 'PAST_TASK_UNDECIDED', task: code })), ...short.map((code) => ({ code: 'EVIDENCE_MISSING', task: code }))];
    if (request.dryRun) {
      return { dryRun: true, applied: false, workflow: null, templateCode: resolved.code, templateHash: resolved.hash, effectiveDate, tasks, schedule: plan.result, calendars: plan.calendars, excluded: plan.excluded, findings, selection };
    }
    if (undecided.length > 0) throw new DomainError('PWF_ADOPT_INVALID', 422, 'past_tasks', { extensions: { tasks: undecided } });
    if (short.length > 0) throw new DomainError('PWF_ADOPT_INVALID', 422, 'past_tasks', { extensions: { tasks: short, reason: 'EVIDENCE_MISSING' } });
    const workflow = await this.write(tx, project, request, plan, decisions, 'ADOPTION', today, effectiveDate);
    return { dryRun: false, applied: true, workflow, templateCode: resolved.code, templateHash: resolved.hash, effectiveDate, tasks, schedule: plan.result, calendars: plan.calendars, excluded: plan.excluded, findings, selection };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async lockFreeProject(tx: TenantTx, request: StartRequest): Promise<LockedProject> {
    if (!UUID.test(request.projectId)) throw invalid('project_id');
    const project = await lockProject(tx, request.projectId.toLowerCase(), request.scopes);
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`pwf:${project.id}`]);
    const existing = await tx.query<{ id: string }>('select id from machvon.project_workflow where project_id = $1::uuid', [project.id]);
    if (existing[0] !== undefined) throw new DomainError('PWF_WORKFLOW_EXISTS', 409, 'project_id', { extensions: { workflow_id: existing[0].id } });
    // A project that is over has no workflow to run (the legal stages that end it end the workflow too).
    if (TERMINAL_STAGES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { project_status: project.status } });
    return project;
  }

  private decisionsOf(template: pwfWorkflow.ProjectWorkflowTemplate, facts: pwfWorkflow.ProjectFacts, request: AdoptRequest, plan: ReadonlyMap<string, { start: string | null; finish: string | null }>): { progress: Record<string, pwfSchedule.TaskProgress>; notTracked: Set<string>; evidence: Map<string, readonly EvidenceDraft[]> } {
    const known = new Set(template.tasks.map((one) => one.code));
    const left = new Set(pwfWorkflow.activeTasks(template, facts).excluded);
    const progress: Record<string, pwfSchedule.TaskProgress> = {};
    const notTracked = new Set<string>();
    const evidence = new Map<string, readonly EvidenceDraft[]>();
    const claim = (code: string, field: string): void => {
      if (!known.has(code) || left.has(code) || progress[code] !== undefined || notTracked.has(code)) throw new DomainError('PWF_ADOPT_INVALID', 422, field);
    };
    for (const [index, one] of (request.pastTasks ?? []).entries()) {
      const field = `past_tasks[${index}]`;
      claim(one.taskCode, field);
      const start = one.actualStart ?? plan.get(one.taskCode)?.start ?? null;
      const finish = one.actualFinish ?? plan.get(one.taskCode)?.finish ?? null;
      if (start !== null) dateOf(start, `${field}.actual_start`);
      if (finish !== null) dateOf(finish, `${field}.actual_finish`);
      if (start !== null && finish !== null && finish < start) throw new DomainError('PWF_ADOPT_INVALID', 422, field);
      progress[one.taskCode] = { status: 'DONE', actualStart: start, actualFinish: finish };
      if (one.treatment === 'NOT_TRACKED') notTracked.add(one.taskCode);
      else evidence.set(one.taskCode, one.evidence ?? []);
    }
    for (const [index, one] of (request.inProgressTasks ?? []).entries()) {
      const field = `in_progress_tasks[${index}]`;
      claim(one.taskCode, field);
      progress[one.taskCode] = { status: 'IN_PROGRESS', actualStart: dateOf(one.actualStart, `${field}.actual_start`), remainingWorkingDays: one.remainingWorkingDays, percentComplete: one.percentComplete ?? null };
    }
    return { progress, notTracked, evidence };
  }

  /** A task taken in as done carries the evidence the template asks for: every type of legal document, and some evidence at all when it has a required checklist item (BR-PWF-17). */
  private evidenceShortfalls(template: pwfWorkflow.ProjectWorkflowTemplate, evidence: Map<string, readonly EvidenceDraft[]>): string[] {
    const byCode = new Map(template.tasks.map((one) => [one.code, one] as const));
    const short: string[] = [];
    for (const [code, given] of evidence) {
      const definition = byCode.get(code) as pwfWorkflow.TemplateTask;
      const kinds = new Set(given.map((one) => one.legalDocType).filter((one): one is string => one !== undefined));
      const needsAny = definition.checklist.some((item) => item.required);
      if (definition.legalDocTypes.some((type) => !kinds.has(type)) || (needsAny && given.length === 0)) short.push(code);
      for (const one of given) if (one.legalDocType !== undefined && pwfWorkflow.resolveLegalDocType(one.legalDocType) === undefined) throw new DomainError('LEGAL_DOC_TYPE_UNKNOWN', 422, 'legal_doc_type');
    }
    return short.sort();
  }

  private async plan(tx: TenantTx, resolved: ResolvedTemplate, facts: pwfWorkflow.ProjectFacts, plannedStart: string, progress: Record<string, pwfSchedule.TaskProgress>, statusDate: string | null, selection: SelectionRecord): Promise<Plan> {
    const calendars = await pinPublishedCalendars(tx, earliestYear([plannedStart, statusDate, ...Object.values(progress).flatMap((one) => [one.actualStart, one.actualFinish])]));
    const tasks = pwfSchedule.tasksFromTemplate(resolved.template, facts, progress);
    const result = pwfSchedule.scheduleProject({ tasks, plannedStart, calendars, ...(statusDate === null ? {} : { statusDate }) });
    return { resolved, facts, tasks, excluded: pwfWorkflow.activeTasks(resolved.template, facts).excluded, calendars, result, inputHash: inputHashOf({ tasks, plannedStart, statusDate, calendars }), statusDate, selection };
  }

  private async write(
    tx: TenantTx,
    project: LockedProject,
    request: StartRequest,
    plan: Plan,
    decisions: { progress: Record<string, pwfSchedule.TaskProgress>; notTracked?: Set<string>; evidence?: Map<string, readonly EvidenceDraft[]> },
    kind: 'INITIAL' | 'ADOPTION',
    today: string,
    adoptedOn: string | null = null,
  ): Promise<WorkflowResult> {
    const { resolved } = plan;
    const plannedStart = checkedDay(request.plannedStartDate, 'planned_start_date');
    const baselines = await tx.query<{ id: string }>('select id from machvon.project_baseline where project_id = $1::uuid and version = 0', [project.id]);
    const workflowId = randomUUID();
    await tx.query(
      `insert into machvon.project_workflow (tenant_id, id, project_id, template_code, template_rule_id, template_rule_version, template_hash, template, facts, planned_start_date, project_baseline_id, adopted_on, created_by, updated_by, status, selection, cited_legal_documents)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::int, $6, $7::jsonb, $8::jsonb, $9::date, $10::uuid, $11::date, $12::uuid, $12::uuid, $13, $14::jsonb, $15::text[])`,
      [workflowId, project.id, resolved.code, resolved.ruleId, resolved.version, resolved.hash, JSON.stringify(pwfWorkflow.templateParamsOf(resolved.template)), JSON.stringify(plan.facts), plannedStart, baselines[0]?.id ?? null, adoptedOn, request.actor, project.status === 'SUSPENDED' ? 'ON_HOLD' : 'ACTIVE', JSON.stringify(plan.selection), pwfWorkflow.citedLegalDocuments(resolved.template)],
    );
    await this.insertTasks(tx, workflowId, project.id, plan, decisions, request.actor, adoptedOn, today);
    await this.defaultAssignments(tx, workflowId, project.id, plannedStart, today, request.actor);
    await tx.query('update machvon.project set planned_start_date = $2::date, updated_at = now(), updated_by = $3::uuid where id = $1::uuid', [project.id, plannedStart, request.actor]);
    const published = await publishSchedule(tx, {
      workflow: { id: workflowId, projectId: project.id, version: 1, scheduleVersion: 0 },
      kind,
      result: plan.result,
      calendars: plan.calendars,
      inputHash: plan.inputHash,
      changes: [],
      reason: null,
      proposedBy: request.actor,
      approvedBy: null,
      today,
      baseline: this.baseline,
    });
    await logWorkflow(tx, { workflowId, kind: kind === 'INITIAL' ? 'WORKFLOW_STARTED' : 'ADOPTED', actor: request.actor, subject: { template_code: resolved.code, template_version: resolved.version, template_hash: resolved.hash, schedule_version: published.scheduleVersion, ...(adoptedOn === null ? {} : { effective_date: adoptedOn }), selection: { ...plan.selection } }, reason: plan.selection.reason });
    return {
      id: workflowId,
      projectId: project.id,
      projectCode: project.code,
      templateCode: resolved.code,
      templateHash: resolved.hash,
      templateRuleVersion: resolved.version,
      status: project.status === 'SUSPENDED' ? 'ON_HOLD' : 'ACTIVE',
      version: published.workflowVersion,
      scheduleVersion: published.scheduleVersion,
      plannedStartDate: plannedStart,
      taskCount: plan.tasks.length,
      facts: { ...plan.facts },
      selection: plan.selection,
    };
  }

  private async insertTasks(
    tx: TenantTx,
    workflowId: string,
    projectId: string,
    plan: Plan,
    decisions: { progress: Record<string, pwfSchedule.TaskProgress>; notTracked?: Set<string>; evidence?: Map<string, readonly EvidenceDraft[]> },
    actor: string,
    adoptedOn: string | null,
    today: string,
  ): Promise<void> {
    const left = new Set(plan.excluded);
    const rows = plan.resolved.template.tasks.map((one, index) => {
      const progress = decisions.progress[one.code];
      const done = progress?.status === 'DONE';
      const untracked = decisions.notTracked?.has(one.code) === true;
      return {
        code: one.code,
        name: one.name,
        phase: one.phase,
        sort_order: index,
        kind: one.kind,
        required: one.required,
        responsible_role: one.responsibleRole,
        approver_role: one.approverRole,
        priority: one.priority,
        duration: one.durationWorkingDays,
        status: done ? 'DONE' : progress?.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'NOT_STARTED',
        excluded: left.has(one.code),
        tracked: !untracked,
        constraint_kind: one.constraint?.kind ?? null,
        constraint_offset: one.constraint?.offsetWorkingDays ?? null,
        actual_start: progress?.actualStart ?? (done ? (progress?.actualFinish ?? adoptedOn) : null),
        actual_finish: done ? (progress?.actualFinish ?? adoptedOn) : null,
        remaining: progress?.status === 'IN_PROGRESS' ? (progress.remainingWorkingDays ?? null) : null,
        percent: progress?.status === 'IN_PROGRESS' ? (progress.percentComplete ?? null) : null,
        // Taken in as done: the person who took it in attests the completion; a task not tracked is never asked to be approved.
        attested: done && !untracked && one.approverRole !== null,
      };
    });
    await tx.query(
      `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, approver_role, priority, duration_working_days, status, excluded, tracked,
              constraint_kind, constraint_offset, actual_start, actual_finish, remaining_working_days, percent_complete, completion_requested_by, approved_by, approved_at, created_by, updated_by)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, x.code, x.name, x.phase, x.sort_order, x.kind, x.required, x.responsible_role, x.approver_role, x.priority, x.duration, x.status, x.excluded, x.tracked,
              x.constraint_kind, x.constraint_offset, x.actual_start, x.actual_finish, x.remaining, x.percent,
              case when x.attested then $3::uuid end, case when x.attested then $3::uuid end, case when x.attested then now() end, $3::uuid, $3::uuid
         from jsonb_to_recordset($4::jsonb) as x(code text, name text, phase text, sort_order int, kind text, required boolean, responsible_role text, approver_role text, priority text, duration int, status text, excluded boolean, tracked boolean,
              constraint_kind text, constraint_offset int, actual_start date, actual_finish date, remaining int, percent int, attested boolean)`,
      [workflowId, projectId, actor, JSON.stringify(rows)],
    );
    const links = plan.resolved.template.tasks.flatMap((one) => one.predecessors.map((link) => ({ task: one.code, predecessor: link.task, kind: link.kind, lag: link.lagWorkingDays })));
    if (links.length > 0) {
      await tx.query(
        `insert into machvon.project_task_dependency (tenant_id, workflow_id, task_id, predecessor_id, kind, lag_working_days)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, t.id, p.id, x.kind, x.lag
           from jsonb_to_recordset($2::jsonb) as x(task text, predecessor text, kind text, lag int)
           join machvon.project_task t on t.workflow_id = $1::uuid and t.task_code = x.task
           join machvon.project_task p on p.workflow_id = $1::uuid and p.task_code = x.predecessor`,
        [workflowId, JSON.stringify(links)],
      );
    }
    const items = plan.resolved.template.tasks.flatMap((one) => one.checklist.map((item) => ({ task: one.code, code: item.code, name: item.name, required: item.required, kinds: [...item.evidenceKinds] })));
    if (items.length > 0) {
      await tx.query(
        `insert into machvon.project_task_checklist_item (tenant_id, id, task_id, item_code, name, required, evidence_kinds)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), t.id, x.code, x.name, x.required, array(select jsonb_array_elements_text(x.kinds))
           from jsonb_to_recordset($2::jsonb) as x(task text, code text, name text, required boolean, kinds jsonb)
           join machvon.project_task t on t.workflow_id = $1::uuid and t.task_code = x.task`,
        [workflowId, JSON.stringify(items)],
      );
    }
    const definitions = new Map(plan.resolved.template.tasks.map((one) => [one.code, one] as const));
    for (const [code, given] of decisions.evidence ?? []) {
      for (const one of given) {
        // R46: the revision of the form the evidence was made from, by the policy of the template (the newest approved one, or the pinned one).
        const form = one.formTemplateCode === undefined ? null : await resolveFormRevision(tx, { code: one.formTemplateCode, policy: pwfWorkflow.formPolicyOf(definitions.get(code) ?? {}, one.formTemplateCode), documentId: one.documentId ?? null, today });
        await tx.query(
          `insert into machvon.project_task_evidence (tenant_id, id, task_id, evidence_kind, document_id, legal_doc_type, form_template_code, external_ref, note, attached_by, form_template_revision, form_template_sha256)
           select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), t.id, $2, $3::uuid, $4, $5, $6, $7, $8::uuid, $10::int, $11 from machvon.project_task t where t.workflow_id = $1::uuid and t.task_code = $9`,
          [workflowId, one.evidenceKind, one.documentId ?? null, one.legalDocType ?? null, one.formTemplateCode ?? null, one.externalRef ?? (one.documentId === undefined && one.formTemplateCode === undefined ? 'ADOPTED' : null), one.note ?? null, actor, code, form?.revision ?? null, form?.sha256 ?? null],
        );
      }
    }
  }

  /** Every task is the responsibility of the leader in charge of the project (the register of PRJ-05) from the day the workflow starts, until the ledger says otherwise; a project without a leader leaves the ledger empty. */
  private async defaultAssignments(tx: TenantTx, workflowId: string, projectId: string, plannedStart: string, today: string, actor: string): Promise<void> {
    const leaders = await tx.query<{ leader_membership_id: string }>(
      `select leader_membership_id from machvon.project_accountability where project_id = $1::uuid and accountability_role = 'LEADER_IN_CHARGE' and status = 'ACTIVE'`,
      [projectId],
    );
    const leader = leaders[0]?.leader_membership_id;
    if (leader === undefined) return;
    await tx.query(
      `insert into machvon.project_task_assignment (tenant_id, id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), t.id, $2::uuid, 'RESPONSIBLE', least($3::date, $4::date) - 1, 100, $6, $5::uuid
         from machvon.project_task t where t.workflow_id = $1::uuid and not t.excluded and t.tracked and t.status in ('NOT_STARTED', 'IN_PROGRESS')`,
      [workflowId, leader, plannedStart, today, actor, DEFAULT_ASSIGNMENT_REASON],
    );
  }
}
