import { randomUUID } from 'node:crypto';
import {
  DomainError,
  ROUNDING_MODES,
  affectedAcceptanceIds,
  assertAffectedMatches,
  assertFollowsRevision,
  assertNoApprovedSettlement,
  assertNotBeforeContract,
  assertNotProposer,
  assertRetroactiveDay,
  assertValueAboveFloor,
  compareDecimal,
  groupByBalance,
  repriceAcceptedLines,
  repricedItems,
  signedVnd,
  totalDelta,
  valueAfterChange,
  APPROVED_SETTLEMENT_STATUSES,
} from '@machvon/kernel';
import type { AcceptedLine, BalanceAdjustment, PricedItem, PriorAdjustment, RoundingMode, SettlementFact } from '@machvon/kernel';
import { CtrChangeChainStore } from './ctr-change-chain-store.ts';
import { CtrChangeRevisions, absoluteVnd } from './ctr-change-revision.ts';
import type { NewRevisionResult } from './ctr-change-revision.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { calendarDate, textOf } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { decisionDocument } from './ctr-decision-document.ts';
import type { DecisionHooks } from './ctr-change-decision-store.ts';
import { putRevisionInForce } from './ctr-revision-effective.ts';
import type { RevisionTakeover } from './ctr-revision-effective.ts';
import { PayLedgerStore } from './pay-ledger-store.ts';
import type { BalanceAdjustmentInput, PostedEntry } from './pay-ledger-store.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_TEXT = 2000;
/** The most acceptances one adjustment names: a change that reaches further is cut into several. */
const MAX_AFFECTED = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? {} : { extensions: { reason } });

export interface RetroactiveInput {
  /** Why the change reaches back: the words the decision rests on. */
  adjustmentBasis: string;
  decisionDocumentVersionId: string | undefined;
  /** Every acceptance the change re-prices, and no other. */
  affectedAcceptanceIds: readonly string[];
  /** The first day the change applies from, `YYYY-MM-DD`, before today. */
  effectiveOn: string;
  /** The signed amount the contract changes by; the assessment of the request when it is left out. */
  approvedDeltaVnd?: string | undefined;
  /** The BOQ of the new revision (the lines of an import, replacing the copy of the BOQ in force); absent, the revision starts from a copy of the BOQ in force. */
  boqLines?: unknown;
}

/** The port to the PAY ledger the adjustment posts its entries through (the cumulative ledger of ST-PAY-001). */
export interface LedgerAdjustments {
  adjust(tx: TenantTx, input: { contractId: string; adjustments: readonly BalanceAdjustmentInput[]; reason: string; requestId: string; actor: string }): Promise<PostedEntry[]>;
}

export interface AdjustedBalance extends Omit<BalanceAdjustment, 'lineIds'> {
  /** The line of the record of the adjustment, which the entry of the ledger names. */
  id: string;
  entryId: string;
}

/** The revision a retroactive adjustment made, already in force. */
export type InForceRevision = Omit<NewRevisionResult, 'status'> & { status: 'EFFECTIVE' };

export interface RetroactiveResult {
  id: string;
  code: string;
  status: 'APPROVED';
  fromStatus: 'EVALUATED';
  version: number;
  contractId: string;
  contractCode: string;
  projectId: string;
  adjustmentId: string;
  adjustmentBasis: string;
  effectiveOn: string;
  approvedOn: string;
  approvedDeltaVnd: string;
  decisionDocumentVersionId: string;
  allocationLineId: string | null;
  /** The line of capital the contract is committed against: where the capital is told the new value. */
  commitmentAllocationLineId: string | null;
  fromValueVnd: string;
  toValueVnd: string;
  revision: InForceRevision;
  supersededRevisionId: string | null;
  /** The sum of the signed differences posted on the ledger. */
  totalAdjustmentVnd: string;
  affectedAcceptanceIds: string[];
  balances: AdjustedBalance[];
  /** The version of the contract after the change. */
  contractVersion: number;
  acceptedTotalVnd: string;
}

interface CandidateSql {
  line_id: string;
  acceptance_id: string;
  acceptance_no: string | null;
  accepted_on: string;
  boq_item_id: string;
  party_id: string | null;
  quantity: string;
  unit_price_snapshot: string;
  amount_vnd: string;
}

