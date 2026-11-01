import { ApiError } from '@machvon/api-client';

export const MANAGE_PERMISSION = 'data.maturity.manage';
export const PUBLISH_PERMISSION = 'data.maturity.publish';
export const ASSESS_PERMISSION = 'data.maturity.assess';
export const REVIEW_PERMISSION = 'data.maturity.review';
export const READ_PERMISSION = 'data.maturity.read';

export const PILLARS = ['GOVERNANCE', 'METADATA', 'QUALITY', 'INTEGRATION', 'SECURITY', 'LINEAGE_BI', 'AI_READINESS', 'VALUE_COST'] as const;
export type PillarCode = (typeof PILLARS)[number];
export const EVIDENCE_KINDS = ['ARTIFACT', 'LOG', 'INTERVIEW', 'TEST'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const SCOPES = ['TENANT', 'DOMAIN', 'DATA_PRODUCT'] as const;
export type Scope = (typeof SCOPES)[number];
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const isEvidenceKind = (value: string): value is EvidenceKind => EVIDENCE_KINDS.some((kind) => kind === value);
const RUBRIC_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type RubricStatus = (typeof RUBRIC_STATUSES)[number];
const ASSESSMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export const CRITERION_STATES = ['ASSESSED', 'NOT_ASSESSED', 'NOT_APPLICABLE'] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];
const REVIEW_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export type OverallState = 'COMPUTED' | 'NOT_COMPUTED';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const pick = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export interface Person {
  membershipId: string;
  displayName: string | null;
}

function toPerson(raw: unknown): Person | null {
  return isRecord(raw) && typeof raw.membership_id === 'string' ? { membershipId: raw.membership_id, displayName: text(raw.display_name) } : null;
}

export const personName = (person: Person | null): string => (person === null ? '—' : (person.displayName ?? person.membershipId));

export interface Criterion {
  code: string;
  name: string;
  weight: string;
  levels: Record<string, string>;
  refs: string[];
}

export interface Pillar {
  code: string;
  name: string;
  weight: string;
  criteria: Criterion[];
}

export interface Rubric {
  id: string;
  code: string;
  revision: number;
  frameworkRefs: Record<string, string[]>;
  pillars: Pillar[];
  minCoveragePct: string;
  evidenceTtlDays: number;
  status: RubricStatus;
  approvedBy: Person | null;
  createdBy: Person | null;
  version: number;
}

function toCriterion(raw: unknown): Criterion[] {
  if (!isRecord(raw) || typeof raw.code !== 'string' || typeof raw.name !== 'string' || typeof raw.weight !== 'string' || !isRecord(raw.levels)) return [];
  const levels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.levels)) if (typeof value === 'string') levels[key] = value;
  return [{ code: raw.code, name: raw.name, weight: raw.weight, levels, refs: Array.isArray(raw.refs) ? raw.refs.filter((ref): ref is string => typeof ref === 'string') : [] }];
}

function toPillar(raw: unknown): Pillar[] {
  if (!isRecord(raw) || typeof raw.code !== 'string' || typeof raw.name !== 'string' || typeof raw.weight !== 'string' || !Array.isArray(raw.criteria)) return [];
  return [{ code: raw.code, name: raw.name, weight: raw.weight, criteria: raw.criteria.flatMap(toCriterion) }];
}

export function toRubric(raw: unknown): Rubric | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.rubric_code !== 'string' || typeof raw.revision !== 'number' || typeof raw.min_coverage_pct !== 'string') return undefined;
  const status = pick(RUBRIC_STATUSES, raw.status);
  if (status === undefined || typeof raw.evidence_ttl_days !== 'number' || typeof raw.version !== 'number' || !Array.isArray(raw.pillars)) return undefined;
  const frameworkRefs: Record<string, string[]> = {};
  if (isRecord(raw.framework_refs))
    for (const [name, value] of Object.entries(raw.framework_refs)) if (Array.isArray(value)) frameworkRefs[name] = value.filter((ref): ref is string => typeof ref === 'string');
  return {
    id: raw.id,
    code: raw.rubric_code,
    revision: raw.revision,
    frameworkRefs,
    pillars: raw.pillars.flatMap(toPillar),
    minCoveragePct: raw.min_coverage_pct,
    evidenceTtlDays: raw.evidence_ttl_days,
    status,
    approvedBy: toPerson(raw.approved_by),
    createdBy: toPerson(raw.created_by),
    version: raw.version,
  };
}

