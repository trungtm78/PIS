import { ApiError } from '@machvon/api-client';
import { draftFindings, submitFindings } from './engine';
import type { DoaRuleInput, DoaRuleRecord, Finding } from './engine';

/** Permissions of the commands of ADM-15 (x-permission in openapi.json). */
export const MANAGE_DOA_PERMISSION = 'adm.doa.manage';
export const APPROVE_DOA_PERMISSION = 'adm.doa.approve';

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;
export const DOCUMENT_TYPE_MAX_LENGTH = 60;
export const LEGAL_BASIS_MIN_LENGTH = 5;
export const MAX_RULES = 500;
export const LEVELS = [1, 2, 3, 4, 5] as const;

export type DoaStatus = 'Draft' | 'PendingApproval' | 'Published' | 'Superseded' | 'Rejected';
const STATUSES: readonly string[] = ['Draft', 'PendingApproval', 'Published', 'Superseded', 'Rejected'];

/** One matrix version with its rules, as the version reads of ADM-15 return it. */
export interface DoaMatrixView {
  id: string;
  revision: number;
  status: DoaStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  legalBasis: string;
  createdBy: string;
  lastEditedBy: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  version: number;
  rules: DoaRuleRecord[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function toRule(raw: unknown): DoaRuleRecord[] {
  if (!isRecord(raw) || typeof raw.id !== 'string') return [];
  return [
    {
      id: raw.id,
      document_type: text(raw.document_type),
      unit_id: text(raw.unit_id),
      include_subtree: raw.include_subtree !== false,
      amount_min_vnd: text(raw.amount_min_vnd),
      amount_max_vnd: textOrNull(raw.amount_max_vnd),
      approver_role_id: text(raw.approver_role_id),
      approval_levels: count(raw.approval_levels) || 1,
      requires_distinct_approvers: raw.requires_distinct_approvers !== false,
    },
  ];
}

/** Reads one row of a version read; a row without an id is not a version. */
export function toMatrix(raw: unknown): DoaMatrixView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    revision: count(raw.revision),
    status: STATUSES.includes(text(raw.status)) ? (raw.status as DoaStatus) : 'Draft',
    effectiveFrom: text(raw.effective_from),
    effectiveUntil: textOrNull(raw.effective_until),
    legalBasis: text(raw.legal_basis_ref),
    createdBy: text(raw.created_by),
    lastEditedBy: textOrNull(raw.last_edited_by),
    approvedBy: textOrNull(raw.approved_by),
    publishedAt: textOrNull(raw.published_at),
    version: count(raw.version),
    rules: Array.isArray(raw.rules) ? raw.rules.flatMap(toRule) : [],
  };
}

export interface RuleValue {
  /** Identity of the row in the form, so a row keeps its inputs when another is removed. */
  key: number;
  documentType: string;
  unitId: string;
  includeSubtree: boolean;
  min: string;
  /** Empty: the band has no upper end. */
  max: string;
  roleId: string;
  levels: number;
  distinct: boolean;
}

/** What the form holds. */
export interface DoaValues {
  effectiveFrom: string;
  effectiveUntil: string;
  legalBasis: string;
  rules: RuleValue[];
}

let nextKey = 1;
export const newRule = (changes: Partial<RuleValue> = {}): RuleValue => ({
  key: nextKey++,
  documentType: '',
  unitId: '',
  includeSubtree: true,
  min: '0',
  max: '',
  roleId: '',
  levels: 1,
  distinct: true,
  ...changes,
});

export const emptyValues = (): DoaValues => ({ effectiveFrom: '', effectiveUntil: '', legalBasis: '', rules: [newRule()] });

/** The form filled from a version, to write the next revision of it or to edit the draft. */
export function valuesOfMatrix(view: DoaMatrixView): DoaValues {
  return {
    effectiveFrom: view.effectiveFrom,
    effectiveUntil: view.effectiveUntil ?? '',
    legalBasis: view.legalBasis,
    rules: view.rules.map((rule) =>
      newRule({
        documentType: rule.document_type,
        unitId: rule.unit_id,
        includeSubtree: rule.include_subtree ?? true,
        min: rule.amount_min_vnd,
        max: rule.amount_max_vnd ?? '',
        roleId: rule.approver_role_id,
        levels: rule.approval_levels ?? 1,
        distinct: rule.requires_distinct_approvers ?? true,
      }),
    ),
  };
}

