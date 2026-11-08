import { randomUUID } from 'node:crypto';
import { DomainError, assertRiskDecision, expiryState, gradeRisk, nextReviewOn, profileCoverage, versionConflict } from '@machvon/kernel';
import type { RiskFactor, RiskFactorLine, RiskGrade, RiskInputs, RiskPolicy, RiskSnapshotState, RiskTier } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorPayeeStore } from './vendor-payee-store.ts';
import { VendorPerformanceStore } from './vendor-performance-store.ts';
import type { VendorFigure } from './vendor-performance-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import type { Policy } from './vendor-policy.ts';
import { VendorProfileStore, factsOfProfile } from './vendor-profile-store.ts';
import { VendorQualificationStore } from './vendor-qualification-store.ts';
import { VendorReputationStore } from './vendor-reputation-store.ts';
import { vendorRiskSignals } from './vendor-risk-signals.ts';
import type { VendorRiskSignalPort } from './vendor-risk-signals.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface VendorRiskAssessmentRow {
  id: string;
  contractorId: string;
  contractorName: string;
  score: number;
  tier: RiskTier;
  scoreTier: RiskTier;
  floored: boolean;
  factors: RiskFactorLine[];
  reasons: RiskFactor[];
  inputs: RiskInputs;
  ruleVersion: string;
  ruleUnverified: boolean;
  reviewMonths: number;
  nextReviewOn: string;
  dualCheck: boolean;
  asOf: string;
  state: RiskSnapshotState;
  assessedBy: string;
  assessedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  supersededById: string | null;
  version: number;
}

interface AssessmentSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  score: number;
  tier: RiskTier;
  score_tier: RiskTier;
  floored: boolean;
  factors: RiskFactorLine[];
  reasons: RiskFactor[];
  inputs: RiskInputs;
  rule_version: string;
  rule_unverified: boolean;
  review_months: number;
  next_review_on: string;
  dual_check: boolean;
  as_of: string;
  state: RiskSnapshotState;
  assessed_by: string;
  assessed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  superseded_by_id: string | null;
  version: string;
}

const SELECT = `select a.id, a.contractor_id, k.legal_name as contractor_name, a.score, a.tier, a.score_tier, a.floored, a.factors, a.reasons, a.inputs, a.rule_version, a.rule_unverified, a.review_months,
       a.next_review_on::text as next_review_on, a.dual_check, a.as_of::text as as_of, a.state, a.assessed_by, to_char(a.assessed_at at time zone 'UTC', ${ISO}) as assessed_at, a.decided_by,
       to_char(a.decided_at at time zone 'UTC', ${ISO}) as decided_at, a.decision_reason, a.superseded_by_id, a.version::text as version
  from machvon.vendor_risk_assessment a join machvon.contractor k on k.tenant_id = a.tenant_id and k.id = a.contractor_id`;

const toRow = (row: AssessmentSql): VendorRiskAssessmentRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  score: row.score,
  tier: row.tier,
  scoreTier: row.score_tier,
  floored: row.floored,
  factors: row.factors,
  reasons: row.reasons,
  inputs: row.inputs,
  ruleVersion: row.rule_version,
  ruleUnverified: row.rule_unverified,
  reviewMonths: row.review_months,
  nextReviewOn: row.next_review_on,
  dualCheck: row.dual_check,
  asOf: row.as_of,
  state: row.state,
  assessedBy: row.assessed_by,
  assessedAt: row.assessed_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  supersededById: row.superseded_by_id,
  version: Number(row.version),
});

/** A computed grade that is not stored: what an assessment would say today, with the inputs, for the explanation view. */
export interface VendorLiveGrade {
  grade: RiskGrade;
  inputs: RiskInputs;
  policy: Policy<RiskPolicy>;
  nextReviewOn: string;
}

export interface VendorRiskRegisterFilter {
  q?: string | undefined;
  tier?: RiskTier | undefined;
  reviewDue?: boolean | undefined;
  pending?: boolean | undefined;
  limit: number;
  after?: { name: string; id: string } | undefined;
}

export interface VendorRiskRegisterRow {
  contractorId: string;
  name: string;
  taxIdentifier: string;
  tier: RiskTier | null;
  score: number | null;
  nextReviewOn: string | null;
  reviewOverdue: boolean;
  assessmentId: string | null;
  pendingAssessmentId: string | null;
  pendingTier: RiskTier | null;
}

