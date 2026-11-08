import {
  BUILT_IN_OCP_IDS,
  DomainError,
  RED_FLAG_RANKING_RULE_TYPE,
  RED_FLAG_RULE_TYPE,
  compareFindings,
  evaluateRedFlags,
  nextRedFlagStatus,
  rankingDefaults,
  registeredRedFlagIndicators,
  reopensAfterRescan,
  scoreOf,
  versionConflict,
} from '@machvon/kernel';
import type { IndicatorParams, IndicatorReading, RankingParams, RedFlagFacts, RedFlagMove, RedFlagScore, RedFlagStatus, RedFlagSubjectType, RuleParams } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

export type RedFlagBandWord = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

/** The rules that judged one scan: the params of each indicator, the version of the rule that decided (0 is the built-in default) and the ranking. */
export interface RedFlagRules {
  indicators: Map<string, IndicatorParams>;
  versions: Record<string, number>;
  ranking: RankingParams;
  rankingVersion: string;
}

export interface FindingRow {
  id: string;
  subjectType: RedFlagSubjectType;
  subjectId: string;
  subjectCode: string;
  projectId: string | null;
  score: number;
  band: RedFlagBandWord;
  fired: Array<{ code: string; ocp_id: string; value: number | null; threshold: number | null; weight: number }>;
  readings: IndicatorReading[];
  notComputable: string[];
  ruleVersions: Record<string, number>;
  rankingVersion: string;
  status: RedFlagStatus;
  firstFlaggedAt: string;
  lastEvaluatedAt: string;
  evaluationCount: number;
  reviewerId: string | null;
  reviewStartedAt: string | null;
  clearProposedBy: string | null;
  clearReason: string | null;
  clearedBy: string | null;
  clearedAt: string | null;
  referredBy: string | null;
  referredAt: string | null;
  referralReason: string | null;
  reopenedCount: number;
  version: number;
}

export interface ReviewRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  reason: string | null;
  score: number;
  at: string;
}

export interface ScanResult {
  scanId: string;
  created: boolean;
  subjects: number;
  flagged: number;
  rescored: number;
  reopened: number;
  notComputable: number;
}

export interface FindingFilter {
  status?: RedFlagStatus | undefined;
  band?: RedFlagBandWord | undefined;
  projectId?: string | undefined;
  /** The ranked list is cut here: the keyset (score, first flagged, code, id) of the last row of the previous page. */
  limit: number;
  offset: number;
}

export interface ScanReading {
  id: string;
  scanKey: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'FINISHED' | 'FAILED';
  subjects: number;
  flagged: number;
}

interface FactsRow {
  subject_type: RedFlagSubjectType;
  subject_id: string;
  subject_code: string;
  project_id: string | null;
  method: string | null;
  estimate: string | null;
  bids_closed: boolean;
  bidder_count: string;
  bid_prices: string[] | null;
  award_price: string | null;
  contract_value: string | null;
  contract_original: string | null;
  change_count: number | null;
  max_variation: string | null;
  tender_days: number | null;
  split_count: string | null;
  split_total: string | null;
  near_awards: string | null;
  restricted: string;
}

