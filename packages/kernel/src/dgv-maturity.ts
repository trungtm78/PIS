import { DomainError } from './errors.ts';

/**
 * The maturity of data governance (ST-DGV-008, DGV 3.1 F8, BR-DGV-08, DGV-16, DGV-17, DGV-21). A rubric of eight pillars, each with three to five criteria that have a weight and a description for each level 1 to 5, is
 * published by somebody other than who drafted it; an assessment records, for each criterion, a level with evidence that a reviewer accepts and that has not run out, or says it does not apply. What has no accepted
 * evidence is NOT_ASSESSED: it is not a level, it is not part of any average and it keeps the total from being computed when it is too much. The frameworks (DCAM, DMM) are references and nothing here is a
 * certification against them. Pure functions of their input; weights are kept in hundredths so that sums are exact.
 */
export const MATURITY_PILLARS = ['GOVERNANCE', 'METADATA', 'QUALITY', 'INTEGRATION', 'SECURITY', 'LINEAGE_BI', 'AI_READINESS', 'VALUE_COST'] as const;
export type MaturityPillar = (typeof MATURITY_PILLARS)[number];
export const MATURITY_LEVELS = [1, 2, 3, 4, 5] as const;
export const CRITERION_STATES = ['ASSESSED', 'NOT_ASSESSED', 'NOT_APPLICABLE'] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];
export const REVIEW_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const EVIDENCE_KINDS = ['ARTIFACT', 'LOG', 'INTERVIEW', 'TEST'] as const;
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;

export const MIN_CRITERIA = 3;
export const MAX_CRITERIA = 5;
export const MAX_EVIDENCE_REFS = 500;
const WEIGHT_TOTAL = 10_000;
const MAX_TEXT = 2000;
const MAX_SAMPLE = 1_000_000_000;
const MAX_TTL_DAYS = 3650;
const CODE = /^[A-Z][A-Z0-9_-]{1,59}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NA_REASON_MIN = 10;

const invalid = (path: string): DomainError => new DomainError('VALIDATION_FAILED', 422, path);
const weightsInvalid = (path: string): DomainError => new DomainError('RUBRIC_WEIGHTS_INVALID', 422, path);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, path: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || value.includes('\0')) throw invalid(path);
  return value.trim();
}

/** A weight written with at most two decimals, above 0 and at most 100, as hundredths. */
function weightOf(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) throw weightsInvalid(path);
  const hundredths = Math.round(value * 100);
  if (Math.abs(value * 100 - hundredths) > 1e-7) throw weightsInvalid(path);
  return hundredths;
}

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The day `days` after `day` (both as YYYY-MM-DD). */
export function dayAfter(day: string, days: number): string {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export interface RubricCriterion {
  code: string;
  name: string;
  /** In hundredths. */
  weight: number;
  levels: Record<'1' | '2' | '3' | '4' | '5', string>;
  refs: string[];
}

export interface RubricPillar {
  code: MaturityPillar;
  name: string;
  /** In hundredths; the pillars add up to 10000. */
  weight: number;
  criteria: RubricCriterion[];
}

export interface Rubric {
  pillars: RubricPillar[];
}

export interface RubricDraft {
  frameworkRefs: Record<string, string[]>;
  rubric: Rubric;
  minCoveragePct: string;
  evidenceTtlDays: number;
}

/** The mapping of a rubric to the frameworks it refers to: a name, and the places in it. Nothing in it is a claim of certification. */
function frameworkRefsOf(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) throw invalid('framework_refs');
  const found: Record<string, string[]> = {};
  const names = Object.keys(raw);
  if (names.length > 20) throw invalid('framework_refs');
  for (const name of names) {
    const value = raw[name];
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.length === 0 || list.length > 100) throw invalid(`framework_refs.${name}`);
    found[text(name, 'framework_refs', 60)] = list.map((item, index) => text(item, `framework_refs.${name}[${index}]`, 200));
  }
  return found;
}

/**
 * Reads the draft of a rubric version: the eight pillars once each, three to five criteria in each with a weight and a description for each of the five levels, the weights of the pillars adding up to 100
 * (422 `RUBRIC_WEIGHTS_INVALID` otherwise, naming where), the share of criteria that must be assessed for a total (1 to 100) and how many days evidence lasts (1 to 3650).
 */
