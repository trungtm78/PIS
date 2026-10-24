import { randomUUID } from 'node:crypto';
import { DomainError, requirePositiveAmount, vietnamDateOf } from '@machvon/kernel';
import { evaluateAvc } from './cap-avc.ts';
import type { AvcFigures, AvcThresholds, AvcVerdict } from './cap-avc.ts';
import { CapAvcPolicyStore } from './cap-avc-policy-store.ts';
import { creditBalance, lockLedgerRows } from './ledger-lock.ts';
import type { TenantTx } from './tenant-database.ts';

/** The business facts that commit capital; the contract is the one this story serves (the activation of a contract), the others join with their own stories. */
export const COMMITMENT_SOURCE_KINDS = ['CONTRACT'] as const;
export type CommitmentSourceKind = (typeof COMMITMENT_SOURCE_KINDS)[number];

export interface Availability {
  /** The line or the appropriation the figures belong to. */
  allocationLineId: string | null;
  appropriationId: string | null;
  figures: AvcFigures;
  thresholds: AvcThresholds | undefined;
  verdict: AvcVerdict | undefined;
  asOf: Date;
}

export interface CommitInput {
  allocationLineId: string;
  /** Whole VND, above zero. */
  amountVnd: string;
  sourceKind: CommitmentSourceKind;
  sourceId: string;
  /** The caller accepted the warning the check may give (the share is at or above the warning threshold and not above the block threshold). */
  acknowledgeWarning: boolean;
}

export interface CommitResult {
  entryId: string;
  allocationLineId: string;
  appropriationId: string;
  projectId: string;
  planYear: number;
  amountVnd: string;
  /** The verdict after the commitment, for the line and, when a policy controls the appropriation, for it. */
  line: AvcVerdict;
  appropriation: AvcVerdict | undefined;
  policyId: string | null;
  /** The commitment was already posted for this fact: nothing moved this time. */
  replayed: boolean;
  /** The caller acknowledged a warning that this commitment gave. */
  warningAcknowledged: boolean;
  balanceVersion: string | undefined;
}

interface LineRow {
  line_id: string;
  balance_id: string;
  project_id: string;
  appropriation_id: string | null;
  project_group: string | null;
  owner_unit_id: string;
  fund_key: string;
  plan_year: number | null;
  appropriation_amount: string | null;
  allocated: string;
  reserved: string;
  committed: string;
  disbursed: string;
}

const LINE_SELECT = `select al.id as line_id, ab.id as balance_id, al.project_id, al.appropriation_id, p.project_group, p.owner_unit_id, fr.business_key as fund_key,
    a.plan_year, a.amount_vnd::text as appropriation_amount, ab.allocated_vnd::text as allocated, ab.reserved_vnd::text as reserved, ab.committed_vnd::text as committed,
    ab.disbursed_vnd::text as disbursed
  from machvon.allocation_line al
  join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
  join machvon.project p on p.tenant_id = al.tenant_id and p.id = al.project_id
  join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
  join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
  left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id`;

const figuresOfLine = (row: LineRow): AvcFigures => ({ allocatedVnd: row.allocated, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed });

const blocked = (verdict: AvcVerdict, thresholds: AvcThresholds, object: string): DomainError =>
  new DomainError('AVC_BLOCKED', 422, undefined, {
    extensions: { reason: verdict.reason, consumption_pct: verdict.consumptionPct, warn_pct: thresholds.warnPct, block_pct: thresholds.blockPct, policy_id: thresholds.policyId, control_object: object },
  });

const ackRequired = (verdict: AvcVerdict, thresholds: AvcThresholds, object: string): DomainError =>
  new DomainError('AVC_WARNING_ACK_REQUIRED', 422, undefined, {
    extensions: { consumption_pct: verdict.consumptionPct, warn_pct: thresholds.warnPct, block_pct: thresholds.blockPct, policy_id: thresholds.policyId, control_object: object },
  });

/**
 * What is left of a line or an appropriation and where it stands against its availability policy, and the one place that commits capital against that policy (ST-CAP-005,
 * BR-CAP-06). A commitment locks the balance of the line (and, when a policy controls the appropriation, the balances of all its lines, in the one lock order of the product),
 * reads the figures under the lock, judges them and moves `committed_vnd` with its ledger entry in the same transaction: of two requests that together would overspend a line,
 * the second waits for the first, sees what it left and is refused.
 */
export class CapAvailabilityStore {
  private readonly policies: CapAvcPolicyStore;

  constructor(policies: CapAvcPolicyStore = new CapAvcPolicyStore()) {
    this.policies = policies;
  }

