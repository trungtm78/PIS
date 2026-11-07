import { DomainError } from './errors.ts';
import type { EacMethod, EvmPolicy } from './gov-b1-policy.ts';
import { percentOf, plannedValueAt, ratioOf, scaledOf } from './prj-baseline.ts';
import { isCalendarDate } from './retention.ts';

/**
 * Earned value of a project, a work package or a contract (G1-4, G1-5; research F01, F02). The planned value comes from the baseline, the earned value only from the quantities that were accepted, the actual cost
 * only from the payments that were certified. What cannot be known is "chưa đủ dữ liệu" with the reason, never a zero: a missing baseline, a package with no contract and money planned for it, a contract with no
 * value or no days. The formula of the estimate at completion that was used is part of the answer. Money is whole dong in text, ratios have four decimals; nothing is a float. Pure functions of their input.
 */
export type EvmMissing = 'NO_BASELINE' | 'NO_CONTRACT_LINK' | 'CONTRACT_VALUE_ZERO' | 'NO_SCHEDULE';
export type EvmUnavailable = 'AC_ZERO' | 'PV_ZERO' | 'EV_ZERO' | 'BAC_EQUALS_AC' | 'NO_DATA';
export type EvmRag = 'GREEN' | 'AMBER' | 'RED';
export const EVM_METRICS = ['pv', 'ev', 'ac', 'bac', 'cpi', 'spi', 'eac', 'etc', 'vac', 'tcpi'] as const;
export type EvmMetric = (typeof EVM_METRICS)[number];

export interface EvmContractFact {
  contractId: string;
  /** The value of the contract now, whole dong. */
  valueVnd: string;
}

export interface EvmLineFacts {
  key: string;
  code: string;
  name: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
  contracts: readonly EvmContractFact[];
}

/** An acceptance that was approved: the day (Vietnam time) and the value accepted. */
export interface AcceptanceFact {
  contractId: string;
  day: string;
  amountVnd: string;
}

/** A payment request that was certified (verified or beyond): the day it was verified, the day it was reversed when it was, and the gross value of the work it pays. */
export interface PaymentFact {
  contractId: string;
  day: string;
  reversedDay: string | null;
  grossVnd: string;
}

export interface LineEvm {
  key: string;
  code: string;
  name: string;
  bacVnd: bigint;
  pvVnd: bigint;
  evVnd: bigint | null;
  acVnd: bigint | null;
  missing: EvmMissing[];
}

const roundDiv = (numerator: bigint, denominator: bigint): bigint => {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * 2n + d) / (2n * d);
  return negative ? -rounded : rounded;
};

/** What the contracts accepted up to the end of a day. */
export function acceptedUpTo(contractIds: ReadonlySet<string>, asOf: string, acceptances: readonly AcceptanceFact[]): bigint {
  return acceptances.reduce((sum, fact) => (contractIds.has(fact.contractId) && fact.day <= asOf ? sum + BigInt(fact.amountVnd) : sum), 0n);
}

/** What the contracts were certified to pay up to the end of a day, a payment that was reversed by then taking nothing. */
export function certifiedUpTo(contractIds: ReadonlySet<string>, asOf: string, payments: readonly PaymentFact[]): bigint {
  return payments.reduce((sum, fact) => (contractIds.has(fact.contractId) && fact.day <= asOf && (fact.reversedDay === null || fact.reversedDay > asOf) ? sum + BigInt(fact.grossVnd) : sum), 0n);
}

/**
 * The figures of one work package on a day. The planned value is that of the baseline. The earned value is the budget of the package times the share of its contracts that was accepted (so a budget of 100 and a
 * contract of 90 accepted in full earn 100). A package with no contract has earned nothing only when nothing was planned for it yet; if money was planned, its earned value is unknown, not zero.
 */
export function lineEvm(line: EvmLineFacts, asOf: string, acceptances: readonly AcceptanceFact[], payments: readonly PaymentFact[]): LineEvm {
  const bac = BigInt(line.bacVnd);
  const pv = plannedValueAt(line, asOf);
  const base = { key: line.key, code: line.code, name: line.name, bacVnd: bac, pvVnd: pv };
  if (line.contracts.length === 0) {
    if (pv === 0n) return { ...base, evVnd: 0n, acVnd: 0n, missing: [] };
    return { ...base, evVnd: null, acVnd: null, missing: ['NO_CONTRACT_LINK'] };
  }
  const ids = new Set(line.contracts.map((contract) => contract.contractId));
  const value = line.contracts.reduce((sum, contract) => sum + BigInt(contract.valueVnd), 0n);
  if (value <= 0n) return { ...base, evVnd: null, acVnd: null, missing: ['CONTRACT_VALUE_ZERO'] };
  const accepted = acceptedUpTo(ids, asOf, acceptances);
  const counted = accepted > value ? value : accepted;
  return { ...base, evVnd: roundDiv(bac * counted, value), acVnd: certifiedUpTo(ids, asOf, payments), missing: [] };
}

