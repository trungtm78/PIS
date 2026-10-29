import { ApiError } from '@machvon/api-client';

export const MAPPING_STATUSES = ['PROPOSED', 'CONFIRMED', 'REJECTED', 'RETIRED'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];
export const GATE_OUTCOMES = ['APPLIED', 'QUARANTINED'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];
export const RECON_RESULTS = ['MATCHED', 'WITHIN_TOLERANCE', 'DIFFERENT'] as const;
export type ReconResult = (typeof RECON_RESULTS)[number];
export const DIFFERENCE_KINDS = ['MISSING', 'TIMING', 'REVERSAL', 'MAPPING', 'AMOUNT'] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];

/** The units a source writes an amount in, as the server knows them (empty: dong). */
export const UNITS = ['', 'VND', 'THOUSAND_VND', 'MILLION_VND', 'BILLION_VND'] as const;
/** The two sources and the basis the server compares: the only ones there are, shown and sent as they are. */
export const RECON_SOURCE_A = 'PAY.treasury_transaction';
export const RECON_SOURCE_B = 'DIS.report_accepted';
export const RECON_BASIS = 'VND, ngày Kho bạc thanh toán';
export const DEFAULT_RECON_CODE = 'PAY-DIS-MONTH';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export interface MappingView {
  id: string;
  datasetId: string;
  datasetCode: string;
  sourceSystem: string;
  sourceField: string;
  targetField: string;
  transformRule: string | null;
  unit: string | null;
  status: MappingStatus;
  proposedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  version: number;
  canDecide: boolean;
}

export function toMapping(raw: unknown): MappingView | undefined {
  const row = record(raw);
  const dataset = record(row?.dataset);
  const status = oneOf(MAPPING_STATUSES, row?.status);
  const id = text(row?.id);
  const datasetId = text(dataset?.id);
  const sourceSystem = text(row?.source_system);
  const sourceField = text(row?.source_field);
  const targetField = text(row?.target_field);
  const version = count(row?.version);
  if (row === undefined || status === undefined || id === undefined || datasetId === undefined || sourceSystem === undefined || sourceField === undefined || targetField === undefined || version === undefined) return undefined;
  return {
    id,
    datasetId,
    datasetCode: text(dataset?.code) ?? '',
    sourceSystem,
    sourceField,
    targetField,
    transformRule: text(row.transform_rule) ?? null,
    unit: text(row.unit) ?? null,
    status,
    proposedByName: text(record(row.proposed_by)?.name) ?? null,
    decidedByName: text(record(row.decided_by)?.name) ?? null,
    decisionNote: text(row.decision_note) ?? null,
    createdAt: text(row.created_at) ?? '',
    version,
    canDecide: record(row.actions)?.decide === true,
  };
}

export interface GateView {
  id: string;
  datasetId: string;
  sourceSystem: string;
  batchRef: string;
  outcome: GateOutcome;
  reason: string | null;
  rowCount: number;
  /** The source fields that had no confirmed mapping, when the batch was kept out. */
  missing: string[];
  gatedAt: string;
}

export function toGate(raw: unknown): GateView | undefined {
  const row = record(raw);
  const outcome = oneOf(GATE_OUTCOMES, row?.outcome);
  const id = text(row?.id);
  const batchRef = text(row?.batch_ref);
  if (row === undefined || outcome === undefined || id === undefined || batchRef === undefined) return undefined;
  const fields = Array.isArray(row.fields) ? row.fields : [];
  return {
    id,
    datasetId: text(row.dataset_id) ?? '',
    sourceSystem: text(row.source_system) ?? '',
    batchRef,
    outcome,
    reason: text(row.reason) ?? null,
    rowCount: count(row.row_count) ?? 0,
    missing: fields.flatMap((field) => {
      const entry = record(field);
      return entry?.missing === true && typeof entry.source_field === 'string' ? [entry.source_field] : [];
    }),
    gatedAt: text(row.gated_at) ?? '',
  };
}

export interface DifferenceView {
  key: string;
  kind: DifferenceKind;
  side: 'A_ONLY' | 'B_ONLY' | 'BOTH';
  amountA: string;
  amountB: string;
  difference: string;
}

export interface ReconView {
  id: string;
  reconCode: string;
  asOfPeriod: string;
  sourceA: string;
  sourceB: string;
  basis: string;
  countA: number;
  countB: number;
  totalA: string;
  totalB: string;
  difference: string;
  tolerance: string;
  result: ReconResult;
  byKind: Record<DifferenceKind, number>;
  differencesCount: number;
  differencesTruncated: boolean;
  differences: DifferenceView[];
  ownerName: string | null;
  incidentId: string | null;
  createdAt: string;
}

const amount = (value: unknown): string | undefined => (typeof value === 'string' && /^-?\d{1,24}$/.test(value) ? value : undefined);