export interface Assessment {
  id: string;
  periodCode: string;
  rubricVersionId: string;
  rubricCode: string;
  rubricRevision: number;
  scopeKind: Scope;
  scopeRef: string | null;
  assessor: Person | null;
  reviewer: Person | null;
  status: AssessmentStatus;
  coveragePercent: string;
  overallState: OverallState | null;
  overallLevel: string | null;
  publishedBy: Person | null;
  publishedAt: string | null;
  version: number;
}

export function toAssessment(raw: unknown): Assessment | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.period_code !== 'string' || typeof raw.rubric_version_id !== 'string' || typeof raw.version !== 'number') return undefined;
  const status = pick(ASSESSMENT_STATUSES, raw.status);
  const scopeKind = pick(SCOPES, raw.scope_kind);
  if (status === undefined || scopeKind === undefined || typeof raw.coverage_percent !== 'string') return undefined;
  return {
    id: raw.id,
    periodCode: raw.period_code,
    rubricVersionId: raw.rubric_version_id,
    rubricCode: text(raw.rubric_code) ?? '',
    rubricRevision: typeof raw.rubric_revision === 'number' ? raw.rubric_revision : 0,
    scopeKind,
    scopeRef: text(raw.scope_ref),
    assessor: toPerson(raw.assessor),
    reviewer: toPerson(raw.reviewer),
    status,
    coveragePercent: raw.coverage_percent,
    overallState: raw.overall_state === 'COMPUTED' || raw.overall_state === 'NOT_COMPUTED' ? raw.overall_state : null,
    overallLevel: text(raw.overall_level),
    publishedBy: toPerson(raw.published_by),
    publishedAt: text(raw.published_at),
    version: raw.version,
  };
}

export interface SubmittedEvidence {
  kind: string;
  ref: string;
  note: string | null;
}

function toSubmitted(raw: unknown): SubmittedEvidence[] {
  return isRecord(raw) && typeof raw.kind === 'string' && typeof raw.ref === 'string' ? [{ kind: raw.kind, ref: raw.ref, note: text(raw.note) }] : [];
}

export interface EvidenceRow {
  id: string;
  assessmentId: string;
  pillarCode: string;
  criterionCode: string;
  state: CriterionState;
  level: number | null;
  reviewStatus: ReviewStatus;
  evidenceCount: number;
  /** What the assessor submitted: each piece of evidence with its kind, what it refers to and its note. */
  evidenceRefs: SubmittedEvidence[];
  sampleSize: number | null;
  confidence: string | null;
  evidenceExpiresOn: string | null;
  naReason: string | null;
  reviewNote: string | null;
  assessedBy: Person | null;
  reviewer: Person | null;
  version: number;
}

export function toEvidence(raw: unknown): EvidenceRow | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.assessment_id !== 'string' ||
    typeof raw.pillar_code !== 'string' ||
    typeof raw.criterion_code !== 'string' ||
    typeof raw.version !== 'number'
  )
    return undefined;
  const state = pick(CRITERION_STATES, raw.assessment_state);
  const reviewStatus = pick(REVIEW_STATUSES, raw.review_status);
  if (state === undefined || reviewStatus === undefined) return undefined;
  return {
    id: raw.id,
    assessmentId: raw.assessment_id,
    pillarCode: raw.pillar_code,
    criterionCode: raw.criterion_code,
    state,
    level: typeof raw.level === 'number' ? raw.level : null,
    reviewStatus,
    evidenceCount: typeof raw.evidence_count === 'number' ? raw.evidence_count : Array.isArray(raw.evidence_refs) ? raw.evidence_refs.length : 0,
    evidenceRefs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs.flatMap(toSubmitted) : [],
    sampleSize: typeof raw.sample_size === 'number' ? raw.sample_size : null,
    confidence: text(raw.confidence),
    evidenceExpiresOn: text(raw.evidence_expires_on),
    naReason: text(raw.na_reason),
    reviewNote: text(raw.review_note),
    assessedBy: toPerson(raw.assessed_by),
    reviewer: toPerson(raw.reviewer),
    version: raw.version,
  };
}

