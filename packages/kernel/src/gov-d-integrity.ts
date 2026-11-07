import { DomainError } from './errors.ts';
import { builtInDefault, validateRuleParams } from './governance-rules.ts';
import { contractAvailability, sharePct } from './money-control.ts';
import { signedDong, wholeVnd } from './pay-money.ts';

/**
 * The checks of a payment request before money goes out (G4-2, lane D): a request is the same request sent twice, a price far from the contract or from what the others paid, a quantity that the diary of the site does
 * not bear out, or an amount above the capital plan line, the price of the contract or the value that was accepted. Every function here is pure: it takes facts as data and the thresholds of the rule PAYMENT_INTEGRITY as
 * arguments (the rule is data a tenant approves, read through the governance port), so every case runs without a database. An INVARIANT finding blocks sending the request (unless an approved exception covers it), a SIGNAL
 * finding only asks the approver to look. Amounts are whole dong over BigInt; a unit price keeps its six decimals.
 */

export type IntegrityCode = 'DUPLICATE_CLAIM' | 'UNIT_PRICE_OUTLIER' | 'QUANTITY_VS_DIARY' | 'EXCEEDS_CONTRACT' | 'EXCEEDS_PLAN' | 'EXCEEDS_ACCEPTED';
export const INTEGRITY_CODES: readonly IntegrityCode[] = ['DUPLICATE_CLAIM', 'UNIT_PRICE_OUTLIER', 'QUANTITY_VS_DIARY', 'EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'EXCEEDS_ACCEPTED'];
export type IntegrityKind = 'INVARIANT' | 'SIGNAL';
export type IntegritySeverity = 'BLOCK' | 'WARN';
/** The ceilings an exception can cover: the value of an acceptance has no exception (the ledger keeps it). */
export const EXCEPTIONAL_CEILINGS = ['EXCEEDS_PLAN', 'EXCEEDS_CONTRACT'] as const;
export type ExceptionalCeiling = (typeof EXCEPTIONAL_CEILINGS)[number];
export const isExceptionalCeiling = (value: unknown): value is ExceptionalCeiling => EXCEPTIONAL_CEILINGS.includes(value as ExceptionalCeiling);

export type IntegrityValue = string | number | boolean | null | readonly string[];
export interface IntegrityFinding {
  code: IntegrityCode;
  kind: IntegrityKind;
  severity: IntegritySeverity;
  /** What the finding is about (a line, a peer request): identifiers only, never free text. */
  subject: Record<string, string>;
  /** The figures behind it, so a reader can check them. */
  params: Record<string, IntegrityValue>;
}

export type IntegrityOutcome = 'PASSED' | 'SIGNALS' | 'BLOCKED' | 'PARTIAL';
/** The sources the checks read; one that could not be read is named in `unavailable` and the run is never PASSED. */
export const INTEGRITY_SOURCES = ['DUPLICATES', 'PRICES', 'DIARY', 'CEILINGS'] as const;
export type IntegritySource = (typeof INTEGRITY_SOURCES)[number];

// ---- the rule ---------------------------------------------------------------------------------------------------------------------------------

export type DuplicateAttribute = 'NUMBER' | 'SUPPLIER' | 'AMOUNT' | 'DATE';
export type CeilingMode = 'BLOCK' | 'WARN';
export type PaymentIntegrityParams = {
  duplicate: { block_attrs: DuplicateAttribute[]; signal_min_matches: number; lookback_days: number };
  unit_price: { contract_tolerance_pct: number; peer_min: number; robust_z: number };
  diary: { tolerance_pct: number; min_diary_days_ratio: number };
  ceilings: { plan: CeilingMode; contract: CeilingMode; accepted: CeilingMode };
  exception_max_days: number;
};

export const PAYMENT_INTEGRITY_TYPE = 'PAYMENT_INTEGRITY';
export const PAYMENT_INTEGRITY_CODE = 'DEFAULT';

/** The params of the rule as the checks read them; whatever the schema of the registered type refuses is 422 GOVERNANCE_RULE_PARAMS_INVALID (a rule that cannot be understood is never half applied). */
export const parsePaymentIntegrityParams = (params: unknown): PaymentIntegrityParams => validateRuleParams(PAYMENT_INTEGRITY_TYPE, params) as unknown as PaymentIntegrityParams;

/** The built-in default of the platform (unverified: a starting value of the research), the fallback of the store when the port cannot give one. */
export function paymentIntegrityFallback(): { params: PaymentIntegrityParams; unverified: boolean } {
  const found = builtInDefault(PAYMENT_INTEGRITY_TYPE, PAYMENT_INTEGRITY_CODE);
  if (found === undefined) throw new Error('governance rule registry: PAYMENT_INTEGRITY has no default');
  return { params: parsePaymentIntegrityParams(found.params), unverified: found.unverified };
}

const finding = (code: IntegrityCode, kind: IntegrityKind, subject: Record<string, string>, params: Record<string, IntegrityValue>): IntegrityFinding => ({ code, kind, severity: kind === 'INVARIANT' ? 'BLOCK' : 'WARN', subject, params });
const kindOfMode = (mode: CeilingMode): IntegrityKind => (mode === 'BLOCK' ? 'INVARIANT' : 'SIGNAL');

// ---- duplicates -------------------------------------------------------------------------------------------------------------------------------

export interface ClaimIdentity {
  id: string;
  /** The number of the request and the numbers of its invoices: two requests with a number in common have the same number. */
  numbers: readonly string[];
  supplierId: string | null;
  grossVnd: string;
  invoiceDates: readonly string[];
}

/** A number as it is compared: letters and digits only, upper case, so `INV-001` and `inv 001` are one. */
export const normalizedNumber = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

function matchedAttributes(request: ClaimIdentity, other: ClaimIdentity): DuplicateAttribute[] {
  const mine = new Set(request.numbers.map(normalizedNumber).filter((number) => number !== ''));
  const matched: DuplicateAttribute[] = [];
  if (other.numbers.map(normalizedNumber).some((number) => mine.has(number))) matched.push('NUMBER');
  if (request.supplierId !== null && request.supplierId === other.supplierId) matched.push('SUPPLIER');
  if (request.grossVnd === other.grossVnd) matched.push('AMOUNT');
  const dates = new Set(request.invoiceDates);
  if (other.invoiceDates.some((date) => dates.has(date))) matched.push('DATE');
  return matched;
}

/**
 * The same claim twice (DUPLICATE_CLAIM): another request (one that is not returned or cancelled, within the look-back) that matches on every attribute the rule blocks on is an INVARIANT; one that matches on at least
 * `signal_min_matches` attributes without that is a SIGNAL (it may be a new instalment that looks alike). Each other request is told once, with the attributes that matched.
 */
export function duplicateFindings(request: ClaimIdentity, others: readonly ClaimIdentity[], params: PaymentIntegrityParams['duplicate']): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const other of others) {
    if (other.id === request.id) continue;
    const matched = matchedAttributes(request, other);
    const blocks = params.block_attrs.length > 0 && params.block_attrs.every((attribute) => matched.includes(attribute));
    if (!blocks && matched.length < params.signal_min_matches) continue;
    out.push(finding('DUPLICATE_CLAIM', blocks ? 'INVARIANT' : 'SIGNAL', { other_request_id: other.id }, { matched, matched_count: matched.length, block_attrs: [...params.block_attrs], gross_vnd: request.grossVnd, other_gross_vnd: other.grossVnd }));
  }
  return out.sort((left, right) => (left.kind === right.kind ? (left.subject.other_request_id ?? '').localeCompare(right.subject.other_request_id ?? '') : left.kind === 'INVARIANT' ? -1 : 1));
}

