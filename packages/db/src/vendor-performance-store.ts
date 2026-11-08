import { randomUUID } from 'node:crypto';
import { DomainError, assertPublication, poorStreak, publicationClock, publicationDueOn, responseReviewClock, streakSuggestion, withinRetrospect } from '@machvon/kernel';
import type { PerformancePolicy, PerformancePublicationKind, PerformanceRating, PublicationClock, RatedContract, ResponseReviewClock, StreakSuggestion } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import type { Policy } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const VN_DAY = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date::text`;
const SCAN_CAP = 2000;

export interface VendorPublicationInfo {
  id: string;
  kind: PerformancePublicationKind;
  receipt: string;
  postedOn: string;
  postedBy: string;
  clock: 'MET' | 'MET_LATE';
}

/** One adopted, told or answered rating of a contractor with the clocks of its publication and of the review of its answer. */
export interface VendorRatingLine {
  proposalId: string;
  contractId: string;
  contractCode: string;
  contractorId: string;
  contractorName: string;
  evaluationKind: string;
  periodLabel: string;
  state: string;
  rating: PerformanceRating | null;
  score: string | null;
  construction: boolean;
  adoptedOn: string | null;
  adoptedBy: string | null;
  /** The day the contract ended (or is due to end for a periodic rating): the publication clock counts from it. */
  endedOn: string;
  responseKind: string | null;
  responseReceivedOn: string | null;
  evaluationId: string | null;
  /** The day the publication is due and where it stands; null for a rating that was not adopted. */
  publicationDueOn: string | null;
  publicationClock: PublicationClock | null;
  /** The first posting (INITIAL) and the updates that followed it. */
  publication: VendorPublicationInfo | null;
  updates: VendorPublicationInfo[];
  responseReview: ResponseReviewClock;
  /** The posting duty of the e-GP lane for the contract, read only (its receipt is handled there). */
  obligation: { id: string; state: string } | null;
}

interface LineSql {
  id: string;
  contract_id: string;
  contract_code: string;
  contractor_id: string;
  contractor_name: string;
  evaluation_kind: string;
  period_label: string;
  state: string;
  rating: PerformanceRating | null;
  score: string | null;
  construction: boolean;
  adopted_on: string | null;
  adopted_by: string | null;
  ended_on: string;
  response_kind: string | null;
  response_received_on: string | null;
  evaluation_id: string | null;
  obligation_id: string | null;
  obligation_state: string | null;
}

interface PublicationSql {
  id: string;
  rating_proposal_id: string;
  kind: PerformancePublicationKind;
  receipt: string;
  posted_on: string;
  posted_by: string;
  clock: 'MET' | 'MET_LATE';
}

const LINE_SELECT = `select p.id, p.contract_id, c.code as contract_code, p.contractor_id, k.legal_name as contractor_name, p.evaluation_kind, p.period_label, p.state,
       coalesce(e.rating, p.rating) as rating, coalesce(e.overall_score, p.overall_score)::text as score, (c.advance_category = 'CONSTRUCTION') as construction,
       ${VN_DAY('p.adopted_at')} as adopted_on, p.adopted_by,
       case when p.evaluation_kind in ('COMPLETION', 'TERMINATION') then coalesce(c.terminated_on, c.completed_on, p.as_of_date) else coalesce(c.completion_due, p.as_of_date) end::text as ended_on,
       p.response_kind, p.response_received_on::text as response_received_on, p.evaluation_id,
       o.id as obligation_id, o.state as obligation_state
  from machvon.contract_rating_proposal p
  join machvon.contract c on c.tenant_id = p.tenant_id and c.id = p.contract_id
  join machvon.contractor k on k.tenant_id = p.tenant_id and k.id = p.contractor_id
  left join machvon.contractor_performance e on e.tenant_id = p.tenant_id and e.id = p.evaluation_id
  left join lateral (select x.id, x.state from machvon.egp_posting_obligation x where x.tenant_id = p.tenant_id and x.kind = 'CONTRACTOR_PERFORMANCE' and x.subject_id = p.contract_id order by x.created_at desc, x.id desc limit 1) o on true`;

const toPublication = (row: PublicationSql): VendorPublicationInfo => ({ id: row.id, kind: row.kind, receipt: row.receipt, postedOn: row.posted_on, postedBy: row.posted_by, clock: row.clock });

export interface VendorPerformanceHistory {
  lines: VendorRatingLine[];
  streak: number;
  suggestion: StreakSuggestion;
  /** The proposals a selection may look at on the day (adopted within the years of the rule). */
  retrospectProposalIds: string[];
  policy: Policy<PerformancePolicy>;
}

export interface VendorPublicationWorkFilter {
  state?: 'DUE' | 'OVERDUE' | 'POSTED' | 'ALL' | undefined;
  contractorId?: string | undefined;
  limit?: number | undefined;
}

export interface VendorFigure {
  code: string;
  numerator: number;
  denominator: number;
  asOf: string;
}

/**
 * The performance of a contractor over its contracts, seen from the vendor side (VND-2, V4; docs/vendor-controls-risk-performance.md). The rating is the proposal of CA-3 (`contract_rating_proposal`); this store
 * reads it with the day the contract ended (a completion or a termination counts from the day it happened, a periodic rating from the day the contract is due to end), the clock of its publication (the months of the
 * rule `VENDOR_PERFORMANCE` after that day), the clock of the review of the answer of the contractor, the streak of poor ratings and the window a selection may look back over, and records the publication (the receipt
 * of the national system) by a person other than the one who adopted the rating. The posting duty of the e-GP lane (`CONTRACTOR_PERFORMANCE`) is shown read only: its own receipt stays in that lane.
 */
export class VendorPerformanceStore {
  private readonly policies: VendorPolicyReader;

  constructor(policies: VendorPolicyReader = new VendorPolicyReader()) {
    this.policies = policies;
  }

  private async publicationsOf(tx: TenantTx, proposalIds: readonly string[]): Promise<Map<string, PublicationSql[]>> {
    const map = new Map<string, PublicationSql[]>();
    if (proposalIds.length === 0) return map;
    const rows = await tx.query<PublicationSql>(
      'select id, rating_proposal_id, kind, receipt, posted_on::text as posted_on, posted_by, clock from machvon.vendor_performance_publication where rating_proposal_id = any($1::uuid[]) order by posted_at, id',
      [proposalIds],
    );
    for (const row of rows) map.set(row.rating_proposal_id, [...(map.get(row.rating_proposal_id) ?? []), row]);
    return map;
  }

  private async lines(tx: TenantTx, where: string, params: unknown[], today: string, policy: PerformancePolicy): Promise<VendorRatingLine[]> {
    const rows = await tx.query<LineSql>(`${LINE_SELECT} where p.state in ('NOTIFIED', 'RESPONDED', 'ADOPTED') ${where} order by p.created_at desc, p.id desc limit ${SCAN_CAP}`, params);
    const publications = await this.publicationsOf(tx, rows.map((row) => row.id));
    return rows.map((row): VendorRatingLine => {
      const all = (publications.get(row.id) ?? []).map(toPublication);
      const initial = all.find((one) => one.kind === 'INITIAL') ?? null;
      const adopted = row.state === 'ADOPTED';
      const dueOn = adopted ? publicationDueOn(row.ended_on, policy) : null;
      return {
        proposalId: row.id,
        contractId: row.contract_id,
        contractCode: row.contract_code,
        contractorId: row.contractor_id,
        contractorName: row.contractor_name,
        evaluationKind: row.evaluation_kind,
        periodLabel: row.period_label,
        state: row.state,
        rating: row.rating,
        score: row.score,
        construction: row.construction,
        adoptedOn: row.adopted_on,
        adoptedBy: row.adopted_by,
        endedOn: row.ended_on,
        responseKind: row.response_kind,
        responseReceivedOn: row.response_received_on,
        evaluationId: row.evaluation_id,
        publicationDueOn: dueOn,
        publicationClock: dueOn === null ? null : publicationClock({ dueOn, postedOn: initial?.postedOn ?? null, today }, policy),
        publication: initial,
        updates: all.filter((one) => one.kind !== 'INITIAL'),
        responseReview: responseReviewClock({ answeredOn: row.response_received_on, adopted, today }, policy),
        obligation: row.obligation_id === null || row.obligation_state === null ? null : { id: row.obligation_id, state: row.obligation_state },
      };
    });
  }

  /** The ratings of a contractor with their clocks, the streak of poor ones and what it suggests (never an action), and the window a selection may look back over. */
  async history(tx: TenantTx, contractorId: string, today: string): Promise<VendorPerformanceHistory> {
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const policy = await this.policies.performance(tx, today);
    const lines = await this.lines(tx, 'and p.contractor_id = $1::uuid', [contractorId], today, policy.value);
    const rated = this.rated(lines);
    const streak = poorStreak(rated);
    const inWindow = new Set(withinRetrospect(rated, today, policy.value).map((one) => `${one.contractId}|${one.adoptedOn}`));
    return {
      lines,
      streak,
      suggestion: streakSuggestion(streak, policy.value),
      retrospectProposalIds: lines.filter((line) => line.adoptedOn !== null && inWindow.has(`${line.contractId}|${line.adoptedOn}`)).map((line) => line.proposalId),
      policy,
    };
  }

  /** The adopted ratings of a contractor in the form the streak and the window read. */
  rated(lines: readonly VendorRatingLine[]): RatedContract[] {
    return lines
      .filter((line) => line.state === 'ADOPTED' && line.rating !== null && line.adoptedOn !== null)
      .map((line) => ({ contractId: line.contractId, adoptedOn: line.adoptedOn as string, rating: line.rating as PerformanceRating, score: line.score, construction: line.construction }));
  }

  /** The poor streak of a contractor on a day (the reading of the risk grade). */
  async streakOf(tx: TenantTx, contractorId: string, today: string): Promise<number> {
    const policy = await this.policies.performance(tx, today);
    return poorStreak(this.rated(await this.lines(tx, 'and p.contractor_id = $1::uuid', [contractorId], today, policy.value)));
  }

  /** The publications to look after: those due (not posted, in time), overdue, or posted; newest rating first. */
  async worklist(tx: TenantTx, filter: VendorPublicationWorkFilter, today: string): Promise<{ lines: VendorRatingLine[]; policy: Policy<PerformancePolicy> }> {
    const policy = await this.policies.performance(tx, today);
    const params: unknown[] = [];
    let where = "and p.state = 'ADOPTED'";
    if (filter.contractorId !== undefined) {
      params.push(filter.contractorId);
      where += ` and p.contractor_id = $${params.length}::uuid`;
    }
    const all = await this.lines(tx, where, params, today, policy.value);
    const state = filter.state ?? 'ALL';
    const keep = (line: VendorRatingLine): boolean => {
      if (state === 'ALL') return true;
      if (state === 'POSTED') return line.publication !== null;
      if (line.publication !== null) return false;
      return state === 'OVERDUE' ? line.publicationClock === 'OVERDUE' : line.publicationClock !== 'OVERDUE';
    };
    return { lines: all.filter(keep).slice(0, filter.limit ?? 200), policy };
  }

  /**
   * Records the posting of an adopted rating on the national system: a person other than the one who adopted it, the reference the network gave, once for the first posting (409 `PERFORMANCE_PUBLICATION_DUPLICATE`),
   * and an update (after the warranty, after a correct answer) only after the first posting, superseding the posting before it. A rating that was not adopted is 409 `RATING_NOT_ADOPTED`.
   */
  async post(tx: TenantTx, proposalId: string, input: { kind: string; receipt: string }, actor: string, today: string): Promise<VendorRatingLine> {
    const [row] = await tx.query<{ state: string; adopted_by: string | null; contract_id: string; contractor_id: string }>('select state, adopted_by, contract_id, contractor_id from machvon.contract_rating_proposal where id = $1::uuid for update', [proposalId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.state !== 'ADOPTED' || row.adopted_by === null) throw new DomainError('RATING_NOT_ADOPTED', 409, 'status');
    const kind = assertPublication({ kind: input.kind, receipt: input.receipt, postedBy: actor, adoptedBy: row.adopted_by });
    const policy = await this.policies.performance(tx, today);
    const [line] = await this.lines(tx, 'and p.id = $1::uuid', [proposalId], today, policy.value);
    if (line === undefined || line.publicationDueOn === null) throw new DomainError('RATING_NOT_ADOPTED', 409, 'status');
    const previous = [line.publication, ...line.updates].filter((one): one is VendorPublicationInfo => one !== null);
    if (kind === 'INITIAL' && line.publication !== null) throw new DomainError('PERFORMANCE_PUBLICATION_DUPLICATE', 409, 'kind');
    if (kind !== 'INITIAL' && line.publication === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'kind');
    const supersedes = kind === 'INITIAL' ? null : (previous[previous.length - 1] as VendorPublicationInfo).id;
    const clock = publicationClock({ dueOn: line.publicationDueOn, postedOn: today, today }, policy.value);
    await tx.query(
      `insert into machvon.vendor_performance_publication (tenant_id, id, rating_proposal_id, contractor_id, contract_id, kind, receipt, posted_by, posted_on, due_on, clock, rule_version, supersedes_id, created_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::date, $9::date, $10, $11, $12::uuid, $7::uuid)`,
      [randomUUID(), proposalId, row.contractor_id, row.contract_id, kind, input.receipt.trim(), actor, today, line.publicationDueOn, clock === 'MET' ? 'MET' : 'MET_LATE', policy.version, supersedes],
    );
    return (await this.lines(tx, 'and p.id = $1::uuid', [proposalId], today, policy.value))[0] as VendorRatingLine;
  }

  async find(tx: TenantTx, proposalId: string, today: string): Promise<VendorRatingLine | undefined> {
    const policy = await this.policies.performance(tx, today);
    return (await this.lines(tx, 'and p.id = $1::uuid', [proposalId], today, policy.value))[0];
  }

  /** The figures of the indicators of the performance register: published in time over published plus overdue, and answers reviewed in time over reviewed plus overdue. */
  async figures(tx: TenantTx, today: string): Promise<VendorFigure[]> {
    const policy = await this.policies.performance(tx, today);
    const lines = await this.lines(tx, '', [], today, policy.value);
    const adopted = lines.filter((line) => line.state === 'ADOPTED');
    const inTime = adopted.filter((line) => line.publication !== null && line.publicationClock === 'MET').length;
    const posted = adopted.filter((line) => line.publication !== null).length;
    const overdue = adopted.filter((line) => line.publication === null && line.publicationClock === 'OVERDUE').length;
    const answered = lines.filter((line) => line.responseReceivedOn !== null);
    const reviewedInTime = answered.filter((line) => line.state === 'ADOPTED' && line.adoptedOn !== null && daysBetween(line.responseReceivedOn as string, line.adoptedOn) <= policy.value.review_response_days).length;
    const reviewedLate = answered.filter((line) => line.state === 'ADOPTED' && line.adoptedOn !== null && daysBetween(line.responseReceivedOn as string, line.adoptedOn) > policy.value.review_response_days).length;
    const reviewOverdue = answered.filter((line) => line.responseReview === 'OVERDUE').length;
    return [
      { code: 'VENDOR_PERFORMANCE_PUBLISHED_IN_TIME', numerator: inTime, denominator: posted + overdue, asOf: today },
      { code: 'VENDOR_RESPONSE_REVIEWED_IN_TIME', numerator: reviewedInTime, denominator: reviewedInTime + reviewedLate + reviewOverdue, asOf: today },
    ];
  }
}

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