export function toRecon(raw: unknown): ReconView | undefined {
  const row = record(raw);
  const result = oneOf(RECON_RESULTS, row?.result);
  const id = text(row?.id);
  const totalA = amount(row?.total_a_vnd);
  const totalB = amount(row?.total_b_vnd);
  if (row === undefined || result === undefined || id === undefined || totalA === undefined || totalB === undefined) return undefined;
  const kinds = record(row.by_kind) ?? {};
  const byKind = Object.fromEntries(DIFFERENCE_KINDS.map((kind) => [kind, count(kinds[kind]) ?? 0])) as Record<DifferenceKind, number>;
  const differences = (Array.isArray(row.differences) ? row.differences : []).flatMap((entry): DifferenceView[] => {
    const item = record(entry);
    const kind = oneOf(DIFFERENCE_KINDS, item?.kind);
    const side = oneOf(['A_ONLY', 'B_ONLY', 'BOTH'] as const, item?.side);
    const key = text(item?.key);
    const a = amount(item?.amount_a_vnd);
    const b = amount(item?.amount_b_vnd);
    const delta = amount(item?.difference_vnd);
    return kind === undefined || side === undefined || key === undefined || a === undefined || b === undefined || delta === undefined ? [] : [{ key, kind, side, amountA: a, amountB: b, difference: delta }];
  });
  return {
    id,
    reconCode: text(row.recon_code) ?? '',
    asOfPeriod: text(row.as_of_period) ?? '',
    sourceA: text(row.source_a) ?? RECON_SOURCE_A,
    sourceB: text(row.source_b) ?? RECON_SOURCE_B,
    basis: text(row.basis) ?? RECON_BASIS,
    countA: count(row.count_a) ?? 0,
    countB: count(row.count_b) ?? 0,
    totalA,
    totalB,
    difference: amount(row.difference_vnd) ?? '0',
    tolerance: amount(row.tolerance_vnd) ?? '0',
    result,
    byKind,
    differencesCount: count(row.differences_count) ?? differences.length,
    differencesTruncated: row.differences_truncated === true,
    differences,
    ownerName: text(record(row.owner)?.name) ?? null,
    incidentId: text(row.incident_id) ?? null,
    createdAt: text(row.created_at) ?? '',
  };
}

/** The id of what a command made, from its answer. */
export function resourceIdOf(raw: unknown): string | undefined {
  return text(record(raw)?.resource_id);
}

/** A whole number of dong as the reader writes it: groups of three, the sign kept. Never rounded, never turned into a float. */
export function formatDong(value: string, locale: string): string {
  const number = BigInt(value);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(number);
}

// ---- the forms --------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooShort' | 'invalidId' | 'invalidPeriod' | 'invalidAmount';

export interface ProposeForm {
  datasetId: string;
  sourceSystem: string;
  sourceField: string;
  targetField: string;
  transformRule: string;
  unit: string;
}

export const emptyPropose = (datasetId = ''): ProposeForm => ({ datasetId, sourceSystem: '', sourceField: '', targetField: '', transformRule: '', unit: '' });

export function validatePropose(form: ProposeForm): Partial<Record<keyof ProposeForm, FormProblem>> {
  const problems: Partial<Record<keyof ProposeForm, FormProblem>> = {};
  if (!UUID.test(form.datasetId)) problems.datasetId = 'invalidId';
  if (form.sourceSystem.trim().length < 2) problems.sourceSystem = form.sourceSystem.trim() === '' ? 'required' : 'tooShort';
  if (form.sourceField.trim() === '') problems.sourceField = 'required';
  if (form.targetField.trim() === '') problems.targetField = 'required';
  return problems;
}

export const proposeBody = (form: ProposeForm) => ({
  dataset_id: form.datasetId,
  source_system: form.sourceSystem.trim(),
  source_field: form.sourceField.trim(),
  target_field: form.targetField.trim(),
  ...(form.transformRule.trim() === '' ? {} : { transform_rule: form.transformRule.trim() }),
  ...(form.unit === '' ? {} : { unit: form.unit }),
});

export interface DecideForm {
  decision: 'CONFIRMED' | 'REJECTED';
  note: string;
}

export const emptyDecide = (decision: DecideForm['decision']): DecideForm => ({ decision, note: '' });
export const decideBody = (form: DecideForm) => ({ decision: form.decision, ...(form.note.trim() === '' ? {} : { note: form.note.trim() }) });

export interface ReconForm {
  reconCode: string;
  asOfPeriod: string;
  datasetId: string;
  toleranceVnd: string;
}

export const emptyRecon = (): ReconForm => ({ reconCode: DEFAULT_RECON_CODE, asOfPeriod: '', datasetId: '', toleranceVnd: '0' });

export function validateRecon(form: ReconForm): Partial<Record<keyof ReconForm, FormProblem>> {
  const problems: Partial<Record<keyof ReconForm, FormProblem>> = {};
  if (form.reconCode.trim().length < 2) problems.reconCode = form.reconCode.trim() === '' ? 'required' : 'tooShort';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.asOfPeriod.trim())) problems.asOfPeriod = form.asOfPeriod.trim() === '' ? 'required' : 'invalidPeriod';
  if (form.datasetId !== '' && !UUID.test(form.datasetId)) problems.datasetId = 'invalidId';
  if (!/^\d{1,24}$/.test(form.toleranceVnd.trim())) problems.toleranceVnd = form.toleranceVnd.trim() === '' ? 'required' : 'invalidAmount';
  return problems;
}

export const reconBody = (form: ReconForm) => ({
  recon_code: form.reconCode.trim(),
  source_a: RECON_SOURCE_A,
  source_b: RECON_SOURCE_B,
  as_of_period: form.asOfPeriod.trim(),
  basis: RECON_BASIS,
  tolerance_vnd: form.toleranceVnd.trim(),
  ...(form.datasetId === '' ? {} : { dataset_id: form.datasetId }),
});

// ---- the refusals -----------------------------------------------------------------------------------------------------------------

export type Problem = 'unit' | 'datasetMissing' | 'duplicate' | 'selfApproval' | 'stateInvalid' | 'basis' | 'noClosedMonth' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'MAPPING_DUPLICATE':
      return 'duplicate';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'MAPPING_STATE_INVALID':
      return 'stateInvalid';
    case 'BASIS_MISMATCH':
      return 'basis';
    case 'SNAPSHOT_NOT_FOUND':
      return 'noClosedMonth';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      // The two fields the server judges on its own say which they are.
      if (error.detail === 'unit') return 'unit';
      if (error.detail === 'dataset_id') return 'datasetMissing';
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}
