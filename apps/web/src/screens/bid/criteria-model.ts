import { ApiError } from '@machvon/api-client';
import { toPackageLine } from './plan-model';
import type { PackageLine } from './plan-model';

/** The permissions that gate the buttons of the criteria screen; the server decides again on every request. */
export const MANAGE_CRITERIA_PERMISSION = 'bid.criteria.manage';
export const APPROVE_CRITERIA_PERMISSION = 'bid.criteria.approve';

export const CRITERIA_PATH = '/bid/bid-04';

export const CRITERIA_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type CriteriaStatus = (typeof CRITERIA_STATUSES)[number];
export const CRITERION_KINDS = ['SCORED', 'PASS_FAIL'] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** Whole weights of the scored criteria add up to this (BR-BID-04). */
export const TOTAL_WEIGHT = 100;
export const MAX_CRITERIA = 50;
export const MAX_EVIDENCE = 10;
export const MAX_SCALE = 100;
export const NAME_MIN = 3;
export const NAME_MAX = 300;
export const CODE_MAX = 30;
export const BASIS_MIN = 3;
export const BASIS_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WHOLE = /^\d{1,9}$/;
/** The statuses of a package whose plan is still in work or was dropped: it has nothing to evaluate yet (the server refuses the criteria of it). */
const PACKAGE_STATUSES_WITHOUT_CRITERIA: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;
const oneOf = <Value extends string>(list: readonly Value[], value: unknown): Value | undefined => list.find((candidate) => candidate === value);

export interface Criterion {
  code: string;
  name: string;
  kind: CriterionKind;
  weight: number | null;
  maxScore: number | null;
  threshold: number | null;
  mandatory: boolean;
  requiredEvidence: string[];
}

/** One version of the criteria of a package (BID-04). */
export interface CriteriaVersion {
  id: string;
  packageId: string;
  packageCode: string;
  packageTitle: string | null;
  packageStatus: string;
  projectCode: string;
  projectName: string;
  revision: number;
  status: CriteriaStatus;
  criteria: Criterion[];
  weightsSum: number | null;
  legalBasis: string | null;
  approvedAt: string | null;
  version: number;
}

function toCriterion(raw: unknown): Criterion | undefined {
  const record = asRecord(raw);
  const code = text(record?.code);
  const name = text(record?.name);
  const kind = oneOf(CRITERION_KINDS, record?.kind);
  if (record === undefined || code === undefined || name === undefined || kind === undefined) return undefined;
  const evidence = Array.isArray(record.required_evidence) ? record.required_evidence.flatMap((item) => text(item) ?? []) : [];
  return {
    code,
    name,
    kind,
    weight: nullableWhole(record.weight),
    maxScore: nullableWhole(record.max_score),
    threshold: nullableWhole(record.threshold),
    mandatory: record.mandatory === true,
    requiredEvidence: evidence,
  };
}

/** A version as the read answers it; undefined for anything that is not one. */
export function toCriteriaVersion(raw: unknown): CriteriaVersion | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const pack = asRecord(record?.package);
  const project = asRecord(pack?.project);
  const packageId = text(pack?.id);
  const packageCode = text(pack?.code);
  const status = oneOf(CRITERIA_STATUSES, record?.status);
  const revision = whole(record?.revision);
  const version = whole(record?.version);
  if (record === undefined || id === undefined || packageId === undefined || packageCode === undefined || status === undefined || revision === undefined || version === undefined) return undefined;
  return {
    id,
    packageId,
    packageCode,
    packageTitle: nullableText(pack?.title),
    packageStatus: text(pack?.status) ?? '',
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    revision,
    status,
    criteria: Array.isArray(record.criteria) ? record.criteria.flatMap((item) => toCriterion(item) ?? []) : [],
    weightsSum: nullableWhole(record.weights_sum),
    legalBasis: nullableText(record.legal_basis),
    approvedAt: nullableText(record.approved_at),
    version,
  };
}

