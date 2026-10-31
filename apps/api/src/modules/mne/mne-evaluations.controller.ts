import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { EVALUATION_RESOURCE, MneEvaluationStore, TenantDatabase, projectScope } from '@machvon/db';
import type { MneEvaluationChange, MneEvaluationView } from '@machvon/db';
import { DomainError, EVALUATION_SUBMITTABLE, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { reaches, refsOf } from '../ctr/contract.controller';

const MANAGE_PERMISSION = PERMISSIONS.planMneEvaluation;
const APPROVE_PERMISSION = PERMISSIONS.decideMneEvaluation;
const READ_PERMISSION = PERMISSIONS.listMneEvaluations;
const CLASSIFICATION = 'INTERNAL';
const PLANNED_EVENT = 'mne.evaluation.planned.v1';
const SUBMITTED_EVENT = 'mne.evaluation.submitted.v1';
const DECIDED_EVENT = 'mne.evaluation.decided.v1';

/** The evaluation as openapi.json exposes it (x-exposure dto): an allowlist, with what the caller may do with it. */
export function evaluationView(view: MneEvaluationView, access: EffectiveAccess, now: Date, memberId: string): Record<string, unknown> {
  const refs = refsOf(view.reach, view.reach.projectId);
  const mine = view.createdBy.toLowerCase() === memberId.toLowerCase() || (view.submittedBy !== null && view.submittedBy.toLowerCase() === memberId.toLowerCase());
  return {
    id: view.id,
    project: { id: view.projectId, code: view.projectCode, name: view.projectName },
    evaluation_kind: view.evaluationKind,
    evaluator_kind: view.evaluatorKind,
    evaluator_name: view.evaluatorName,
    scope_text: view.scopeText,
    planned_date: view.plannedDate,
    status: view.status,
    findings: view.findings,
    conclusion: view.conclusion,
    recommendations_text: view.recommendationsText,
    completed_date: view.completedDate,
    report_document_id: view.reportDocumentId,
    mne_report_id: view.mneReportId,
    submitted_by: view.submittedBy,
    submitted_at: view.submittedAt,
    decided_by: view.decidedBy,
    decided_at: view.decidedAt,
    decision_reason: view.decisionReason,
    created_at: view.createdAt,
    actions: {
      submit: (EVALUATION_SUBMITTABLE as readonly string[]).includes(view.status) && reaches(access, MANAGE_PERMISSION, refs, now),
      decide: view.status === 'SUBMITTED' && !mine && reaches(access, APPROVE_PERMISSION, refs, now),
    },
    version: view.version,
  };
}

/** The ids, the kind and the statuses of an evaluation: what the trail and the event say, never the findings or the words of the decision. */
function factsOf(change: MneEvaluationChange): Record<string, unknown> {
  const { view } = change;
  return {
    project_id: view.projectId,
    evaluation_kind: view.evaluationKind,
    from_status: change.fromStatus,
    to_status: view.status,
    conclusion: view.conclusion,
    completed_date: view.completedDate,
    mne_report_id: view.mneReportId,
  };
}

async function record(scope: CommandScope, change: MneEvaluationChange, action: string, type: string, now: Date, reason?: string): Promise<CommandResult> {
  const { view } = change;
  const facts = factsOf(change);
  await scope.audit({ action, resourceType: EVALUATION_RESOURCE, resourceId: view.id, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff: facts });
  await scope.emit({
    aggregateType: EVALUATION_RESOURCE,
    aggregateId: view.id,
    aggregateVersion: view.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, evaluation_id: view.id, ...facts, version: view.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${EVALUATION_RESOURCE}:${view.id}:${view.version}`,
  });
  return commandResult(scope, view.status, view.version, view.id);
}

/**
 * The investment evaluation of a project (ST-MNE-009, MNE F9, BR-MNE-08, UAT-AC292): planned for a kind that the stage of the project allows (409 `STAGE_TRANSITION_DENIED`), submitted with its findings, a conclusion and the day
 * it was completed (422 `VALIDATION_FAILED`), and decided by somebody other than who planned or submitted it (403 `SELF_APPROVAL_DENIED`); an approved evaluation is linked to the next overall report. The right to plan and submit is
 * `mne.evaluation.manage` and the right to decide `mne.evaluation.approve`, each over the project.
 */
@Controller()
export class MneEvaluationsController {
  private readonly evaluations = new MneEvaluationStore();

  @Post('mne-evaluations')
  @HttpCode(200)
  @OperationId('planMneEvaluation')
  @Command({ operation: 'planMneEvaluation' })
  async plan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MneEvaluationInput']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.evaluations.plan(
      scope.tx,
      { projectId: body.project_id, evaluationKind: body.evaluation_kind, evaluatorKind: body.evaluator_kind, evaluatorName: body.evaluator_name, scopeText: body.scope_text, plannedDate: body.planned_date },
      scope.tenant.membershipId,
      projectScope(access, MANAGE_PERMISSION, now),
      vietnamDateOf(now),
    );
    return record(scope, change, 'mne_evaluation.planned', PLANNED_EVENT, now);
  }

  @Post('mne-evaluations/:id/submit')
  @HttpCode(200)
  @OperationId('submitMneEvaluation')
  @Command({ operation: 'submitMneEvaluation', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneEvaluationSubmit']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.evaluations.submit(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { findings: body.findings, conclusion: body.conclusion, recommendationsText: body.recommendations_text, completedDate: body.completed_date, reportDocumentId: body.report_document_id },
      scope.tenant.membershipId,
      projectScope(access, MANAGE_PERMISSION, now),
      vietnamDateOf(now),
    );
    return record(scope, change, 'mne_evaluation.submitted', SUBMITTED_EVENT, now);
  }

  @Post('mne-evaluations/:id/decision')
  @HttpCode(200)
  @OperationId('decideMneEvaluation')
  @Command({ operation: 'decideMneEvaluation', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneDecision']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.evaluations.decide(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason }, scope.tenant.membershipId, projectScope(access, APPROVE_PERMISSION, now));
    // The reason is the words of the person: the audit row keeps it as the reason and the event does not repeat it.
    return record(scope, change, change.view.status === 'APPROVED' ? 'mne_evaluation.approved' : 'mne_evaluation.returned', DECIDED_EVENT, now, body.reason.trim());
  }
}

/** The evaluations in the scope of the reader (MNE-08), newest first. */
@Controller()
export class MneEvaluationReadsController {
  private readonly evaluations = new MneEvaluationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  /** The projects the reader can be evaluated for, by code (MNE-08: the filter and the plan). */
  @Get('mne-evaluations/projects')
  @OperationId('listMneEvaluationProjects')
  async projects(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.evaluations.projects(tx, projectScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status })),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.code, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('mne-evaluations')
  @OperationId('listMneEvaluations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = project === undefined ? undefined : typeof project === 'string' ? asUuid(project) : undefined;
    if (project !== undefined && projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.evaluations.list(tx, projectScope(access, READ_PERMISSION, now), {
        projectId: projectId?.toLowerCase(),
        status,
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => evaluationView(row, access, now, tenant.membershipId)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
