import { rateOf } from './aud-recovery.ts';
import type { Rate } from './aud-recovery.ts';
import { FINANCIAL_RECOMMENDATION_TYPES } from './aud-conclusion.ts';
import { DomainError } from './errors.ts';

export const REPORT_STATUSES = ['DRAFT', 'ISSUE_REQUESTED', 'ISSUED', 'REJECTED', 'RECALLED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What moves a report (AUD 3.6): the request to DOC, and what DOC answers. */
export type ReportAction = 'request' | 'issue' | 'reject' | 'recall';

export const REPORT_EDGES: Readonly<Record<ReportAction, { from: readonly ReportStatus[]; to: ReportStatus }>> = {
  request: { from: ['DRAFT'], to: 'ISSUE_REQUESTED' },
  issue: { from: ['ISSUE_REQUESTED'], to: 'ISSUED' },
  reject: { from: ['ISSUE_REQUESTED'], to: 'REJECTED' },
  recall: { from: ['ISSUED'], to: 'RECALLED' },
};

/** The status after an action, or 409 `REPORT_STATE_INVALID` when the report is not where the action starts. The table holds the same edges (`audit_follow_up_report_guard`). */
export function nextReportStatus(status: ReportStatus, action: ReportAction): ReportStatus {
  const edge = REPORT_EDGES[action];
  if (!edge.from.includes(status)) throw new DomainError('REPORT_STATE_INVALID', 409, `${status}->${action}`);
  return edge.to;
}

/** The template DOC issues the report with, and the module DOC knows the request by. */
export const REPORT_TEMPLATE_CODE = 'AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI';
export const REPORT_SOURCE_MODULE = 'AUD';

const SOURCE_REF = /^AUD:audit_follow_up_report:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):r([1-9][0-9]{0,5})$/;

/** How DOC names the report in its events: the id and the revision, so that a second revision is another request. */
export const reportSourceRef = (id: string, revision: number): string => `AUD:audit_follow_up_report:${id.toLowerCase()}:r${revision}`;

export function parseReportSourceRef(ref: unknown): { id: string; revision: number } | undefined {
  if (typeof ref !== 'string') return undefined;
  const found = SOURCE_REF.exec(ref);
  return found === null ? undefined : { id: found[1] as string, revision: Number(found[2]) };
}

/** The day the figures are as of: today or before, and not before the conclusion reached the authority's addressee (422 `VALIDATION_FAILED` naming the field). */
export function assertAsOf(asOf: string, today: string, receivedOn: string): void {
  if (asOf > today || asOf < receivedOn) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_date');
}

/** A recommendation and, as of the day, how much of it was recovered. `closedOn` is the Vietnam day the verifier closed it. */
export interface ReportRecommendation {
  type: string;
  status: string;
  amountVnd: string | null;
  createdOn: string;
  closedOn: string | null;
  recoveredVnd: string;
}

export type ReportGroup = 'closed' | 'in_progress' | 'open' | 'disputed';

/** Where a recommendation stood on a day: not at all (cancelled, or not yet given), or in one of four groups. A recommendation closed after the day was still being worked on it. */
export function groupAsOf(row: ReportRecommendation, asOf: string): ReportGroup | undefined {
  if (row.status === 'CANCELLED' || row.createdOn > asOf) return undefined;
  if (row.status === 'CLOSED') return row.closedOn === null || row.closedOn <= asOf ? 'closed' : 'in_progress';
  if (row.status === 'OPEN') return 'open';
  if (row.status === 'DISPUTED') return 'disputed';
  return 'in_progress';
}

/** The figures of a report, frozen with it. The money is in whole dong as decimal text; a rate always carries its numerator and denominator (BR-AUD-04). */
export interface ReportTotals {
  as_of_date: string;
  total: number;
  closed: number;
  in_progress: number;
  open: number;
  disputed: number;
  amount: string;
  recovered: string;
  remaining: string;
  money_rate: Rate;
  count_rate: Rate;
}

