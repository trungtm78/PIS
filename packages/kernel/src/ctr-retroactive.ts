import { addDecimal, compareDecimal } from './decimal.ts';
import type { RoundingMode } from './decimal.ts';
import { lineAmount, sumAmounts } from './ctr-acceptance.ts';
import { DomainError } from './errors.ts';
import type { LedgerDelta } from './pay-ledger.ts';
import type { SettlementScope } from './pay-project-settlement.ts';

/**
 * The retroactive adjustment of a contract (ST-CTR-016, CTR 3.3 step 6, BR-CTR-03). A change order whose price takes effect from a day before the day it is approved does not rewrite what was
 * accepted under the old price: the lines of the acceptances stay as they were approved, and the money difference is a new entry of the cumulative ledger (PAY) on the balance of each
 * acceptance that the new price reaches. The rules of that difference are these, kept here apart from the database so a test can run them:
 *
 * 1. Only the items whose unit price the change order changes (against the BOQ in force when it is approved) are re-priced. An item at the same price is not touched, whatever the snapshots of
 *    older acceptances say: a revision in between that raised another price is not undone by this change.
 * 2. Every approved line of such an item accepted on the effective day or after is re-priced at the new price, whichever revision priced it: the change order stands over the revisions since its
 *    day. The new amount of a line is the quantity at the new price rounded as the new line of the BOQ is rounded, exactly as if the line had been accepted at the new price.
 * 3. The difference of a line is the new amount less the amount it was accepted for (the difference of the rounded amounts, not of the prices times the quantity, so no cent is lost or made by
 *    rounding twice). It is positive when the price rises and negative when it falls; the ledger entry carries that sign on the accepted amount and on nothing else.
 * 4. The lines of one item of one acceptance (and member of a joint venture) are one balance of the ledger and one adjustment.
 * 5. The caller names the affected acceptances and the list must be exactly the acceptances that rule 2 finds.
 * 6. An approved settlement, which has read the ledger, closes the adjustment.
 */

/** An approved line of an acceptance as the adjustment reads it: the price and the amount it was accepted at, never changed by the adjustment. */
export interface AcceptedLine {
  acceptanceId: string;
  acceptanceNo: string | null;
  /** The day of the acceptance, `YYYY-MM-DD`. */
  acceptedOn: string;
  lineId: string;
  boqItemId: string;
  partyId: string | null;
  quantity: string;
  unitPriceSnapshot: string;
  amountVnd: string;
}

/** The new price of an item and the way its line of the BOQ rounds. */
export interface Repricing {
  unitPrice: string;
  roundingRule: RoundingMode;
}

/** A line of a BOQ as the comparison of two revisions reads it. */
export interface PricedItem extends Repricing {
  boqItemId: string;
}

export interface RepricedLine extends AcceptedLine {
  newUnitPrice: string;
  newAmountVnd: string;
  /** New amount less the amount accepted, signed. */
  deltaVnd: string;
}

/** The adjustment of one balance of the ledger: one item of one acceptance (and member). */
export interface BalanceAdjustment {
  acceptanceId: string;
  acceptanceNo: string | null;
  boqItemId: string;
  partyId: string | null;
  lineIds: string[];
  quantity: string;
  oldAmountVnd: string;
  newUnitPrice: string;
  newAmountVnd: string;
  deltaVnd: string;
}

/** The settlements that read the ledger are approved once their figures were verified. */
export const APPROVED_SETTLEMENT_STATUSES = ['VERIFIED', 'CLOSED'] as const;

/**
 * 422 `VALIDATION_FAILED` on `effective_on` unless the day is before the day of the approval. A change that begins today or later is not retroactive and goes through the ordinary decision of the
 * change order (`RETROACTIVE_NOT_ALLOWED` is the refusal the other way round). Days as `YYYY-MM-DD`, which compare as text.
 */
export function assertRetroactiveDay(effectiveOn: string, today: string): void {
  if (effectiveOn >= today) throw new DomainError('VALIDATION_FAILED', 422, 'effective_on', { extensions: { reason: 'NOT_RETROACTIVE', effective_on: effectiveOn, approved_on: today } });
}

/** 422 `VALIDATION_FAILED` on `effective_on` when the day is before the contract began: there is nothing accepted to reach back to. */
export function assertNotBeforeContract(effectiveOn: string, contractBeganOn: string): void {
  if (effectiveOn < contractBeganOn) throw new DomainError('VALIDATION_FAILED', 422, 'effective_on', { extensions: { reason: 'BEFORE_CONTRACT', effective_on: effectiveOn, contract_began_on: contractBeganOn } });
}

/**
 * The items whose unit price the new BOQ changes against the BOQ in force (rule 1), with the price and rounding the new BOQ gives them. Prices are compared as numbers (`1500000` equals
 * `1500000.000000`); an item the new BOQ no longer prices or newly adds has no accepted work to re-price, and a rounding rule alone changes no price.
 */
export function repricedItems(inForce: readonly PricedItem[], next: readonly PricedItem[]): Map<string, Repricing> {
  const before = new Map(inForce.map((item) => [item.boqItemId, item]));
  const changed = new Map<string, Repricing>();
  for (const item of next) {
    const was = before.get(item.boqItemId);
    if (was !== undefined && compareDecimal(was.unitPrice, item.unitPrice) !== 0) changed.set(item.boqItemId, { unitPrice: item.unitPrice, roundingRule: item.roundingRule });
  }
  return changed;
}