export interface Subject {
  type: RedFlagSubjectType;
  id: string;
  code: string;
  projectId: string | null;
  facts: RedFlagFacts;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const text = (params: RuleParams, key: string, fallback: string): string => (typeof params[key] === 'string' ? (params[key] as string) : fallback);
const NEVER = '9999999999999999999999';

function indicatorParamsOf(params: RuleParams): IndicatorParams {
  return {
    weight: typeof params.weight === 'number' ? params.weight : 1,
    enabled: params.enabled !== false,
    ...(typeof params.threshold === 'number' ? { threshold: params.threshold } : {}),
    ...(typeof params.threshold_vnd === 'string' ? { threshold_vnd: params.threshold_vnd } : {}),
    ...(typeof params.margin_pct === 'number' ? { margin_pct: params.margin_pct } : {}),
    ...(typeof params.min_count === 'number' ? { min_count: params.min_count } : {}),
    ...(typeof params.window_days === 'number' ? { window_days: params.window_days } : {}),
  };
}

const FINDING_COLUMNS = `f.id, f.subject_type, f.subject_id, f.subject_code, f.project_id, f.score, f.band, f.fired, f.readings, f.not_computable, f.rule_versions, f.ranking_version, f.status,
  ${ISO('f.first_flagged_at')} as first_flagged_at, ${ISO('f.last_evaluated_at')} as last_evaluated_at, f.evaluation_count, f.reviewer_membership_id, ${ISO('f.review_started_at')} as review_started_at,
  f.clear_proposed_by, f.clear_reason, f.cleared_by, ${ISO('f.cleared_at')} as cleared_at, f.referred_by, ${ISO('f.referred_at')} as referred_at, f.referral_reason, f.reopened_count, f.version`;

type Raw = Record<string, unknown>;
const toFinding = (row: Raw): FindingRow => ({
  id: row.id as string,
  subjectType: row.subject_type as RedFlagSubjectType,
  subjectId: row.subject_id as string,
  subjectCode: row.subject_code as string,
  projectId: (row.project_id as string | null) ?? null,
  score: row.score as number,
  band: row.band as RedFlagBandWord,
  fired: row.fired as FindingRow['fired'],
  readings: row.readings as IndicatorReading[],
  notComputable: row.not_computable as string[],
  ruleVersions: row.rule_versions as Record<string, number>,
  rankingVersion: row.ranking_version as string,
  status: row.status as RedFlagStatus,
  firstFlaggedAt: row.first_flagged_at as string,
  lastEvaluatedAt: row.last_evaluated_at as string,
  evaluationCount: row.evaluation_count as number,
  reviewerId: (row.reviewer_membership_id as string | null) ?? null,
  reviewStartedAt: (row.review_started_at as string | null) ?? null,
  clearProposedBy: (row.clear_proposed_by as string | null) ?? null,
  clearReason: (row.clear_reason as string | null) ?? null,
  clearedBy: (row.cleared_by as string | null) ?? null,
  clearedAt: (row.cleared_at as string | null) ?? null,
  referredBy: (row.referred_by as string | null) ?? null,
  referredAt: (row.referred_at as string | null) ?? null,
  referralReason: (row.referral_reason as string | null) ?? null,
  reopenedCount: row.reopened_count as number,
  version: row.version as number,
});

/** The finding is hidden from the people who took part in what it is about (`red_flag_involved`): this fragment is in every read, with the reader as a parameter. */
const NOT_INVOLVED = (readerParam: string): string => `not exists (select 1 from machvon.red_flag_involved i where i.tenant_id = f.tenant_id and i.finding_id = f.id and i.membership_id = ${readerParam}::uuid)`;

/**
 * The red flags of procurement (G4-3): the scan that reads the facts of BID and CTR, the twelve indicators of the kernel judge them with the rules in force, and the finding of each subject is written; the review in
 * two steps; and the reads, every one of which leaves out what the reader took part in. The store never concludes anything: a finding is a score and a list of readings.
 */
export class RedFlagStore {
  private readonly port = new GovernancePolicyPort();

  /** The rules in force on a day: each indicator's params from the rule of the tenant or the built-in default, and the ranking. A rule that does not read is the default (and the indicator keeps working). */
  async rules(tx: TenantTx, today: string): Promise<RedFlagRules> {
    const indicators = new Map<string, IndicatorParams>();
    const versions: Record<string, number> = {};
    for (const indicator of registeredRedFlagIndicators()) {
      const resolved = await this.port.get(tx, RED_FLAG_RULE_TYPE, indicator.code, today);
      if (resolved === undefined) continue;
      indicators.set(indicator.code, indicatorParamsOf(resolved.params));
      versions[indicator.code] = resolved.version;
    }
    const ranking = await this.port.get(tx, RED_FLAG_RANKING_RULE_TYPE, 'DEFAULT', today);
    const params = ranking?.params;
    const rank: RankingParams = typeof params?.medium_from === 'number' && typeof params.high_from === 'number' ? { medium_from: params.medium_from, high_from: params.high_from } : rankingDefaults();
    return { indicators, versions, ranking: rank, rankingVersion: ranking === undefined || ranking.source === 'DEFAULT' ? 'builtin' : String(ranking.version) };
  }

