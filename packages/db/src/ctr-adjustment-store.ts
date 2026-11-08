import { randomUUID } from 'node:crypto';
import {
  BASELINE_IMPACT_RULE_CODE,
  BASELINE_IMPACT_RULE_TYPE,
  DomainError,
  adjustmentImpact,
  adjustmentNeedsReview,
  assertAdjustmentReview,
  assertNotProposer,
  baselineImpactDefaults,
  baselineImpactOf,
  versionConflict,
} from '@machvon/kernel';
import type { AdjustmentClass, AdjustmentReviewDecision, BaselineImpactPolicy, Provenance } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const CONTRACT_ADJUSTMENT_RESOURCE = 'contract_adjustment';
export const CONTRACT_ADJUSTMENT_RECORDED_EVENT = 'ctr.adjustment_recorded.v1';
export const CONTRACT_ADJUSTMENT_REVIEWED_EVENT = 'ctr.adjustment_reviewed.v1';

export interface AdjustmentRow {
  id: string;
  contract: { id: string; code: string };
  project: { id: string; code: string; name: string };
  revisionId: string;
  revision: number;
  changeRequestId: string | null;
  originalVnd: string;
  previousVnd: string;
  newVnd: string;
  deltaVnd: string;
  deltaPctOfPrevious: string | null;
  cumulativeDeltaVnd: string;
  cumulativePctOfOriginal: string | null;
  baselineVersion: number | null;
  baselineBacVnd: string | null;
  shareOfBaselinePct: string | null;
  classification: AdjustmentClass;
  reasons: string[];
  policyVersion: number;
  madeBy: string;
  reviewStatus: 'NOT_NEEDED' | 'PENDING' | 'DECIDED';
  reviewDecision: AdjustmentReviewDecision | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  version: number;
}

interface AdjustmentSql {
  id: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  project_code: string;
  project_name: string;
  revision_id: string;
  revision: number;
  change_request_id: string | null;
  original_vnd: string;
  previous_vnd: string;
  new_vnd: string;
  delta_vnd: string;
  delta_pct_of_previous: string | null;
  cumulative_delta_vnd: string;
  cumulative_pct_of_original: string | null;
  baseline_version: number | null;
  baseline_bac_vnd: string | null;
  share_of_baseline_pct: string | null;
  classification: AdjustmentClass;
  reasons: string[];
  policy_version: number;
  made_by: string;
  review_status: 'NOT_NEEDED' | 'PENDING' | 'DECIDED';
  review_decision: AdjustmentReviewDecision | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  version: string;
}

const COLUMNS = `a.id, c.id as contract_id, c.code as contract_code, p.id as project_id, p.code as project_code, p.name as project_name, a.revision_id, a.revision, a.change_request_id, a.original_vnd::text as original_vnd,
  a.previous_vnd::text as previous_vnd, a.new_vnd::text as new_vnd, a.delta_vnd::text as delta_vnd, a.delta_pct_of_previous::text as delta_pct_of_previous, a.cumulative_delta_vnd::text as cumulative_delta_vnd,
  a.cumulative_pct_of_original::text as cumulative_pct_of_original, a.baseline_version, a.baseline_bac_vnd::text as baseline_bac_vnd, a.share_of_baseline_pct::text as share_of_baseline_pct, a.classification, a.reasons,
  a.policy_version, a.made_by, a.review_status, a.review_decision, a.reviewed_by, to_char(a.reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reviewed_at, a.review_note,
  to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, a.version::text as version`;

const toRow = (row: AdjustmentSql): AdjustmentRow => ({
  id: row.id,
  contract: { id: row.contract_id, code: row.contract_code },
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  revisionId: row.revision_id,
  revision: row.revision,
  changeRequestId: row.change_request_id,
  originalVnd: row.original_vnd,
  previousVnd: row.previous_vnd,
  newVnd: row.new_vnd,
  deltaVnd: row.delta_vnd,
  deltaPctOfPrevious: row.delta_pct_of_previous,
  cumulativeDeltaVnd: row.cumulative_delta_vnd,
  cumulativePctOfOriginal: row.cumulative_pct_of_original,
  baselineVersion: row.baseline_version,
  baselineBacVnd: row.baseline_bac_vnd,
  shareOfBaselinePct: row.share_of_baseline_pct,
  classification: row.classification,
  reasons: row.reasons,
  policyVersion: row.policy_version,
  madeBy: row.made_by,
  reviewStatus: row.review_status,
  reviewDecision: row.review_decision,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  reviewNote: row.review_note,
  createdAt: row.created_at,
  version: Number(row.version),
});

