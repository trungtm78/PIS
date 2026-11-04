import { randomUUID } from 'node:crypto';
import { DomainError, assertRubricCode, assertTargetAbove, checkEvidenceRecord, checkMilestone, computeScore, effectiveCriterion, parseRubricDraft, pillarReaches, rubricOf } from '@machvon/kernel';
import type { CriterionRow, CriterionState, EvidenceRecordInput, MaturityScore, ReviewStatus, Rubric } from '@machvon/kernel';
import { cursorFor, cursorOf } from './dgv-keyset.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The maturity of data governance (ST-DGV-008, DGV 3.1 F8, BR-DGV-08, DGV-16, DGV-17, DGV-21): the rubrics (versions, published by somebody other than who drafted them), the assessments that apply a version to a scope
 * with an assessor and a reviewer who are two people, the evidence for each criterion (accepted by a reviewer other than who assessed, and running out), the score that exists only when an assessment is published, and the
 * milestones of the roadmap that a published assessment proves, or that are missed when their day goes by. The people named here are tenant members; none of it belongs to an organisation unit.
 */
export const MATURITY_RUBRIC_RESOURCE = 'maturity_rubric_version';
export const MATURITY_ASSESSMENT_RESOURCE = 'maturity_assessment';
export const MATURITY_EVIDENCE_RESOURCE = 'maturity_evidence';
export const MATURITY_MILESTONE_RESOURCE = 'maturity_milestone';
const VIETNAM_DAY = "(now() at time zone 'Asia/Ho_Chi_Minh')::date::text";
const MAX_REASON = 2000;
const MAX_PERIOD = 20;
const MAX_SCOPE_REF = 120;
const SCOPES = ['TENANT', 'DOMAIN', 'DATA_PRODUCT'] as const;
export type MaturityScope = (typeof SCOPES)[number];
export type AssessmentStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'REJECTED';
export type RubricStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export type MilestoneStatus = 'PLANNED' | 'IN_PROGRESS' | 'ACHIEVED' | 'MISSED';
export type AssessmentDecision = 'approve' | 'return' | 'reject';

interface Sql {
  [column: string]: unknown;
  id: string;
  rubric_code: string;
  framework_refs: Record<string, string[]>;
  min_coverage_pct: string;
  status: RubricStatus | AssessmentStatus | MilestoneStatus;
  approved_by: string | null;
  created_by: string | null;
  created_raw: string;
  period_code: string;
  rubric_version_id: string;
  scope_kind: "TENANT" | "DOMAIN" | "DATA_PRODUCT";
  scope_ref: string | null;
  assessor_user_id: string | null;
  reviewer_id: string | null;
  coverage_percent: string;
  overall_state: "COMPUTED" | "NOT_COMPUTED" | null;
  overall_level: string | null;
  published_by: string | null;
  published_raw: string | null;
  assessment_id: string;
  pillar_code: string;
  criterion_code: string;
  assessment_state: "NOT_ASSESSED" | "ASSESSED" | "NOT_APPLICABLE";
  assessment_reviewer_id: string;
  review_status: "EXPIRED" | "REJECTED" | "PENDING" | "ACCEPTED";
  assessed_by: string | null;
  assessed_on: string | null;
  confidence: string | null;
  reviewer_user_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  evidence_expires_on: string | null;
  na_reason: string | null;
  due_on: string;
  owner_user_id: string | null;
  exit_criteria: string;
  achieved_assessment_id: string | null;
  today: string;
  expires_on: string | null;
}

export interface Person {
  membershipId: string;
  displayName: string | null;
}

export interface MaturityRubric {
  id: string;
  rubricCode: string;
  revision: number;
  frameworkRefs: Record<string, string[]>;
  rubric: Rubric;
  minCoveragePct: string;
  evidenceTtlDays: number;
  status: RubricStatus;
  approvedBy: Person | null;
  createdBy: Person;
  createdAt: string;
  version: number;
}

export interface MaturityAssessment {
  id: string;
  periodCode: string;
  rubricVersionId: string;
  rubricCode: string;
  rubricRevision: number;
  scopeKind: MaturityScope;
  scopeRef: string | null;
  assessor: Person;
  reviewer: Person;
  status: AssessmentStatus;
  coveragePercent: string;
  overallState: 'COMPUTED' | 'NOT_COMPUTED' | null;
  overallLevel: string | null;
  publishedBy: Person | null;
  publishedAt: string | null;
  createdAt: string;
  version: number;
}

export interface MaturityEvidence {
  id: string;
  assessmentId: string;
  pillarCode: string;
  criterionCode: string;
  state: CriterionState;
  level: number | null;
  evidenceRefs: unknown[];
  /** How many pieces of evidence there are, whoever may read them. */
  evidenceCount: number;
  /** The assessor and the reviewer of the assessment the row belongs to: with an auditor, the only people the evidence is shown to. */
  assessorId: string;
  reviewerId: string;
  reviewStatus: ReviewStatus;
  assessedBy: Person | null;
  assessedOn: string | null;
  sampleSize: number | null;
  confidence: string | null;
  reviewer: Person | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  evidenceExpiresOn: string | null;
  naReason: string | null;
  createdAt: string;
  version: number;
}

export interface MaturityMilestone {
  id: string;
  rubricVersionId: string;
  rubricCode: string;
  pillarCode: string;
  targetLevel: number;
  dueOn: string;
  owner: Person;
  exitCriteria: string;
  evidenceRequired: string[];
  status: MilestoneStatus;
  achievedAssessmentId: string | null;
  createdAt: string;
  version: number;
}

