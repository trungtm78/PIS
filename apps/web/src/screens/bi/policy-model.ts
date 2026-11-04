import { ApiError } from '@machvon/api-client';

export const POLICY_PERMISSION = 'bi.policy.manage';
export const GRANTEE_KINDS = ['ROLE', 'UNIT_TREE', 'MEMBERSHIP'] as const;
export type GranteeKind = (typeof GRANTEE_KINDS)[number];
export const POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const includes = <T extends string>(list: readonly T[], value: string | undefined): value is T => value !== undefined && (list as readonly string[]).includes(value);

export interface Policy {
  id: string;
  datasetId: string;
  revision: number;
  granteeKind: GranteeKind;
  granteeRefId: string;
  predicate: Raw;
  columnMasks: Record<string, string>;
  hiddenColumns: string[];
  status: PolicyStatus;
  approvedBy: string | null;
}

/** A policy as the screen reads it; an entry that lacks what the screen needs is left out, never guessed. */
export function toPolicy(raw: unknown): Policy | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const datasetId = text(row?.dataset_id);
  const kind = text(row?.grantee_kind);
  const ref = text(row?.grantee_ref_id);
  const status = text(row?.status);
  const predicate = asRecord(row?.row_predicate_ast);
  const masks = asRecord(row?.column_masks);
  if (row === undefined || id === undefined || datasetId === undefined || ref === undefined || predicate === undefined || masks === undefined || typeof row.revision !== 'number' || !includes(GRANTEE_KINDS, kind) || !includes(POLICY_STATUSES, status)) return undefined;
  const modes: Record<string, string> = {};
  for (const [column, mode] of Object.entries(masks)) if (typeof mode === 'string') modes[column] = mode;
  return {
    id,
    datasetId,
    revision: row.revision,
    granteeKind: kind,
    granteeRefId: ref,
    predicate,
    columnMasks: modes,
    hiddenColumns: Object.entries(modes).filter(([, mode]) => mode === 'HIDE').map(([column]) => column).sort(),
    status,
    approvedBy: text(row.approved_by) ?? null,
  };
}

const OPERATORS: Readonly<Record<string, string>> = { eq: '=', ne: '≠' };

/** A predicate written as a condition a person reads: `unit in scope AND fund ∈ (NSTW)`; what the grammar does not have is a question mark. */
export function predicateText(node: Raw, scope: string): string {
  const op = text(node.op);
  const args = Array.isArray(node.args) ? node.args.map((child) => asRecord(child) ?? {}) : [];
  if (op === 'unit_in_scope') return scope;
  if (op !== undefined && OPERATORS[op] !== undefined && typeof node.field === 'string') return `${node.field} ${OPERATORS[op]} ${String(node.value)}`;
  if (op === 'in' && typeof node.field === 'string' && Array.isArray(node.values)) return `${node.field} ∈ (${node.values.map(String).join(', ')})`;
  if ((op === 'and' || op === 'or') && args.length >= 2) return `(${args.map((child) => predicateText(child, scope)).join(op === 'and' ? ' AND ' : ' OR ')})`;
  if (op === 'not' && args.length === 1) return `NOT ${predicateText(args[0] as Raw, scope)}`;
  return '?';
}

export interface PolicyValues {
  datasetId: string;
  granteeKind: GranteeKind;
  granteeRefId: string;
  /** Only the rows of the units the person has in scope. */
  inScope: boolean;
  /** An extra condition on one dimension: the field and the values it may have (separated by commas); empty for none. */
  conditionField: string;
  conditionValues: string;
  /** Columns hidden (HIDE) and masked (MASK), separated by commas. */
  hiddenColumns: string;
  maskedColumns: string;
}

export const EMPTY_POLICY: PolicyValues = { datasetId: '', granteeKind: 'ROLE', granteeRefId: '', inScope: true, conditionField: '', conditionValues: '', hiddenColumns: '', maskedColumns: '' };

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

export type PolicyProblemKind = 'required' | 'invalidId' | 'invalidName' | 'needsCondition' | 'bothMasks';
export type PolicyErrors = Partial<Record<'datasetId' | 'granteeRefId' | 'condition' | 'conditionValues' | 'hiddenColumns' | 'maskedColumns', PolicyProblemKind>>;

export function validatePolicy(values: PolicyValues): PolicyErrors {
  const errors: PolicyErrors = {};
  if (values.datasetId === '') errors.datasetId = 'required';
  if (!UUID.test(values.granteeRefId.trim())) errors.granteeRefId = values.granteeRefId.trim() === '' ? 'required' : 'invalidId';
  const hasField = values.conditionField.trim() !== '';
  const hasValues = list(values.conditionValues).length > 0;
  if (hasField && !NAME.test(values.conditionField.trim())) errors.condition = 'invalidName';
  else if (hasField !== hasValues) errors[hasField ? 'conditionValues' : 'condition'] = 'needsCondition';
  else if (!values.inScope && !hasField) errors.condition = 'needsCondition';
  const hidden = list(values.hiddenColumns);
  const masked = list(values.maskedColumns);
  if (!hidden.every((column) => NAME.test(column))) errors.hiddenColumns = 'invalidName';
  if (!masked.every((column) => NAME.test(column))) errors.maskedColumns = 'invalidName';
  else if (hidden.some((column) => masked.includes(column))) errors.maskedColumns = 'bothMasks';
  return errors;
}

/** The body of createBiAccessPolicy: the predicate is built from the choices, so a node outside the grammar cannot be typed; the server judges again. */
export function policyBody(values: PolicyValues) {
  const parts: Raw[] = [];
  if (values.inScope) parts.push({ op: 'unit_in_scope' });
  if (values.conditionField.trim() !== '') parts.push({ op: 'in', field: values.conditionField.trim(), values: list(values.conditionValues) });
  const predicate = parts.length === 1 ? (parts[0] as Raw) : { op: 'and', args: parts };
  const masks: Record<string, string> = {};
  for (const column of list(values.maskedColumns)) masks[column] = 'MASK';
  for (const column of list(values.hiddenColumns)) masks[column] = 'HIDE';
  return {
    dataset_id: values.datasetId,
    grantee_kind: values.granteeKind,
    grantee_ref_id: values.granteeRefId.trim().toLowerCase(),
    row_predicate_ast: predicate as Record<string, never>,
    column_masks: masks as Record<string, never>,
  };
}

export type PolicyReason = 'predicate' | 'dimension' | 'invalid' | 'denied' | 'session' | 'general';
const REASON_BY_CODE: Readonly<Record<string, PolicyReason>> = {
  PREDICATE_NOT_ALLOWED: 'predicate',
  DIMENSION_NOT_IN_DATASET: 'dimension',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

export function describePolicyProblem(error: unknown): { reason: PolicyReason; field: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', field: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail ?? '' };
}
