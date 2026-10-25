import { ApiError } from '@machvon/api-client';
import type { BoqLine } from '../boq-model';
import { MAX_TEXT, describeProblem as describeBaseProblem, isUuid } from '../change/model';
import type { Problem } from '../change/model';

export const MEASUREMENT_PATH = '/ctr/ctr-10';

/** The permissions of the commands (x-permission in openapi.json); the server judges them again, with the scope and the people. */
export const RECORD_PERMISSION = 'measurement.record';

/** The measurements of a contract (CTR-10). */
export const measurementLink = (contractId: string): string => `${MEASUREMENT_PATH}?${new URLSearchParams({ contract: contractId }).toString()}`;

export const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type MeasurementStatus = (typeof STATUSES)[number];

export const DECISIONS = ['approve', 'return', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

const MAX_EVIDENCE = 50;
const SCALE = 6;
const MICRO = 10n ** BigInt(SCALE);
const QUANTITY = /^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/;

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export interface MeasurementActions {
  submit: boolean;
  decide: boolean;
  correct: boolean;
}

export interface Measurement {
  id: string;
  contract: { id: string; code: string; status: string };
  projectId: string;
  contractRevisionId: string;
  contractRevisionNo: number;
  boqItem: { id: string; businessKey: string; description: string; unitCode: string };
  /** The quantity of the item in the revision it was recorded under; exact decimal text. */
  boqQuantity: string;
  /** What is left of the quantity of the item in the revision in force after everything recorded for it. */
  remainingQuantity: string;
  period: { id: string; code: string };
  quantityPeriod: string;
  quantityCumulative: string;
  revision: number;
  status: MeasurementStatus;
  evidenceIds: string[];
  referenceNo: string | null;
  correctionOfId: string | null;
  correctionReason: string | null;
  createdBy: string;
  createdAt: string;
  actions: MeasurementActions;
  version: number;
}

export function toMeasurement(raw: unknown): Measurement | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const item = asRecord(row?.boq_item);
  const period = asRecord(row?.period);
  const id = text(row?.id);
  const status = text(row?.status);
  const version = whole(row?.version);
  const contractId = text(contract?.id);
  const itemId = text(item?.id);
  const periodId = text(period?.id);
  if (row === undefined || id === undefined || version === undefined || contractId === undefined || itemId === undefined || periodId === undefined || !(STATUSES as readonly string[]).includes(status ?? '')) return undefined;
  const actions = asRecord(row.actions);
  return {
    id,
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '' },
    projectId: text(row.project_id) ?? '',
    contractRevisionId: text(row.contract_revision_id) ?? '',
    contractRevisionNo: whole(row.contract_revision_no) ?? 0,
    boqItem: { id: itemId, businessKey: text(item?.business_key) ?? '', description: text(item?.description) ?? '', unitCode: text(item?.unit_code) ?? '' },
    boqQuantity: text(row.boq_quantity) ?? '0',
    remainingQuantity: text(row.remaining_quantity) ?? '0',
    period: { id: periodId, code: text(period?.code) ?? '' },
    quantityPeriod: text(row.quantity_period) ?? '0',
    quantityCumulative: text(row.quantity_cumulative) ?? '0',
    revision: whole(row.revision) ?? 1,
    status: status as MeasurementStatus,
    evidenceIds: (Array.isArray(row.evidence_refs) ? row.evidence_refs : []).flatMap((reference) => text(asRecord(reference)?.document_version_id) ?? []),
    referenceNo: nullableText(row.reference_no),
    correctionOfId: nullableText(row.correction_of_id),
    correctionReason: nullableText(row.correction_reason),
    createdBy: text(row.created_by) ?? '',
    createdAt: text(row.created_at) ?? '',
    actions: { submit: actions?.submit === true, decide: actions?.decide === true, correct: actions?.correct === true },
    version,
  };
}

// ---- quantities ---------------------------------------------------------------------------------------------------------------

/** An exact decimal quantity as a count of millionths; undefined when the text is not a quantity. */
export function micros(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!QUANTITY.test(trimmed)) return undefined;
  const negative = trimmed.startsWith('-');
  const [whole_, fraction = ''] = trimmed.replace('-', '').split('.');
  const amount = BigInt(whole_ ?? '0') * MICRO + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -amount : amount;
}

