import { DomainError, hasControlCharExceptWhitespace, pwfKpi } from '@machvon/kernel';
import type { AdjustmentView } from './pwf-score-reads.ts';
import { checkVersion, lockPeriod, notFound, scoreIdOf, unitReached, withScoreScope } from './pwf-score-support.ts';
import type { ScoreUnits } from './pwf-score-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The adjustments of a score and the responses of the person scored (PWF-3, docs PWF 3 F10, 5 BR-PWF-38, 39, R43). A locked period never changes its computed scores; the one way a score moves is an adjustment that one
 * person asked for with a reason and another person, who is neither the one who asked nor the person scored, approved, inside the bounds of the policy of the period. The person scored answers their score inside the
 * window of response, and someone other than them handles the answer (directly, or through the approval engine of ADM). Every command takes the lock of the period, so that it reads the period either before the lock
 * or after it and never in between.
 */

const MAX_RESPONSES_PER_LINE = 5;
const MIN_BODY = 20;
const MAX_BODY = 2000;
const MIN_CONCLUSION = 5;
const MAX_CONCLUSION = 2000;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function textOf(value: string | undefined, field: string, min: number, max: number): string {
  const text = (value ?? '').trim();
  if (text.length < min || text.length > max || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

interface HeldLine {
  id: string;
  periodId: string;
  membershipId: string | null;
  unitId: string;
  state: 'RATED' | 'NOT_RATED' | 'SMALL_SAMPLE';
  scoreComputed: number | null;
  adjustmentPoints: number;
  version: number;
  periodStatus: 'DRAFT' | 'LOCKED' | 'OFFICIAL';
  responseUntil: string | null;
  policy: pwfKpi.StaffScoringPolicy | undefined;
}

interface HeldSql {
  id: string;
  period_id: string;
  membership_id: string | null;
  unit_id_at_period: string;
  state: HeldLine['state'];
  score_computed: string | null;
  adjustment_points: string;
  version: number;
  status: HeldLine['periodStatus'];
  response_until: string | null;
  params: Record<string, unknown> | null;
}

const HELD = `l.id, l.period_id, l.membership_id, l.unit_id_at_period, l.state, l.score_computed::text as score_computed, l.adjustment_points::text as adjustment_points, l.version, p.status, p.response_until::text as response_until,
  p.snapshot #> '{policy,params}' as params`;

const toHeld = (row: HeldSql): HeldLine => ({
  id: row.id,
  periodId: row.period_id,
  membershipId: row.membership_id,
  unitId: row.unit_id_at_period,
  state: row.state,
  scoreComputed: row.score_computed === null ? null : Number(row.score_computed),
  adjustmentPoints: Number(row.adjustment_points),
  version: row.version,
  periodStatus: row.status,
  responseUntil: row.response_until,
  policy: row.params === null ? undefined : pwfKpi.parseStaffScoringPolicy(row.params),
});

export interface AdjustmentResult {
  id: string;
  lineId: string;
  periodId: string;
  unitId: string;
  fromStatus: string;
  status: string;
  version: number;
  facts: Record<string, unknown>;
}

export interface ResponseResult {
  id: string;
  lineId: string;
  periodId: string;
  unitId: string;
  subject: string;
  status: string;
  version: number;
  facts: Record<string, unknown>;
}

export class PwfScoreAdjustmentStore {
  /** The line, its period and the policy the period was locked under, read under the lock of the period: not there for a caller whose units do not reach it. */
  private async hold(tx: TenantTx, lineId: string, scope: { units: ScoreUnits; subject: string }): Promise<HeldLine> {
    const id = scoreIdOf(lineId, 'id');
    const first = await withScoreScope(tx, scope, () => tx.query<{ period_id: string }>('select l.period_id from machvon.staff_score_line l where l.id = $1::uuid and l.erased_at is null', [id]));
    if (first[0] === undefined) throw notFound();
    await lockPeriod(tx, first[0].period_id);
    const rows = await withScoreScope(tx, scope, () =>
      tx.query<HeldSql>(`select ${HELD} from machvon.staff_score_line l join machvon.staff_score_period p on p.tenant_id = l.tenant_id and p.id = l.period_id where l.id = $1::uuid and l.erased_at is null for update of l`, [id]),
    );
    if (rows[0] === undefined) throw notFound();
    return toHeld(rows[0]);
  }

  private assertWritablePeriod(line: HeldLine): pwfKpi.StaffScoringPolicy {
    if (line.periodStatus === 'DRAFT' || line.policy === undefined) throw new DomainError('STAFF_SCORE_PERIOD_LOCKED', 409, 'status', { extensions: { period_status: line.periodStatus } });
    return line.policy;
  }

  /** The points approved so far plus these must stay inside the bounds of the policy: adjustments never add up to more than the policy allows for a score. */
  private assertWithinBounds(policy: pwfKpi.StaffScoringPolicy, net: number): void {
    if (Math.abs(net) > policy.calibration.maxAdjustmentPoints) throw new DomainError('STAFF_SCORE_ADJUSTMENT_INVALID', 422, 'points');
  }

  /**
   * Asks to adjust the score of a person. The person asking reaches the unit of the line through `staff_score.adjust`, is not the person scored, and the period is locked or official (409 `STAFF_SCORE_PERIOD_LOCKED`
   * otherwise); the points are inside the bounds of the policy of the period together with what was approved before, the reason is long enough (422 `STAFF_SCORE_ADJUSTMENT_INVALID`).
   */
  async request(tx: TenantTx, input: { lineId: string; points: number; reason: string; evidenceRef?: string | undefined; responseId?: string | undefined; actor: string; units: ScoreUnits }): Promise<AdjustmentResult> {
    const line = await this.hold(tx, input.lineId, { units: input.units, subject: '' });
    if (!unitReached(input.units, line.unitId)) throw notFound();
    const policy = this.assertWritablePeriod(line);
    const reason = textOf(input.reason, 'reason', 1, 1000);
    const evidence = input.evidenceRef === undefined ? null : textOf(input.evidenceRef, 'evidence_ref', 1, 300);
    pwfKpi.assertAdjustmentRequestable(policy, { points: input.points, reason, requestedBy: input.actor, subjectMembershipId: line.membershipId ?? '' });
    if (line.state === 'NOT_RATED' || line.scoreComputed === null) throw new DomainError('STAFF_SCORE_ADJUSTMENT_INVALID', 422, 'line');
    this.assertWithinBounds(policy, line.adjustmentPoints + input.points);
    const rows = await withScoreScope(tx, { units: input.units, subject: '' }, () =>
      tx.query<{ id: string }>(
        `insert into machvon.staff_score_adjustment (tenant_id, line_id, subject_membership_id, unit_id_at_period, points, reason, evidence_ref, response_id, requested_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6, $7::uuid, $8::uuid) returning id`,
        [line.id, line.membershipId, line.unitId, input.points, reason, evidence, input.responseId ?? null, input.actor],
      ),
    );
    const id = (rows[0] as { id: string }).id;
    return { id, lineId: line.id, periodId: line.periodId, unitId: line.unitId, fromStatus: 'NONE', status: 'REQUESTED', version: 1, facts: { period_id: line.periodId, line_id: line.id, points: input.points, response_id: input.responseId ?? null } };
  }

  /**
   * Decides an adjustment. The decider is neither the one who asked (403 `SELF_APPROVAL_DENIED`) nor the person scored (422 `STAFF_SCORE_ADJUSTMENT_INVALID`); the version is the one the screen read (409
   * `VERSION_CONFLICT`); an approval moves the adjusted score of the line (the computed score stays) and never past the bounds of the policy.
   */
  async decide(tx: TenantTx, input: { adjustmentId: string; expectedVersion: number; decision: 'APPROVE' | 'REJECT'; note?: string | undefined; actor: string; units: ScoreUnits }): Promise<AdjustmentResult> {
    const id = scoreIdOf(input.adjustmentId, 'id');
    const scope = { units: input.units, subject: '' };
    const first = await withScoreScope(tx, scope, () => tx.query<{ line_id: string }>('select a.line_id from machvon.staff_score_adjustment a where a.id = $1::uuid', [id]));
    if (first[0] === undefined) throw notFound();
    const line = await this.hold(tx, first[0].line_id, scope);
    if (!unitReached(input.units, line.unitId)) throw notFound();
    const policy = this.assertWritablePeriod(line);
    const rows = await withScoreScope(tx, scope, () =>
      tx.query<{ points: string; status: AdjustmentView['status']; requested_by: string; version: number }>('select points::text as points, status, requested_by, version from machvon.staff_score_adjustment where id = $1::uuid for update', [id]),
    );
    const held = rows[0] as { points: string; status: AdjustmentView['status']; requested_by: string; version: number };
    checkVersion(held.version, input.expectedVersion);
    if (held.requested_by === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (held.status !== 'REQUESTED') throw new DomainError('STAFF_SCORE_ADJUSTMENT_INVALID', 422, 'status', { extensions: { adjustment_status: held.status } });
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw invalid('decision');
    if (line.membershipId === input.actor) throw new DomainError('STAFF_SCORE_ADJUSTMENT_INVALID', 422, 'approvedBy');
    const note = input.note === undefined ? null : textOf(input.note, 'note', 5, 500);
    const approve = input.decision === 'APPROVE';
    let adjusted: number | null = null;
    if (approve) {
      const net = Math.round((line.adjustmentPoints + Number(held.points)) * 100) / 100;
      this.assertWithinBounds(policy, net);
      adjusted = pwfKpi.applyAdjustment(line.scoreComputed as number, net);
      await withScoreScope(tx, scope, () => tx.query('update machvon.staff_score_line set adjustment_points = $2::numeric, score_adjusted = $3::numeric, version = version + 1, updated_at = now() where id = $1::uuid', [line.id, net, adjusted]));
    }
    await withScoreScope(tx, scope, () =>
      tx.query(`update machvon.staff_score_adjustment set status = $2, decided_by = $3::uuid, decided_at = now(), decision_note = $4, version = version + 1 where id = $1::uuid`, [id, approve ? 'APPROVED' : 'REJECTED', input.actor, note]),
    );
    return { id, lineId: line.id, periodId: line.periodId, unitId: line.unitId, fromStatus: 'REQUESTED', status: approve ? 'APPROVED' : 'REJECTED', version: held.version + 1, facts: { period_id: line.periodId, line_id: line.id, points: Number(held.points), decision: input.decision, score_adjusted: adjusted } };
  }

  /**
   * The person scored answers their score. Only the person (the line is theirs), only while the period is locked and today is inside the window (409 `STAFF_SCORE_RESPONSE_WINDOW_CLOSED`), at most a few times per
   * line; what they wrote is kept as written.
   */
  async submit(tx: TenantTx, input: { lineId: string; body: string; actor: string; today: string }): Promise<ResponseResult> {
    const line = await this.hold(tx, input.lineId, { units: '', subject: input.actor });
    if (line.membershipId !== input.actor || line.periodStatus === 'DRAFT') throw notFound();
    if (line.periodStatus !== 'LOCKED' || line.responseUntil === null || input.today > line.responseUntil) throw new DomainError('STAFF_SCORE_RESPONSE_WINDOW_CLOSED', 409, 'status', { extensions: { period_status: line.periodStatus, response_until: line.responseUntil } });
    const body = textOf(input.body, 'body', MIN_BODY, MAX_BODY);
    const scope = { units: '', subject: input.actor };
    const count = await withScoreScope(tx, scope, () => tx.query<{ total: string }>('select count(*)::text as total from machvon.staff_score_response where line_id = $1::uuid', [line.id]));
    if (Number(count[0]?.total ?? 0) >= MAX_RESPONSES_PER_LINE) throw invalid('body');
    const rows = await withScoreScope(tx, scope, async () => {
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.staff_score_response (tenant_id, line_id, subject_membership_id, unit_id_at_period, body)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4) returning id`,
        [line.id, line.membershipId, line.unitId, body],
      );
      await tx.query('update machvon.staff_score_line set version = version + 1, updated_at = now() where id = $1::uuid', [line.id]);
      return inserted;
    });
    const id = (rows[0] as { id: string }).id;
    return { id, lineId: line.id, periodId: line.periodId, unitId: line.unitId, subject: input.actor, status: 'OPEN', version: 1, facts: { period_id: line.periodId, line_id: line.id, response_until: line.responseUntil } };
  }

  /** The id of the instance of the ADM engine that handles a response, once it started (the response keeps the reference). */
  async attachInstance(tx: TenantTx, responseId: string, instanceId: string, subject: string): Promise<void> {
    await withScoreScope(tx, { units: '', subject }, () => tx.query('update machvon.staff_score_response set approval_instance_id = $2::uuid where id = $1::uuid and status = \'OPEN\'', [scoreIdOf(responseId, 'id'), scoreIdOf(instanceId, 'id')]));
  }

  /**
   * Handles a response directly: someone with `staff_score.approve` who is not the person scored, in the units they reach. The version is the one of the line the screen read; the outcome keeps the score or asks for
   * an adjustment (which another person decides). A response that the approval engine is handling is not handled by hand (409 `WORKFLOW_ALREADY_RUNNING`).
   */
  async handle(
    tx: TenantTx,
    input: { responseId: string; expectedVersion: number; outcome: 'KEEP' | 'ADJUST'; conclusion: string; adjustment?: { points: number; reason: string } | undefined; actor: string; units: ScoreUnits },
  ): Promise<ResponseResult & { adjustmentId: string | null }> {
    const id = scoreIdOf(input.responseId, 'id');
    const scope = { units: input.units, subject: '' };
    const first = await withScoreScope(tx, scope, () => tx.query<{ line_id: string }>('select r.line_id from machvon.staff_score_response r where r.id = $1::uuid', [id]));
    if (first[0] === undefined) throw notFound();
    const line = await this.hold(tx, first[0].line_id, scope);
    if (!unitReached(input.units, line.unitId)) throw notFound();
    this.assertWritablePeriod(line);
    checkVersion(line.version, input.expectedVersion);
    const rows = await withScoreScope(tx, scope, () =>
      tx.query<{ status: 'OPEN' | 'HANDLED'; subject_membership_id: string | null; approval_instance_id: string | null; running: boolean }>(
        `select r.status, r.subject_membership_id, r.approval_instance_id,
                exists (select 1 from machvon.workflow_instance i where i.id = r.approval_instance_id and i.status = 'Running') as running
           from machvon.staff_score_response r where r.id = $1::uuid for update of r`,
        [id],
      ),
    );
    const held = rows[0] as { status: 'OPEN' | 'HANDLED'; subject_membership_id: string | null; approval_instance_id: string | null; running: boolean };
    if (held.subject_membership_id === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (held.status !== 'OPEN') throw new DomainError('VERSION_CONFLICT', 409, 'status', { extensions: { response_status: held.status } });
    if (held.running) throw new DomainError('WORKFLOW_ALREADY_RUNNING', 409, 'response_id');
    if (input.outcome !== 'KEEP' && input.outcome !== 'ADJUST') throw invalid('outcome');
    const conclusion = textOf(input.conclusion, 'conclusion', MIN_CONCLUSION, MAX_CONCLUSION);
    let adjustmentId: string | null = null;
    if (input.outcome === 'ADJUST') {
      if (input.adjustment === undefined) throw invalid('adjustment_points');
      adjustmentId = (await this.request(tx, { lineId: line.id, points: input.adjustment.points, reason: input.adjustment.reason, responseId: id, actor: input.actor, units: input.units })).id;
    } else if (input.adjustment !== undefined) throw invalid('adjustment_points');
    await withScoreScope(tx, scope, async () => {
      await tx.query(`update machvon.staff_score_response set status = 'HANDLED', handled_by = $2::uuid, handled_at = now(), outcome = $3, conclusion = $4, version = version + 1 where id = $1::uuid`, [id, input.actor, input.outcome, conclusion]);
      await tx.query('update machvon.staff_score_line set version = version + 1, updated_at = now() where id = $1::uuid', [line.id]);
    });
    return { id, lineId: line.id, periodId: line.periodId, unitId: line.unitId, subject: held.subject_membership_id ?? '', status: 'HANDLED', version: line.version + 1, adjustmentId, facts: { period_id: line.periodId, line_id: line.id, outcome: input.outcome, adjustment_id: adjustmentId } };
  }

  /**
   * The end of the instance of the approval engine that handled a response (the final command of the business type `score.response`): upheld, returned or kept, with the reason the last approver gave. A response that
   * is no longer open, or an end by the person scored, is not applied (the engine answers `GUARD_REJECTED` and the response stays as it was).
   */
  async applyWorkflowDecision(tx: TenantTx, input: { responseId: string; outcome: 'UPHELD' | 'RETURNED' | 'KEPT'; conclusion: string; actor: string }): Promise<ResponseResult | undefined> {
    const id = scoreIdOf(input.responseId, 'id');
    const scope = { units: '*', subject: '' };
    const first = await withScoreScope(tx, scope, () => tx.query<{ line_id: string }>('select r.line_id from machvon.staff_score_response r where r.id = $1::uuid', [id]));
    if (first[0] === undefined) return undefined;
    const line = await this.hold(tx, first[0].line_id, scope);
    const rows = await withScoreScope(tx, scope, () =>
      tx.query<{ status: 'OPEN' | 'HANDLED'; subject_membership_id: string | null }>('select r.status, r.subject_membership_id from machvon.staff_score_response r where r.id = $1::uuid for update of r', [id]),
    );
    const held = rows[0];
    if (held === undefined || held.status !== 'OPEN' || held.subject_membership_id === input.actor) return undefined;
    const conclusion = input.conclusion.trim().slice(0, MAX_CONCLUSION);
    await withScoreScope(tx, scope, async () => {
      await tx.query(`update machvon.staff_score_response set status = 'HANDLED', handled_by = $2::uuid, handled_at = now(), outcome = $3, conclusion = $4, version = version + 1 where id = $1::uuid`, [id, input.actor, input.outcome, conclusion === '' ? null : conclusion]);
      await tx.query('update machvon.staff_score_line set version = version + 1, updated_at = now() where id = $1::uuid', [line.id]);
    });
    return { id, lineId: line.id, periodId: line.periodId, unitId: line.unitId, subject: held.subject_membership_id ?? '', status: 'HANDLED', version: line.version + 1, facts: { period_id: line.periodId, line_id: line.id, outcome: input.outcome } };
  }
}