export interface PillarScore {
  code: string;
  weight: string;
  state: 'ASSESSED' | 'NOT_ASSESSED';
  level: string | null;
  assessed: number;
  notAssessed: number;
  notApplicable: number;
}

export interface CriterionScore {
  pillarCode: string;
  criterionCode: string;
  weight: string;
  state: CriterionState;
  level: number | null;
  reviewStatus: ReviewStatus;
  evidenceExpiresOn: string | null;
  evidenceCount: number;
  evidenceId: string;
}

export interface Score {
  assessmentId: string;
  status: AssessmentStatus;
  asOf: string;
  coveragePercent: string;
  minCoveragePct: string;
  overallState: OverallState;
  overallLevel: string | null;
  assessed: number;
  notAssessed: number;
  notApplicable: number;
  pillars: PillarScore[];
  criteria: CriterionScore[];
}

function toPillarScore(raw: unknown): PillarScore[] {
  if (!isRecord(raw) || typeof raw.pillar_code !== 'string' || typeof raw.weight !== 'string' || (raw.state !== 'ASSESSED' && raw.state !== 'NOT_ASSESSED')) return [];
  return [
    {
      code: raw.pillar_code,
      weight: raw.weight,
      state: raw.state,
      level: text(raw.level),
      assessed: Number(raw.assessed_count ?? 0),
      notAssessed: Number(raw.not_assessed_count ?? 0),
      notApplicable: Number(raw.not_applicable_count ?? 0),
    },
  ];
}

function toCriterionScore(raw: unknown): CriterionScore[] {
  if (!isRecord(raw) || typeof raw.pillar_code !== 'string' || typeof raw.criterion_code !== 'string' || typeof raw.evidence_id !== 'string') return [];
  const state = pick(CRITERION_STATES, raw.state);
  const reviewStatus = pick(REVIEW_STATUSES, raw.review_status);
  if (state === undefined || reviewStatus === undefined) return [];
  return [
    {
      pillarCode: raw.pillar_code,
      criterionCode: raw.criterion_code,
      weight: text(raw.weight) ?? '',
      state,
      level: typeof raw.level === 'number' ? raw.level : null,
      reviewStatus,
      evidenceExpiresOn: text(raw.evidence_expires_on),
      evidenceCount: Number(raw.evidence_count ?? 0),
      evidenceId: raw.evidence_id,
    },
  ];
}

export function toScore(raw: unknown): Score | undefined {
  if (!isRecord(raw) || typeof raw.assessment_id !== 'string' || typeof raw.coverage_percent !== 'string' || !Array.isArray(raw.pillars)) return undefined;
  const status = pick(ASSESSMENT_STATUSES, raw.status);
  if (status === undefined || (raw.overall_state !== 'COMPUTED' && raw.overall_state !== 'NOT_COMPUTED')) return undefined;
  return {
    assessmentId: raw.assessment_id,
    status,
    asOf: text(raw.as_of) ?? '',
    coveragePercent: raw.coverage_percent,
    minCoveragePct: text(raw.min_coverage_pct) ?? '',
    overallState: raw.overall_state,
    overallLevel: text(raw.overall_level),
    assessed: Number(raw.assessed_count ?? 0),
    notAssessed: Number(raw.not_assessed_count ?? 0),
    notApplicable: Number(raw.not_applicable_count ?? 0),
    pillars: raw.pillars.flatMap(toPillarScore),
    criteria: Array.isArray(raw.criteria) ? raw.criteria.flatMap(toCriterionScore) : [],
  };
}

export interface Milestone {
  id: string;
  rubricVersionId: string;
  rubricCode: string;
  pillarCode: string;
  targetLevel: number;
  dueOn: string;
  owner: Person | null;
  exitCriteria: string;
  evidenceRequired: string[];
  status: MilestoneStatus;
  achievedAssessmentId: string | null;
  version: number;
}