/** A quantity from millionths: the digits are grouped by the language of the screen, the fraction keeps the digits that matter, and nothing is turned into a float. */
export function quantityText(value: string | bigint, locale: string): string {
  const amount = typeof value === 'bigint' ? value : micros(value);
  if (amount === undefined) return typeof value === 'string' ? value : '';
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const integer = new Intl.NumberFormat(locale).format(magnitude / MICRO);
  const fraction = (magnitude % MICRO).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const decimal = new Intl.NumberFormat(locale).format(1.1).charAt(1);
  return `${negative ? '-' : ''}${integer}${fraction === '' ? '' : `${decimal}${fraction}`}`;
}

// ---- the entry grid -----------------------------------------------------------------------------------------------------------

export interface ItemRow {
  line: BoqLine;
  /** The stable item the quantity is recorded against; null when the server does not show it to the caller (no right to record). */
  itemId: string | null;
  /** The quantity of the item already approved, as millionths. */
  approved: bigint;
  /** What is left of the quantity of the item after all that is recorded for it (draft, sent, approved); the quantity of the line when nothing is. */
  remaining: string;
}

/** One row for each item of the revision in force: its quantity, what has been approved, and what is left. */
export function itemRows(lines: readonly BoqLine[], measurements: readonly Measurement[]): ItemRow[] {
  return lines.map((line) => {
    const ofItem = measurements.filter((measurement) => measurement.boqItem.businessKey === line.businessKey);
    const approved = ofItem.filter((measurement) => measurement.status === 'APPROVED').reduce((sum, measurement) => sum + (micros(measurement.quantityPeriod) ?? 0n), 0n);
    // Every measurement of the item carries the quantity that is left now; with none, the whole quantity is left.
    return { line, itemId: line.boqItemId, approved, remaining: ofItem[0]?.remainingQuantity ?? line.quantity };
  });
}

// ---- the forms ----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'quantity' | 'positive' | 'uuid' | 'tooMany';

export const evidenceIds = (text_: string): string[] =>
  text_
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

const textProblem = (value: string): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > MAX_TEXT ? 'tooLong' : undefined);

function evidenceProblem(value: string, required: boolean): FormProblem | undefined {
  const ids = evidenceIds(value);
  if (ids.length === 0) return required ? 'required' : undefined;
  if (ids.length > MAX_EVIDENCE) return 'tooMany';
  return ids.every(isUuid) ? undefined : 'uuid';
}

export interface RecordForm {
  boqItemId: string;
  periodId: string;
  quantity: string;
  referenceNo: string;
  /** Said only when the number of the record is already used in the contract. */
  overrideReason: string;
  /** One identifier of a version of a file per line, or separated by commas. */
  evidence: string;
}

export const emptyRecord = (boqItemId: string): RecordForm => ({ boqItemId, periodId: '', quantity: '', referenceNo: '', overrideReason: '', evidence: '' });

export function validateRecord(form: RecordForm): Partial<Record<keyof RecordForm, FormProblem>> {
  const problems: Partial<Record<keyof RecordForm, FormProblem>> = {};
  if (!isUuid(form.boqItemId)) problems.boqItemId = 'required';
  if (!isUuid(form.periodId)) problems.periodId = form.periodId.trim() === '' ? 'required' : 'uuid';
  const quantity = micros(form.quantity);
  if (form.quantity.trim() === '') problems.quantity = 'required';
  else if (quantity === undefined) problems.quantity = 'quantity';
  else if (quantity <= 0n) problems.quantity = 'positive';
  const reference = textProblem(form.referenceNo);
  if (reference !== undefined) problems.referenceNo = reference;
  if (form.overrideReason.trim().length > MAX_TEXT) problems.overrideReason = 'tooLong';
  const evidence = evidenceProblem(form.evidence, false);
  if (evidence !== undefined) problems.evidence = evidence;
  return problems;
}

export interface RecordBody {
  contract_revision_id: string;
  boq_item_id: string;
  period_id: string;
  quantity_period: string;
  reference_no: string;
  duplicate_override_reason?: string;
  evidence_refs: Array<{ document_version_id: string }>;
}

export function recordBody(form: RecordForm, revisionId: string): RecordBody {
  const override = form.overrideReason.trim();
  return {
    contract_revision_id: revisionId,
    boq_item_id: form.boqItemId.trim().toLowerCase(),
    period_id: form.periodId.trim().toLowerCase(),
    quantity_period: form.quantity.trim(),
    reference_no: form.referenceNo.trim(),
    ...(override === '' ? {} : { duplicate_override_reason: override }),
    evidence_refs: evidenceIds(form.evidence).map((document_version_id) => ({ document_version_id })),
  };
}