interface SettlementSql {
  id: string;
  settlement_scope: SettlementFact['scope'];
  status: string;
  contract_id: string | null;
  project_id: string;
  fiscal_year: number | null;
}

const roundingOf = (value: string): RoundingMode => {
  const mode = ROUNDING_MODES.find((each) => each === value);
  if (mode === undefined) throw invalid('boq_lines', 'ROUNDING_RULE_UNKNOWN');
  return mode;
};

/**
 * The retroactive adjustment of a change order (ST-CTR-016, CTR 3.3 step 6, BR-CTR-03). An assessed CO whose price takes effect from a day before today is approved here and not by the
 * ordinary decision (422 `RETROACTIVE_NOT_ALLOWED`), by someone who had no part in its chain (403 `SELF_APPROVAL_DENIED`), on a decision document, and while no settlement that has read the
 * ledger is approved (409 `SETTLEMENT_ALREADY_APPROVED`). It makes the next revision of the contract (flagged retroactive, in force from today) and takes it over at once, because the ledger it
 * adjusts is judged against the value the contract has after the change. The acceptances it reaches keep their lines and their amounts as they were approved; the money difference of each
 * balance (the rules of the kernel: only items whose price the change moves, from the effective day on, as the difference of the rounded amounts between what the balance is worth, counting the earlier adjustments, and what it is worth at the new price) is a new `ADJUSTMENT` entry of the cumulative
 * ledger of PAY, and the adjustment, its lines and the decision document are recorded. The caller names the affected acceptances and they must be exactly the ones the change reaches.
 */
export class CtrRetroactiveStore {
  private readonly chain: CtrChangeChainStore;
  private readonly revisions = new CtrChangeRevisions();
  private readonly source: CtrContractSource;
  private readonly ledger: LedgerAdjustments;

  constructor(source: CtrContractSource = new CtrContractSource(), ledger: LedgerAdjustments = new PayLedgerStore()) {
    this.source = source;
    this.chain = new CtrChangeChainStore(source);
    this.ledger = ledger;
  }