const isFinancial = (type: string): boolean => (FINANCIAL_RECOMMENDATION_TYPES as readonly string[]).includes(type);

export function reportTotals(asOf: string, rows: readonly ReportRecommendation[]): ReportTotals {
  const counts: Record<ReportGroup, number> = { closed: 0, in_progress: 0, open: 0, disputed: 0 };
  let amount = 0n;
  let recovered = 0n;
  for (const row of rows) {
    const group = groupAsOf(row, asOf);
    if (group === undefined) continue;
    counts[group] += 1;
    if (isFinancial(row.type) && row.amountVnd !== null) {
      amount += BigInt(row.amountVnd);
      recovered += BigInt(row.recoveredVnd);
    }
  }
  const total = counts.closed + counts.in_progress + counts.open + counts.disputed;
  const remaining = amount > recovered ? amount - recovered : 0n;
  return {
    as_of_date: asOf,
    total,
    ...counts,
    amount: amount.toString(),
    recovered: recovered.toString(),
    remaining: remaining.toString(),
    money_rate: rateOf(recovered.toString(), amount.toString()),
    count_rate: rateOf(String(counts.closed), String(total)),
  };
}

/** Whole dong with a dot between the thousands, as a Vietnamese document writes it. */
export const groupDong = (value: string): string => value.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** A percentage as a Vietnamese document writes it (a comma before the decimals); a dash for a rate that is not applicable. */
export const percentText = (rate: Rate): string => (rate.percent === null ? '-' : `${rate.percent.replace('.', ',')}%`);

/** What the engagement and the conclusion say of themselves; the words come from the people who entered them. */
export interface ReportFacts {
  /** The agency that issues the report (the drafting unit) and the place it is issued at: DOC prints both in the head of the document and asks for both. */
  agency: string;
  place: string;
  title: string;
  engagementCode: string;
  authorityName: string;
  conclusionSymbol: string;
  conclusionIssuedOn: string;
  totals: ReportTotals;
}

/**
 * The payload DOC issues the report from: scalars only, filled into the placeholders of the template, whose own text carries the legal wording. The money is not under `amount_vnd`, which DOC
 * reads as the amount of a decision for the delegation of the signer: a report decides nothing.
 */
export function reportPayload(facts: ReportFacts): Record<string, string> {
  const totals = facts.totals;
  return {
    agency: facts.agency,
    place: facts.place,
    title: facts.title,
    engagement_code: facts.engagementCode,
    authority_name: facts.authorityName,
    conclusion_symbol: facts.conclusionSymbol,
    conclusion_issued_on: facts.conclusionIssuedOn,
    as_of_date: totals.as_of_date,
    recommendations_total: String(totals.total),
    recommendations_closed: String(totals.closed),
    recommendations_in_progress: String(totals.in_progress),
    recommendations_open: String(totals.open),
    recommendations_disputed: String(totals.disputed),
    recommended_vnd: groupDong(totals.amount),
    recovered_vnd: groupDong(totals.recovered),
    remaining_vnd: groupDong(totals.remaining),
    recovery_rate: percentText(totals.money_rate),
    completion_rate: percentText(totals.count_rate),
  };
}

/** BR-AUD-04 and the closure of an engagement: no recommendation is open, and every conclusion that stands has a report DOC issued. The first is 409, the second 422. */
export function assertEngagementClosable(input: { openRecommendations: number; conclusionsWithoutReport: number }): void {
  if (input.openRecommendations > 0) throw new DomainError('OPEN_RECOMMENDATIONS_REMAIN', 409, 'recommendations', { extensions: { open_recommendations: input.openRecommendations } });
  if (input.conclusionsWithoutReport > 0) throw new DomainError('FOLLOW_UP_REPORT_MISSING', 422, 'report', { extensions: { conclusions_without_report: input.conclusionsWithoutReport } });
}