export interface CorrectForm {
  quantity: string;
  reason: string;
  evidence: string;
}

export const emptyCorrect = (current: string): CorrectForm => ({ quantity: current, reason: '', evidence: '' });

export function validateCorrect(form: CorrectForm): Partial<Record<keyof CorrectForm, FormProblem>> {
  const problems: Partial<Record<keyof CorrectForm, FormProblem>> = {};
  const quantity = micros(form.quantity);
  if (form.quantity.trim() === '') problems.quantity = 'required';
  else if (quantity === undefined || quantity < 0n) problems.quantity = 'quantity';
  const reason = textProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const evidence = evidenceProblem(form.evidence, true);
  if (evidence !== undefined) problems.evidence = evidence;
  return problems;
}

export interface CorrectBody {
  quantity_period: string;
  correction_reason: string;
  evidence_refs: Array<{ document_version_id: string }>;
}

export const correctBody = (form: CorrectForm): CorrectBody => ({
  quantity_period: form.quantity.trim(),
  correction_reason: form.reason.trim(),
  evidence_refs: evidenceIds(form.evidence).map((document_version_id) => ({ document_version_id })),
});

export interface DecideForm {
  decision: '' | Decision;
  reason: string;
  evidence: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', reason: '', evidence: '' };

export function validateDecide(form: DecideForm): Partial<Record<keyof DecideForm, FormProblem | 'choose'>> {
  const problems: Partial<Record<keyof DecideForm, FormProblem | 'choose'>> = {};
  if (form.decision === '') problems.decision = 'choose';
  const reason = textProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const evidence = evidenceProblem(form.evidence, false);
  if (evidence !== undefined) problems.evidence = evidence;
  return problems;
}

export interface DecideBody {
  decision: Decision;
  reason: string;
  evidence_ids: string[];
}

export const decideBody = (form: DecideForm, decision: Decision): DecideBody => ({ decision, reason: form.reason.trim(), evidence_ids: evidenceIds(form.evidence) });

// ---- refusals ------------------------------------------------------------------------------------------------------------------

export type MeasurementProblem =
  | Problem
  | 'exceeds'
  | 'decrease'
  | 'duplicateReference'
  | 'revisionNotEffective'
  | 'permitGate'
  | 'inAcceptance'
  | 'evidenceRequired'
  | 'periodTaken'
  | 'measurementState';

export interface MeasurementProblemView {
  problem: MeasurementProblem;
  /** What is left of the quantity of the item, when the server said it. */
  remaining: string | undefined;
}

/** The refusal of the server as the screen words it: the codes of this story first, the rest as the chain of changes words them. */
export function describeMeasurementProblem(error: unknown): MeasurementProblemView {
  const view = (problem: MeasurementProblem): MeasurementProblemView => ({ problem, remaining: undefined });
  if (!(error instanceof ApiError)) return view('general');
  const extensions = error.extensions;
  switch (error.code) {
    case 'QUANTITY_EXCEEDS_BOQ':
      return { problem: 'exceeds', remaining: typeof extensions.remaining_quantity === 'string' ? extensions.remaining_quantity : undefined };
    case 'CUMULATIVE_DECREASE_WITHOUT_CORRECTION':
      return view('decrease');
    case 'MEASUREMENT_REFERENCE_DUPLICATE':
      return view('duplicateReference');
    case 'REVISION_NOT_EFFECTIVE':
      return view('revisionNotEffective');
    case 'PERMIT_GATE_BLOCKED':
      return view('permitGate');
    case 'MEASUREMENT_IN_ACTIVE_ACCEPTANCE':
      return view('inAcceptance');
    case 'EVIDENCE_REQUIRED':
      return view('evidenceRequired');
    case 'MEASUREMENT_STATE_INVALID':
      return view(extensions.reason === 'PERIOD_ALREADY_MEASURED' ? 'periodTaken' : 'measurementState');
    default:
      return { problem: describeBaseProblem(error).problem, remaining: undefined };
  }
}

/** Whether the caller may record a quantity: the permission is held (or not yet known) and the session is not read-only. */
export const mayRecord = (permissions: readonly string[] | undefined, mode: string | undefined): boolean => (permissions === undefined || permissions.includes(RECORD_PERMISSION)) && mode !== 'READ_ONLY';
