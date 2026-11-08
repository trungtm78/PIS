import { DomainError } from './errors.ts';
import { daysBetween } from './monitoring-file.ts';

/**
 * The standing of an investor unit with the recommendations of the auditors (G4-10, practice P15). The recommendations that an audit made to a unit are counted by state (open, overdue, disputed, closed) with the money
 * that is still owed; the units are ordered so that follow-up starts where the most is open and late, and the position is shown next to the position of the unit in the disbursement ranking so that a leader reads
 * both. It is a standing for follow-up, not a verdict, and it never changes the order of the disbursement ranking. The weights are the governance rule `AUDIT_STANDING_RULE` (UNVERIFIED).
 */

export const AUDIT_STANDING_RULE_TYPE = 'AUDIT_STANDING_RULE';

export interface AuditStandingPolicy {
  weight_overdue: number;
  weight_disputed: number;
  weight_open: number;
  /** Every this many dong still owed adds one point of the weight below. */
  money_step_vnd: string;
  weight_money: number;
}

export const auditStandingDefaults = (): AuditStandingPolicy => ({ weight_overdue: 3, weight_disputed: 2, weight_open: 1, money_step_vnd: '1000000000', weight_money: 1 });

function intIn(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DomainError('VALIDATION_FAILED', 422, path);
  return value;
}

export function auditStandingPolicyOf(params: Readonly<Record<string, unknown>>): AuditStandingPolicy {
  const step = params.money_step_vnd;
  if (typeof step !== 'string' || !/^[1-9][0-9]{0,23}$/.test(step)) throw new DomainError('VALIDATION_FAILED', 422, 'money_step_vnd');
  return { weight_overdue: intIn(params.weight_overdue, 0, 100, 'weight_overdue'), weight_disputed: intIn(params.weight_disputed, 0, 100, 'weight_disputed'), weight_open: intIn(params.weight_open, 0, 100, 'weight_open'), money_step_vnd: step, weight_money: intIn(params.weight_money, 0, 100, 'weight_money') };
}

export type AuditRecommendationStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'CLOSED' | 'DISPUTED' | 'CANCELLED';

export interface RecommendationFact {
  status: AuditRecommendationStatus;
  dueOn: string | null;
  amountVnd: string | null;
  recoveredVnd: string;
}

export interface UnitStanding {
  unitId: string;
  unitCode: string | null;
  total: number;
  open: number;
  overdue: number;
  disputed: number;
  closed: number;
  /** Money recommended and not yet recovered, on the recommendations that are not closed or cancelled, in whole dong. */
  owedVnd: string;
  /** Closed share of the recommendations that count (not cancelled), one decimal; null when none counts. */
  closedPct: number | null;
  score: number;
}

/** The overdue test: a recommendation that is still being worked (not closed, not cancelled, not disputed) and whose day has passed. A disputed one waits for the authority and is counted as disputed only. */
export function isOverdueRecommendation(fact: RecommendationFact, today: string): boolean {
  if (fact.dueOn === null) return false;
  if (fact.status === 'CLOSED' || fact.status === 'CANCELLED' || fact.status === 'DISPUTED') return false;
  return daysBetween(fact.dueOn, today) > 0;
}

export function standingOf(unit: { unitId: string; unitCode: string | null }, facts: readonly RecommendationFact[], today: string, policy: AuditStandingPolicy): UnitStanding {
  let open = 0;
  let overdue = 0;
  let disputed = 0;
  let closed = 0;
  let counting = 0;
  let owed = 0n;
  for (const fact of facts) {
    if (fact.status === 'CANCELLED') continue;
    counting += 1;
    if (fact.status === 'CLOSED') {
      closed += 1;
      continue;
    }
    if (fact.status === 'DISPUTED') disputed += 1;
    else open += 1;
    if (isOverdueRecommendation(fact, today)) overdue += 1;
    if (fact.amountVnd !== null) {
      const left = BigInt(fact.amountVnd) - BigInt(fact.recoveredVnd);
      if (left > 0n) owed += left;
    }
  }
  const moneyPoints = Number(owed / BigInt(policy.money_step_vnd));
  const score = overdue * policy.weight_overdue + disputed * policy.weight_disputed + open * policy.weight_open + moneyPoints * policy.weight_money;
  return { ...unit, total: counting, open, overdue, disputed, closed, owedVnd: owed.toString(), closedPct: counting === 0 ? null : Math.round((closed * 1000) / counting) / 10, score };
}

export interface RankedStanding extends UnitStanding {
  /** 1 is the unit with the most to follow up; units with no recommendation are not ranked. */
  rank: number | null;
}

/** The order of follow-up: the higher score first; a tie goes to the larger sum still owed, then to the unit code, so the order never depends on how the rows were read. */
export function rankStandings(standings: readonly UnitStanding[]): RankedStanding[] {
  const counted = standings.filter((one) => one.total > 0 && one.score > 0);
  const rest = standings.filter((one) => !(one.total > 0 && one.score > 0));
  const ordered = [...counted].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const owedA = BigInt(a.owedVnd);
    const owedB = BigInt(b.owedVnd);
    if (owedA !== owedB) return owedA > owedB ? -1 : 1;
    return (a.unitCode ?? a.unitId) < (b.unitCode ?? b.unitId) ? -1 : 1;
  });
  return [
    ...ordered.map((one, index) => ({ ...one, rank: index + 1 })),
    ...[...rest].sort((a, b) => ((a.unitCode ?? a.unitId) < (b.unitCode ?? b.unitId) ? -1 : 1)).map((one) => ({ ...one, rank: null })),
  ];
}
