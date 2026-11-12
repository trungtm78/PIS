import { randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@machvon/contracts';
import { scoreUnitsOf } from '@machvon/db';
import type { AuditWriter, ScoreUnits, StaffScoreAdjustmentView, StaffScoreLineDetail, StaffScorePeriodView, StaffScoreResponseView, TenantTx } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';

/**
 * What the controllers of the scores of staff share (PWF-3, R33): the units each permission reaches, the audit row (ADM-11) of a view of another person, and the answers of the API (snake case, allowlisted,
 * never a row as it is). A caller that holds none of the permissions reaches no unit; the database says the same through its policy.
 */

export const PWF_RESOURCE_SCORE_PERIOD = 'staff_score_period';
export const PWF_RESOURCE_SCORE_LINE = 'staff_score_line';
export const PWF_RESOURCE_SCORE_ADJUSTMENT = 'staff_score_adjustment';
export const PWF_RESOURCE_SCORE_RESPONSE = 'staff_score_response';
export const READ_HR_PERMISSION = PERMISSIONS.getStaffScoreOverview;
const CLASSIFICATION = 'PERSONAL' as const;

export interface ScoreReach {
  /** `staff_score.read_unit` and `staff_score.read_hr`: the units whose scores the caller may read (`*` for the human resources, who read the whole tenant). */
  read: ScoreUnits;
  adjust: ScoreUnits;
  approve: ScoreUnits;
  manage: ScoreUnits;
  review: ScoreUnits;
  exportFiles: ScoreUnits;
}

/** The units the caller reaches with each permission of the scores, judged on the grants held now (a grant that was revoked reaches nothing). */
export async function reachOf(tx: TenantTx, access: EffectiveAccess, now: Date): Promise<ScoreReach> {
  const reach = (permissions: readonly string[]): Promise<ScoreUnits> => scoreUnitsOf(tx, access, permissions, now);
  const [read, adjust, approve, manage, review, exportFiles] = await Promise.all([
    reach([PERMISSIONS.listStaffScorePeriods, READ_HR_PERMISSION]),
    reach([PERMISSIONS.requestStaffScoreAdjustment]),
    reach([PERMISSIONS.decideStaffScoreAdjustment]),
    reach([PERMISSIONS.computeStaffScorePeriod]),
    reach([PERMISSIONS.listStaffScoreSignals]),
    reach([PERMISSIONS.exportStaffScorePeriod]),
  ]);
  return { read, adjust, approve, manage, review, exportFiles };
}

/** The units both lists reach: a file is made only of what the caller may export AND read. */
export function intersectUnits(left: ScoreUnits, right: ScoreUnits): ScoreUnits {
  if (left === '*') return right;
  if (right === '*') return left;
  const have = new Set(right.split(',').filter((id) => id !== ''));
  return left
    .split(',')
    .filter((id) => id !== '' && have.has(id))
    .join(',');
}

/** The audit row of a view or an export of the scores of other people (ADM-11): who, what, how many; never a score and never a name. */
export async function auditView(audit: Pick<AuditWriter, 'recordInTx'>, tx: TenantTx, tenant: TenantContext, entry: { action: string; resourceType: string; resourceId: string; diff: Record<string, unknown> }): Promise<void> {
  await audit.recordInTx(tx, tenant.membershipId, { ...entry, classification: CLASSIFICATION, correlationId: randomUUID(), requestId: randomUUID() });
}

export function periodDto(period: StaffScorePeriodView, now: Date): Schemas['StaffScorePeriod'] {
  return {
    id: period.id,
    scope_unit_id: period.scopeUnitId,
    period_kind: period.periodKind,
    period_from: period.periodFrom,
    period_to: period.periodTo,
    status: period.status,
    policy_code: period.policyCode,
    policy_rule_id: period.policyRuleId,
    policy_version: period.policyVersion,
    snapshot_hash: period.snapshotHash,
    locked_by: period.lockedBy,
    locked_at: period.lockedAt,
    response_until: period.responseUntil,
    official_at: period.officialAt,
    supersedes_period_id: period.supersedesPeriodId,
    line_count: period.lineCount,
    open_response_count: period.openResponseCount,
    version: period.version,
    as_of: now.toISOString(),
  } as unknown as Schemas['StaffScorePeriod'];
}

export const adjustmentDto = (row: StaffScoreAdjustmentView): Schemas['StaffScoreLine']['adjustments'][number] => ({
  id: row.id,
  line_id: row.lineId,
  points: row.points,
  reason: row.reason,
  evidence_ref: row.evidenceRef,
  status: row.status,
  requested_by: row.requestedBy,
  decided_by: row.decidedBy,
  decided_at: row.decidedAt,
  version: row.version,
});

export const responseDto = (row: StaffScoreResponseView): Schemas['StaffScoreLine']['responses'][number] => ({
  id: row.id,
  line_id: row.lineId,
  body: row.body,
  status: row.status,
  submitted_at: row.submittedAt,
  handled_by: row.handledBy,
  handled_at: row.handledAt,
  conclusion: row.conclusion,
  approval_instance_id: row.approvalInstanceId,
});

/** The line as the screens take it: the figures, every point with its tasks and shares, the adjustments and responses, the basis (policy and hash) and the buttons the server allows. */
export function lineDto(line: StaffScoreLineDetail, now: Date): Schemas['StaffScoreLine'] {
  return {
    id: line.id,
    period_id: line.periodId,
    membership_id: line.membershipId,
    display_name: line.displayName,
    unit_id_at_period: line.unitIdAtPeriod,
    score_computed: line.scoreComputed,
    score_adjusted: line.scoreAdjusted,
    rating: line.rating,
    state: line.state,
    rated_task_count: line.ratedTaskCount,
    effective_weight: line.effectiveWeight,
    period_status: line.periodStatus,
    contributions: line.contributions.map((one) => ({
      task_code: one.taskCode,
      task_id: one.taskId,
      name: one.name,
      fraction: one.fraction,
      weight: one.weight,
      score: one.score,
      spans: one.spans.map((span) => ({ role: span.role, valid_from: span.validFrom, valid_to: span.validTo, share_pct: span.sharePct })),
    })),
    excluded: line.excluded.map((one) => ({ task_code: one.taskCode, reason: one.reason })),
    // The signals of gaming are for the reviewer: a line read by anybody else has no `flags` member at all.
    ...(line.flags.length === 0 ? {} : { flags: line.flags.map((one) => one.code) }),
    adjustments: line.adjustments.map(adjustmentDto),
    responses: line.responses.map(responseDto),
    basis: { policy_code: line.policyCode, policy_version: line.policyVersion, snapshot_hash: line.snapshotHash },
    can_request_adjustment: line.canRequestAdjustment,
    can_respond: line.canRespond,
    version: line.version,
    as_of: now.toISOString(),
  } as unknown as Schemas['StaffScoreLine'];
}