/** The rules of the form in the shape the findings and the request take. */
export const inputsOf = (values: DoaValues): DoaRuleInput[] =>
  values.rules.map((rule) => ({
    document_type: rule.documentType.trim(),
    unit_id: rule.unitId,
    include_subtree: rule.includeSubtree,
    amount_min_vnd: rule.min.trim(),
    amount_max_vnd: rule.max.trim() === '' ? null : rule.max.trim(),
    approver_role_id: rule.roleId,
    approval_levels: rule.levels,
    requires_distinct_approvers: rule.distinct,
  }));

/** The request body of `createDoaMatrixDraft` and `updateDoaMatrixDraft`. */
export function matrixBody(values: DoaValues) {
  return {
    effective_from: values.effectiveFrom,
    ...(values.effectiveUntil === '' ? {} : { effective_until: values.effectiveUntil }),
    legal_basis_ref: values.legalBasis.trim(),
    rules: inputsOf(values).map((rule) => ({
      document_type: rule.document_type,
      unit_id: rule.unit_id,
      include_subtree: rule.include_subtree ?? true,
      amount_min_vnd: rule.amount_min_vnd,
      ...(rule.amount_max_vnd === null || rule.amount_max_vnd === undefined ? {} : { amount_max_vnd: rule.amount_max_vnd }),
      approver_role_id: rule.approver_role_id,
      approval_levels: rule.approval_levels ?? 1,
      requires_distinct_approvers: rule.requires_distinct_approvers ?? true,
    })),
  };
}

export type HeaderField = 'effectiveFrom' | 'effectiveUntil' | 'legalBasis' | 'rules';
export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'order' | 'tooMany' | 'unit' | 'role';
export type HeaderErrors = Partial<Record<HeaderField, FieldProblem>>;
/** A problem of one row of the form, by the row's position. */
export type RuleErrors = Array<Partial<Record<'documentType' | 'unitId' | 'roleId', FieldProblem>>>;

/**
 * The rules the form can check before anything is sent: the dates, the legal basis, a kind of document, a unit and a role for each
 * row. The bands themselves are judged by `draftFindings` and `submitFindings`, whose answers the chart shows.
 */
export function validateForm(values: DoaValues): { header: HeaderErrors; rows: RuleErrors } {
  const header: HeaderErrors = {};
  if (values.effectiveFrom === '') header.effectiveFrom = 'required';
  if (values.effectiveUntil !== '' && values.effectiveFrom !== '' && values.effectiveUntil <= values.effectiveFrom) header.effectiveUntil = 'order';
  const basis = values.legalBasis.trim();
  if (basis === '') header.legalBasis = 'required';
  else if (basis.length < LEGAL_BASIS_MIN_LENGTH) header.legalBasis = 'tooShort';
  if (values.rules.length === 0) header.rules = 'required';
  else if (values.rules.length > MAX_RULES) header.rules = 'tooMany';
  const rows: RuleErrors = values.rules.map((rule) => {
    const row: RuleErrors[number] = {};
    if (rule.documentType.trim() === '') row.documentType = 'required';
    else if (rule.documentType.trim().length > DOCUMENT_TYPE_MAX_LENGTH) row.documentType = 'tooLong';
    if (rule.unitId === '') row.unitId = 'unit';
    if (rule.roleId === '') row.roleId = 'role';
    return row;
  });
  return { header, rows };
}

export const hasErrors = (errors: { header: HeaderErrors; rows: RuleErrors }): boolean =>
  Object.keys(errors.header).length > 0 || errors.rows.some((row) => Object.keys(row).length > 0);

/** The findings of the bands of the form: what blocks saving (`draft`) and what blocks submitting (`submit`, which includes the first). */
export function bandProblems(values: DoaValues): { draft: Finding[]; submit: Finding[] } {
  const rules = inputsOf(values);
  return { draft: draftFindings(rules), submit: submitFindings(rules) };
}

export type ProblemReason =
  | 'matrixInvalid'
  | 'selfApproval'
  | 'conflict'
  | 'notDraft'
  | 'stateInvalid'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The findings the server listed for DOA_MATRIX_INVALID (`errors`), in its order. */
  findings: Finding[];
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  DOA_MATRIX_INVALID: 'matrixInvalid',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'conflict',
  DOA_MATRIX_NOT_DRAFT: 'notDraft',
  DOA_STATE_INVALID: 'stateInvalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

function findingsOf(error: ApiError): Finding[] {
  const listed = error.extensions.errors;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.field !== 'string' || typeof entry.code !== 'string') return [];
    return [{ field: entry.field, code: entry.code }];
  });
}

/** Maps the error of a command of ADM-15 to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', findings: [] };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', findings: findingsOf(error) };
}