// ---- unit prices ------------------------------------------------------------------------------------------------------------------------------

const MICRO = 1_000_000n;
const DECIMAL = /^(0|[1-9][0-9]{0,17})(?:\.([0-9]{1,6}))?$/;

/** A non-negative price with up to six decimals in millionths. */
export function microUnits(value: string, field: string): bigint {
  const match = DECIMAL.exec(value);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason: 'NOT_A_PRICE' } });
  return BigInt(match[1] ?? '0') * MICRO + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
}

export interface PriceLine {
  lineId: string;
  /** The item of the bill of quantities: its key and unit are what makes two prices comparable. */
  boqKey: string;
  unitCode: string;
  /** The price on the acceptance line (what the request is worth per unit). */
  unitPrice: string;
  /** The price of the line in the contract revision in force; null when there is none to compare with. */
  contractUnitPrice: string | null;
  /** The prices of the same item and unit on other acceptances of the tenant within the look-back (not this request's). */
  peerPrices: readonly string[];
}

const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** Median and median absolute deviation of a set of prices (as numbers: a signal does not need the last digit). */
export function robustCentre(prices: readonly string[]): { median: number; mad: number } {
  const values = prices.map((price) => Number(microUnits(price, 'price')) / 1e6).sort((a, b) => a - b);
  const centre = median(values);
  const deviations = values.map((value) => Math.abs(value - centre)).sort((a, b) => a - b);
  return { median: centre, mad: median(deviations) };
}