interface RegisterSql {
  id: string;
  legal_name: string;
  tax_identifier: string;
  risk_tier: RiskTier | null;
  score: number | null;
  risk_next_review_on: string | null;
  review_overdue: boolean;
  risk_assessment_id: string | null;
  pending_id: string | null;
  pending_tier: RiskTier | null;
}

/**
 * The risk grade of a contractor (VND-2, V13; docs/vendor-controls-risk-performance.md). The grade is computed by the kernel from what the other controls found, with the weights and cut points of the rule `VENDOR_RISK`;
 * it is stored as a snapshot with the points of every factor and the rule version, proposed by one person and confirmed by a decision (a grade that needs a dual check is confirmed by another person). A confirmation
 * writes the grade on the contractor and supersedes the one before. The readings that the finance, independence, security and subcontract controls own come through `VendorRiskSignalPort`; a reading that is not
 * available counts as unknown (never as a pass). The grade does not decide whether a contractor may bid.
 */
export class VendorRiskStore {
  private readonly policies: VendorPolicyReader;
  private readonly signals: VendorRiskSignalPort;
  private readonly profiles = new VendorProfileStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly reputation = new VendorReputationStore();
  private readonly payee = new VendorPayeeStore();
  private readonly performance: VendorPerformanceStore;

  constructor(signals: VendorRiskSignalPort = vendorRiskSignals, policies: VendorPolicyReader = new VendorPolicyReader()) {
    this.signals = signals;
    this.policies = policies;
    this.performance = new VendorPerformanceStore(policies);
  }

  /** What the controls found about one contractor on a day. */
  async inputsOf(tx: TenantTx, contractorId: string, today: string): Promise<RiskInputs> {
    const profile = await this.profiles.require(tx, contractorId);
    const profilePolicy = await this.policies.profile(tx, today);
    const coverage = profileCoverage(factsOfProfile(profile), profilePolicy.value.required_before_bid);
    const [restrictions] = await tx.query<{ in_force: number; past: number }>(
      `select count(*) filter (where lifted_at is null and effective_from <= $2::date and (effective_until is null or effective_until >= $2::date))::int as in_force,
              count(*) filter (where lifted_at is not null or effective_until < $2::date)::int as past
         from machvon.contractor_restriction where contractor_id = $1::uuid`,
      [contractorId, today],
    );
    const factor = await this.reputation.bidSecurityFactor(tx, contractorId, today);
    const qualificationPolicy = (await this.policies.expiry(tx, 'QUALIFICATION', today)).value;
    const lapsed = (await this.qualifications.qualifications(tx, contractorId)).filter((one) => expiryState({ issuedOn: one.issuedOn, expiresOn: one.expiresOn, revoked: one.revokedAt !== null }, today, qualificationPolicy) === 'EXPIRED').length;
    const shared = (await this.payee.sharedAccounts(tx)).filter((one) => one.contractorIds.includes(contractorId)).length;
    const stalled = (await this.payee.requests(tx, { contractorId, status: 'REQUESTED', limit: 50 })).filter((one) => Date.parse(one.expiresAt) >= Date.parse(`${today}T00:00:00Z`)).length;
    return {
      profileCoveragePct: coverage.coveragePct,
      restrictionsInForce: restrictions?.in_force ?? 0,
      restrictionsPast: restrictions?.past ?? 0,
      reputationEventsPosted: factor.eventIds.length,
      qualificationsLapsed: lapsed,
      payeeAlerts: shared + stalled,
      poorRatingsConsecutive: await this.performance.streakOf(tx, contractorId, today),
      financeStatus: (await this.signals.finance?.(tx, contractorId, today)) ?? null,
      loadStatus: (await this.signals.load?.(tx, contractorId, today)) ?? null,
      openStrongFindings: (await this.signals.openStrongFindings?.(tx, contractorId, today)) ?? 0,
      subcontractBreaches: (await this.signals.subcontractBreaches?.(tx, contractorId, today)) ?? 0,
      securityForfeits: (await this.signals.securityForfeits?.(tx, contractorId, today)) ?? 0,
    };
  }

  /** The rule in force that grades use, with its version and legal status. */
  policyOf(tx: TenantTx, today: string): Promise<Policy<RiskPolicy>> {
    return this.policies.risk(tx, today);
  }

