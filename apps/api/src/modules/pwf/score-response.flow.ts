import { ApprovalStore, HomeWorkClockStore, PwfScoreAdjustmentStore } from '@machvon/db';
import type { ApprovalEffects, FinalCommand, StaffScoreResponseResult, TenantTx } from '@machvon/db';
import { DomainError, PWF_SCORE_TEXT, pwfKpi } from '@machvon/kernel';
import type { FinalCommandRegistry } from '../adm/approval.service';

/** The clock a response runs: this many working minutes (three working days of eight hours) to be handled. */
const HANDLING_MINUTES = 3 * 8 * 60;
export const SCORE_RESPONSE_CLOCK = 'PWF_SCORE_RESPONSE';
export const SCORE_RESPONSE_SUBJECT = 'staff_score_response';
const CLOCK_SCREEN = 'PWF-14';

/**
 * What happens to a response of a person to their score besides being kept (R43): a clock of the alert centre that runs while it waits, owned by the unit of the person at the period, and, when the tenant published a
 * workflow of approval for the business type `score.response`, an instance of the ADM engine that the approvers decide on. Without a published workflow the response is handled directly by someone with
 * `staff_score.approve`; the end of an instance is the final command below, the same domain step as the direct one.
 */
export class ScoreResponseFlow {
  private readonly approvals = new ApprovalStore();
  private readonly clocks = new HomeWorkClockStore();
  private readonly adjustments = new PwfScoreAdjustmentStore();

  /** `commands` is the registry of the final commands of the process; absent where the ADM module is not mounted. */
  constructor(private readonly commands?: FinalCommandRegistry) {}

  /** Starts the clock and, when a workflow is published, the instance; the reference of the instance is kept on the response. Returns the id of the instance, or undefined when the response is handled directly. */
  async start(tx: TenantTx, effects: ApprovalEffects, response: StaffScoreResponseResult, now: Date): Promise<string | undefined> {
    await this.startClock(tx, response, now);
    if (this.commands === undefined || !this.commands.canHandle(pwfKpi.SCORE_RESPONSE_BUSINESS_TYPE)) return undefined;
    const published = await tx.query<{ id: string }>("select id from machvon.workflow_version where kind = 'APPROVAL' and business_type = $1 and status = 'Published'", [pwfKpi.SCORE_RESPONSE_BUSINESS_TYPE]);
    if (published[0] === undefined) return undefined;
    const instance = await this.approvals.start(tx, effects, {
      resourceType: pwfKpi.SCORE_RESPONSE_RESOURCE,
      resourceId: response.id,
      resourceVersion: response.version,
      businessType: pwfKpi.SCORE_RESPONSE_BUSINESS_TYPE,
      amountVnd: null,
      unitId: response.unitId,
      initiatorMembershipId: response.subject,
      now,
    });
    await this.adjustments.attachInstance(tx, response.id, instance.id, response.subject);
    return instance.id;
  }

  /** The clock is the response's own time limit; a tenant with no published calendar has no clock (a person's answer is never refused for that). */
  private async startClock(tx: TenantTx, response: StaffScoreResponseResult, now: Date): Promise<void> {
    try {
      await this.clocks.start(tx, {
        clockType: SCORE_RESPONSE_CLOCK,
        subjectType: SCORE_RESPONSE_SUBJECT,
        subjectId: response.id,
        title: PWF_SCORE_TEXT.clock_title,
        ownerUnitId: response.unitId,
        severity: 'WATCH',
        expectedAction: PWF_SCORE_TEXT.clock_action,
        consequence: PWF_SCORE_TEXT.clock_consequence,
        startedAt: now,
        workingMinutes: HANDLING_MINUTES,
        targetScreen: CLOCK_SCREEN,
        targetId: response.periodId,
        createdBy: response.subject,
      });
    } catch (failure) {
      if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
    }
  }

  /** The response was handled: its clock is met. */
  async stopClock(tx: TenantTx, responseId: string, by: string): Promise<void> {
    await this.clocks.endBySubject(tx, { clockType: SCORE_RESPONSE_CLOCK, subjectType: SCORE_RESPONSE_SUBJECT, subjectId: responseId }, 'MET', by, 'Handled');
  }
}

/**
 * The final command of the business type `score.response` (R43): what the engine calls when the last step of an instance approves (the response is upheld), an approver returns it or rejects it (the score is kept).
 * The response has to be open and the one who ends it is not the person scored; otherwise the answer is `GUARD_REJECTED` and the response stays as it was (BR-ADM-07).
 */
export function scoreResponseHandler(): FinalCommand {
  const adjustments = new PwfScoreAdjustmentStore();
  const flow = new ScoreResponseFlow();
  return async ({ tx, instance, outcome, effects }) => {
    if (instance.resourceType !== pwfKpi.SCORE_RESPONSE_RESOURCE) return 'GUARD_REJECTED';
    const [decided] = await tx.query<{ reason: string | null }>("select reason from machvon.approval_task where workflow_instance_id = $1::uuid and decision_seq = $2::integer and status = 'Decided' limit 1", [instance.id, instance.decisionSeq]);
    const mapped = outcome === 'APPROVED' ? 'UPHELD' : outcome === 'RETURNED' ? 'RETURNED' : 'KEPT';
    const done = await adjustments.applyWorkflowDecision(tx, { responseId: instance.resourceId, outcome: mapped, conclusion: decided?.reason ?? PWF_SCORE_TEXT.workflow_conclusion, actor: effects.actor });
    if (done === undefined) return 'GUARD_REJECTED';
    await flow.stopClock(tx, done.id, effects.actor);
    await effects.audit({ action: 'score.response_handled', resourceType: 'staff_score_response', resourceId: done.id, classification: 'PERSONAL', diff: { period_id: done.periodId, line_id: done.lineId, outcome: mapped, instance_id: instance.id } });
    await effects.emit({
      aggregateType: 'staff_score_response',
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'pwf.score.response.handled.v1',
      schemaVersion: 1,
      payload: { id: done.id, period_id: done.periodId, line_id: done.lineId, outcome: mapped, instance_id: instance.id, version: done.version },
      eventKey: `staff_score_response:${done.id}:handled`,
    });
    return 'APPLIED';
  };
}