/**
 * UNIT_PRICE_OUTLIER (a SIGNAL): a line whose unit price differs from the price of the same line in the contract by more than `contract_tolerance_pct`, or from the others who were paid for the same item and unit by a
 * robust z-score above `robust_z` (0.6745 x distance from the median over the median absolute deviation; with fewer than `peer_min` peers there is nothing to compare with and no finding; when the peers all agree
 * the deviation is read against the median with the same percentage tolerance as the contract's).
 */
export function unitPriceFindings(lines: readonly PriceLine[], params: PaymentIntegrityParams['unit_price']): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  const tolerance = BigInt(Math.round(params.contract_tolerance_pct * 100)); // hundredths of a percent
  for (const line of lines) {
    const price = microUnits(line.unitPrice, 'unit_price');
    const reasons: string[] = [];
    const figures: Record<string, IntegrityValue> = { unit_price: line.unitPrice, unit_code: line.unitCode, boq_key: line.boqKey };
    if (line.contractUnitPrice !== null) {
      const contract = microUnits(line.contractUnitPrice, 'contract_unit_price');
      const distance = price > contract ? price - contract : contract - price;
      // |p - c| / c > tolerance / 10000  <=>  |p - c| * 10000 > tolerance * c (a contract price of nothing: any price above nothing differs)
      const differs = contract === 0n ? price > 0n : distance * 10_000n > tolerance * contract;
      figures.contract_unit_price = line.contractUnitPrice;
      figures.contract_deviation_pct = sharePct(price > contract ? distance : -distance, contract);
      if (differs) reasons.push('CONTRACT_PRICE');
    }
    if (line.peerPrices.length >= params.peer_min) {
      const centre = robustCentre(line.peerPrices);
      const value = Number(price) / 1e6;
      const away = Math.abs(value - centre.median);
      figures.peer_count = line.peerPrices.length;
      figures.peer_median = centre.median;
      figures.peer_mad = centre.mad;
      const outlier = centre.mad === 0 ? (centre.median === 0 ? value > 0 : (away / centre.median) * 100 > params.contract_tolerance_pct) : (0.6745 * away) / centre.mad > params.robust_z;
      if (outlier) reasons.push('PEER_PRICES');
    }
    if (reasons.length > 0) out.push(finding('UNIT_PRICE_OUTLIER', 'SIGNAL', { line_id: line.lineId }, { ...figures, reasons }));
  }
  return out;
}

// ---- the diary of the site --------------------------------------------------------------------------------------------------------------------

export interface DiaryQuantity {
  boqKey: string;
  /** What the acceptance measured over the period, and the sum of what the diaries of the period record for the item (null when no diary of the period records a quantity for it). */
  measured: string;
  recorded: string | null;
}
export interface DiaryPeriod {
  periodFrom: string;
  periodTo: string;
  workingDays: number;
  withDiary: number;
  quantities: readonly DiaryQuantity[];
}

const parseMicro = (value: string): bigint => microUnits(value, 'quantity');

/**
 * QUANTITY_VS_DIARY (a SIGNAL): the work measured for a period is not borne out by the diary of the site, either because too few working days of the period have a diary (`min_diary_days_ratio`) or because the quantity
 * measured is above what the diaries record by more than `tolerance_pct`. A period with no working day has no coverage to judge; an item no diary gives a quantity for is not judged on quantity.
 */
export function diaryFindings(periods: readonly DiaryPeriod[], params: PaymentIntegrityParams['diary']): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const period of periods) {
    const subject = { period_from: period.periodFrom, period_to: period.periodTo };
    if (period.workingDays > 0 && period.withDiary / period.workingDays < params.min_diary_days_ratio) {
      out.push(finding('QUANTITY_VS_DIARY', 'SIGNAL', subject, { reason: 'COVERAGE_LOW', working_days: period.workingDays, days_with_diary: period.withDiary, min_ratio: params.min_diary_days_ratio }));
    }
    const tolerance = BigInt(Math.round(params.tolerance_pct * 100));
    for (const quantity of period.quantities) {
      if (quantity.recorded === null) continue;
      const measured = parseMicro(quantity.measured);
      const recorded = parseMicro(quantity.recorded);
      // measured > recorded x (1 + tolerance / 10000)  <=>  measured x 10000 > recorded x (10000 + tolerance)
      if (measured * 10_000n > recorded * (10_000n + tolerance)) {
        out.push(finding('QUANTITY_VS_DIARY', 'SIGNAL', { ...subject, boq_key: quantity.boqKey }, { reason: 'QUANTITY_ABOVE_DIARY', measured: quantity.measured, recorded: quantity.recorded, tolerance_pct: params.tolerance_pct }));
      }
    }
  }
  return out;
}