  /** The facts of every approved package with the contract that came of it, and of every contract with no package, as the indicators need them; a fact the data does not have is null. */
  async subjects(tx: TenantTx, rules: RedFlagRules, now: Date): Promise<Subject[]> {
    const split = rules.indicators.get('SPLIT_PROCUREMENT');
    const near = rules.indicators.get('NEAR_THRESHOLD_DIRECT_AWARDS');
    const splitLimit = split?.threshold_vnd ?? NEVER;
    const nearLimit = near?.threshold_vnd ?? NEVER;
    const rows = await tx.query<FactsRow>(
      `select 'PACKAGE' as subject_type, pk.id as subject_id, pk.code as subject_code, pk.project_id,
              pk.method, pk.budget_vnd::text as estimate,
              exists (select 1 from machvon.procurement_milestone m where m.tenant_id = pk.tenant_id and m.package_id = pk.id and m.milestone_kind = 'BID_CLOSING' and coalesce(m.actual_at, m.planned_at) <= $1::timestamptz) as bids_closed,
              (select count(*) from machvon.proposal pr where pr.tenant_id = pk.tenant_id and pr.package_id = pk.id and pr.status = 'RECEIVED')::text as bidder_count,
              array(select pr.bid_price_vnd::text from machvon.proposal pr where pr.tenant_id = pk.tenant_id and pr.package_id = pk.id and pr.status = 'RECEIVED' and pr.bid_price_vnd is not null order by pr.id) as bid_prices,
              (select r.award_price_vnd::text from machvon.procurement_result r where r.tenant_id = pk.tenant_id and r.package_id = pk.id and r.status = 'APPROVED' order by r.approved_at desc nulls last limit 1) as award_price,
              cf.contract_value_vnd::text as contract_value, cf.original_value_vnd::text as contract_original, cf.approved_change_count as change_count, cf.max_cumulative_variation_pct::text as max_variation,
              (select (extract(epoch from (coalesce(c.actual_at, c.planned_at) - coalesce(i.actual_at, i.planned_at))) / 86400)::int
                 from machvon.procurement_milestone i join machvon.procurement_milestone c on c.tenant_id = i.tenant_id and c.package_id = i.package_id and c.milestone_kind = 'BID_CLOSING'
                where i.tenant_id = pk.tenant_id and i.package_id = pk.id and i.milestone_kind = 'INVITATION_PUBLISHED' and coalesce(c.actual_at, c.planned_at) is not null and coalesce(i.actual_at, i.planned_at) is not null) as tender_days,
              case when pk.budget_vnd < $2::numeric then (select count(*) from machvon.procurement_package o where o.tenant_id = pk.tenant_id and o.project_id = pk.project_id and o.contract_type is not distinct from pk.contract_type
                      and o.method not in ('OPEN_BIDDING', 'LIMITED_BIDDING') and o.budget_vnd < $2::numeric and o.status = 'APPROVED' and abs(o.created_at::date - pk.created_at::date) <= $3)::text end as split_count,
              case when pk.budget_vnd < $2::numeric then (select coalesce(sum(o.budget_vnd), 0) from machvon.procurement_package o where o.tenant_id = pk.tenant_id and o.project_id = pk.project_id and o.contract_type is not distinct from pk.contract_type
                      and o.method not in ('OPEN_BIDDING', 'LIMITED_BIDDING') and o.budget_vnd < $2::numeric and o.status = 'APPROVED' and abs(o.created_at::date - pk.created_at::date) <= $3)::text end as split_total,
              case when pk.method = 'DIRECT_APPOINTMENT' and pk.budget_vnd < $4::numeric and pk.budget_vnd >= $4::numeric * (100 - $5::numeric) / 100
                   then (select count(*) from machvon.procurement_package o join machvon.project op on op.tenant_id = o.tenant_id and op.id = o.project_id
                          where o.tenant_id = pk.tenant_id and o.method = 'DIRECT_APPOINTMENT' and o.status = 'APPROVED' and op.owner_unit_id = p.owner_unit_id
                            and o.budget_vnd < $4::numeric and o.budget_vnd >= $4::numeric * (100 - $5::numeric) / 100 and o.created_at >= $1::timestamptz - ($6::int * interval '1 day'))::text
                   else '0' end as near_awards,
              (select count(*) from machvon.proposal pr join machvon.contractor_restriction cr on cr.tenant_id = pr.tenant_id and cr.contractor_id = pr.contractor_id and cr.kind in ('DEBARMENT', 'SUSPENSION')
                where pr.tenant_id = pk.tenant_id and pr.package_id = pk.id and pr.status = 'RECEIVED' and cr.effective_from <= coalesce(pr.submitted_at, pr.created_at)::date
                  and (cr.effective_until is null or cr.effective_until >= coalesce(pr.submitted_at, pr.created_at)::date))::text as restricted
         from machvon.procurement_package pk join machvon.project p on p.tenant_id = pk.tenant_id and p.id = pk.project_id
         left join machvon.contract_fact cf on cf.tenant_id = pk.tenant_id and cf.package_id = pk.id
        where pk.status = 'APPROVED'
       union all
       select 'CONTRACT', c.id, c.code, c.project_id, null, null, false, '0', null, null, c.contract_value_vnd::text, c.original_value_vnd::text, c.approved_change_count, c.max_cumulative_variation_pct::text, null, null, null, null, '0'
         from machvon.contract_fact c where c.package_id is null and c.contract_status not in ('DRAFT', 'IN_REVIEW', 'CANCELLED')
        order by 1, 3 limit 5000`,
      [now.toISOString(), splitLimit, split?.window_days ?? 90, nearLimit, near?.margin_pct ?? 5, near?.window_days ?? 365],
    );
    return rows.map((row) => ({
      type: row.subject_type,
      id: row.subject_id,
      code: row.subject_code,
      projectId: row.project_id,
      facts: {
        packageCode: row.subject_code,
        method: row.method,
        estimateVnd: row.estimate,
        // Until the bids closed the number of bidders is not known: it is not "none".
        bidderCount: row.subject_type === 'CONTRACT' || !row.bids_closed ? null : Number(row.bidder_count),
        bidPricesVnd: row.subject_type === 'CONTRACT' || !row.bids_closed ? null : (row.bid_prices ?? []),
        awardPriceVnd: row.award_price,
        contractValueVnd: row.contract_value,
        contractOriginalValueVnd: row.contract_original,
        approvedChangeCount: row.change_count,
        maxCumulativeVariationPct: row.max_variation === null ? null : Number(row.max_variation),
        tenderPeriodDays: row.tender_days,
        splitCount: row.split_count === null ? null : Number(row.split_count),
        splitTotalVnd: row.split_total,
        nearThresholdDirectAwards: row.subject_type === 'CONTRACT' ? null : Number(row.near_awards ?? '0'),
        restrictedBidderCount: row.subject_type === 'CONTRACT' || !row.bids_closed ? null : Number(row.restricted),
      },
    }));
  }