  async approve(tx: TenantTx, id: string, expectedVersion: number, input: RetroactiveInput, actor: string, scopes: ContractScopes, today: string, hooks: DecisionHooks): Promise<RetroactiveResult> {
    const basis = textOf(input.adjustmentBasis, 'adjustment_basis', MAX_TEXT);
    const effectiveOn = calendarDate(input.effectiveOn, 'effective_on');
    const asked = this.affectedOf(input.affectedAcceptanceIds);

    const { row, contract } = await this.chain.lock(tx, id, expectedVersion, scopes);
    if (row.stage !== 'CO') throw new DomainError('CHANGE_STAGE_NOT_ALLOWED', 422, 'stage', { extensions: { stage: row.stage, reason: 'ONLY_CO_DECIDED' } });
    if (row.status !== 'EVALUATED') throw new DomainError('CHANGE_STATE_INVALID', 409, 'status', { extensions: { change_status: row.status } });
    if (contract.status !== 'ACTIVE' && contract.status !== 'SUSPENDED') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    const document = await decisionDocument(tx, input.decisionDocumentVersionId, 'decision_document_version_id');
    assertNotProposer(actor, [...(await this.revisions.makersOf(tx, row)), document.maker]);
    assertRetroactiveDay(effectiveOn, today);
    assertNotBeforeContract(effectiveOn, await this.contractBeganOn(tx, contract.id));
    const delta = signedVnd(input.approvedDeltaVnd ?? row.evaluated_delta_vnd ?? '', 'approved_delta_vnd');

    // The contract is held first by the lock of the request; an approved settlement that has read its ledger closes the adjustment before anything is written.
    assertNoApprovedSettlement(await this.settlementsOf(tx, contract.projectId), { contractId: contract.id, projectId: contract.projectId, postingYear: Number(today.slice(0, 4)) });

    const head = await this.revisions.head(tx, contract.id);
    if (head.status !== 'EFFECTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { reason: 'REVISION_PENDING', revision_id: head.id } });
    assertFollowsRevision(today, head.valid_from);
    const newValue = valueAfterChange(head.amount_vnd, delta);
    if (compareDecimal(newValue, '0') <= 0) throw invalid('approved_delta_vnd');

    const revision = await this.revisions.make(tx, { head, contractId: contract.id, row, value: newValue, validFrom: today, documentVersionId: document.versionId, actor, boqLines: input.boqLines, scopes, retroactive: true });
    const repricing = await this.repricing(tx, head.id, revision.id);
    const reached = repriceAcceptedLines(await this.acceptedLines(tx, contract.id, effectiveOn, [...repricing.keys()]), repricing, effectiveOn);
    // A balance is moved from what it is worth now, the amounts of its lines and the differences earlier adjustments posted on it, to its worth at the new price.
    const balances = groupByBalance(reached, await this.priorAdjustments(tx, contract.id, [...new Set(reached.map((line) => line.acceptanceId))]));
    assertAffectedMatches(asked, affectedAcceptanceIds(balances));
    const total = totalDelta(balances);

    const project = await this.source.projectRef(tx, contract.projectId);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const exposure = compareDecimal(absoluteVnd(delta), absoluteVnd(total)) >= 0 ? absoluteVnd(delta) : absoluteVnd(total);
    // The tiers of the change orders: the same gate as the decision, and the authority is asked for the larger of the exposure and the cumulative variation.
    const gated = hooks.gate === undefined ? undefined : await hooks.gate({ changeId: row.id, contractId: contract.id, projectId: contract.projectId, deltaVnd: delta });
    await hooks.authorise({ amountVnd: gated !== undefined && compareDecimal(gated.authorityAmountVnd, exposure) > 0 ? gated.authorityAmountVnd : exposure, contractId: contract.id, projectId: contract.projectId, ownerUnit: project.ownerUnit });
    const figures = await this.revisions.figuresOf(tx, contract.id);
    const acceptedAfter = (BigInt(figures.acceptedTotalVnd) + BigInt(total)).toString();
    assertValueAboveFloor(newValue, { ...figures, acceptedTotalVnd: acceptedAfter });
    if (compareDecimal(delta, '0') > 0) {
      if (row.evaluation_allocation_line_id === null) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
      await hooks.available(row.evaluation_allocation_line_id, delta);
    }

    const adjustmentId = randomUUID();
    const lineIds = balances.map(() => randomUUID());
    await this.record(tx, { adjustmentId, contractId: contract.id, changeRequestId: row.id, revisionId: revision.id, effectiveOn, today, basis, documentVersionId: document.versionId, total, balances, lineIds, actor });
    const entries = await this.ledger.adjust(tx, {
      contractId: contract.id,
      reason: basis,
      requestId: adjustmentId,
      actor,
      adjustments: balances.map((balance, index) => ({ adjustmentLineId: lineIds[index] as string, acceptanceId: balance.acceptanceId, boqItemId: balance.boqItemId, partyId: balance.partyId, deltaVnd: balance.deltaVnd })),
    });

    // `contract_ledger_order_chk` (accepted total <= value) is judged after each statement, so the two updates of the contract go in the order that keeps every figure in between valid: when the
    // total rises the revision takes over first (the total may go above the value the contract had, never above the value it has); when it falls the total moves first (the value may go below
    // the total the contract had, never below the one it has). The final figures were judged by the floor above.
    const takeOver = (): Promise<RevisionTakeover> => putRevisionInForce(tx, { contractId: contract.id, revisionId: revision.id, validFrom: today, amountVnd: newValue, actor });
    let takeover: RevisionTakeover;
    let contractVersion: number;
    if (BigInt(total) < 0n) {
      await this.moveAcceptedTotal(tx, contract.id, total, actor);
      takeover = await takeOver();
      contractVersion = takeover.version;
    } else {
      takeover = await takeOver();
      contractVersion = total === '0' ? takeover.version : await this.moveAcceptedTotal(tx, contract.id, total, actor);
    }
    await tx.query(
      `update machvon.change_request
          set status = 'APPROVED', status_reason = $2, approved_delta_vnd = $3::numeric, effective_on = $4::date, retroactive = true, decision_document_version_id = $5::uuid,
              resulting_revision_id = $6::uuid, decided_by = $7::uuid, decided_at = now(), updated_at = now(), updated_by = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [row.id, basis, delta, effectiveOn, document.versionId, revision.id, actor],
    );
    return {
      id: row.id,
      code: row.code ?? row.id,
      status: 'APPROVED',
      fromStatus: 'EVALUATED',
      version: Number(row.version) + 1,
      contractId: contract.id,
      contractCode: row.contract_code,
      projectId: contract.projectId,
      adjustmentId,
      adjustmentBasis: basis,
      effectiveOn,
      approvedOn: today,
      approvedDeltaVnd: delta,
      decisionDocumentVersionId: document.versionId,
      allocationLineId: row.evaluation_allocation_line_id,
      commitmentAllocationLineId: await this.commitmentLineOf(tx, contract.id),
      fromValueVnd: takeover.fromValueVnd,
      toValueVnd: newValue,
      revision: { ...revision, status: 'EFFECTIVE' },
      supersededRevisionId: takeover.supersededId,
      totalAdjustmentVnd: total,
      affectedAcceptanceIds: affectedAcceptanceIds(balances),
      balances: balances.map((balance, index) => ({
        id: lineIds[index] as string,
        entryId: entries[index]?.id as string,
        acceptanceId: balance.acceptanceId,
        acceptanceNo: balance.acceptanceNo,
        boqItemId: balance.boqItemId,
        partyId: balance.partyId,
        quantity: balance.quantity,
        oldAmountVnd: balance.oldAmountVnd,
        newUnitPrice: balance.newUnitPrice,
        newAmountVnd: balance.newAmountVnd,
        deltaVnd: balance.deltaVnd,
      })),
      contractVersion,
      acceptedTotalVnd: acceptedAfter,
    };
  }

  // ---- what the adjustment is judged on --------------------------------------------------------------------------------------

  /** Moves the accepted total of the contract by the signed total of the adjustment; the version of the contract after it. */
  private async moveAcceptedTotal(tx: TenantTx, contractId: string, total: string, actor: string): Promise<number> {
    const moved = await tx.query<{ version: string }>(
      'update machvon.contract set accepted_total_vnd = accepted_total_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
      [contractId, total, actor],
    );
    return Number(moved[0]?.version ?? '0');
  }

  /** The differences earlier adjustments of the contract posted on the balances of these acceptances, one row for each balance (the lines of every record, summed). */
  private async priorAdjustments(tx: TenantTx, contractId: string, acceptanceIds: readonly string[]): Promise<PriorAdjustment[]> {
    if (acceptanceIds.length === 0) return [];
    const rows = await tx.query<{ acceptance_id: string; boq_item_id: string; party_id: string | null; delta_vnd: string }>(
      `select acceptance_id, boq_item_id, party_id, sum(delta_vnd)::text as delta_vnd from machvon.retroactive_adjustment_line
        where contract_id = $1::uuid and acceptance_id = any($2::uuid[]) group by acceptance_id, boq_item_id, party_id`,
      [contractId, acceptanceIds],
    );
    return rows.map((row) => ({ acceptanceId: row.acceptance_id, boqItemId: row.boq_item_id, partyId: row.party_id, deltaVnd: row.delta_vnd }));
  }

  private async commitmentLineOf(tx: TenantTx, contractId: string): Promise<string | null> {
    const rows = await tx.query<{ allocation_line_id: string | null }>(
      'select k.allocation_line_id from machvon.contract c left join machvon.procurement_package k on k.tenant_id = c.tenant_id and k.id = c.package_id where c.id = $1::uuid',
      [contractId],
    );
    return rows[0]?.allocation_line_id ?? null;
  }

  private affectedOf(ids: readonly string[]): string[] {
    if (ids.length > MAX_AFFECTED || ids.some((each) => !UUID.test(each))) throw invalid('affected_acceptance_ids');
    return [...new Set(ids.map((each) => each.toLowerCase()))].sort();
  }

  /** The day the contract began: the first day of its first revision. */
  private async contractBeganOn(tx: TenantTx, contractId: string): Promise<string> {
    const rows = await tx.query<{ began: string | null }>('select min(valid_from)::text as began from machvon.contract_revision where contract_id = $1::uuid', [contractId]);
    return rows[0]?.began ?? '0001-01-01';
  }

  private async settlementsOf(tx: TenantTx, projectId: string): Promise<SettlementFact[]> {
    const rows = await tx.query<SettlementSql>(
      'select id, settlement_scope, status, contract_id, project_id, fiscal_year from machvon.settlement_revision where project_id = $1::uuid and status = any($2::text[]) order by revision, id',
      [projectId, [...APPROVED_SETTLEMENT_STATUSES]],
    );
    return rows.map((row) => ({ id: row.id, scope: row.settlement_scope, status: row.status, contractId: row.contract_id, projectId: row.project_id, fiscalYear: row.fiscal_year }));
  }

  /** The items whose unit price the new revision changes against the revision in force, with the price and rounding of the new line. */
  private async repricing(tx: TenantTx, inForceRevisionId: string, nextRevisionId: string): Promise<ReadonlyMap<string, { unitPrice: string; roundingRule: RoundingMode }>> {
    const read = async (revisionId: string): Promise<PricedItem[]> => {
      const rows = await tx.query<{ boq_item_id: string; unit_price: string; rounding_rule: string }>(
        'select boq_item_id, unit_price::text as unit_price, rounding_rule from machvon.boq_line where contract_revision_id = $1::uuid',
        [revisionId],
      );
      return rows.map((row) => ({ boqItemId: row.boq_item_id, unitPrice: row.unit_price, roundingRule: roundingOf(row.rounding_rule) }));
    };
    return repricedItems(await read(inForceRevisionId), await read(nextRevisionId));
  }

  /** The approved, active lines of the contract accepted on the effective day or after, of the items whose price the new revision changes. */
  private async acceptedLines(tx: TenantTx, contractId: string, effectiveOn: string, items: readonly string[]): Promise<AcceptedLine[]> {
    if (items.length === 0) return [];
    const rows = await tx.query<CandidateSql>(
      `select l.id as line_id, l.acceptance_id, a.acceptance_no, a.accepted_on::text as accepted_on, l.boq_item_id, l.party_id, l.quantity::text as quantity,
              l.unit_price_snapshot::text as unit_price_snapshot, l.amount_vnd::text as amount_vnd
         from machvon.acceptance_line l join machvon.acceptance a on a.tenant_id = l.tenant_id and a.id = l.acceptance_id
        where a.contract_id = $1::uuid and a.status = 'APPROVED' and l.active and a.accepted_on >= $2::date and l.boq_item_id = any($3::uuid[])
        order by l.acceptance_id, l.id`,
      [contractId, effectiveOn, items],
    );
    return rows.map((row) => ({
      acceptanceId: row.acceptance_id,
      acceptanceNo: row.acceptance_no,
      acceptedOn: row.accepted_on,
      lineId: row.line_id,
      boqItemId: row.boq_item_id,
      partyId: row.party_id,
      quantity: row.quantity,
      unitPriceSnapshot: row.unit_price_snapshot,
      amountVnd: row.amount_vnd,
    }));
  }

  /** Writes the record of the adjustment: the header, with the decision document, and a line for each balance the ledger entries will name. */
  private async record(
    tx: TenantTx,
    values: {
      adjustmentId: string;
      contractId: string;
      changeRequestId: string;
      revisionId: string;
      effectiveOn: string;
      today: string;
      basis: string;
      documentVersionId: string;
      total: string;
      balances: readonly BalanceAdjustment[];
      lineIds: readonly string[];
      actor: string;
    },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.retroactive_adjustment
         (tenant_id, id, contract_id, change_request_id, revision_id, effective_on, approved_on, basis, decision_document_version_id, line_count, acceptance_count, total_delta_vnd, created_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, $8::uuid, $9, $10, $11::numeric, $12::uuid)`,
      [
        values.adjustmentId,
        values.contractId,
        values.changeRequestId,
        values.revisionId,
        values.effectiveOn,
        values.today,
        values.basis,
        values.documentVersionId,
        values.balances.length,
        affectedAcceptanceIds(values.balances).length,
        values.total,
        values.actor,
      ],
    );
    for (const [index, balance] of values.balances.entries()) {
      await tx.query(
        `insert into machvon.retroactive_adjustment_line
           (tenant_id, id, adjustment_id, contract_id, acceptance_id, boq_item_id, party_id, quantity, old_amount_vnd, new_unit_price, new_amount_vnd, delta_vnd, created_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::uuid)`,
        [values.lineIds[index], values.adjustmentId, values.contractId, balance.acceptanceId, balance.boqItemId, balance.partyId, balance.quantity, balance.oldAmountVnd, balance.newUnitPrice, balance.newAmountVnd, balance.deltaVnd, values.actor],
      );
    }
  }
}