/** The packages that criteria can be made for, as the read of the packages answers them. */
export function toEligiblePackage(raw: unknown): PackageLine | undefined {
  const line = toPackageLine(raw);
  return line === undefined || PACKAGE_STATUSES_WITHOUT_CRITERIA.includes(line.status) ? undefined : line;
}

export function criteriaLink(packageId: string): string {
  return `${CRITERIA_PATH}?package=${packageId}`;
}

/** The version the screen shows by default: the one in force, else the newest. */
export function defaultVersion(versions: readonly CriteriaVersion[]): CriteriaVersion | undefined {
  return versions.find((version) => version.status === 'APPROVED') ?? versions[0];
}

/** The draft in work, if the package has one: a new revision takes its place. */
export function draftOf(versions: readonly CriteriaVersion[]): CriteriaVersion | undefined {
  return versions.find((version) => version.status === 'DRAFT');
}

// ---- the editor -------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidId' | 'invalidCode' | 'duplicateCode' | 'invalidWhole' | 'outOfRange' | 'tooMany' | 'weightTotal';

export interface CriterionRow {
  key: string;
  code: string;
  name: string;
  kind: CriterionKind;
  weight: string;
  maxScore: string;
  threshold: string;
  mandatory: boolean;
  /** One piece of evidence a line. */
  evidence: string;
}

export interface CriteriaForm {
  packageId: string;
  legalBasis: string;
  rows: CriterionRow[];
}

let rowCounter = 0;
export function emptyRow(): CriterionRow {
  rowCounter += 1;
  return { key: `criterion-${rowCounter}`, code: '', name: '', kind: 'SCORED', weight: '', maxScore: '10', threshold: '', mandatory: false, evidence: '' };
}

export const emptyForm = (packageId = ''): CriteriaForm => ({ packageId, legalBasis: '', rows: [emptyRow()] });

/** The rows of a version as the start of the next revision. */
export function rowsOf(version: CriteriaVersion): CriterionRow[] {
  return version.criteria.map((criterion) => ({
    ...emptyRow(),
    code: criterion.code,
    name: criterion.name,
    kind: criterion.kind,
    weight: criterion.weight === null ? '' : String(criterion.weight),
    maxScore: criterion.maxScore === null ? '' : String(criterion.maxScore),
    threshold: criterion.threshold === null ? '' : String(criterion.threshold),
    mandatory: criterion.mandatory,
    evidence: criterion.requiredEvidence.join('\n'),
  }));
}

const evidenceOf = (row: CriterionRow): string[] =>
  row.evidence
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The sum of the weights of the scored rows that hold a whole weight: the figure the planner watches while typing. */
export function weightsTotal(rows: readonly CriterionRow[]): number {
  return rows.reduce((sum, row) => (row.kind === 'SCORED' && WHOLE.test(row.weight.trim()) ? sum + Number(row.weight.trim()) : sum), 0);
}

export const hasScored = (rows: readonly CriterionRow[]): boolean => rows.some((row) => row.kind === 'SCORED');

export type RowField = 'code' | 'name' | 'weight' | 'maxScore' | 'threshold' | 'evidence';

export interface CriteriaErrors {
  packageId?: FieldProblem;
  legalBasis?: FieldProblem;
  rows?: FieldProblem;
  /** By row key, then by field. */
  items: Record<string, Partial<Record<RowField, FieldProblem>>>;
}

function checkLength(value: string, min: number, max: number): FieldProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  return length > max ? 'tooLong' : undefined;
}

function checkWhole(value: string, min: number, max: number): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (!WHOLE.test(trimmed)) return 'invalidWhole';
  const number = Number(trimmed);
  return number < min || number > max ? 'outOfRange' : undefined;
}