  /**
   * One scan of the tenant: every subject is evaluated and a finding is written for each that has a score. A scan of the same key (a day and a slot) is recorded once; a scan that fails midway is rolled back by the
   * transaction of the caller and recorded as FAILED by the next one. A cleared finding is reopened only when an indicator fires that was not among the cleared ones or the score rose; a finding whose score fell
   * to nothing keeps its row (its history stays) and drops out of the ranked list.
   */
  async scan(tx: TenantTx, now: Date, scanKey: string, today: string): Promise<ScanResult> {
    const started = await tx.query<{ id: string }>(
      `insert into machvon.red_flag_scan (tenant_id, scan_key, started_at) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::timestamptz) on conflict (tenant_id, scan_key) do nothing returning id`,
      [scanKey, now.toISOString()],
    );
    const scanId = started[0]?.id;
    if (scanId === undefined) {
      const [existing] = await tx.query<{ id: string; subjects: number; flagged: number; rescored: number; reopened: number; not_computable: number }>('select id, subjects, flagged, rescored, reopened, not_computable from machvon.red_flag_scan where scan_key = $1', [scanKey]);
      const found = existing as NonNullable<typeof existing>;
      return { scanId: found.id, created: false, subjects: found.subjects, flagged: found.flagged, rescored: found.rescored, reopened: found.reopened, notComputable: found.not_computable };
    }
    const rules = await this.rules(tx, today);
    const subjects = await this.subjects(tx, rules, now);
    const result: ScanResult = { scanId, created: true, subjects: subjects.length, flagged: 0, rescored: 0, reopened: 0, notComputable: 0 };
    for (const subject of subjects) {
      const readings = evaluateRedFlags(subject.facts, rules.indicators);
      const score = scoreOf(readings, rules.ranking);
      if (score.notComputable.length > 0) result.notComputable += 1;
      const outcome = await this.write(tx, subject, readings, score, rules, now);
      if (outcome === 'FLAGGED') result.flagged += 1;
      else if (outcome === 'RESCORED') result.rescored += 1;
      else if (outcome === 'REOPENED') result.reopened += 1;
    }
    await tx.query(`update machvon.red_flag_scan set finished_at = $2::timestamptz, status = 'FINISHED', subjects = $3, flagged = $4, rescored = $5, reopened = $6, not_computable = $7 where id = $1::uuid`, [
      scanId,
      new Date().toISOString(),
      result.subjects,
      result.flagged,
      result.rescored,
      result.reopened,
      result.notComputable,
    ]);
    return result;
  }