export interface ReviewResult {
  row: AdjustmentRow;
}

/**
 * The adjustment versions of a contract (G1-18): `record` is called when a revision takes effect (the value and the change, the share of the baseline cost of the project, and the class the rule
 * `CONTRACT_BASELINE_IMPACT` gives); a version that has to be looked at waits for `review`, by a person other than who made the change, which keeps the baseline or asks for a new one. The record is evidence and
 * is never changed but by the one review.
 */
export class CtrAdjustmentStore {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async policy(tx: TenantTx, asOf: string | Date): Promise<{ policy: BaselineImpactPolicy; version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; provenance: Provenance | null }> {
    const found = await this.port.get(tx, BASELINE_IMPACT_RULE_TYPE, BASELINE_IMPACT_RULE_CODE, asOf);
    if (found === undefined) return { policy: baselineImpactOf(baselineImpactDefaults()), version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { policy: baselineImpactOf(found.params), version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  /**
   * Writes the adjustment of the revision that has just taken effect, once (a second call for the same revision returns the row that is there). The first version of a contract is not an adjustment. The caller
   * holds the lock of the contract and has already moved its value.
   */
  async record(tx: TenantTx, input: { contractId: string; revisionId: string; actor: string; now: Date }): Promise<AdjustmentRow | undefined> {
    const revision = (
      await tx.query<{ revision: number; amount_vnd: string; change_request_id: string | null; created_by: string | null; project_id: string; owner_unit_id: string; supersedes_amount: string | null }>(
        `select r.revision, r.amount_vnd::text as amount_vnd, r.change_request_id, r.created_by, c.project_id, p.owner_unit_id,
                (select s.amount_vnd::text from machvon.contract_revision s where s.tenant_id = r.tenant_id and s.id = r.supersedes_id) as supersedes_amount
           from machvon.contract_revision r join machvon.contract c on c.tenant_id = r.tenant_id and c.id = r.contract_id join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
          where r.id = $1::uuid and r.contract_id = $2::uuid`,
        [input.revisionId, input.contractId],
      )
    )[0];
    if (revision === undefined || revision.revision < 2) return undefined;
    const existing = await tx.query<AdjustmentSql>(`select ${COLUMNS} from machvon.contract_adjustment a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id where a.revision_id = $1::uuid`, [input.revisionId]);
    if (existing[0] !== undefined) return toRow(existing[0]);
    const original = (await tx.query<{ amount_vnd: string }>('select amount_vnd::text as amount_vnd from machvon.contract_revision where contract_id = $1::uuid and revision = 1', [input.contractId]))[0];
    const previous = revision.supersedes_amount ?? (await tx.query<{ amount_vnd: string }>('select amount_vnd::text as amount_vnd from machvon.contract_revision where contract_id = $1::uuid and revision < $2 order by revision desc limit 1', [input.contractId, revision.revision]))[0]?.amount_vnd;
    if (original === undefined || previous === undefined) return undefined;
    const baseline = (await tx.query<{ id: string; version: number; bac_vnd: string }>('select id, version, bac_vnd::text as bac_vnd from machvon.project_baseline where project_id = $1::uuid order by version desc limit 1', [revision.project_id]))[0];
    const rule = await this.policy(tx, input.now);
    const impact = adjustmentImpact({ originalVnd: original.amount_vnd, previousVnd: previous, newVnd: revision.amount_vnd, baselineBacVnd: baseline?.bac_vnd ?? null }, rule.policy);
    const id = randomUUID();
    const madeBy = revision.created_by ?? input.actor;
    await tx.query(
      `insert into machvon.contract_adjustment
         (tenant_id, id, contract_id, project_id, owner_unit_id, revision_id, revision, change_request_id, original_vnd, previous_vnd, new_vnd, delta_vnd, delta_pct_of_previous, cumulative_delta_vnd, cumulative_pct_of_original,
          baseline_id, baseline_version, baseline_bac_vnd, share_of_baseline_pct, classification, reasons, policy_version, made_by, review_status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
               $15::uuid, $16, $17::numeric, $18::numeric, $19, $20::text[], $21, $22::uuid, $23)`,
      [
        id,
        input.contractId,
        revision.project_id,
        revision.owner_unit_id,
        input.revisionId,
        revision.revision,
        revision.change_request_id,
        original.amount_vnd,
        previous,
        revision.amount_vnd,
        impact.deltaVnd,
        impact.deltaPctOfPrevious,
        impact.cumulativeDeltaVnd,
        impact.cumulativePctOfOriginal,
        baseline?.id ?? null,
        baseline?.version ?? null,
        baseline?.bac_vnd ?? null,
        impact.shareOfBaselinePct,
        impact.classification,
        impact.reasons,
        rule.version,
        madeBy,
        adjustmentNeedsReview(impact.classification) ? 'PENDING' : 'NOT_NEEDED',
      ],
    );
    const written = await tx.query<AdjustmentSql>(`select ${COLUMNS} from machvon.contract_adjustment a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id where a.id = $1::uuid`, [id]);
    return toRow(written[0] as AdjustmentSql);
  }

  /** The versions of one contract, newest first, in the scope of the caller. */
  async ofContract(tx: TenantTx, scope: ScopeBuilder, contractId: string): Promise<AdjustmentRow[]> {
    const visible = scope(2);
    const rows = await tx.query<AdjustmentSql>(
      `select ${COLUMNS}
         from machvon.contract_adjustment a
         join ${CONTRACT_SCOPE_FROM} on c.tenant_id = a.tenant_id and c.id = a.contract_id
        where a.contract_id = $1::uuid and ${visible.sql}
        order by a.revision desc`,
      [contractId, ...visible.params],
    );
    return rows.map(toRow);
  }

  /** The versions that wait for a review, oldest first, in the scope of the caller. */
  async pending(tx: TenantTx, scope: ScopeBuilder, limit = 200): Promise<AdjustmentRow[]> {
    const visible = scope(1);
    const rows = await tx.query<AdjustmentSql>(
      `select ${COLUMNS}
         from machvon.contract_adjustment a
         join ${CONTRACT_SCOPE_FROM} on c.tenant_id = a.tenant_id and c.id = a.contract_id
        where a.review_status = 'PENDING' and ${visible.sql}
        order by a.created_at, a.id
        limit ${Math.trunc(limit)}`,
      [...visible.params],
    );
    return rows.map(toRow);
  }

  /** Decides a version that waits: by someone other than who made the change (403 `SELF_APPROVAL_DENIED`), once (409 `ADJUSTMENT_STATE_INVALID` after), with a stale version refused (409). */
  async review(tx: TenantTx, scope: ScopeBuilder, input: { id: string; expectedVersion: number; decision: string; note: string | undefined; actor: string; now: Date }): Promise<ReviewResult> {
    const visible = scope(2);
    const found = await tx.query<AdjustmentSql>(
      `select ${COLUMNS}
         from machvon.contract_adjustment a
         join ${CONTRACT_SCOPE_FROM} on c.tenant_id = a.tenant_id and c.id = a.contract_id
        where a.id = $1::uuid and ${visible.sql}
        for update of a`,
      [input.id, ...visible.params],
    );
    const held = found[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== input.expectedVersion) throw versionConflict(Number(held.version));
    if (held.review_status !== 'PENDING') throw new DomainError('ADJUSTMENT_STATE_INVALID', 409, 'id', { extensions: { review_status: held.review_status } });
    assertNotProposer(input.actor, [held.made_by]);
    const rule = await this.policy(tx, input.now);
    const decision = assertAdjustmentReview({ decision: input.decision, note: input.note, policy: rule.policy });
    await tx.query(
      "update machvon.contract_adjustment set review_status = 'DECIDED', review_decision = $2, reviewed_by = $3::uuid, reviewed_at = $4::timestamptz, review_note = $5, version = version + 1 where id = $1::uuid",
      [input.id, decision, input.actor, input.now.toISOString(), input.note?.trim() ?? null],
    );
    const after = await tx.query<AdjustmentSql>(`select ${COLUMNS} from machvon.contract_adjustment a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id where a.id = $1::uuid`, [input.id]);
    return { row: toRow(after[0] as AdjustmentSql) };
  }
}

export function adjustmentRecord(action: string, row: AdjustmentRow) {
  return {
    action,
    resourceType: CONTRACT_ADJUSTMENT_RESOURCE,
    resourceId: row.id,
    diff: { contract_id: row.contract.id, project_id: row.project.id, revision: row.revision, classification: row.classification, review_status: row.reviewStatus, review_decision: row.reviewDecision, policy_version: row.policyVersion },
  };
}