export interface ScoredCriterion {
  pillarCode: string;
  criterionCode: string;
  weight: number;
  state: CriterionState;
  level: number | null;
  reviewStatus: ReviewStatus;
  evidenceExpiresOn: string | null;
  evidenceCount: number;
  evidenceId: string;
}

export interface AssessmentScore {
  assessment: MaturityAssessment;
  rubric: MaturityRubric;
  asOf: string;
  score: MaturityScore;
  criteria: ScoredCriterion[];
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ExpiredEvidence {
  assessmentId: string;
  assessorId: string;
  periodCode: string;
  version: number;
  expired: number;
  criteria: string[];
}

export interface MissedMilestone {
  id: string;
  ownerId: string;
  pillarCode: string;
  targetLevel: number;
  dueOn: string;
  version: number;
}

const person = (id: string | null, name: string | null): Person | null => (id === null ? null : { membershipId: id, displayName: name });

const RUBRIC_SELECT = `select r.id, r.rubric_code, r.revision, r.framework_refs, r.pillars_json, r.min_coverage_pct::text as min_coverage_pct, r.evidence_ttl_days, r.status, r.approved_by, ad.display_name as approver_name,
  r.created_by, cd.display_name as creator_name, r.created_at::text as created_raw, r.version::text as version
  from machvon.maturity_rubric_version r
  left join machvon.tenant_user_directory ad on ad.tenant_id = r.tenant_id and ad.membership_id = r.approved_by
  left join machvon.tenant_user_directory cd on cd.tenant_id = r.tenant_id and cd.membership_id = r.created_by`;

const ASSESSMENT_SELECT = `select a.id, a.period_code, a.rubric_version_id, v.rubric_code, v.revision as rubric_revision, a.scope_kind, a.scope_ref, a.assessor_user_id, asd.display_name as assessor_name,
  a.reviewer_id, rvd.display_name as reviewer_name, a.status, a.coverage_percent::text as coverage_percent, a.overall_state, a.overall_level::text as overall_level, a.published_by, pbd.display_name as published_name,
  a.published_at, a.published_at::text as published_raw, a.created_at::text as created_raw, a.version::text as version
  from machvon.maturity_assessment a
  join machvon.maturity_rubric_version v on v.tenant_id = a.tenant_id and v.id = a.rubric_version_id
  left join machvon.tenant_user_directory asd on asd.tenant_id = a.tenant_id and asd.membership_id = a.assessor_user_id
  left join machvon.tenant_user_directory rvd on rvd.tenant_id = a.tenant_id and rvd.membership_id = a.reviewer_id
  left join machvon.tenant_user_directory pbd on pbd.tenant_id = a.tenant_id and pbd.membership_id = a.published_by`;

const EVIDENCE_SELECT = `select e.id, e.assessment_id, e.pillar_code, e.criterion_code, e.assessment_state, e.level, e.evidence_refs, e.review_status, e.assessed_by, abd.display_name as assessed_name, e.assessed_on::text as assessed_on,
  e.sample_size, e.confidence, e.reviewer_user_id, rvd.display_name as reviewer_name, e.reviewed_at::text as reviewed_at, e.review_note, e.evidence_expires_on::text as evidence_expires_on, e.na_reason,
  jsonb_array_length(e.evidence_refs) as evidence_count, a.assessor_user_id, a.reviewer_id as assessment_reviewer_id, e.created_at::text as created_raw, e.version::text as version
  from machvon.maturity_evidence e
  join machvon.maturity_assessment a on a.tenant_id = e.tenant_id and a.id = e.assessment_id
  left join machvon.tenant_user_directory abd on abd.tenant_id = e.tenant_id and abd.membership_id = e.assessed_by
  left join machvon.tenant_user_directory rvd on rvd.tenant_id = e.tenant_id and rvd.membership_id = e.reviewer_user_id`;

const MILESTONE_SELECT = `select m.id, m.rubric_version_id, v.rubric_code, m.pillar_code, m.target_level, m.due_on::text as due_on, m.owner_user_id, od.display_name as owner_name, m.exit_criteria, m.evidence_required, m.status,
  m.achieved_assessment_id, m.created_at::text as created_raw, m.version::text as version
  from machvon.maturity_milestone m
  join machvon.maturity_rubric_version v on v.tenant_id = m.tenant_id and v.id = m.rubric_version_id
  left join machvon.tenant_user_directory od on od.tenant_id = m.tenant_id and od.membership_id = m.owner_user_id`;

function rubricOfRow(row: Sql): MaturityRubric {
  return {
    id: row.id,
    rubricCode: row.rubric_code,
    revision: Number(row.revision),
    frameworkRefs: row.framework_refs,
    rubric: rubricOf(row.pillars_json),
    minCoveragePct: row.min_coverage_pct,
    evidenceTtlDays: Number(row.evidence_ttl_days),
    status: row.status as RubricStatus,
    approvedBy: person(row.approved_by, row.approver_name as string | null),
    createdBy: person(row.created_by, row.creator_name as string | null) as Person,
    createdAt: row.created_raw,
    version: Number(row.version),
  };
}

function assessmentOfRow(row: Sql): MaturityAssessment {
  return {
    id: row.id,
    periodCode: row.period_code,
    rubricVersionId: row.rubric_version_id,
    rubricCode: row.rubric_code,
    rubricRevision: Number(row.rubric_revision),
    scopeKind: row.scope_kind,
    scopeRef: row.scope_ref,
    assessor: person(row.assessor_user_id, row.assessor_name as string | null) as Person,
    reviewer: person(row.reviewer_id, row.reviewer_name as string | null) as Person,
    status: row.status as AssessmentStatus,
    coveragePercent: row.coverage_percent,
    overallState: row.overall_state,
    overallLevel: row.overall_level,
    publishedBy: person(row.published_by, row.published_name as string | null),
    publishedAt: row.published_raw,
    createdAt: row.created_raw,
    version: Number(row.version),
  };
}

function evidenceOfRow(row: Sql): MaturityEvidence {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    pillarCode: row.pillar_code,
    criterionCode: row.criterion_code,
    state: row.assessment_state,
    level: row.level === null ? null : Number(row.level),
    evidenceRefs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
    evidenceCount: Number(row.evidence_count),
    assessorId: row.assessor_user_id as string,
    reviewerId: row.assessment_reviewer_id,
    reviewStatus: row.review_status,
    assessedBy: person(row.assessed_by, row.assessed_name as string | null),
    assessedOn: row.assessed_on,
    sampleSize: row.sample_size === null ? null : Number(row.sample_size),
    confidence: row.confidence,
    reviewer: person(row.reviewer_user_id, row.reviewer_name as string | null),
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    evidenceExpiresOn: row.evidence_expires_on,
    naReason: row.na_reason,
    createdAt: row.created_raw,
    version: Number(row.version),
  };
}