export function parseRubricDraft(input: { frameworkRefs: unknown; pillarsJson: unknown; minCoveragePct: string; evidenceTtlDays: number }): RubricDraft {
  const frameworkRefs = frameworkRefsOf(input.frameworkRefs);
  if (!isRecord(input.pillarsJson) || !Array.isArray(input.pillarsJson.pillars)) throw invalid('pillars_json');
  const listed = input.pillarsJson.pillars as unknown[];
  if (listed.length !== MATURITY_PILLARS.length) throw invalid('pillars_json.pillars');
  const seenPillars = new Set<string>();
  const seenCriteria = new Set<string>();
  let total = 0;
  const pillars: RubricPillar[] = listed.map((rawPillar, index) => {
    const path = `pillars_json.pillars[${index}]`;
    if (!isRecord(rawPillar)) throw invalid(path);
    const code = MATURITY_PILLARS.find((candidate) => candidate === rawPillar.code);
    if (code === undefined || seenPillars.has(code)) throw invalid(`${path}.code`);
    seenPillars.add(code);
    const weight = weightOf(rawPillar.weight, `${path}.weight`);
    total += weight;
    const criteria = rawPillar.criteria;
    if (!Array.isArray(criteria) || criteria.length < MIN_CRITERIA || criteria.length > MAX_CRITERIA) throw invalid(`${path}.criteria`);
    return {
      code,
      name: text(rawPillar.name, `${path}.name`, 200),
      weight,
      criteria: criteria.map((rawCriterion: unknown, criterionIndex): RubricCriterion => {
        const criterionPath = `${path}.criteria[${criterionIndex}]`;
        if (!isRecord(rawCriterion)) throw invalid(criterionPath);
        const criterionCode = rawCriterion.code;
        if (typeof criterionCode !== 'string' || !CODE.test(criterionCode) || seenCriteria.has(criterionCode)) throw invalid(`${criterionPath}.code`);
        seenCriteria.add(criterionCode);
        if (!isRecord(rawCriterion.levels)) throw invalid(`${criterionPath}.levels`);
        const levels = {} as RubricCriterion['levels'];
        for (const level of ['1', '2', '3', '4', '5'] as const) levels[level] = text(rawCriterion.levels[level], `${criterionPath}.levels.${level}`);
        const refs = rawCriterion.refs === undefined ? [] : rawCriterion.refs;
        if (!Array.isArray(refs) || refs.length > 20) throw invalid(`${criterionPath}.refs`);
        return {
          code: criterionCode,
          name: text(rawCriterion.name, `${criterionPath}.name`, 200),
          weight: weightOf(rawCriterion.weight, `${criterionPath}.weight`),
          levels,
          refs: refs.map((ref, refIndex) => text(ref, `${criterionPath}.refs[${refIndex}]`, 200)),
        };
      }),
    };
  });
  if (total !== WEIGHT_TOTAL) throw weightsInvalid('pillars_json.pillars');
  const coverage = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.minCoveragePct);
  const hundredths = coverage === null ? Number.NaN : Number(coverage[1]) * 100 + Number((coverage[2] ?? '').padEnd(2, '0') || 0);
  if (!(hundredths >= 100 && hundredths <= 10_000)) throw invalid('min_coverage_pct');
  if (!Number.isInteger(input.evidenceTtlDays) || input.evidenceTtlDays < 1 || input.evidenceTtlDays > MAX_TTL_DAYS) throw invalid('evidence_ttl_days');
  return { frameworkRefs, rubric: { pillars }, minCoveragePct: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`, evidenceTtlDays: input.evidenceTtlDays };
}

/** The rubric as it was stored (what `parseRubricDraft` accepted), read back; anything else is a stored row that cannot be scored. */
export function rubricOf(pillarsJson: unknown): Rubric {
  if (!isRecord(pillarsJson) || !Array.isArray(pillarsJson.pillars)) throw invalid('pillars_json');
  return pillarsJson as unknown as Rubric;
}

export function criterionOf(rubric: Rubric, pillarCode: string, criterionCode: string): { pillar: RubricPillar; criterion: RubricCriterion } | undefined {
  const pillar = rubric.pillars.find((candidate) => candidate.code === pillarCode);
  const criterion = pillar?.criteria.find((candidate) => candidate.code === criterionCode);
  return pillar === undefined || criterion === undefined ? undefined : { pillar, criterion };
}

export interface EvidenceRecordInput {
  pillarCode: string;
  criterionCode: string;
  state: CriterionState;
  level: number | undefined;
  evidenceRefs: readonly unknown[];
  sampleSize: number | undefined;
  confidence: string | undefined;
  naReason: string | undefined;
  expiresOn: string | undefined;
}

export interface EvidenceRecord {
  state: CriterionState;
  level: number | null;
  evidenceRefs: unknown[];
  sampleSize: number | null;
  confidence: string | null;
  naReason: string | null;
  expiresOn: string | null;
}

/**
 * What an assessor records for a criterion, checked on its own: a criterion of the rubric; a level 1 to 5 and nothing else for ASSESSED (422 `LEVEL_OUT_OF_RANGE` outside them), with at least one piece of evidence
 * (422 `EVIDENCE_REQUIRED`: a kind - artifact, log, interview or test - and what it refers to) and a last day that is not before `today` (422 `EVIDENCE_EXPIRED`) and not after the rubric's days of life of evidence
 * (the day itself is given when none is); a reason for NOT_APPLICABLE; no level, no evidence for NOT_ASSESSED (a level there is 422, as the database says).
 */
export function checkEvidenceRecord(input: EvidenceRecordInput, rubric: Rubric, ttlDays: number, today: string): EvidenceRecord {
  if (criterionOf(rubric, input.pillarCode, input.criterionCode) === undefined) throw invalid('criterion_code');
  if (input.evidenceRefs.length > MAX_EVIDENCE_REFS) throw invalid('evidence_refs');
  const refs = input.evidenceRefs.map((item, index) => {
    if (!isRecord(item) || !EVIDENCE_KINDS.some((kind) => kind === item.kind)) throw invalid(`evidence_refs[${index}].kind`);
    const ref = text(item.ref, `evidence_refs[${index}].ref`, 500);
    const note = item.note === undefined ? undefined : text(item.note, `evidence_refs[${index}].note`, 1000);
    return { kind: item.kind as string, ref, ...(note === undefined ? {} : { note }) };
  });
  if (input.sampleSize !== undefined && (!Number.isInteger(input.sampleSize) || input.sampleSize < 1 || input.sampleSize > MAX_SAMPLE)) throw invalid('sample_size');
  if (input.confidence !== undefined && !CONFIDENCES.some((confidence) => confidence === input.confidence)) throw invalid('confidence');
  if (input.state === 'NOT_ASSESSED') {
    if (input.level !== undefined) throw invalid('level');
    if (refs.length > 0 || input.naReason !== undefined || input.expiresOn !== undefined || input.sampleSize !== undefined || input.confidence !== undefined) throw invalid('assessment_state');
    return { state: 'NOT_ASSESSED', level: null, evidenceRefs: [], sampleSize: null, confidence: null, naReason: null, expiresOn: null };
  }
  if (input.state === 'NOT_APPLICABLE') {
    if (input.level !== undefined) throw invalid('level');
    const reason = input.naReason === undefined ? '' : input.naReason.trim();
    if (reason.length < NA_REASON_MIN || reason.length > MAX_TEXT || reason.includes('\0')) throw invalid('na_reason');
    if (input.expiresOn !== undefined) throw invalid('evidence_expires_on');
    return { state: 'NOT_APPLICABLE', level: null, evidenceRefs: refs, sampleSize: input.sampleSize ?? null, confidence: input.confidence ?? null, naReason: reason, expiresOn: null };
  }
  if (input.state !== 'ASSESSED') throw invalid('assessment_state');
  if (input.level === undefined) throw invalid('level');
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 5) throw new DomainError('LEVEL_OUT_OF_RANGE', 422, 'level');
  if (input.naReason !== undefined) throw invalid('na_reason');
  if (refs.length === 0) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_refs');
  let expiresOn = dayAfter(today, ttlDays);
  if (input.expiresOn !== undefined) {
    if (!isDay(input.expiresOn)) throw invalid('evidence_expires_on');
    if (input.expiresOn < today) throw new DomainError('EVIDENCE_EXPIRED', 422, 'evidence_expires_on');
    if (input.expiresOn > expiresOn) throw invalid('evidence_expires_on');
    expiresOn = input.expiresOn;
  }
  return { state: 'ASSESSED', level: input.level, evidenceRefs: refs, sampleSize: input.sampleSize ?? null, confidence: input.confidence ?? null, naReason: null, expiresOn };
}

export interface CriterionRow {
  pillarCode: string;
  criterionCode: string;
  state: CriterionState;
  level: number | null;
  reviewStatus: ReviewStatus;
  expiresOn: string | null;
}

/**
 * What a row counts as on `asOf`: an ASSESSED criterion counts only when a reviewer accepted it and its evidence has not run out; NOT_APPLICABLE only when a reviewer accepted the reason. Anything else is
 * NOT_ASSESSED - an assessor cannot make a criterion count, or leave the average, on their own word.
 */
export function effectiveCriterion(row: CriterionRow, asOf: string): { state: CriterionState; level: number | null } {
  if (row.reviewStatus !== 'ACCEPTED') return { state: 'NOT_ASSESSED', level: null };
  if (row.state === 'NOT_APPLICABLE') return { state: 'NOT_APPLICABLE', level: null };
  if (row.state === 'ASSESSED' && row.level !== null && row.expiresOn !== null && row.expiresOn >= asOf) return { state: 'ASSESSED', level: row.level };
  return { state: 'NOT_ASSESSED', level: null };
}

export interface PillarScore {
  code: MaturityPillar;
  /** In hundredths. */
  weight: number;
  state: 'ASSESSED' | 'NOT_ASSESSED';
  /** The weighted average of its assessed criteria with two decimals, or null when none is assessed. */
  level: string | null;
  levelNumerator: number;
  levelDenominator: number;
  assessedCount: number;
  notAssessedCount: number;
  notApplicableCount: number;
}

export interface MaturityScore {
  coveragePercent: string;
  overallState: 'COMPUTED' | 'NOT_COMPUTED';
  overallLevel: string | null;
  assessedCount: number;
  notAssessedCount: number;
  notApplicableCount: number;
  pillars: PillarScore[];
}

/** numerator / denominator times 100, rounded half up (so a ratio becomes hundredths). */
const fraction = (numerator: bigint, denominator: bigint): bigint => (denominator === 0n ? 0n : (numerator * 200n + denominator) / (2n * denominator));
const twoDecimals = (hundredths: bigint): string => `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * The score of BR-DGV-08. Coverage is the weight of the criteria that count as assessed over the weight of those that are assessed or not (NOT_APPLICABLE leaves both). A pillar's level is the weighted average of its
 * assessed criteria, or NOT_ASSESSED when it has none. The total is the weighted average of the pillars that have a level, and only when coverage is at least `minCoveragePct`; otherwise it is NOT_COMPUTED and
 * has no level. Levels are rounded half up to two decimals. Exact: the comparison with the coverage asked for is made on the fractions, not on the rounded value.
 */
export function computeScore(rubric: Rubric, minCoveragePct: string, rows: readonly CriterionRow[], asOf: string): MaturityScore {
  const byCriterion = new Map(rows.map((row) => [`${row.pillarCode}:${row.criterionCode}`, effectiveCriterion(row, asOf)]));
  let assessedWeight = 0;
  let pendingWeight = 0;
  let assessedCount = 0;
  let notAssessedCount = 0;
  let notApplicableCount = 0;
  const pillars: PillarScore[] = rubric.pillars.map((pillar) => {
    let weights = 0;
    let weighted = 0;
    let assessed = 0;
    let notAssessed = 0;
    let notApplicable = 0;
    for (const criterion of pillar.criteria) {
      const effective = byCriterion.get(`${pillar.code}:${criterion.code}`) ?? { state: 'NOT_ASSESSED' as const, level: null };
      if (effective.state === 'NOT_APPLICABLE') notApplicable += 1;
      else if (effective.state === 'ASSESSED' && effective.level !== null) {
        assessed += 1;
        weights += criterion.weight;
        weighted += criterion.weight * effective.level;
        assessedWeight += criterion.weight;
      } else {
        notAssessed += 1;
        pendingWeight += criterion.weight;
      }
    }
    assessedCount += assessed;
    notAssessedCount += notAssessed;
    notApplicableCount += notApplicable;
    return {
      code: pillar.code,
      weight: pillar.weight,
      state: assessed === 0 ? 'NOT_ASSESSED' : 'ASSESSED',
      level: assessed === 0 ? null : twoDecimals(fraction(BigInt(weighted), BigInt(weights))),
      levelNumerator: weighted,
      levelDenominator: weights,
      assessedCount: assessed,
      notAssessedCount: notAssessed,
      notApplicableCount: notApplicable,
    };
  });
  const asked = /^(\d+)\.(\d{2})$/.exec(minCoveragePct);
  const askedHundredths = asked === null ? 10_000n : BigInt(asked[1] as string) * 100n + BigInt(asked[2] as string);
  const counted = BigInt(assessedWeight + pendingWeight);
  const coverage = twoDecimals(fraction(BigInt(assessedWeight) * 100n, counted));
  const enough = counted > 0n && BigInt(assessedWeight) * 10_000n >= askedHundredths * counted;
  const scored = pillars.filter((pillar) => pillar.state === 'ASSESSED');
  let overallLevel: string | null = null;
  if (enough && scored.length > 0) {
    // sum of (pillar weight x level) / sum of pillar weights, with each level the fraction numerator / denominator
    let numerator = 0n;
    let denominator = 1n;
    for (const pillar of scored) {
      const term = BigInt(pillar.weight) * BigInt(pillar.levelNumerator);
      const under = BigInt(pillar.levelDenominator);
      numerator = numerator * under + term * denominator;
      denominator *= under;
      const divisor = gcd(numerator, denominator);
      if (divisor > 1n) {
        numerator /= divisor;
        denominator /= divisor;
      }
    }
    const totalWeight = BigInt(scored.reduce((sum, pillar) => sum + pillar.weight, 0));
    overallLevel = twoDecimals(fraction(numerator, denominator * totalWeight));
  }
  return { coveragePercent: coverage, overallState: overallLevel === null ? 'NOT_COMPUTED' : 'COMPUTED', overallLevel, assessedCount, notAssessedCount, notApplicableCount, pillars };
}

/** Whether the level of a pillar is at least `target`, exactly (a level shown as 3.00 that is 2.996 does not reach 3). */
export function pillarReaches(pillar: Pick<PillarScore, 'state' | 'levelNumerator' | 'levelDenominator'>, target: number): boolean {
  return pillar.state === 'ASSESSED' && pillar.levelNumerator >= target * pillar.levelDenominator;
}

/** The target of a milestone must be above where the pillar stands now (422 `TARGET_BELOW_CURRENT`); a pillar with no published level stands nowhere. */
export function assertTargetAbove(current: Pick<PillarScore, 'state' | 'levelNumerator' | 'levelDenominator'> | undefined, target: number): void {
  if (!Number.isInteger(target) || target < 1 || target > 5) throw new DomainError('LEVEL_OUT_OF_RANGE', 422, 'target_level');
  if (current !== undefined && pillarReaches(current, target)) throw new DomainError('TARGET_BELOW_CURRENT', 422, 'target_level');
}

/** The code of a rubric: capital letters, digits, hyphen and underscore, 2 to 60 characters. */
export function assertRubricCode(code: string): string {
  const trimmed = code.trim();
  if (!CODE.test(trimmed)) throw invalid('rubric_code');
  return trimmed;
}

export interface MaturityMilestoneInput {
  pillarCode: string;
  dueOn: string;
  exitCriteria: string;
  evidenceRequired: readonly unknown[];
}

/**
 * What a milestone asks for, checked on its own: a pillar of the rubric, a last day that is not before `today`, the criteria to leave by (10 to 2000 characters) and the evidence it needs (at most 500 texts).
 * The level aimed at is judged against where the pillar stands (`assertTargetAbove`).
 */
export function checkMilestone(input: MaturityMilestoneInput, today: string): { exitCriteria: string; evidenceRequired: string[] } {
  if (!MATURITY_PILLARS.some((pillar) => pillar === input.pillarCode)) throw invalid('pillar_code');
  if (!isDay(input.dueOn) || input.dueOn < today) throw invalid('due_on');
  const exitCriteria = typeof input.exitCriteria === 'string' ? input.exitCriteria.trim() : '';
  if (exitCriteria.length < 10 || exitCriteria.length > MAX_TEXT || exitCriteria.includes('\0')) throw invalid('exit_criteria');
  if (input.evidenceRequired.length > MAX_EVIDENCE_REFS) throw invalid('evidence_required');
  return { exitCriteria, evidenceRequired: input.evidenceRequired.map((item, index) => text(item, `evidence_required[${index}]`, 4000)) };
}