/** The sum of the packages: unknown as soon as one package is, with the reasons gathered. A project with no package at all has no baseline to stand on. */
export function rollupLines(lines: readonly LineEvm[]): { bac: bigint | null; pv: bigint | null; ev: bigint | null; ac: bigint | null; missing: EvmMissing[] } {
  if (lines.length === 0) return { bac: null, pv: null, ev: null, ac: null, missing: ['NO_BASELINE'] };
  const missing = [...new Set(lines.flatMap((line) => line.missing))];
  const bac = lines.reduce((sum, line) => sum + line.bacVnd, 0n);
  const pv = lines.reduce((sum, line) => sum + line.pvVnd, 0n);
  if (lines.some((line) => line.evVnd === null || line.acVnd === null)) return { bac, pv, ev: null, ac: null, missing };
  return { bac, pv, ev: lines.reduce((sum, line) => sum + (line.evVnd as bigint), 0n), ac: lines.reduce((sum, line) => sum + (line.acVnd as bigint), 0n), missing };
}

export interface EvmInputs {
  bac: bigint | null;
  pv: bigint | null;
  ev: bigint | null;
  ac: bigint | null;
  missing: readonly EvmMissing[];
}

export interface EvmFigures {
  status: 'OK' | 'INSUFFICIENT';
  asOf: string;
  eacMethod: EacMethod;
  bacVnd: string | null;
  pvVnd: string | null;
  evVnd: string | null;
  acVnd: string | null;
  cpi: string | null;
  spi: string | null;
  eacVnd: string | null;
  etcVnd: string | null;
  vacVnd: string | null;
  tcpi: string | null;
  /** Why a figure is empty when the others are not (a division by zero is not an index of zero). */
  unavailable: Partial<Record<EvmMetric, EvmUnavailable>>;
  missing: EvmMissing[];
  ragCpi: EvmRag | null;
  ragSpi: EvmRag | null;
}

const text = (value: bigint | null): string | null => (value === null ? null : value.toString());

/** Green at or above the amber line, amber at or above the red one, red below it; unknown stays unknown. */
export function ragOf(index: string | null, policy: Pick<EvmPolicy, 'amberBelow' | 'redBelow'>): EvmRag | null {
  if (index === null) return null;
  const value = scaledOf(index);
  if (value >= BigInt(Math.round(policy.amberBelow * 10_000))) return 'GREEN';
  if (value >= BigInt(Math.round(policy.redBelow * 10_000))) return 'AMBER';
  return 'RED';
}

/**
 * The nine figures from the four that are measured. With one of them unknown the whole answer is "chưa đủ dữ liệu": every figure empty, the reasons named. The estimate at completion follows the formula of the
 * policy: BAC over the cumulative CPI (default), or the actual cost plus the work left at the budgeted rate, or that work over CPI times SPI.
 */