function milestoneOfRow(row: Sql): MaturityMilestone {
  return {
    id: row.id,
    rubricVersionId: row.rubric_version_id,
    rubricCode: row.rubric_code,
    pillarCode: row.pillar_code,
    targetLevel: Number(row.target_level),
    dueOn: row.due_on,
    owner: person(row.owner_user_id, row.owner_name as string | null) as Person,
    exitCriteria: row.exit_criteria,
    evidenceRequired: Array.isArray(row.evidence_required) ? row.evidence_required : [],
    status: row.status as MilestoneStatus,
    achievedAssessmentId: row.achieved_assessment_id,
    createdAt: row.created_raw,
    version: Number(row.version),
  };
}

const conflict = (current: number): DomainError => new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current } });
const MAX_PAGE = 200;

function pageOf<T extends { id: string; createdAt: string }>(rows: T[], limit: number): Page<T> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
}

export class DgvMaturityStore {
  private async assertMembers(tx: TenantTx, ids: ReadonlyArray<{ id: string; field: string }>): Promise<void> {
    const found = await tx.query<{ id: string }>('select id from machvon.membership where id = any($1::uuid[])', [ids.map((item) => item.id)]);
    const known = new Set(found.map((row) => row.id));
    const missing = ids.find((item) => !known.has(item.id));
    if (missing !== undefined) throw new DomainError('VALIDATION_FAILED', 422, missing.field);
  }