  /** The figures of a line in force and its verdict as it stands (an amount of nothing); undefined when the line has no balance (it is not the line in force of a published plan). */
  async ofLine(tx: TenantTx, lineId: string, today: string = vietnamDateOf(new Date())): Promise<Availability | undefined> {
    const [row] = await tx.query<LineRow>(`${LINE_SELECT} where al.id = $1::uuid`, [lineId]);
    if (row === undefined) return undefined;
    const thresholds = await this.policies.governingLine(tx, { projectGroup: row.project_group, unitId: row.owner_unit_id, fundSourceKey: row.fund_key }, today);
    const figures = figuresOfLine(row);
    return { allocationLineId: row.line_id, appropriationId: row.appropriation_id, figures, thresholds, verdict: evaluateAvc(figures, thresholds), asOf: new Date() };
  }

  /** The figures of a published appropriation (its amount against what its lines have reserved, committed and disbursed); the verdict only when a policy controls the appropriation. */
  async ofAppropriation(tx: TenantTx, appropriationId: string, today: string = vietnamDateOf(new Date())): Promise<Availability | undefined> {
    const [row] = await tx.query<{ amount: string; fund_key: string; reserved: string; committed: string; disbursed: string }>(
      `select a.amount_vnd::text as amount, fr.business_key as fund_key, coalesce(sum(ab.reserved_vnd), 0)::text as reserved, coalesce(sum(ab.committed_vnd), 0)::text as committed,
              coalesce(sum(ab.disbursed_vnd), 0)::text as disbursed
         from machvon.appropriation a
         join machvon.master_record_version fv on fv.tenant_id = a.tenant_id and fv.id = a.fund_source_version_id
         join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
         left join machvon.allocation_line al on al.tenant_id = a.tenant_id and al.appropriation_id = a.id
         left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
        where a.id = $1::uuid and a.status = 'PUBLISHED' group by a.tenant_id, a.id, fr.business_key`,
      [appropriationId],
    );
    if (row === undefined) return undefined;
    const figures: AvcFigures = { allocatedVnd: row.amount, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed };
    const thresholds = await this.policies.governing(tx, { controlObject: 'APPROPRIATION', fundSourceKey: row.fund_key }, today);
    return { allocationLineId: null, appropriationId, figures, thresholds, verdict: thresholds === undefined ? undefined : evaluateAvc(figures, thresholds), asOf: new Date() };
  }