  private async write(tx: TenantTx, subject: Subject, readings: IndicatorReading[], score: RedFlagScore, rules: RedFlagRules, now: Date): Promise<'FLAGGED' | 'RESCORED' | 'REOPENED' | 'SAME' | 'NONE'> {
    const fired = readings.filter((reading) => reading.status === 'FIRED').map((reading) => ({ code: reading.code, ocp_id: reading.ocpId, value: reading.value, threshold: reading.threshold, weight: reading.weight }));
    const [current] = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.red_flag_finding f where f.subject_type = $1 and f.subject_id = $2::uuid for update`, [subject.type, subject.id]);
    if (current === undefined) {
      if (score.score === 0) return 'NONE';
      const [created] = await tx.query<{ id: string }>(
        `insert into machvon.red_flag_finding (tenant_id, subject_type, subject_id, subject_code, project_id, score, band, fired, readings, not_computable, rule_versions, ranking_version, first_flagged_at, last_evaluated_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb, $8::jsonb, $9::text[], $10::jsonb, $11, $12::timestamptz, $12::timestamptz) returning id`,
        [subject.type, subject.id, subject.code, subject.projectId, score.score, score.band, JSON.stringify(fired), JSON.stringify(readings), score.notComputable, JSON.stringify(rules.versions), rules.rankingVersion, now.toISOString()],
      );
      const id = (created as { id: string }).id;
      await this.history(tx, id, 'FLAGGED', null, 'NEW', null, null, score.score, now);
      await this.deriveInvolved(tx, id, subject);
      return 'FLAGGED';
    }
    const before = toFinding(current);
    const firedBefore = before.fired.map((entry) => entry.code);
    let status: RedFlagStatus = before.status;
    let outcome: 'RESCORED' | 'REOPENED' | 'SAME' = 'SAME';
    if (score.score !== before.score) outcome = 'RESCORED';
    if ((before.status === 'CLEARED' || before.status === 'REFERRED') && reopensAfterRescan({ fired: firedBefore, score: before.score }, { fired: score.fired, score: score.score })) {
      status = 'NEW';
      outcome = 'REOPENED';
    }
    await tx.query(
      `update machvon.red_flag_finding set subject_code = $2, project_id = $3::uuid, score = $4::int, band = $5::text, fired = $6::jsonb, readings = $7::jsonb, not_computable = $8::text[], rule_versions = $9::jsonb, ranking_version = $10,
              status = $11::text, last_evaluated_at = $12::timestamptz, evaluation_count = evaluation_count + 1, reopened_count = reopened_count + $13::int,
              cleared_by = case when $11 = 'NEW' then null else cleared_by end, cleared_at = case when $11 = 'NEW' then null else cleared_at end, clear_proposed_by = case when $11 = 'NEW' then null else clear_proposed_by end,
              clear_reason = case when $11 = 'NEW' then null else clear_reason end, referred_by = case when $11 = 'NEW' then null else referred_by end, referred_at = case when $11 = 'NEW' then null else referred_at end,
              referral_reason = case when $11 = 'NEW' then null else referral_reason end, reviewer_membership_id = case when $11 = 'NEW' then null else reviewer_membership_id end,
              version = version + case when $4::int <> $14::int or $11::text <> $15::text then 1 else 0 end
        where id = $1::uuid`,
      [before.id, subject.code, subject.projectId, score.score, score.band, JSON.stringify(fired), JSON.stringify(readings), score.notComputable, JSON.stringify(rules.versions), rules.rankingVersion, status, now.toISOString(), outcome === 'REOPENED' ? 1 : 0, before.score, before.status],
    );
    if (outcome === 'REOPENED') await this.history(tx, before.id, 'REOPENED', before.status, 'NEW', null, 'a new signal or a higher score after the finding was closed', score.score, now);
    else if (outcome === 'RESCORED') await this.history(tx, before.id, 'RESCORED', before.status, before.status, null, null, score.score, now);
    await this.deriveInvolved(tx, before.id, subject);
    return outcome;
  }

  private async history(tx: TenantTx, findingId: string, move: string, from: string | null, to: string, actor: string | null, reason: string | null, score: number, at: Date): Promise<void> {
    await tx.query(
      `insert into machvon.red_flag_review (tenant_id, finding_id, move, from_status, to_status, actor_membership_id, reason, score, at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::timestamptz)`,
      [findingId, move, from, to, actor, reason, score, at.toISOString()],
    );
  }

  /** Rebuilds the people who took part in the procurement or the contract: the drafter, the panel who declared on conflicts, whoever moved the workflow, wrote or approved the result, drew up or signed the contract, and the leader accountable for the project. */
  private async deriveInvolved(tx: TenantTx, findingId: string, subject: Subject): Promise<void> {
    await tx.query('delete from machvon.red_flag_involved where finding_id = $1::uuid', [findingId]);
    const isPackage = subject.type === 'PACKAGE';
    await tx.query(
      `insert into machvon.red_flag_involved (tenant_id, finding_id, membership_id, role)
       select distinct nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, x.member, x.role
         from (
           select pk.created_by as member, 'DRAFTER' as role from machvon.procurement_package pk where $3 and pk.id = $2::uuid
           union all select c.user_id, 'PANEL' from machvon.bid_conflict_declaration c where $3 and c.package_id = $2::uuid
           union all select w.owner_membership_id, 'WORKFLOW' from machvon.package_workflow w where $3 and w.package_id = $2::uuid
           union all select l.actor, 'WORKFLOW' from machvon.package_workflow_log l where $3 and l.package_id = $2::uuid
           union all select u.member, 'RESULT' from machvon.procurement_result r cross join lateral (values (r.created_by), (r.submitted_by), (r.approved_by)) as u(member) where $3 and r.package_id = $2::uuid
           union all select k.created_by, 'CONTRACT' from machvon.contract k where (($3 and k.package_id = $2::uuid) or (not $3 and k.id = $2::uuid))
           union all select s.created_by, 'CONTRACT' from machvon.contract_status_change s join machvon.contract k on k.tenant_id = s.tenant_id and k.id = s.contract_id where (($3 and k.package_id = $2::uuid) or (not $3 and k.id = $2::uuid))
           union all select a.leader_membership_id, 'ACCOUNTABLE_LEADER' from machvon.project_accountability a where a.status = 'ACTIVE' and a.project_id = $4::uuid
         ) x join machvon.membership m on m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and m.id = x.member
        where x.member is not null`,
      [findingId, subject.id, isPackage, subject.projectId],
    );
  }

  // -- reads (each leaves out what the reader took part in) -------------------------------------------------------------------------------------------------------------------------

  async list(tx: TenantTx, reader: string, filter: FindingFilter): Promise<FindingRow[]> {
    const params: unknown[] = [reader];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where = ['f.band <> \'NONE\'', NOT_INVOLVED('$1')];
    if (filter.status !== undefined) where.push(`f.status = ${add(filter.status)}`);
    if (filter.band !== undefined) where.push(`f.band = ${add(filter.band)}`);
    if (filter.projectId !== undefined) where.push(`f.project_id = ${add(filter.projectId)}::uuid`);
    const limit = add(filter.limit);
    const offset = add(filter.offset);
    const rows = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.red_flag_finding f where ${where.join(' and ')} order by f.score desc, f.first_flagged_at, f.subject_code, f.id limit ${limit} offset ${offset}`, params);
    return rows.map(toFinding).sort((left, right) => compareFindings({ score: left.score, firstFlaggedAt: left.firstFlaggedAt, subjectCode: left.subjectCode }, { score: right.score, firstFlaggedAt: right.firstFlaggedAt, subjectCode: right.subjectCode }));
  }