// ---- the ceilings -----------------------------------------------------------------------------------------------------------------------------

export interface ContractCeilingFacts {
  /** The price of the contract in force and at signing, and the totals of the contract as they are now. */
  currentPriceVnd: string;
  originalPriceVnd: string;
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  pendingIncreaseVnd: string;
  /** The request: its kind, gross, advance recovery; `onBooks` is true once it has been sent (its figures are then already in the totals). */
  requestKind: 'ADVANCE' | 'INTERIM' | 'FINAL';
  grossVnd: string;
  advanceRecoveryVnd: string;
  onBooks: boolean;
}

/**
 * EXCEEDS_CONTRACT: the request, put on the books, would take what was asked for above the price in force, or the cash that left or is asked for (paid plus the advances not yet recovered) above it. Built on the
 * availability of the money control (`contractAvailability`, CAP-17 extended to the contract): this only adds the request to its totals first. `over_by_vnd` is how far above, the figure an exception is judged against.
 */
export function contractCeilingFinding(facts: ContractCeilingFacts, mode: CeilingMode): IntegrityFinding | undefined {
  const gross = wholeVnd(facts.grossVnd, 'gross_vnd');
  const recovery = wholeVnd(facts.advanceRecoveryVnd, 'advance_recovery_vnd');
  const add = facts.onBooks ? { requested: 0n, paid: 0n, advancePaid: 0n, recovered: 0n } : facts.requestKind === 'ADVANCE' ? { requested: 0n, paid: 0n, advancePaid: gross, recovered: 0n } : { requested: gross, paid: gross, advancePaid: 0n, recovered: recovery };
  const position = contractAvailability({
    currentPriceVnd: facts.currentPriceVnd,
    originalPriceVnd: facts.originalPriceVnd,
    requestedTotalVnd: (wholeVnd(facts.requestedTotalVnd, 'requested_total_vnd') + add.requested).toString(),
    paidTotalVnd: (wholeVnd(facts.paidTotalVnd, 'paid_total_vnd') + add.paid).toString(),
    advancePaidVnd: (wholeVnd(facts.advancePaidVnd, 'advance_paid_vnd') + add.advancePaid).toString(),
    advanceRecoveredVnd: (wholeVnd(facts.advanceRecoveredVnd, 'advance_recovered_vnd') + add.recovered).toString(),
    pendingIncreaseVnd: facts.pendingIncreaseVnd,
  });
  if (position.withinPrice) return undefined;
  const price = BigInt(position.currentPriceVnd);
  const requested = BigInt(position.requestedTotalVnd);
  const cashOut = BigInt(position.cashOutVnd);
  const basis = requested > price ? 'REQUESTED' : 'CASH_OUT';
  const over = (requested > price ? requested : cashOut) - price;
  return finding('EXCEEDS_CONTRACT', kindOfMode(mode), {}, { basis, price_vnd: position.currentPriceVnd, projected_requested_vnd: position.requestedTotalVnd, projected_cash_out_vnd: position.cashOutVnd, over_by_vnd: over.toString() });
}

export interface PlanCeilingFacts {
  allocatedVnd: string;
  disbursedVnd: string;
  /** The net of the other requests of the line that are in flight (sent, checked or with the Treasury). */
  inFlightVnd: string;
  /** The net of the request (a negative net, after a tax adjustment, asks for nothing from the line). */
  netVnd: string;
}

/** EXCEEDS_PLAN: the net of the request is above what the capital plan line has left once what is disbursed and what other requests in flight are worth are taken off (the check `ALLOCATION_UNAVAILABLE` of sending, told before anything moves). */
export function planCeilingFinding(facts: PlanCeilingFacts, mode: CeilingMode): IntegrityFinding | undefined {
  const room = wholeVnd(facts.allocatedVnd, 'allocated_vnd') - wholeVnd(facts.disbursedVnd, 'disbursed_vnd') - wholeVnd(facts.inFlightVnd, 'in_flight_vnd');
  const signedNet = signedDong(facts.netVnd, 'net_vnd');
  const net = signedNet < 0n ? 0n : signedNet;
  if (net <= room) return undefined;
  return finding('EXCEEDS_PLAN', kindOfMode(mode), {}, { allocated_vnd: facts.allocatedVnd, disbursed_vnd: facts.disbursedVnd, in_flight_vnd: facts.inFlightVnd, net_vnd: net.toString(), available_vnd: (room < 0n ? 0n : room).toString(), over_by_vnd: (net - (room < 0n ? 0n : room)).toString() });
}