  /** The grade an assessment would give today, not stored. */
  async liveProposal(tx: TenantTx, contractorId: string, today: string): Promise<VendorLiveGrade> {
    const policy = await this.policies.risk(tx, today);
    const inputs = await this.inputsOf(tx, contractorId, today);
    const grade = gradeRisk(inputs, policy.value);
    return { grade, inputs, policy, nextReviewOn: nextReviewOn(today, grade.reviewMonths) };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<VendorRiskAssessmentRow | undefined> {
    const rows = await tx.query<AssessmentSql>(`${SELECT} where a.id = $1::uuid${lock ? ' for update of a' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The snapshots of a contractor, newest first. */
  async history(tx: TenantTx, contractorId: string, limit = 50): Promise<VendorRiskAssessmentRow[]> {
    const rows = await tx.query<AssessmentSql>(`${SELECT} where a.contractor_id = $1::uuid order by a.assessed_at desc, a.id desc limit $2::int`, [contractorId, limit]);
    return rows.map(toRow);
  }

  /** The grade in force (CONFIRMED) and the one waiting for its decision (PROPOSED), when there are such. */
  async current(tx: TenantTx, contractorId: string): Promise<{ confirmed: VendorRiskAssessmentRow | undefined; pending: VendorRiskAssessmentRow | undefined }> {
    const rows = await tx.query<AssessmentSql>(`${SELECT} where a.contractor_id = $1::uuid and a.state in ('CONFIRMED', 'PROPOSED')`, [contractorId]);
    const mapped = rows.map(toRow);
    return { confirmed: mapped.find((one) => one.state === 'CONFIRMED'), pending: mapped.find((one) => one.state === 'PROPOSED') };
  }

  /** The tier in force of a contractor (null when never graded): a read for the bid evaluation. */
  async riskTierOf(tx: TenantTx, contractorId: string): Promise<RiskTier | null> {
    const [row] = await tx.query<{ risk_tier: RiskTier | null }>('select risk_tier from machvon.contractor where id = $1::uuid', [contractorId]);
    return row?.risk_tier ?? null;
  }

  /** Computes the grade and stores it as a snapshot waiting for its decision (409 `RISK_ASSESSMENT_STATE_INVALID` when another waits). */
  async assess(tx: TenantTx, contractorId: string, today: string, actor: string): Promise<VendorRiskAssessmentRow> {
    const locked = await tx.query('select 1 from machvon.contractor where id = $1::uuid for update', [contractorId]);
    if (locked.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if ((await this.current(tx, contractorId)).pending !== undefined) throw new DomainError('RISK_ASSESSMENT_STATE_INVALID', 409, 'status');
    const live = await this.liveProposal(tx, contractorId, today);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.vendor_risk_assessment (tenant_id, id, contractor_id, score, tier, score_tier, floored, factors, reasons, inputs, rule_version, rule_unverified, review_months, next_review_on, dual_check, as_of, assessed_by, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::int, $4, $5, $6, $7::jsonb, $8::text[], $9::jsonb, $10, $11, $12::int, $13::date, $14, $15::date, $16::uuid, $16::uuid, $16::uuid)`,
      [id, contractorId, live.grade.score, live.grade.tier, live.grade.scoreTier, live.grade.floored, JSON.stringify(live.grade.factors), live.grade.reasons, JSON.stringify(live.inputs), live.policy.version, live.policy.unverified, live.grade.reviewMonths, live.nextReviewOn, live.grade.dualCheck, today, actor],
    );
    return (await this.find(tx, id)) as VendorRiskAssessmentRow;
  }

  /**
   * Confirms or rejects a waiting snapshot. A snapshot that needs a dual check is decided by a person other than the assessor (403 `SELF_APPROVAL_DENIED`); a rejection needs a reason of 20 characters; a confirmation writes
   * the tier on the contractor, with the day it is looked at again (the months of the tier from the day of the decision), and supersedes the grade that stood.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: 'CONFIRM' | 'REJECT', reason: string | undefined, actor: string, today: string): Promise<VendorRiskAssessmentRow> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    assertRiskDecision({ decision, reason, decidedBy: actor, assessedBy: row.assessedBy, dualCheck: row.dualCheck, state: row.state });
    const text = reason === undefined || reason.trim() === '' ? null : reason.trim();
    if (decision === 'REJECT') {
      await tx.query("update machvon.vendor_risk_assessment set state = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, version = version + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid", [id, actor, text]);
      return (await this.find(tx, id)) as VendorRiskAssessmentRow;
    }
    const previous = (await this.current(tx, row.contractorId)).confirmed;
    if (previous !== undefined) {
      // The one in force steps aside first: the unique index allows one confirmed row. The pointer on the new row is set once it is confirmed.
      await tx.query("update machvon.vendor_risk_assessment set state = 'SUPERSEDED', superseded_by_id = $2::uuid, version = version + 1, updated_at = now(), updated_by = $3::uuid where id = $1::uuid", [previous.id, id, actor]);
    }
    await tx.query("update machvon.vendor_risk_assessment set state = 'CONFIRMED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, version = version + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid", [id, actor, text]);
    const next = nextReviewOn(today, row.reviewMonths);
    await tx.query('update machvon.contractor set risk_tier = $2, risk_next_review_on = $3::date, risk_assessment_id = $4::uuid, version = version + 1 where id = $1::uuid', [row.contractorId, row.tier, next, id]);
    return (await this.find(tx, id)) as VendorRiskAssessmentRow;
  }

  /** The contractors with the grade in force, the day it is looked at again and the proposal waiting, filtered; ordered by name. */
  async register(tx: TenantTx, filter: VendorRiskRegisterFilter, today: string): Promise<VendorRiskRegisterRow[]> {
    const params: unknown[] = [today];
    const where: string[] = [];
    if (filter.q !== undefined && filter.q.trim() !== '') {
      params.push(`%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      where.push(`(c.legal_name ilike $${params.length} escape '\\' or c.tax_identifier ilike $${params.length} escape '\\')`);
    }
    if (filter.tier !== undefined) {
      params.push(filter.tier);
      where.push(`c.risk_tier = $${params.length}`);
    }
    if (filter.reviewDue === true) where.push('c.risk_next_review_on is not null and c.risk_next_review_on < $1::date');
    if (filter.pending === true) where.push('p.id is not null');
    if (filter.after !== undefined) {
      params.push(filter.after.name, filter.after.id);
      where.push(`(c.legal_name, c.id) > ($${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(filter.limit + 1);
    const rows = await tx.query<RegisterSql>(
      `select c.id, c.legal_name, c.tax_identifier, c.risk_tier, a.score, c.risk_next_review_on::text as risk_next_review_on,
              (c.risk_next_review_on is not null and c.risk_next_review_on < $1::date) as review_overdue, c.risk_assessment_id, p.id as pending_id, p.tier as pending_tier
         from machvon.contractor c
         left join machvon.vendor_risk_assessment a on a.tenant_id = c.tenant_id and a.id = c.risk_assessment_id
         left join machvon.vendor_risk_assessment p on p.tenant_id = c.tenant_id and p.contractor_id = c.id and p.state = 'PROPOSED'
        ${where.length === 0 ? '' : `where ${where.join(' and ')}`}
        order by c.legal_name, c.id limit $${params.length}::int`,
      params,
    );
    return rows.map((row) => ({ contractorId: row.id, name: row.legal_name, taxIdentifier: row.tax_identifier, tier: row.risk_tier, score: row.score, nextReviewOn: row.risk_next_review_on, reviewOverdue: row.review_overdue, assessmentId: row.risk_assessment_id, pendingAssessmentId: row.pending_id, pendingTier: row.pending_tier }));
  }

  /** Snapshots waiting for their decision (the alert reads them). */
  async waiting(tx: TenantTx, limit = 500): Promise<VendorRiskAssessmentRow[]> {
    const rows = await tx.query<AssessmentSql>(`${SELECT} where a.state = 'PROPOSED' order by a.assessed_at, a.id limit $1::int`, [limit]);
    return rows.map(toRow);
  }

  /** The figures of the indicators of the risk grades: grades looked at in time over the graded, and the contractors at HIGH or CRITICAL. */
  async figures(tx: TenantTx, today: string): Promise<VendorFigure[]> {
    const [row] = await tx.query<{ graded: number; in_time: number; high: number }>(
      `select count(*) filter (where risk_tier is not null)::int as graded, count(*) filter (where risk_tier is not null and risk_next_review_on >= $1::date)::int as in_time,
              count(*) filter (where risk_tier in ('HIGH', 'CRITICAL'))::int as high
         from machvon.contractor`,
      [today],
    );
    return [
      { code: 'VENDOR_RISK_REVIEW_IN_TIME', numerator: row?.in_time ?? 0, denominator: row?.graded ?? 0, asOf: today },
      { code: 'VENDOR_HIGH_RISK_CONTRACTORS', numerator: row?.high ?? 0, denominator: 0, asOf: today },
    ];
  }
}
