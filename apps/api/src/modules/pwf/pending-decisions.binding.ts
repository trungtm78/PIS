import { Inject, Injectable, Optional } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfPendingDecisionReads, projectScope, scoreUnitsOf } from '@machvon/db';
import type { PwfPendingDecision, PwfPendingKind } from '@machvon/db';
import { APPROVAL_FINAL_COMMANDS } from '../adm/approval.service';
import type { FinalCommandRegistry, PendingDecision, PendingDecisionAction, PendingDecisionSource } from '../adm/approval.service';

/** The code PWF is named by in the unified inbox (`unavailable_sources`). */
export const PWF_PENDING_SOURCE = 'PWF';

/** The limits of the words of a decision, as the commands keep them: a note of 5 to 500 characters, the reason of a return of 20 to 500 (`PwfDecisionInput`, `PwfReturnInput`). */
const note = (decision: PendingDecisionAction['decision'], operationId: string): PendingDecisionAction => ({ decision, operationId, reasonRequired: false, reasonMin: 5, reasonMax: 500 });

/**
 * The commands that decide each kind, which are the ones the screens of PWF already call: nothing is decided through any other way. A completion is approved by `approveProjectTaskCompletion` or sent back by
 * `returnProjectTask` (the reason is required); the three others take `APPROVE` or `REJECT` on their own command.
 */
export const PWF_PENDING_ACTIONS: Readonly<Record<PwfPendingKind, readonly PendingDecisionAction[]>> = {
  'pwf.task.completion': [note('approve', 'approveProjectTaskCompletion'), { decision: 'return', operationId: 'returnProjectTask', reasonRequired: true, reasonMin: 20, reasonMax: 500 }],
  'pwf.task.exception': [note('approve', 'decideProjectTaskException'), note('reject', 'decideProjectTaskException')],
  'pwf.reschedule': [note('approve', 'decideProjectReschedule'), note('reject', 'decideProjectReschedule')],
  'pwf.score.adjustment': [note('approve', 'decideStaffScoreAdjustment'), note('reject', 'decideStaffScoreAdjustment')],
};

function decisionOf(row: PwfPendingDecision): PendingDecision {
  return {
    id: `${row.kind}:${row.resourceId}`,
    kind: row.kind,
    resource: { type: row.resourceType, id: row.resourceId },
    version: row.version,
    submittedAt: row.submittedAt,
    initiatorName: row.initiatorName,
    // None of these kinds runs a clock of its own (only the response to a score does, and that one is a task of the engine): no day is invented for them.
    dueAt: null,
    overdue: false,
    summary: { kind: row.kind, subject: row.subjectName === null ? null : { name: row.subjectName }, unit: row.unit, project: row.project, period: row.period, facts: row.facts, body: row.body, target: row.target },
    actions: [...PWF_PENDING_ACTIONS[row.kind]],
  };
}

/**
 * What waits in PWF for the reader to decide (PWF 20.9): the completions of tasks, the exceptions, the proposals of a new schedule and the adjustments of scores. The reach of each kind is the one of the permission of
 * its command for this reader, so the list holds exactly what the command would let them decide.
 */
export function pwfPendingSource(): PendingDecisionSource {
  const reads = new PwfPendingDecisionReads();
  return async (tx, viewer, limit) => {
    const found = await reads.list(
      tx,
      {
        membershipId: viewer.membershipId,
        taskApprove: projectScope(viewer.access, PERMISSIONS.approveProjectTaskCompletion, viewer.now),
        scheduleApprove: projectScope(viewer.access, PERMISSIONS.decideProjectReschedule, viewer.now),
        scoreUnits: await scoreUnitsOf(tx, viewer.access, [PERMISSIONS.decideStaffScoreAdjustment], viewer.now),
      },
      limit,
    );
    return found.map(decisionOf);
  };
}

/** Binds the source of PWF into the registry of the approval engine when the application starts, as the final command of `score.response` is bound. */
@Injectable()
export class PwfPendingDecisionsBinding {
  constructor(@Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry) {
    commands?.registerPendingSource(PWF_PENDING_SOURCE, pwfPendingSource());
  }
}