export function toMilestone(raw: unknown): Milestone | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.rubric_version_id !== 'string' ||
    typeof raw.pillar_code !== 'string' ||
    typeof raw.target_level !== 'number' ||
    typeof raw.due_on !== 'string'
  )
    return undefined;
  const status = pick(MILESTONE_STATUSES, raw.status);
  if (status === undefined || typeof raw.exit_criteria !== 'string' || typeof raw.version !== 'number') return undefined;
  return {
    id: raw.id,
    rubricVersionId: raw.rubric_version_id,
    rubricCode: text(raw.rubric_code) ?? '',
    pillarCode: raw.pillar_code,
    targetLevel: raw.target_level,
    dueOn: raw.due_on,
    owner: toPerson(raw.owner),
    exitCriteria: raw.exit_criteria,
    evidenceRequired: Array.isArray(raw.evidence_required) ? raw.evidence_required.filter((item): item is string => typeof item === 'string') : [],
    status,
    achievedAssessmentId: text(raw.achieved_assessment_id),
    version: raw.version,
  };
}

/** The same person never assesses and reviews, and does not publish what they assessed: what the screens may offer a person on an assessment. */
export function actionsFor(
  assessment: Assessment,
  permissions: readonly string[] | undefined,
  mode: string | undefined,
  membershipId: string | undefined,
): { record: boolean; review: boolean; decide: boolean } {
  const holds = (permission: string): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
  const open = assessment.status === 'DRAFT' || assessment.status === 'IN_REVIEW';
  return {
    record: open && holds(ASSESS_PERMISSION) && assessment.assessor?.membershipId === membershipId,
    review: assessment.status === 'IN_REVIEW' && holds(REVIEW_PERMISSION) && assessment.reviewer?.membershipId === membershipId,
    decide: assessment.status === 'IN_REVIEW' && holds(PUBLISH_PERMISSION) && assessment.assessor?.membershipId !== membershipId,
  };
}

/** A criterion is open to a reviewer when a record waits for them: assessed or not applicable, not yet decided. */
export const awaitsReview = (row: EvidenceRow): boolean => row.reviewStatus === 'PENDING' && row.state !== 'NOT_ASSESSED';

// --- the rubric --------------------------------------------------------------------------------------------------------------------------------

export interface RubricForm {
  code: string;
  minCoveragePct: string;
  evidenceTtlDays: string;
  frameworkRefs: string;
  pillars: string;
}

export type RubricField = keyof RubricForm;
export type FormProblem = 'required' | 'invalid';

/** A rubric to start from: eight pillars, three criteria each, equal weights, a line for every level to be written over. */
export function rubricTemplate(): { frameworkRefs: string; pillars: string } {
  const codes: Record<PillarCode, string> = { GOVERNANCE: 'GOV', METADATA: 'META', QUALITY: 'QUAL', INTEGRATION: 'INTEG', SECURITY: 'SEC', LINEAGE_BI: 'LIN', AI_READINESS: 'AI', VALUE_COST: 'VAL' };
  const pillars = PILLARS.map((pillar) => ({
    code: pillar,
    name: pillar,
    weight: 12.5,
    criteria: [1, 2, 3].map((n) => ({
      code: `${codes[pillar]}-${n}`,
      name: `${codes[pillar]}-${n}`,
      weight: 10,
      levels: { 1: 'Level 1', 2: 'Level 2', 3: 'Level 3', 4: 'Level 4', 5: 'Level 5' },
      refs: [],
    })),
  }));
  return { frameworkRefs: '{}', pillars: JSON.stringify({ pillars }, null, 2) };
}

export const EMPTY_RUBRIC: RubricForm = { code: '', minCoveragePct: '70', evidenceTtlDays: '365', frameworkRefs: '{}', pillars: '' };

function jsonObject(value: string): Raw | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function validateRubric(form: RubricForm): Partial<Record<RubricField, FormProblem>> {
  const problems: Partial<Record<RubricField, FormProblem>> = {};
  if (form.code.trim() === '') problems.code = 'required';
  else if (!/^[A-Z][A-Z0-9_-]{1,59}$/.test(form.code.trim())) problems.code = 'invalid';
  const coverage = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(form.minCoveragePct.trim());
  if (form.minCoveragePct.trim() === '') problems.minCoveragePct = 'required';
  else if (coverage === null || Number(form.minCoveragePct) < 1 || Number(form.minCoveragePct) > 100) problems.minCoveragePct = 'invalid';
  if (form.evidenceTtlDays.trim() === '') problems.evidenceTtlDays = 'required';
  else if (!/^\d{1,4}$/.test(form.evidenceTtlDays.trim()) || Number(form.evidenceTtlDays) < 1 || Number(form.evidenceTtlDays) > 3650) problems.evidenceTtlDays = 'invalid';
  if (jsonObject(form.frameworkRefs) === undefined) problems.frameworkRefs = 'invalid';
  if (form.pillars.trim() === '') problems.pillars = 'required';
  else if (jsonObject(form.pillars) === undefined) problems.pillars = 'invalid';
  return problems;
}