  /** One finding, or nothing when it does not exist or the reader took part in what it is about (the caller answers 404 for both: the reader must not learn that a finding exists). */
  async findOne(tx: TenantTx, reader: string, id: string): Promise<FindingRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.red_flag_finding f where f.id = $2::uuid and ${NOT_INVOLVED('$1')}`, [reader, id]);
    return row === undefined ? undefined : toFinding(row);
  }

  async reviews(tx: TenantTx, id: string): Promise<ReviewRow[]> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_membership_id: string | null; reason: string | null; score: number; at: string }>(
      `select id, move, from_status, to_status, actor_membership_id, reason, score, ${ISO('at')} as at from machvon.red_flag_review where finding_id = $1::uuid order by at, id`,
      [id],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_membership_id, reason: row.reason, score: row.score, at: row.at }));
  }

  /** The counts of the ranked list by band and by status, for the reader (what they took part in is not counted). */
  async summary(tx: TenantTx, reader: string): Promise<{ total: number; byBand: Record<string, number>; byStatus: Record<string, number>; lastScan: ScanReading | null }> {
    const rows = await tx.query<{ band: string; status: string; n: string }>(
      `select f.band, f.status, count(*)::text as n from machvon.red_flag_finding f where f.band <> 'NONE' and ${NOT_INVOLVED('$1')} group by 1, 2`,
      [reader],
    );
    const byBand: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.n);
      total += n;
      byBand[row.band] = (byBand[row.band] ?? 0) + n;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
    }
    return { total, byBand, byStatus, lastScan: await this.lastScan(tx) };
  }

  async lastScan(tx: TenantTx): Promise<ScanReading | null> {
    const [row] = await tx.query<{ id: string; scan_key: string; started_at: string; finished_at: string | null; status: ScanReading['status']; subjects: number; flagged: number }>(
      `select id, scan_key, ${ISO('started_at')} as started_at, ${ISO('finished_at')} as finished_at, status, subjects, flagged from machvon.red_flag_scan order by started_at desc, id desc limit 1`,
    );
    return row === undefined ? null : { id: row.id, scanKey: row.scan_key, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, subjects: row.subjects, flagged: row.flagged };
  }

  // -- review ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** One move of the review. The one who acts is an auditor (the caller judged the permission); clearing needs a second auditor than the proposer; a finding the actor took part in is not found. */
  async move(tx: TenantTx, id: string, expectedVersion: number, move: RedFlagMove, actor: string, reason: string | undefined, now: Date): Promise<FindingRow> {
    const [row] = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.red_flag_finding f where f.id = $2::uuid and ${NOT_INVOLVED('$1')} for update`, [actor, id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const current = toFinding(row);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const next = nextRedFlagStatus(current.status, move, { actor, proposer: current.clearProposedBy, reason: reason ?? null });
    const text = reason?.trim() ?? null;
    // Each move sets its own columns; a statement names only the parameters it uses (the database cannot type one that nothing mentions).
    const at = now.toISOString();
    if (move === 'TAKE') await tx.query("update machvon.red_flag_finding set status = $2, reviewer_membership_id = $3::uuid, review_started_at = $4::timestamptz, version = version + 1 where id = $1::uuid", [id, next, actor, at]);
    else if (move === 'PROPOSE_CLEAR') await tx.query("update machvon.red_flag_finding set status = $2, clear_proposed_by = $3::uuid, clear_reason = $4, version = version + 1 where id = $1::uuid", [id, next, actor, text]);
    else if (move === 'CONFIRM_CLEAR') await tx.query("update machvon.red_flag_finding set status = $2, cleared_by = $3::uuid, cleared_at = $4::timestamptz, version = version + 1 where id = $1::uuid", [id, next, actor, at]);
    else if (move === 'REJECT_CLEAR') await tx.query("update machvon.red_flag_finding set status = $2, clear_proposed_by = null, clear_reason = null, version = version + 1 where id = $1::uuid", [id, next]);
    else await tx.query("update machvon.red_flag_finding set status = $2, referred_by = $3::uuid, referred_at = $4::timestamptz, referral_reason = $5, version = version + 1 where id = $1::uuid", [id, next, actor, at, text]);
    await this.history(tx, id, move, current.status, next, actor, text, current.score, now);
    return (await this.findOne(tx, actor, id)) as FindingRow;
  }