export function validateCriteria(form: CriteriaForm): CriteriaErrors {
  const errors: CriteriaErrors = { items: {} };
  if (form.packageId.trim() === '') errors.packageId = 'required';
  else if (!UUID.test(form.packageId.trim())) errors.packageId = 'invalidId';
  errors.legalBasis = checkLength(form.legalBasis, BASIS_MIN, BASIS_MAX);
  if (form.rows.length === 0) errors.rows = 'required';
  else if (form.rows.length > MAX_CRITERIA) errors.rows = 'tooMany';
  const seen = new Set<string>();
  for (const row of form.rows) {
    const found: CriteriaErrors['items'][string] = {};
    const code = row.code.trim().toLowerCase();
    const codeProblem = checkLength(row.code, 1, CODE_MAX) ?? (!CODE.test(row.code.trim()) ? 'invalidCode' : seen.has(code) ? 'duplicateCode' : undefined);
    seen.add(code);
    if (codeProblem !== undefined) found.code = codeProblem;
    const name = checkLength(row.name, NAME_MIN, NAME_MAX);
    if (name !== undefined) found.name = name;
    if (row.kind === 'SCORED') {
      const weight = checkWhole(row.weight, 1, TOTAL_WEIGHT);
      if (weight !== undefined) found.weight = weight;
      const scale = checkWhole(row.maxScore, 1, MAX_SCALE);
      if (scale !== undefined) found.maxScore = scale;
      if (row.threshold.trim() !== '') {
        const limit = scale === undefined ? Number(row.maxScore.trim()) : MAX_SCALE;
        const threshold = checkWhole(row.threshold, 0, limit);
        if (threshold !== undefined) found.threshold = threshold;
      }
    }
    if (evidenceOf(row).length > MAX_EVIDENCE) found.evidence = 'tooMany';
    else if (evidenceOf(row).some((line) => line.length < NAME_MIN || line.length > NAME_MAX)) found.evidence = 'tooShort';
    if (Object.keys(found).length > 0) errors.items[row.key] = found;
  }
  // The total is judged once the rows themselves can be read: a typo in one weight is told in its place, not as a wrong total.
  if (errors.rows === undefined && hasScored(form.rows) && weightsTotal(form.rows) !== TOTAL_WEIGHT && Object.values(errors.items).every((item) => item.weight === undefined)) errors.rows = 'weightTotal';
  return errors;
}

export function hasErrors(errors: CriteriaErrors): boolean {
  return errors.packageId !== undefined || errors.legalBasis !== undefined || errors.rows !== undefined || Object.keys(errors.items).length > 0;
}

/** The body of createCriteriaVersion: the allowlist of the contract. The list of criteria is an open object in the contract, so the typed body takes it through one cast at the hook. */
export function criteriaBody(form: CriteriaForm): { package_id: string; legal_basis: string; criteria_json: { criteria: Array<Record<string, unknown>> } } {
  return {
    package_id: form.packageId.trim().toLowerCase(),
    legal_basis: form.legalBasis.trim(),
    criteria_json: {
      criteria: form.rows.map((row) => ({
        code: row.code.trim(),
        name: row.name.trim(),
        kind: row.kind,
        ...(row.kind === 'SCORED'
          ? { weight: Number(row.weight.trim()), max_score: Number(row.maxScore.trim()), threshold: row.threshold.trim() === '' ? null : Number(row.threshold.trim()) }
          : {}),
        mandatory: row.mandatory,
        required_evidence: evidenceOf(row),
      })),
    },
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'weight'
  | 'prohibited'
  | 'packageState'
  | 'stateInvalid'
  | 'lockedByRun'
  | 'selfApproval'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  CRITERIA_WEIGHT_INVALID: 'weight',
  PROHIBITED_CRITERION: 'prohibited',
  PACKAGE_STATE_INVALID: 'packageState',
  CRITERIA_STATE_INVALID: 'stateInvalid',
  CRITERIA_LOCKED_BY_RUN: 'lockedByRun',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** The sum of the weights the server counted (CRITERIA_WEIGHT_INVALID). */
  weightsSum: number | undefined;
  /** The code of the criterion that fell under a rule and the legal basis of the rule (PROHIBITED_CRITERION). */
  criterionCode: string | undefined;
  legalBasis: string | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, weightsSum: undefined, criterionCode: undefined, legalBasis: undefined };
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: error.detail,
    weightsSum: whole(error.extensions.weights_sum),
    criterionCode: text(error.extensions.criterion_code),
    legalBasis: text(error.extensions.legal_basis),
  };
}