export function rubricBody(form: RubricForm): Record<string, unknown> {
  return {
    rubric_code: form.code.trim(),
    framework_refs: jsonObject(form.frameworkRefs) ?? {},
    pillars_json: jsonObject(form.pillars) ?? {},
    min_coverage_pct: form.minCoveragePct.trim(),
    evidence_ttl_days: Number(form.evidenceTtlDays),
  };
}

// --- the assessment ----------------------------------------------------------------------------------------------------------------------------

export interface StartForm {
  rubricId: string;
  period: string;
  scopeKind: Scope;
  scopeRef: string;
  assessorId: string;
  reviewerId: string;
}

export type StartField = keyof StartForm;
export const EMPTY_START: StartForm = { rubricId: '', period: '', scopeKind: 'TENANT', scopeRef: '', assessorId: '', reviewerId: '' };

export function validateStart(form: StartForm): Partial<Record<StartField, FormProblem>> {
  const problems: Partial<Record<StartField, FormProblem>> = {};
  if (form.rubricId === '') problems.rubricId = 'required';
  const period = form.period.trim();
  if (period === '') problems.period = 'required';
  else if (period.length < 4 || period.length > 20) problems.period = 'invalid';
  if (form.scopeKind !== 'TENANT' && form.scopeRef.trim() === '') problems.scopeRef = 'required';
  if (form.assessorId === '') problems.assessorId = 'required';
  if (form.reviewerId === '') problems.reviewerId = 'required';
  else if (form.reviewerId === form.assessorId) problems.reviewerId = 'invalid';
  return problems;
}

export function startBody(form: StartForm): Record<string, unknown> {
  return {
    period_code: form.period.trim(),
    rubric_version_id: form.rubricId,
    scope_kind: form.scopeKind,
    ...(form.scopeKind === 'TENANT' ? {} : { scope_ref: form.scopeRef.trim() }),
    assessor_user_id: form.assessorId,
    reviewer_id: form.reviewerId,
  };
}

export interface RecordForm {
  state: CriterionState;
  level: string;
  evidence: string;
  expiresOn: string;
  sampleSize: string;
  confidence: string;
  naReason: string;
}

export type RecordField = keyof RecordForm;
export const EMPTY_RECORD: RecordForm = { state: 'ASSESSED', level: '', evidence: '', expiresOn: '', sampleSize: '', confidence: '', naReason: '' };

/** One piece of evidence per line: its kind, a space, and what it refers to. */
export function parseEvidenceLines(value: string): Array<{ kind: EvidenceKind; ref: string }> | undefined {
  const found: Array<{ kind: EvidenceKind; ref: string }> = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    const kind = space < 0 ? undefined : pick(EVIDENCE_KINDS, trimmed.slice(0, space).toUpperCase());
    const ref = space < 0 ? '' : trimmed.slice(space + 1).trim();
    if (kind === undefined || ref === '') return undefined;
    found.push({ kind, ref });
  }
  return found;
}

export const isDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function validateRecord(form: RecordForm): Partial<Record<RecordField, FormProblem>> {
  const problems: Partial<Record<RecordField, FormProblem>> = {};
  if (form.state === 'ASSESSED') {
    if (form.level === '') problems.level = 'required';
    else if (!/^[1-5]$/.test(form.level)) problems.level = 'invalid';
    const lines = parseEvidenceLines(form.evidence);
    if (lines === undefined) problems.evidence = 'invalid';
    else if (lines.length === 0) problems.evidence = 'required';
    if (form.expiresOn !== '' && !isDay(form.expiresOn)) problems.expiresOn = 'invalid';
    if (form.sampleSize.trim() !== '' && !/^[1-9]\d{0,8}$/.test(form.sampleSize.trim())) problems.sampleSize = 'invalid';
  } else if (form.state === 'NOT_APPLICABLE') {
    if (form.naReason.trim() === '') problems.naReason = 'required';
    else if (form.naReason.trim().length < 10) problems.naReason = 'invalid';
  }
  return problems;
}