  /**
   * Commits `amountVnd` of a line to a business fact (the activation of a contract) after the availability control. Refusals in order: the amount (422), the line (404 when it is
   * not a line in force), AVC_BLOCKED (422, with ZERO_ALLOCATION for a line that was allocated nothing) and AVC_WARNING_ACK_REQUIRED (422) when the caller has not accepted the
   * warning. The same fact posts once: asking again with the same amount answers what was done (`replayed`), asking with another amount is 409 IDEMPOTENCY_CONFLICT.
   */
  async checkAndCommit(tx: TenantTx, input: CommitInput, actor: string, today: string = vietnamDateOf(new Date())): Promise<CommitResult> {
    requirePositiveAmount(input.amountVnd, 0);
    const [peek] = await tx.query<LineRow>(`${LINE_SELECT} where al.id = $1::uuid`, [input.allocationLineId]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (peek.appropriation_id === null || peek.plan_year === null) throw new DomainError('VALIDATION_FAILED', 422, 'allocation_line_id', { extensions: { reason: 'LINE_WITHOUT_APPROPRIATION' } });
    const appropriationId = peek.appropriation_id;
    const lineThresholds = await this.policies.governingLine(tx, { projectGroup: peek.project_group, unitId: peek.owner_unit_id, fundSourceKey: peek.fund_key }, today);
    const appropriationThresholds = await this.policies.governing(tx, { controlObject: 'APPROPRIATION', fundSourceKey: peek.fund_key }, today);
    // The balance of the line first, and with a policy on the appropriation the balances of all its lines: one lock order (rank, table, id), so no two commitments deadlock.
    const siblings =
      appropriationThresholds === undefined
        ? [peek.balance_id]
        : (await tx.query<{ id: string }>('select ab.id from machvon.allocation_balance ab join machvon.allocation_line al on al.tenant_id = ab.tenant_id and al.id = ab.allocation_line_id where al.appropriation_id = $1::uuid', [appropriationId])).map((row) => row.id);
    await lockLedgerRows(tx, siblings.map((id) => ({ table: 'allocation_balance', id })));

    const [row] = await tx.query<LineRow>(`${LINE_SELECT} where al.id = $1::uuid`, [input.allocationLineId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const earlier = await tx.query<{ id: string; amount_vnd: string }>(
      "select id, amount_vnd::text as amount_vnd from machvon.capital_ledger_entry where source_ref_kind = $1 and source_ref_id = $2::uuid and entry_type = 'COMMIT' and allocation_line_id = $3::uuid",
      [input.sourceKind, input.sourceId, input.allocationLineId],
    );
    const figures = figuresOfLine(row);
    if (earlier[0] !== undefined) {
      if (earlier[0].amount_vnd !== input.amountVnd) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'amount_vnd', { extensions: { committed_vnd: earlier[0].amount_vnd } });
      const settled = evaluateAvc(figures, lineThresholds);
      return this.result(row, appropriationId, earlier[0].id, input.amountVnd, settled, undefined, lineThresholds, true, false, undefined);
    }

    const lineVerdict = evaluateAvc(figures, lineThresholds, input.amountVnd);
    if (lineVerdict.state === 'BLOCK') throw blocked(lineVerdict, lineThresholds, 'ALLOCATION_LINE');
    let appropriationVerdict: AvcVerdict | undefined;
    let appropriationFigures: AvcFigures | undefined;
    if (appropriationThresholds !== undefined) {
      appropriationFigures = await this.appropriationFigures(tx, appropriationId);
      appropriationVerdict = evaluateAvc(appropriationFigures, appropriationThresholds, input.amountVnd);
      if (appropriationVerdict.state === 'BLOCK') throw blocked(appropriationVerdict, appropriationThresholds, 'APPROPRIATION');
    }
    const warned = lineVerdict.state === 'WARN' || appropriationVerdict?.state === 'WARN';
    if (warned && !input.acknowledgeWarning) {
      if (lineVerdict.state === 'WARN') throw ackRequired(lineVerdict, lineThresholds, 'ALLOCATION_LINE');
      if (appropriationVerdict !== undefined && appropriationThresholds !== undefined) throw ackRequired(appropriationVerdict, appropriationThresholds, 'APPROPRIATION');
    }

    const moved = await creditBalance(tx, { table: 'allocation_balance', id: row.balance_id, column: 'committed_vnd' }, input.amountVnd);
    const entryId = randomUUID();
    const note = warned ? `AVC warning acknowledged at ${(lineVerdict.state === 'WARN' ? lineVerdict : (appropriationVerdict ?? lineVerdict)).consumptionPct}%` : null;
    await tx.query(
      `insert into machvon.capital_ledger_entry
         (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reason, posted_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COMMIT', $5::numeric, $6::integer, $7, $8::uuid, $9, $10::uuid)`,
      [entryId, appropriationId, row.line_id, row.project_id, input.amountVnd, row.plan_year, input.sourceKind, input.sourceId, note, actor],
    );
    const after = await tx.query<LineRow>(`${LINE_SELECT} where al.id = $1::uuid`, [input.allocationLineId]);
    const afterFigures = after[0] === undefined ? figures : figuresOfLine(after[0]);
    return this.result(
      row,
      appropriationId,
      entryId,
      input.amountVnd,
      evaluateAvc(afterFigures, lineThresholds),
      appropriationFigures === undefined || appropriationThresholds === undefined ? undefined : evaluateAvc({ ...appropriationFigures, committedVnd: (BigInt(appropriationFigures.committedVnd) + BigInt(input.amountVnd)).toString() }, appropriationThresholds),
      lineThresholds,
      false,
      warned,
      moved.version,
    );
  }

  private async appropriationFigures(tx: TenantTx, appropriationId: string): Promise<AvcFigures> {
    const [row] = await tx.query<{ amount: string; reserved: string; committed: string; disbursed: string }>(
      `select a.amount_vnd::text as amount, coalesce(sum(ab.reserved_vnd), 0)::text as reserved, coalesce(sum(ab.committed_vnd), 0)::text as committed, coalesce(sum(ab.disbursed_vnd), 0)::text as disbursed
         from machvon.appropriation a
         left join machvon.allocation_line al on al.tenant_id = a.tenant_id and al.appropriation_id = a.id
         left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
        where a.id = $1::uuid group by a.tenant_id, a.id`,
      [appropriationId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { allocatedVnd: row.amount, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed };
  }

  private result(
    row: LineRow,
    appropriationId: string,
    entryId: string,
    amountVnd: string,
    line: AvcVerdict,
    appropriation: AvcVerdict | undefined,
    thresholds: AvcThresholds,
    replayed: boolean,
    warningAcknowledged: boolean,
    balanceVersion: string | undefined,
  ): CommitResult {
    return {
      entryId,
      allocationLineId: row.line_id,
      appropriationId,
      projectId: row.project_id,
      planYear: row.plan_year ?? 0,
      amountVnd,
      line,
      appropriation,
      policyId: thresholds.policyId,
      replayed,
      warningAcknowledged,
      balanceVersion,
    };
  }
}