  // -- the registry (what each indicator is, for the screen) ---------------------------------------------------------------------------------------------------------------------

  /** Every registered indicator with its formula, source, as-of day and legal status, and the thresholds the rule in force gives it today (a default is flagged as not confirmed). */
  async registry(tx: TenantTx, today: string): Promise<Array<{ code: string; ocpId: string; vendorSide: boolean; dataSources: string[]; formula: string; source: string; asOf: string; legalStatus: string; params: Record<string, unknown> | null; version: number | null; unverified: boolean; enabled: boolean }>> {
    const out = [];
    for (const indicator of registeredRedFlagIndicators()) {
      const resolved = await this.port.get(tx, RED_FLAG_RULE_TYPE, indicator.code, today);
      out.push({
        code: indicator.code,
        ocpId: indicator.ocpId,
        vendorSide: indicator.vendorSide,
        dataSources: indicator.dataSources,
        formula: resolved?.provenance?.formula ?? indicator.formula,
        source: resolved?.provenance?.source ?? indicator.source,
        asOf: resolved?.provenance?.asOf ?? indicator.asOf,
        legalStatus: resolved?.provenance?.legalStatus ?? indicator.legalStatus,
        params: resolved === undefined ? null : { ...resolved.params, indicator: text(resolved.params, 'indicator', indicator.code) },
        version: resolved === undefined ? null : resolved.version,
        unverified: resolved?.unverified ?? true,
        enabled: resolved?.params.enabled !== false,
      });
    }
    return out;
  }

  /** The OCP ids of the twelve built-in indicators (for the screens that name them). */
  static readonly OCP_IDS = BUILT_IN_OCP_IDS;
}