export function recordBody(pillarCode: string, criterionCode: string, form: RecordForm): Record<string, unknown> {
  const base = { pillar_code: pillarCode, criterion_code: criterionCode, assessment_state: form.state };
  if (form.state === 'NOT_ASSESSED') return { ...base, evidence_refs: [] };
  if (form.state === 'NOT_APPLICABLE') return { ...base, evidence_refs: [], na_reason: form.naReason.trim() };
  return {
    ...base,
    level: Number(form.level),
    evidence_refs: parseEvidenceLines(form.evidence) ?? [],
    ...(form.expiresOn === '' ? {} : { evidence_expires_on: form.expiresOn }),
    ...(form.sampleSize.trim() === '' ? {} : { sample_size: Number(form.sampleSize) }),
    ...(form.confidence === '' ? {} : { confidence: form.confidence }),
  };
}

// --- the roadmap -------------------------------------------------------------------------------------------------------------------------------

export interface MilestoneForm {
  rubricId: string;
  pillar: string;
  targetLevel: string;
  dueOn: string;
  ownerId: string;
  exitCriteria: string;
  evidence: string;
}

export type MilestoneField = keyof MilestoneForm;
export const EMPTY_MILESTONE: MilestoneForm = { rubricId: '', pillar: 'QUALITY', targetLevel: '', dueOn: '', ownerId: '', exitCriteria: '', evidence: '' };

export function validateMilestone(form: MilestoneForm): Partial<Record<MilestoneField, FormProblem>> {
  const problems: Partial<Record<MilestoneField, FormProblem>> = {};
  if (form.rubricId === '') problems.rubricId = 'required';
  if (form.targetLevel === '') problems.targetLevel = 'required';
  else if (!/^[1-5]$/.test(form.targetLevel)) problems.targetLevel = 'invalid';
  if (form.dueOn === '') problems.dueOn = 'required';
  else if (!isDay(form.dueOn)) problems.dueOn = 'invalid';
  if (form.ownerId === '') problems.ownerId = 'required';
  if (form.exitCriteria.trim() === '') problems.exitCriteria = 'required';
  else if (form.exitCriteria.trim().length < 10) problems.exitCriteria = 'invalid';
  return problems;
}

export function milestoneBody(form: MilestoneForm): Record<string, unknown> {
  return {
    rubric_version_id: form.rubricId,
    pillar_code: form.pillar,
    target_level: Number(form.targetLevel),
    due_on: form.dueOn,
    owner_user_id: form.ownerId,
    exit_criteria: form.exitCriteria.trim(),
    evidence_required: form.evidence
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  };
}

// --- refusals ----------------------------------------------------------------------------------------------------------------------------------

export type MaturityReason =
  'weights' | 'notPublished' | 'sameRole' | 'evidenceRequired' | 'expired' | 'level' | 'targetBelow' | 'self' | 'scope' | 'stale' | 'state' | 'duplicate' | 'validation' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, MaturityReason>> = {
  RUBRIC_WEIGHTS_INVALID: 'weights',
  RUBRIC_NOT_PUBLISHED: 'notPublished',
  ASSESSOR_IS_REVIEWER: 'sameRole',
  EVIDENCE_REQUIRED: 'evidenceRequired',
  EVIDENCE_EXPIRED: 'expired',
  LEVEL_OUT_OF_RANGE: 'level',
  TARGET_BELOW_CURRENT: 'targetBelow',
  SELF_APPROVAL_DENIED: 'self',
  SCOPE_DENIED: 'scope',
  VERSION_CONFLICT: 'stale',
  STAGE_TRANSITION_DENIED: 'state',
  DUPLICATE_KEY: 'duplicate',
  VALIDATION_FAILED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export function describeMaturityProblem(error: unknown): { reason: MaturityReason; detail: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '' };
}
