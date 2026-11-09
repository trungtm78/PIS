import { DomainError, versionConflict } from '@machvon/kernel';
import { timestampKey } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { assertAdjustable, hpmAdjustmentDecision, hpmAdjustmentRequestOf } from './hpm-adjust-rules.ts';
import type { HpmAdjustmentState } from './hpm-adjust-rules.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const UNIQUE_VIOLATION = '23505';

export interface HpmAdjustmentRow {
  id: string;
  layoutCode: string;
  sourcePeriod: string;
  sourceRevision: number;
  targetPeriod: string;
  subjectCode: string;
  amountVnd: string;
  reason: string;
  state: HpmAdjustmentState;
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedPushId: string | null;
  appliedAt: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface AdjustmentSql {
  id: string;
  layout_code: string;
  source_period: string;
  source_revision: number;
  target_period: string;
  subject_code: string;
  amount_vnd: string;
  reason: string;
  state: HpmAdjustmentState;
  proposed_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  applied_push_id: string | null;
  applied_at: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
}

const SELECT = `select a.id, a.layout_code, a.source_period, a.source_revision, a.target_period, a.subject_code, a.amount_vnd::text as amount_vnd, a.reason, a.state, a.proposed_by, a.decided_by,
  to_char(a.decided_at at time zone 'UTC', ${ISO}) as decided_at, a.decision_reason, a.applied_push_id, to_char(a.applied_at at time zone 'UTC', ${ISO}) as applied_at, a.version::text as version,
  to_char(a.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('a.created_at')} as created_at_key from machvon.hpm_adjustment a`;

const adjustmentOf = (row: AdjustmentSql): HpmAdjustmentRow => ({
  id: row.id,
  layoutCode: row.layout_code,
  sourcePeriod: row.source_period,
  sourceRevision: row.source_revision,
  targetPeriod: row.target_period,
  subjectCode: row.subject_code,
  amountVnd: row.amount_vnd,
  reason: row.reason,
  state: row.state,
  proposedBy: row.proposed_by,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  appliedPushId: row.applied_push_id,
  appliedAt: row.applied_at,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface HpmAdjustmentFilter {
  state?: HpmAdjustmentState | undefined;
  layoutCode?: string | undefined;
  targetPeriod?: string | undefined;
}

/**
 * The adjustments in the next period (TH.01): proposed by one person against a revision the receiver accepted, decided by another, applied once by the push of the target period. Every move is written to the journal
 * (`hpm_adjustment_entry`, append-only) in the same transaction as the row, so the two never disagree. The accepted period is never touched: that is what makes this the second way beside the overwrite.
 */
export class HpmAdjustmentStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<HpmAdjustmentRow | undefined> {
    const rows = await tx.query<AdjustmentSql>(`${SELECT} where a.id = $1::uuid${lock ? ' for update of a' : ''}`, [id]);
    return rows[0] === undefined ? undefined : adjustmentOf(rows[0]);
  }

  async list(tx: TenantTx, filter: HpmAdjustmentFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<HpmAdjustmentRow[]> {
    const rows = await tx.query<AdjustmentSql>(
      `select * from (${SELECT} where ($1::text is null or a.state = $1) and ($2::text is null or a.layout_code = $2) and ($3::text is null or a.target_period = $3)) x
        where ($4::text is null or (x.created_at_key, x.id) < ($4::text, $5::uuid)) order by x.created_at_key desc, x.id desc limit $6`,
      [filter.state ?? null, filter.layoutCode ?? null, filter.targetPeriod ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(adjustmentOf);
  }

  private async journal(tx: TenantTx, adjustmentId: string, kind: HpmAdjustmentState, actor: string, reason: string | null, now: Date): Promise<void> {
    await tx.query(
      `insert into machvon.hpm_adjustment_entry (tenant_id, id, adjustment_id, kind, actor_id, reason, at) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5::timestamptz)`,
      [adjustmentId, kind, actor, reason, now.toISOString()],
    );
  }

  /** The journal of an adjustment, oldest first. */
  async journalOf(tx: TenantTx, adjustmentId: string): Promise<Array<{ kind: HpmAdjustmentState; actorId: string; reason: string | null; at: string }>> {
    const rows = await tx.query<{ kind: HpmAdjustmentState; actor_id: string; reason: string | null; at: string }>(
      `select kind, actor_id, reason, to_char(at at time zone 'UTC', ${ISO}) as at from machvon.hpm_adjustment_entry where adjustment_id = $1::uuid order by at, kind`,
      [adjustmentId],
    );
    return rows.map((row) => ({ kind: row.kind, actorId: row.actor_id, reason: row.reason, at: row.at }));
  }

  /**
   * Proposes an adjustment: the revision it names must be the one the receiver accepted for the period (404 otherwise: there is nothing to put right), and the next period must not have been accepted yet (409
   * `HPM_ADJUSTMENT_STATE_INVALID`). One open adjustment for a subject of a period; a second waits for the first to be decided or applied.
   */
  async propose(tx: TenantTx, body: Readonly<Record<string, unknown>>, actor: string, now: Date): Promise<HpmAdjustmentRow> {
    const request = hpmAdjustmentRequestOf(body);
    const [source] = await tx.query<{ revision: number }>(`select max(revision) as revision from machvon.hpm_push where layout_code = $1 and period = $2 and status = 'ACCEPTED'`, [request.layoutCode, request.sourcePeriod]);
    const [target] = await tx.query<{ found: boolean }>(`select exists (select 1 from machvon.hpm_push where layout_code = $1 and period = $2 and status = 'ACCEPTED') as found`, [request.layoutCode, request.targetPeriod]);
    assertAdjustable({ acceptedRevision: source?.revision ?? undefined, targetAccepted: target?.found === true }, request);
    try {
      const rows = await tx.query<AdjustmentSql>(
        `with inserted as (
           insert into machvon.hpm_adjustment (tenant_id, id, layout_code, source_period, source_revision, target_period, subject_code, amount_vnd, reason, state, proposed_by, created_at, updated_at)
           values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4, $5, $6::numeric, $7, 'PROPOSED', $8::uuid, $9::timestamptz, $9::timestamptz) returning *)
         ${SELECT.replace('from machvon.hpm_adjustment a', 'from inserted a')}`,
        [request.layoutCode, request.sourcePeriod, request.sourceRevision, request.targetPeriod, request.subjectCode, request.amountVnd, request.reason, actor, now.toISOString()],
      );
      const row = adjustmentOf(rows[0] as AdjustmentSql);
      await this.journal(tx, row.id, 'PROPOSED', actor, request.reason, now);
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('HPM_ADJUSTMENT_STATE_INVALID', 409, 'state');
      throw error;
    }
  }

  /** Approves or rejects a proposal: a stale version is 409 `VERSION_CONFLICT`; the rules say who may and that a reason is needed. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { decision: unknown; reason: unknown }, actor: string, now: Date): Promise<{ before: HpmAdjustmentRow; row: HpmAdjustmentRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = hpmAdjustmentDecision(before, { ...step, actorId: actor });
    await tx.query(
      `update machvon.hpm_adjustment set state = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, version = version + 1, updated_at = $4::timestamptz where id = $1::uuid`,
      [id, decided.to, actor, now.toISOString(), decided.reason],
    );
    await this.journal(tx, id, decided.to, actor, decided.reason, now);
    return { before, row: (await this.find(tx, id)) as HpmAdjustmentRow };
  }

  /** The approved adjustments waiting to ride on the push of a period of a layout, oldest first. */
  async approvedFor(tx: TenantTx, layoutCode: string, targetPeriod: string, lock = false): Promise<HpmAdjustmentRow[]> {
    const rows = await tx.query<AdjustmentSql>(`${SELECT} where a.layout_code = $1 and a.target_period = $2 and a.state = 'APPROVED' order by a.created_at, a.id${lock ? ' for update of a' : ''}`, [layoutCode, targetPeriod]);
    return rows.map(adjustmentOf);
  }

  /** What a push already carried: a retry of the same key sends exactly these, so the package is the same however the states moved. */
  async appliedBy(tx: TenantTx, pushId: string): Promise<HpmAdjustmentRow[]> {
    const rows = await tx.query<AdjustmentSql>(`${SELECT} where a.applied_push_id = $1::uuid order by a.created_at, a.id`, [pushId]);
    return rows.map(adjustmentOf);
  }

  /** The first push of the target period uses the approved adjustments, once (APPROVED to APPLIED, named for the push). */
  async apply(tx: TenantTx, adjustments: readonly HpmAdjustmentRow[], pushId: string, actor: string, now: Date): Promise<void> {
    for (const adjustment of adjustments) {
      await tx.query(`update machvon.hpm_adjustment set state = 'APPLIED', applied_push_id = $2::uuid, applied_at = $3::timestamptz, version = version + 1, updated_at = $3::timestamptz where id = $1::uuid and state = 'APPROVED'`, [adjustment.id, pushId, now.toISOString()]);
      await this.journal(tx, adjustment.id, 'APPLIED', actor, null, now);
    }
  }
}