export interface AcceptedCeilingFacts {
  acceptedVnd: string;
  /** What the other requests that hold the acceptance already ask for, gross. */
  claimedByOthersVnd: string;
  grossVnd: string;
}

/** EXCEEDS_ACCEPTED: with this request, what is asked for against the acceptance is above the value that was accepted (the ledger keeps the same rule; this tells it before anything moves). */
export function acceptedCeilingFinding(facts: AcceptedCeilingFacts, mode: CeilingMode): IntegrityFinding | undefined {
  const accepted = wholeVnd(facts.acceptedVnd, 'accepted_vnd');
  const projected = wholeVnd(facts.claimedByOthersVnd, 'claimed_by_others_vnd') + wholeVnd(facts.grossVnd, 'gross_vnd');
  if (projected <= accepted) return undefined;
  return finding('EXCEEDS_ACCEPTED', kindOfMode(mode), {}, { accepted_vnd: accepted.toString(), projected_claimed_vnd: projected.toString(), over_by_vnd: (projected - accepted).toString() });
}

// ---- exceptions and the outcome ---------------------------------------------------------------------------------------------------------------

/** An exception as it is when the checks run: the ceiling, the most it lets go over, and the last day it holds. */
export interface LiveException {
  id: string;
  ceiling: ExceptionalCeiling;
  allowedAmountVnd: string;
  validTo: string;
}

/** The exception that covers an invariant: of the ceiling it names, not lapsed on `today` and allowing at least as much as the request is over by; undefined otherwise (a signal is not covered, there is nothing to cover). */
export function exceptionFor(found: IntegrityFinding, exceptions: readonly LiveException[], today: string): LiveException | undefined {
  if (found.kind !== 'INVARIANT' || !isExceptionalCeiling(found.code)) return undefined;
  const over = BigInt(String(found.params.over_by_vnd ?? '0'));
  return exceptions.find((candidate) => candidate.ceiling === found.code && candidate.validTo >= today && BigInt(candidate.allowedAmountVnd) >= over);
}

export interface JudgedFinding extends IntegrityFinding {
  excusedBy: string | null;
}

export interface IntegrityVerdict {
  outcome: IntegrityOutcome;
  findings: JudgedFinding[];
  invariantCount: number;
  signalCount: number;
  excusedCount: number;
  unavailable: IntegritySource[];
}

/**
 * The outcome of a run: BLOCKED when an invariant stands that no exception covers; SIGNALS when only signals (or invariants that an exception covers) are left; PARTIAL when nothing was found but a source could not
 * be read (a source that cannot be read is never "nothing found"); PASSED only when nothing was found and every source was read.
 */
export function judgeIntegrity(found: readonly IntegrityFinding[], exceptions: readonly LiveException[], unavailable: readonly IntegritySource[], today: string): IntegrityVerdict {
  const findings: JudgedFinding[] = found.map((one) => ({ ...one, excusedBy: exceptionFor(one, exceptions, today)?.id ?? null }));
  const invariantCount = findings.filter((one) => one.kind === 'INVARIANT').length;
  const signalCount = findings.length - invariantCount;
  const excusedCount = findings.filter((one) => one.excusedBy !== null).length;
  const gaps = [...new Set(unavailable)].sort() as IntegritySource[];
  const outcome: IntegrityOutcome = invariantCount > excusedCount ? 'BLOCKED' : findings.length > 0 ? 'SIGNALS' : gaps.length > 0 ? 'PARTIAL' : 'PASSED';
  return { outcome, findings, invariantCount, signalCount, excusedCount, unavailable: gaps };
}

/** The code of the refusal of a blocked request: the first invariant (a ceiling first, then a duplicate) that no exception covers. */
export function blockingCode(verdict: IntegrityVerdict): IntegrityCode | undefined {
  const order: readonly IntegrityCode[] = ['EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'EXCEEDS_ACCEPTED', 'DUPLICATE_CLAIM'];
  const standing = verdict.findings.filter((one) => one.kind === 'INVARIANT' && one.excusedBy === null);
  return order.find((code) => standing.some((one) => one.code === code));
}

/** The last day an exception may be asked to hold: `exception_max_days` after `today`; a request for a day past it is 422 `DISBURSEMENT_EXCEPTION_WINDOW_INVALID` (decided by the caller from this). */
export function exceptionWindowEnd(today: string, maxDays: number): string {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + maxDays)).toISOString().slice(0, 10);
}