export function computeEvm(inputs: EvmInputs, method: EacMethod, policy: Pick<EvmPolicy, 'amberBelow' | 'redBelow'>, asOf: string): EvmFigures {
  if (!isCalendarDate(asOf)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const { bac, pv, ev, ac } = inputs;
  const empty: EvmFigures = {
    status: 'INSUFFICIENT',
    asOf,
    eacMethod: method,
    bacVnd: text(bac),
    pvVnd: text(pv),
    evVnd: null,
    acVnd: null,
    cpi: null,
    spi: null,
    eacVnd: null,
    etcVnd: null,
    vacVnd: null,
    tcpi: null,
    unavailable: Object.fromEntries(EVM_METRICS.filter((metric) => !['bac', 'pv'].includes(metric) || (metric === 'bac' ? bac === null : pv === null)).map((metric) => [metric, 'NO_DATA' as const])),
    missing: [...inputs.missing],
    ragCpi: null,
    ragSpi: null,
  };
  if (bac === null || pv === null || ev === null || ac === null) return empty;
  const unavailable: Partial<Record<EvmMetric, EvmUnavailable>> = {};
  const cpi = ratioOf(ev, ac);
  if (cpi === null) unavailable.cpi = 'AC_ZERO';
  const spi = ratioOf(ev, pv);
  if (spi === null) unavailable.spi = 'PV_ZERO';
  const remaining = bac - ev;
  let eac: bigint | null = null;
  switch (method) {
    case 'CPI_CUMULATIVE':
      if (ev === 0n) unavailable.eac = 'EV_ZERO';
      else if (ac === 0n) unavailable.eac = 'AC_ZERO';
      else eac = roundDiv(bac * ac, ev);
      break;
    case 'AC_PLUS_REMAINING':
      eac = ac + remaining;
      break;
    case 'AC_PLUS_REMAINING_OVER_CPI_SPI':
      if (ev === 0n) unavailable.eac = 'EV_ZERO';
      else if (ac === 0n) unavailable.eac = 'AC_ZERO';
      else if (pv === 0n) unavailable.eac = 'PV_ZERO';
      else eac = ac + roundDiv(remaining * ac * pv, ev * ev);
      break;
  }
  const etc = eac === null ? null : eac - ac;
  const vac = eac === null ? null : bac - eac;
  if (eac === null) {
    unavailable.etc = unavailable.eac ?? 'NO_DATA';
    unavailable.vac = unavailable.eac ?? 'NO_DATA';
  }
  const tcpi = ratioOf(remaining, bac - ac);
  if (tcpi === null) unavailable.tcpi = 'BAC_EQUALS_AC';
  return {
    status: 'OK',
    asOf,
    eacMethod: method,
    bacVnd: bac.toString(),
    pvVnd: pv.toString(),
    evVnd: ev.toString(),
    acVnd: ac.toString(),
    cpi,
    spi,
    eacVnd: text(eac),
    etcVnd: text(etc),
    vacVnd: text(vac),
    tcpi,
    unavailable,
    missing: [...inputs.missing],
    ragCpi: ragOf(cpi, policy),
    ragSpi: ragOf(spi, policy),
  };
}

/** EAC against the investment total (F03): how far the estimate goes over the approved total, in dong and percent; null when the estimate is unknown. */
export function eacAgainstTotal(eacVnd: string | null, totalInvestmentVnd: string): { overVnd: string; overPct: string | null } | null {
  if (eacVnd === null) return null;
  const over = BigInt(eacVnd) - BigInt(totalInvestmentVnd);
  return { overVnd: over.toString(), overPct: percentOf(over, BigInt(totalInvestmentVnd)) };
}

// ---- the S-curve ------------------------------------------------------------------------------------------------------------

export interface SCurvePoint {
  day: string;
  /** Planned by baseline version 0, whole dong. */
  pvV0Vnd: string;
  /** Planned by the current baseline. */
  pvCurrentVnd: string;
  /** Earned and cost so far; null after the day of the view, and null where they cannot be known. */
  evVnd: string | null;
  acVnd: string | null;
}

const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number): string => String(value).padStart(2, '0');

/** The days the curve is drawn at: the first day, the end of every month up to the last day, the last day and the day of the view, in order and once. At most 600. */
export function sCurveDays(from: string, to: string, asOf: string): string[] {
  const days = new Set<string>([from, to, asOf]);
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to > asOf ? to : asOf;
  for (let guard = 0; guard < 600; guard += 1) {
    const day = `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`;
    if (day > last) break;
    if (day >= from) days.add(day);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return [...days].filter((day) => day >= from && day <= last).sort();
}

export interface SCurve {
  asOf: string;
  points: SCurvePoint[];
  /** Earned value and cost are drawn only where they can be known; the reasons they cannot are here. */
  missing: EvmMissing[];
}

/**
 * The curves of a project: the value planned by baseline version 0 and by the current baseline over the whole life, and the value earned and the cost up to the day of the view. A version 0 that does not exist is
 * a refusal of the caller (422), not a flat line.
 */
export function sCurve(input: { v0: readonly EvmLineFacts[]; current: readonly EvmLineFacts[]; asOf: string; acceptances: readonly AcceptanceFact[]; payments: readonly PaymentFact[] }): SCurve {
  if (!isCalendarDate(input.asOf)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const all = [...input.v0, ...input.current];
  if (all.length === 0) throw new DomainError('BASELINE_MISSING', 422, 'baseline');
  const from = all.reduce((first, line) => (line.plannedStart < first ? line.plannedStart : first), all[0]?.plannedStart ?? input.asOf);
  const to = all.reduce((last, line) => (line.plannedFinish > last ? line.plannedFinish : last), all[0]?.plannedFinish ?? input.asOf);
  const missing = new Set<EvmMissing>();
  const points = sCurveDays(from, to, input.asOf).map((day): SCurvePoint => {
    const sum = (lines: readonly EvmLineFacts[]): bigint => lines.reduce((total, line) => total + plannedValueAt(line, day), 0n);
    let ev: string | null = null;
    let ac: string | null = null;
    if (day <= input.asOf) {
      const rolled = rollupLines(input.current.map((line) => lineEvm(line, day, input.acceptances, input.payments)));
      for (const reason of rolled.missing) missing.add(reason);
      ev = text(rolled.ev);
      ac = text(rolled.ac);
    }
    return { day, pvV0Vnd: sum(input.v0).toString(), pvCurrentVnd: sum(input.current).toString(), evVnd: ev, acVnd: ac };
  });
  return { asOf: input.asOf, points, missing: [...missing] };
}