  /** Drafts the next revision of a rubric (422 `RUBRIC_WEIGHTS_INVALID` or `VALIDATION_FAILED` naming where). It is a draft until somebody other than the drafter publishes it. */
  async createRubric(
    tx: TenantTx,
    input: { rubricCode: string; frameworkRefs: unknown; pillarsJson: unknown; minCoveragePct: string; evidenceTtlDays: number },
    actor: string,
  ): Promise<MaturityRubric> {
    const code = assertRubricCode(input.rubricCode);
    const draft = parseRubricDraft({ frameworkRefs: input.frameworkRefs, pillarsJson: input.pillarsJson, minCoveragePct: input.minCoveragePct, evidenceTtlDays: input.evidenceTtlDays });
    await this.lockRubric(tx, code);
    const next = await tx.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from machvon.maturity_rubric_version where rubric_code = $1', [code]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.maturity_rubric_version (tenant_id, id, rubric_code, revision, framework_refs, pillars_json, min_coverage_pct, evidence_ttl_days, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4::jsonb, $5::jsonb, $6::numeric, $7::int, 'DRAFT', $8::uuid, $8::uuid)`,
      [id, code, Number(next[0]?.revision ?? 1), JSON.stringify(draft.frameworkRefs), JSON.stringify(draft.rubric), draft.minCoveragePct, draft.evidenceTtlDays, actor],
    );
    return (await this.findRubric(tx, id)) as MaturityRubric;
  }

  /** Serializes the drafting and the publication of the versions of one rubric, until the transaction ends. */
  private async lockRubric(tx: TenantTx, rubricCode: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':maturity-rubric:' || $1, 0))", [rubricCode]);
  }

  async findRubric(tx: TenantTx, id: string): Promise<MaturityRubric | undefined> {
    const rows = await tx.query<Sql>(`${RUBRIC_SELECT} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : rubricOfRow(rows[0]);
  }

  async listRubrics(tx: TenantTx, filter: { rubricCode?: string | undefined; status?: string | undefined; cursor?: string | undefined; limit: number }): Promise<Page<MaturityRubric>> {
    if (filter.status !== undefined && !['DRAFT', 'PUBLISHED', 'SUPERSEDED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${RUBRIC_SELECT} where ($1::text is null or r.rubric_code = $1) and ($2::text is null or r.status = $2) and ($3::timestamptz is null or (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        order by r.created_at desc, r.id desc limit $5::int`,
      [filter.rubricCode ?? null, filter.status ?? null, after?.at ?? null, after?.id ?? null, Math.min(filter.limit, MAX_PAGE) + 1],
    );
    return pageOf(rows.map(rubricOfRow), Math.min(filter.limit, MAX_PAGE));
  }

  /** Publishes a draft against the version the caller read: 404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` (not a draft), 403 `SELF_APPROVAL_DENIED`. The version it replaces is SUPERSEDED. */
  async publishRubric(tx: TenantTx, id: string, expected: number, actor: string): Promise<{ rubric: MaturityRubric; supersededId: string | null }> {
    // Two drafts of one rubric are published one after the other, the second replacing the first: the rubric is locked, not only the draft.
    const named = await tx.query<{ rubric_code: string }>('select rubric_code from machvon.maturity_rubric_version where id = $1::uuid', [id]);
    if (named[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockRubric(tx, named[0].rubric_code);
    const rows = await tx.query<Sql>('select rubric_code, status, created_by, version::text as version from machvon.maturity_rubric_version where id = $1::uuid for update', [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw conflict(Number(row.version));
    if (row.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const before = await tx.query<{ id: string }>(
      "update machvon.maturity_rubric_version set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where rubric_code = $1 and status = 'PUBLISHED' returning id",
      [row.rubric_code, actor],
    );
    await tx.query("update machvon.maturity_rubric_version set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [
      id,
      actor,
    ]);
    return { rubric: (await this.findRubric(tx, id)) as MaturityRubric, supersededId: before[0]?.id ?? null };
  }

  /**
   * Starts an assessment of a rubric version that is published (422 `RUBRIC_NOT_PUBLISHED`) for a scope, with an assessor and a reviewer who are two members (422 `ASSESSOR_IS_REVIEWER`); every criterion of the
   * rubric starts NOT_ASSESSED. One assessment for a rubric version, a scope and a period (409 `DUPLICATE_KEY`).
   */
  async createAssessment(
    tx: TenantTx,
    input: { periodCode: string; rubricVersionId: string; scopeKind: string; scopeRef: string | undefined; assessorId: string; reviewerId: string },
  ): Promise<MaturityAssessment> {
    const period = input.periodCode.trim();
    if (period.length < 4 || period.length > MAX_PERIOD || period.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'period_code');
    const scopeKind = SCOPES.find((candidate) => candidate === input.scopeKind);
    if (scopeKind === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'scope_kind');
    const scopeRef = input.scopeRef === undefined ? undefined : input.scopeRef.trim();
    if (scopeKind === 'TENANT' ? scopeRef !== undefined : scopeRef === undefined || scopeRef === '' || scopeRef.length > MAX_SCOPE_REF || scopeRef.includes('\0'))
      throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    const rubrics = await tx.query<Sql>('select pillars_json, status, rubric_code, revision from machvon.maturity_rubric_version where id = $1::uuid for share', [input.rubricVersionId]);
    const rubricRow = rubrics[0];
    if (rubricRow === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'rubric_version_id');
    if (rubricRow.status !== 'PUBLISHED') throw new DomainError('RUBRIC_NOT_PUBLISHED', 422, 'rubric_version_id');
    if (input.assessorId === input.reviewerId) throw new DomainError('ASSESSOR_IS_REVIEWER', 422, 'reviewer_id');
    await this.assertMembers(tx, [
      { id: input.assessorId, field: 'assessor_user_id' },
      { id: input.reviewerId, field: 'reviewer_id' },
    ]);
    if (scopeKind === 'DOMAIN' && (await tx.query('select 1 from machvon.dataset where domain = $1 limit 1', [scopeRef])).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    if (scopeKind === 'DATA_PRODUCT' && (await tx.query('select 1 from machvon.data_product where code = $1 limit 1', [scopeRef])).length === 0)
      throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    const same = await tx.query(
      "select 1 from machvon.maturity_assessment where rubric_version_id = $1::uuid and scope_kind = $2 and coalesce(scope_ref, '') = coalesce($3, '') and period_code = $4 and status <> 'REJECTED' limit 1",
      [input.rubricVersionId, scopeKind, scopeRef ?? null, period],
    );
    if (same.length > 0) throw new DomainError('DUPLICATE_KEY', 409, 'period_code');
    const rubric = rubricOf(rubricRow.pillars_json);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.maturity_assessment (tenant_id, id, period_code, rubric_version, coverage_percent, status, reviewer_id, rubric_version_id, scope_kind, scope_ref, assessor_user_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, 0, 'DRAFT', $4::uuid, $5::uuid, $6, $7, $8::uuid)`,
      [id, period, `${rubricRow.rubric_code}@r${rubricRow.revision}`, input.reviewerId, input.rubricVersionId, scopeKind, scopeRef ?? null, input.assessorId],
    );
    const pairs = rubric.pillars.flatMap((pillar) => pillar.criteria.map((criterion) => [pillar.code, criterion.code] as const));
    await tx.query(
      `insert into machvon.maturity_evidence (tenant_id, id, assessment_id, pillar_code, criterion_code, level, evidence_refs, review_status, assessment_state)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, t.pillar, t.criterion, null, '[]'::jsonb, 'PENDING', 'NOT_ASSESSED' from unnest($2::text[], $3::text[]) as t(pillar, criterion)`,
      [id, pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
    );
    return (await this.findAssessment(tx, id)) as MaturityAssessment;
  }

  async findAssessment(tx: TenantTx, id: string): Promise<MaturityAssessment | undefined> {
    const rows = await tx.query<Sql>(`${ASSESSMENT_SELECT} where a.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : assessmentOfRow(rows[0]);
  }

  async listAssessments(tx: TenantTx, filter: { status?: string | undefined; rubricVersionId?: string | undefined; cursor?: string | undefined; limit: number }): Promise<Page<MaturityAssessment>> {
    if (filter.status !== undefined && !['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${ASSESSMENT_SELECT} where ($1::text is null or a.status = $1) and ($2::uuid is null or a.rubric_version_id = $2) and ($3::timestamptz is null or (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
        order by a.created_at desc, a.id desc limit $5::int`,
      [filter.status ?? null, filter.rubricVersionId ?? null, after?.at ?? null, after?.id ?? null, Math.min(filter.limit, MAX_PAGE) + 1],
    );
    return pageOf(rows.map(assessmentOfRow), Math.min(filter.limit, MAX_PAGE));
  }

  async findEvidence(tx: TenantTx, id: string): Promise<MaturityEvidence | undefined> {
    const rows = await tx.query<Sql>(`${EVIDENCE_SELECT} where e.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : evidenceOfRow(rows[0]);
  }

  async listEvidence(tx: TenantTx, filter: { assessmentId?: string | undefined; cursor?: string | undefined; limit: number }): Promise<Page<MaturityEvidence>> {
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${EVIDENCE_SELECT} where ($1::uuid is null or e.assessment_id = $1) and ($2::timestamptz is null or (e.created_at, e.id) < ($2::timestamptz, $3::uuid))
        order by e.created_at desc, e.id desc limit $4::int`,
      [filter.assessmentId ?? null, after?.at ?? null, after?.id ?? null, Math.min(filter.limit, MAX_PAGE) + 1],
    );
    return pageOf(rows.map(evidenceOfRow), Math.min(filter.limit, MAX_PAGE));
  }

  /**
   * The assessor records a criterion against the version of its row that they read (the order of the refusals: 404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` when the assessment is closed, 403 `SCOPE_DENIED`
   * when the person is not its assessor, then what the record needs of its own - `EVIDENCE_REQUIRED`, `LEVEL_OUT_OF_RANGE`, `EVIDENCE_EXPIRED`). It counts for nothing until the reviewer accepts it, and it
   * puts the assessment IN_REVIEW.
   */
  async recordEvidence(
    tx: TenantTx,
    assessmentId: string,
    expected: number,
    input: EvidenceRecordInput,
    actor: string,
  ): Promise<{ assessment: MaturityAssessment; evidence: MaturityEvidence; previous: CriterionState }> {
    const locked = await tx.query<Sql>(
      `select a.status, a.assessor_user_id, a.version::text as version, v.pillars_json, v.evidence_ttl_days, ${VIETNAM_DAY} as today
         from machvon.maturity_assessment a join machvon.maturity_rubric_version v on v.tenant_id = a.tenant_id and v.id = a.rubric_version_id where a.id = $1::uuid for update of a`,
      [assessmentId],
    );
    const row = locked[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const target = await tx.query<Sql>(
      'select id, assessment_state, version::text as version from machvon.maturity_evidence where assessment_id = $1::uuid and pillar_code = $2 and criterion_code = $3 for update',
      [assessmentId, input.pillarCode, input.criterionCode],
    );
    const current = target[0];
    if (current === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'criterion_code');
    if (Number(current.version) !== expected) throw conflict(Number(current.version));
    if (row.status !== 'DRAFT' && row.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.assessor_user_id !== actor) throw new DomainError('SCOPE_DENIED', 403);
    const record = checkEvidenceRecord(input, rubricOf(row.pillars_json), Number(row.evidence_ttl_days), row.today);
    await tx.query(
      `update machvon.maturity_evidence set assessment_state = $2, level = $3::int, evidence_refs = $4::jsonb, review_status = 'PENDING', assessed_by = $5::uuid, assessed_on = $6::date, sample_size = $7::int, confidence = $8,
         reviewer_user_id = null, reviewed_at = null, review_note = null, evidence_expires_on = $9::date, na_reason = $10, version = version + 1 where id = $1::uuid`,
      [current.id, record.state, record.level, JSON.stringify(record.evidenceRefs), actor, row.today, record.sampleSize, record.confidence, record.expiresOn, record.naReason],
    );
    // What a decision on the assessment stands on has changed: its version moves, so that a decision made on the score as it was is refused, and the first record puts it in review.
    await tx.query("update machvon.maturity_assessment set status = case when status = 'DRAFT' and $2::boolean then 'IN_REVIEW' else status end, version = version + 1 where id = $1::uuid", [
      assessmentId,
      record.state !== 'NOT_ASSESSED',
    ]);
    return {
      assessment: (await this.findAssessment(tx, assessmentId)) as MaturityAssessment,
      evidence: (await this.findEvidence(tx, current.id)) as MaturityEvidence,
      previous: current.assessment_state,
    };
  }

  /**
   * The reviewer accepts or rejects what was recorded, against the version of the row they read (404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` when the assessment is not in review or the row has
   * nothing waiting, 403 `SELF_APPROVAL_DENIED` for the person who recorded it, 403 `SCOPE_DENIED` for anybody who is not the reviewer of the assessment, 422 `EVIDENCE_EXPIRED` for an acceptance of evidence that
   * has run out). A rejected row is NOT_ASSESSED again.
   */
  async reviewEvidence(
    tx: TenantTx,
    evidenceId: string,
    expected: number,
    input: { decision: string; note: string },
    actor: string,
  ): Promise<{ assessment: MaturityAssessment; evidence: MaturityEvidence; previous: ReviewStatus }> {
    if (input.decision !== 'ACCEPTED' && input.decision !== 'REJECTED') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const note = input.note.trim();
    if (note.length < 10 || note.length > MAX_REASON || note.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const owner = await tx.query<{ assessment_id: string }>('select assessment_id from machvon.maturity_evidence where id = $1::uuid', [evidenceId]);
    if (owner[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The assessment is locked before the row, as recording and publishing lock them.
    const assessment = await tx.query<Sql>(`select status, reviewer_id, ${VIETNAM_DAY} as today from machvon.maturity_assessment where id = $1::uuid for update`, [owner[0].assessment_id]);
    const rows = await tx.query<Sql>(
      'select assessment_state, review_status, assessed_by, evidence_expires_on::text as expires_on, version::text as version from machvon.maturity_evidence where id = $1::uuid for update',
      [evidenceId],
    );
    const row = rows[0];
    const head = assessment[0];
    if (row === undefined || head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw conflict(Number(row.version));
    if (head.status !== 'IN_REVIEW' || row.review_status !== 'PENDING' || row.assessment_state === 'NOT_ASSESSED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'decision');
    if (row.assessed_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (head.reviewer_id !== actor) throw new DomainError('SCOPE_DENIED', 403);
    if (input.decision === 'ACCEPTED' && row.assessment_state === 'ASSESSED' && (row.expires_on === null || row.expires_on < head.today))
      throw new DomainError('EVIDENCE_EXPIRED', 422, 'evidence_expires_on');
    if (input.decision === 'ACCEPTED') {
      await tx.query("update machvon.maturity_evidence set review_status = 'ACCEPTED', reviewer_user_id = $2::uuid, reviewed_at = now(), review_note = $3, version = version + 1 where id = $1::uuid", [
        evidenceId,
        actor,
        note,
      ]);
    } else {
      await tx.query(
        "update machvon.maturity_evidence set review_status = 'REJECTED', assessment_state = 'NOT_ASSESSED', level = null, reviewer_user_id = $2::uuid, reviewed_at = now(), review_note = $3, version = version + 1 where id = $1::uuid",
        [evidenceId, actor, note],
      );
    }
    await tx.query('update machvon.maturity_assessment set version = version + 1 where id = $1::uuid', [owner[0].assessment_id]);
    return {
      assessment: (await this.findAssessment(tx, owner[0].assessment_id)) as MaturityAssessment,
      evidence: (await this.findEvidence(tx, evidenceId)) as MaturityEvidence,
      previous: row.review_status,
    };
  }

  private async criteriaOf(tx: TenantTx, assessmentId: string): Promise<Array<CriterionRow & { evidenceId: string; evidenceCount: number }>> {
    const rows = await tx.query<Sql>(
      `select id, pillar_code, criterion_code, assessment_state, level, review_status, evidence_expires_on::text as expires_on, jsonb_array_length(evidence_refs) as evidence_count
         from machvon.maturity_evidence where assessment_id = $1::uuid order by pillar_code, criterion_code`,
      [assessmentId],
    );
    return rows.map((row) => ({
      pillarCode: row.pillar_code,
      criterionCode: row.criterion_code,
      state: row.assessment_state,
      level: row.level === null ? null : Number(row.level),
      reviewStatus: row.review_status,
      expiresOn: row.expires_on,
      evidenceId: row.id,
      evidenceCount: Number(row.evidence_count),
    }));
  }

  /** The score of an assessment: on the day of its publication when it is published (it never changes after), on today otherwise. 404 for an assessment nobody has. */
  async score(tx: TenantTx, assessmentId: string): Promise<AssessmentScore | undefined> {
    const assessment = await this.findAssessment(tx, assessmentId);
    if (assessment === undefined) return undefined;
    const rubric = (await this.findRubric(tx, assessment.rubricVersionId)) as MaturityRubric;
    const day = await tx.query<{ day: string }>(`select case when $1::timestamptz is null then ${VIETNAM_DAY} else ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date::text end as day`, [
      assessment.publishedAt,
    ]);
    const asOf = day[0]?.day as string;
    const rows = await this.criteriaOf(tx, assessmentId);
    const score = computeScore(rubric.rubric, rubric.minCoveragePct, rows, asOf);
    const weights = new Map<string, number>(rubric.rubric.pillars.flatMap((pillar) => pillar.criteria.map((criterion) => [`${pillar.code}:${criterion.code}`, criterion.weight] as const)));
    const criteria = rows.map((row): ScoredCriterion => {
      const effective = effectiveCriterion(row, asOf);
      return {
        pillarCode: row.pillarCode,
        criterionCode: row.criterionCode,
        weight: weights.get(`${row.pillarCode}:${row.criterionCode}`) ?? 0,
        state: effective.state,
        level: effective.level,
        reviewStatus: row.reviewStatus,
        evidenceExpiresOn: row.expiresOn,
        evidenceCount: row.evidenceCount,
        evidenceId: row.evidenceId,
      };
    });
    return { assessment, rubric, asOf, score, criteria };
  }

  /**
   * Decides on an assessment that is in review, against the version the caller read (404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED`, 403 `SELF_APPROVAL_DENIED` for its assessor). `approve` publishes it with
   * the score of BR-DGV-08 and proves the milestones of the same rubric that its pillars reach; `return` sends it back to be worked on; `reject` closes it.
   */
  async decideAssessment(
    tx: TenantTx,
    id: string,
    expected: number,
    decision: AssessmentDecision,
    actor: string,
  ): Promise<{ assessment: MaturityAssessment; previous: AssessmentStatus; score: MaturityScore | null; achieved: MaturityMilestone[] }> {
    const rows = await tx.query<Sql>('select status, assessor_user_id, version::text as version from machvon.maturity_assessment where id = $1::uuid for update', [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw conflict(Number(row.version));
    if (row.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.assessor_user_id === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (decision === 'return') {
      await tx.query("update machvon.maturity_assessment set status = 'DRAFT', version = version + 1 where id = $1::uuid", [id]);
      return { assessment: (await this.findAssessment(tx, id)) as MaturityAssessment, previous: row.status, score: null, achieved: [] };
    }
    if (decision === 'reject') {
      await tx.query("update machvon.maturity_assessment set status = 'REJECTED', version = version + 1 where id = $1::uuid", [id]);
      return { assessment: (await this.findAssessment(tx, id)) as MaturityAssessment, previous: row.status, score: null, achieved: [] };
    }
    const code = await tx.query<{ rubric_code: string }>(
      'select v.rubric_code from machvon.maturity_assessment a join machvon.maturity_rubric_version v on v.tenant_id = a.tenant_id and v.id = a.rubric_version_id where a.id = $1::uuid',
      [id],
    );
    await this.lockRoadmap(tx, (code[0] as { rubric_code: string }).rubric_code);
    const current = (await this.score(tx, id)) as AssessmentScore;
    const score = current.score;
    await tx.query(
      `update machvon.maturity_assessment set status = 'PUBLISHED', coverage_percent = $2::numeric, overall_state = $3, overall_level = $4::numeric, published_by = $5::uuid, published_at = now(), version = version + 1 where id = $1::uuid`,
      [id, score.coveragePercent, score.overallState, score.overallLevel, actor],
    );
    const achieved: MaturityMilestone[] = [];
    // The roadmap is the tenant's: only an assessment of the whole tenant proves a milestone.
    const open =
      current.assessment.scopeKind !== 'TENANT'
        ? []
        : await tx.query<Sql>(
            `select m.id, m.pillar_code, m.target_level from machvon.maturity_milestone m join machvon.maturity_rubric_version v on v.tenant_id = m.tenant_id and v.id = m.rubric_version_id
              where v.rubric_code = $1 and m.status in ('PLANNED', 'IN_PROGRESS') and m.due_on >= ${VIETNAM_DAY}::date order by m.due_on, m.id for update of m`,
            [current.rubric.rubricCode],
          );
    for (const milestone of open) {
      const pillar = score.pillars.find((candidate) => candidate.code === milestone.pillar_code);
      if (pillar === undefined || !pillarReaches(pillar, Number(milestone.target_level))) continue;
      await tx.query(
        "update machvon.maturity_milestone set status = 'ACHIEVED', achieved_assessment_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
        [milestone.id, id, actor],
      );
      achieved.push((await this.findMilestone(tx, milestone.id)) as MaturityMilestone);
    }
    return { assessment: (await this.findAssessment(tx, id)) as MaturityAssessment, previous: row.status, score, achieved };
  }

  /** Serializes the planning of the milestones of a rubric with the publication of its assessments, until the transaction ends. */
  private async lockRoadmap(tx: TenantTx, rubricCode: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':maturity-roadmap:' || $1, 0))", [rubricCode]);
  }

  async findMilestone(tx: TenantTx, id: string): Promise<MaturityMilestone | undefined> {
    const rows = await tx.query<Sql>(`${MILESTONE_SELECT} where m.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : milestoneOfRow(rows[0]);
  }

  async listMilestones(
    tx: TenantTx,
    filter: { status?: string | undefined; rubricVersionId?: string | undefined; pillarCode?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<Page<MaturityMilestone>> {
    if (filter.status !== undefined && !['PLANNED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${MILESTONE_SELECT} where ($1::text is null or m.status = $1) and ($2::uuid is null or m.rubric_version_id = $2) and ($3::text is null or m.pillar_code = $3)
          and ($4::timestamptz is null or (m.created_at, m.id) < ($4::timestamptz, $5::uuid)) order by m.created_at desc, m.id desc limit $6::int`,
      [filter.status ?? null, filter.rubricVersionId ?? null, filter.pillarCode ?? null, after?.at ?? null, after?.id ?? null, Math.min(filter.limit, MAX_PAGE) + 1],
    );
    return pageOf(rows.map(milestoneOfRow), Math.min(filter.limit, MAX_PAGE));
  }

  /**
   * Adds a milestone to the roadmap: a pillar of a published rubric, a level above where the pillar stands in the latest published assessment of the whole tenant (422 `TARGET_BELOW_CURRENT`), a last day that is not
   * past, an owner who is a member. It is PLANNED until a published assessment proves it or its day goes by.
   */
  async createMilestone(
    tx: TenantTx,
    input: { rubricVersionId: string; pillarCode: string; targetLevel: number; dueOn: string; ownerId: string; exitCriteria: string; evidenceRequired: readonly unknown[] },
    actor: string,
  ): Promise<MaturityMilestone> {
    const rubrics = await tx.query<Sql>(`select rubric_code, status, ${VIETNAM_DAY} as today from machvon.maturity_rubric_version where id = $1::uuid`, [input.rubricVersionId]);
    const rubric = rubrics[0];
    if (rubric === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'rubric_version_id');
    if (rubric.status !== 'PUBLISHED') throw new DomainError('RUBRIC_NOT_PUBLISHED', 422, 'rubric_version_id');
    const checked = checkMilestone({ pillarCode: input.pillarCode, dueOn: input.dueOn, exitCriteria: input.exitCriteria, evidenceRequired: input.evidenceRequired }, rubric.today);
    await this.assertMembers(tx, [{ id: input.ownerId, field: 'owner_user_id' }]);
    // A milestone is judged against the standing of the pillar and a publication proves the milestones there are: the two never run at the same time for a rubric.
    await this.lockRoadmap(tx, rubric.rubric_code);
    const latest = await tx.query<{ id: string }>(
      `select a.id from machvon.maturity_assessment a join machvon.maturity_rubric_version v on v.tenant_id = a.tenant_id and v.id = a.rubric_version_id
        where v.rubric_code = $1 and a.scope_kind = 'TENANT' and a.status = 'PUBLISHED' order by a.published_at desc, a.id desc limit 1`,
      [rubric.rubric_code],
    );
    const standing = latest[0] === undefined ? undefined : (await this.score(tx, latest[0].id))?.score.pillars.find((pillar) => pillar.code === input.pillarCode);
    assertTargetAbove(standing, input.targetLevel);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.maturity_milestone (tenant_id, id, rubric_version_id, pillar_code, target_level, due_on, owner_user_id, exit_criteria, evidence_required, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::int, $5::date, $6::uuid, $7, $8::jsonb, 'PLANNED', $9::uuid, $9::uuid)`,
      [id, input.rubricVersionId, input.pillarCode, input.targetLevel, input.dueOn, input.ownerId, checked.exitCriteria, JSON.stringify(checked.evidenceRequired), actor],
    );
    return (await this.findMilestone(tx, id)) as MaturityMilestone;
  }

  /**
   * The evidence that has run out, on the assessments still being worked on: an ASSESSED criterion whose last day is before `today` becomes NOT_ASSESSED with no level, review status EXPIRED, once (a published
   * assessment keeps what it was published with). Returns, for each assessment, how many criteria and which, so that its assessor can be told.
   */
  async expireEvidence(tx: TenantTx): Promise<ExpiredEvidence[]> {
    // The assessments are locked first, as recording, reviewing and publishing lock them, and their state is read again once the lock is held: an assessment that was published meanwhile is left as it was published.
    const locked = await tx.query<{ id: string }>(
      `select a.id from machvon.maturity_assessment a
        where a.status in ('DRAFT', 'IN_REVIEW')
          and exists (select 1 from machvon.maturity_evidence e where e.tenant_id = a.tenant_id and e.assessment_id = a.id and e.assessment_state = 'ASSESSED' and e.evidence_expires_on < ${VIETNAM_DAY}::date)
        order by a.id for update of a`,
    );
    if (locked.length === 0) return [];
    const ids = locked.map((row) => row.id);
    const lapsed = await tx.query<Sql>(
      `update machvon.maturity_evidence e set assessment_state = 'NOT_ASSESSED', level = null, review_status = 'EXPIRED', version = e.version + 1
        where e.assessment_id = any($1::uuid[]) and e.assessment_state = 'ASSESSED' and e.evidence_expires_on < ${VIETNAM_DAY}::date returning e.assessment_id, e.criterion_code`,
      [ids],
    );
    const rows = await tx.query<Sql>(
      `update machvon.maturity_assessment set version = version + 1 where id = any($1::uuid[]) returning id as assessment_id, assessor_user_id, period_code, version::text as version`,
      [ids],
    );
    return rows
      .map((row) => {
        const criteria = lapsed.filter((item) => item.assessment_id === row.assessment_id).map((item) => item.criterion_code as string);
        return {
          assessmentId: row.assessment_id as string,
          assessorId: row.assessor_user_id as string,
          periodCode: row.period_code as string,
          version: Number(row.version),
          expired: criteria.length,
          criteria: criteria.sort(),
        };
      })
      .filter((item) => item.expired > 0)
      .sort((a, b) => a.assessmentId.localeCompare(b.assessmentId));
  }

  /** The milestones whose day has gone by without a published assessment proving them become MISSED, once (a published assessment that proved one has made it ACHIEVED already). */
  async missMilestones(tx: TenantTx, actor: string): Promise<MissedMilestone[]> {
    const rows = await tx.query<Sql>(
      `update machvon.maturity_milestone set status = 'MISSED', updated_at = now(), updated_by = $1::uuid, version = version + 1
        where status in ('PLANNED', 'IN_PROGRESS') and due_on < ${VIETNAM_DAY}::date returning id, owner_user_id, pillar_code, target_level, due_on::text as due_on, version::text as version`,
      [actor],
    );
    return rows.map((row) => ({ id: row.id, ownerId: row.owner_user_id as string, pillarCode: row.pillar_code, targetLevel: Number(row.target_level), dueOn: row.due_on, version: Number(row.version) }));
  }
}