/**
 * The lines the change reaches and what each differs by (rules 2 and 3): lines of a re-priced item accepted on the effective day or after, whose amount at the new price is not the amount they were
 * accepted for. The caller passes approved, active lines only.
 */
export function repriceAcceptedLines(lines: readonly AcceptedLine[], repricing: ReadonlyMap<string, Repricing>, effectiveOn: string): RepricedLine[] {
  const repriced: RepricedLine[] = [];
  for (const line of lines) {
    const price = repricing.get(line.boqItemId);
    if (price === undefined || line.acceptedOn < effectiveOn) continue;
    const newAmountVnd = lineAmount(line.quantity, price.unitPrice, price.roundingRule);
    const deltaVnd = (BigInt(newAmountVnd) - BigInt(line.amountVnd)).toString();
    if (deltaVnd === '0') continue;
    repriced.push({ ...line, newUnitPrice: price.unitPrice, newAmountVnd, deltaVnd });
  }
  return repriced;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One adjustment for each balance of the ledger (rule 4), in the order of the acceptance, the item and the member (no member first), so a retried call posts the same entries in the same order. */
export function groupByBalance(lines: readonly RepricedLine[]): BalanceAdjustment[] {
  const groups = new Map<string, RepricedLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.acceptanceId, line.boqItemId, line.partyId]);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.values()]
    .map((members): BalanceAdjustment => {
      const first = members[0]!;
      return {
        acceptanceId: first.acceptanceId,
        acceptanceNo: first.acceptanceNo,
        boqItemId: first.boqItemId,
        partyId: first.partyId,
        lineIds: members.map((member) => member.lineId).sort(compareText),
        quantity: members.reduce((sum, member) => addDecimal(sum, member.quantity), '0'),
        oldAmountVnd: sumAmounts(members.map((member) => member.amountVnd)),
        newUnitPrice: first.newUnitPrice,
        newAmountVnd: sumAmounts(members.map((member) => member.newAmountVnd)),
        deltaVnd: sumAmounts(members.map((member) => member.deltaVnd)),
      };
    })
    .sort((a, b) => compareText(a.acceptanceId, b.acceptanceId) || compareText(a.boqItemId, b.boqItemId) || compareText(a.partyId ?? '', b.partyId ?? ''));
}

/** The sum of the signed differences. */
export function totalDelta(adjustments: readonly Pick<BalanceAdjustment, 'deltaVnd'>[]): string {
  return sumAmounts(adjustments.map((adjustment) => adjustment.deltaVnd));
}

/** The acceptances the adjustments reach, each once, in order. */
export function affectedAcceptanceIds(adjustments: readonly Pick<BalanceAdjustment, 'acceptanceId'>[]): string[] {
  return [...new Set(adjustments.map((adjustment) => adjustment.acceptanceId))].sort(compareText);
}

/** What the entry of the ledger adds to the balance: the signed difference on the accepted amount, and nothing on what was requested, paid, recovered or held. */
export function adjustmentLedgerDelta(deltaVnd: string): LedgerDelta {
  return { accepted: deltaVnd, requested: '0', paid: '0', advanceRecovery: '0', retention: '0' };
}

/** 422 `VALIDATION_FAILED` on `affected_acceptance_ids` unless the caller named exactly the acceptances the change reaches (rule 5); the extensions say which are missing and which are not affected. */
export function assertAffectedMatches(asked: readonly string[], computed: readonly string[]): void {
  const named = new Set(asked);
  const found = new Set(computed);
  const missing = [...found].filter((id) => !named.has(id)).sort(compareText);
  const unexpected = [...named].filter((id) => !found.has(id)).sort(compareText);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new DomainError('VALIDATION_FAILED', 422, 'affected_acceptance_ids', { extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: missing, unexpected_acceptance_ids: unexpected } });
  }
}

/** A settlement as the adjustment reads it. */
export interface SettlementFact {
  id: string;
  scope: SettlementScope;
  status: string;
  contractId: string | null;
  projectId: string;
  fiscalYear: number | null;
}

/** What an entry posted now would reach: the contract, its project and the year (Vietnam time) of the day it is posted. */
export interface PostingTarget {
  contractId: string;
  projectId: string;
  postingYear: number;
}

/**
 * Whether an approved settlement has read, or will read, the entry the adjustment posts (rule 6). A settlement of a contract reads that contract's ledger, one of a project reads the ledger of its
 * contracts, and one of a year reads the entries posted before the year ends: the year of the posting and the years after it, never an earlier one whose entries were all posted by then.
 */
export function settlementBlocks(settlement: SettlementFact, target: PostingTarget): boolean {
  if (!(APPROVED_SETTLEMENT_STATUSES as readonly string[]).includes(settlement.status) || settlement.projectId !== target.projectId) return false;
  if (settlement.scope === 'CONTRACT') return settlement.contractId === target.contractId;
  if (settlement.scope === 'PROJECT') return true;
  return settlement.fiscalYear !== null && settlement.fiscalYear >= target.postingYear;
}

/** 409 `SETTLEMENT_ALREADY_APPROVED` naming the first settlement that has read the ledger the adjustment would change. */
export function assertNoApprovedSettlement(settlements: readonly SettlementFact[], target: PostingTarget): void {
  const blocking = settlements.find((settlement) => settlementBlocks(settlement, target));
  if (blocking !== undefined) {
    throw new DomainError('SETTLEMENT_ALREADY_APPROVED', 409, 'settlement', { extensions: { settlement_id: blocking.id, settlement_scope: blocking.scope, settlement_status: blocking.status } });
  }
}
