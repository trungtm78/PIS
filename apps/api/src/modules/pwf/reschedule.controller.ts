import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfRescheduleStore } from '@machvon/db';
import type { ProposalView, RescheduleInput } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { PROPOSAL_RESOURCE, WORKFLOW_RESOURCE, announce, scopesOf } from './pwf-support';
import { schedulePreviewOf } from './workflow.controller';

type Request = Schemas['PwfRescheduleRequest'];

const linksOf = (links: ReadonlyArray<{ task: string; kind: 'FS' | 'SS' | 'FF' | 'SF'; lag_working_days: number }> | undefined) => links?.map((link) => ({ task: link.task, kind: link.kind, lagWorkingDays: link.lag_working_days }));

/** The request of the contract as the store takes it. */
function inputOf(body: Request): RescheduleInput {
  const overrides = body.overrides;
  return {
    plannedStartDate: body.planned_start_date,
    statusDate: body.status_date,
    progress: body.progress?.map((one) => ({ taskCode: one.task_code, actualStart: one.actual_start, remainingWorkingDays: one.remaining_working_days, percentComplete: one.percent_complete })),
    overrides:
      overrides === undefined
        ? undefined
        : {
            add: overrides.add?.map((one) => ({ code: one.code, name: one.name, phase: one.phase, kind: one.kind, durationWorkingDays: one.duration_working_days, predecessors: linksOf(one.predecessors) })),
            change: overrides.change?.map((one) => ({ taskCode: one.task_code, durationWorkingDays: one.duration_working_days, predecessors: linksOf(one.predecessors) })),
            remove: overrides.remove,
          },
    reason: body.reason,
  };
}

function previewOf(proposal: ProposalView, now: Date): Schemas['PwfReschedulePreview'] {
  const { preview } = proposal;
  return {
    proposal_id: proposal.id,
    status: proposal.status,
    base_version: proposal.baseVersion,
    schedule: schedulePreviewOf(preview.schedule, { names: preview.names, phases: preview.phases, plannedStart: preview.schedule.tasks[0]?.start ?? '', excluded: preview.excluded, now }),
    changes: preview.changes.map((one) => ({ task_code: one.code, start_shift_days: one.startShiftDays, finish_shift_days: one.finishShiftDays, float_change: one.floatChange, became_critical: one.becameCritical, became_non_critical: one.becameNonCritical, state_changed: one.stateChanged })),
    project_finish_shift_days: preview.projectFinishShiftDays,
    input_hash: proposal.inputHash,
    result_hash: proposal.resultHash,
    reason: proposal.reason,
    proposed_by: proposal.proposedBy,
    version: proposal.version,
    as_of: now.toISOString(),
  };
}

/**
 * Moving the schedule of a project (PWF-06, F6): a manager proposes a change and gets the preview computed on what is not done, with the baseline untouched; another person decides. Approval publishes the new schedule in one
 * transaction under the lock of the project and the version the preview was made on, or is 409 `PWF_SCHEDULE_VERSION_CONFLICT`.
 */
@Controller()
export class ProjectRescheduleController {
  private readonly store = new PwfRescheduleStore();

  @Post('projects/:project_id/workflow/reschedules')
  @HttpCode(200)
  @OperationId('proposeProjectReschedule')
  @Command({ operation: 'proposeProjectReschedule', versioned: true })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Body() body: Request): Promise<Schemas['PwfReschedulePreview']> {
    const now = new Date();
    const proposal = await this.store.propose(scope.tx, { projectId: projectId.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, input: inputOf(body), actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.proposeProjectReschedule, now), now });
    await announce(scope, { resource: PROPOSAL_RESOURCE, id: proposal.id, version: proposal.version, action: 'reschedule.proposed', type: 'pwf.reschedule.proposed.v1', fromStatus: null, status: proposal.status, facts: { workflow_id: proposal.workflowId, project_id: proposal.projectId, base_version: proposal.baseVersion, result_hash: proposal.resultHash }, reason: body.reason }, now);
    return previewOf(proposal, now);
  }

  @Post('project-reschedules/:id/decide')
  @HttpCode(200)
  @OperationId('decideProjectReschedule')
  @Command({ operation: 'decideProjectReschedule', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PwfDecisionInput']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.decide(scope.tx, { proposalId: id, expectedVersion: scope.expectedVersion ?? 0, decision: body.decision, note: body.note, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.decideProjectReschedule, now), now });
    const { proposal } = done;
    await announce(scope, { resource: PROPOSAL_RESOURCE, id: proposal.id, version: proposal.version + 1, action: 'reschedule.decided', type: 'pwf.reschedule.decided.v1', fromStatus: 'PROPOSED', status: proposal.status, facts: { workflow_id: proposal.workflowId, project_id: proposal.projectId, decision: body.decision } }, now);
    if (proposal.status === 'APPROVED') {
      await announce(scope, { resource: WORKFLOW_RESOURCE, id: proposal.workflowId, version: done.workflowVersion, action: 'schedule.published', type: 'pwf.schedule.published.v1', fromStatus: null, status: 'ACTIVE', facts: { project_id: proposal.projectId, schedule_version: done.scheduleVersion, result_hash: done.resultHash } }, now);
    }
    return commandResult(scope, proposal.status, done.workflowVersion, proposal.id);
  }
}
