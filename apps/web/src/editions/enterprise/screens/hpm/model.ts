import type { components } from '@machvon/contracts';
import type { Tone } from '../../../../ui';
import { shaped } from '../shared/format';

/** HPM-01 and HPM-02: the push of the issued reports to HPM and the corrections that let an accepted period be replaced. Everything rests on a file writer that stands for HPM: PENDING-EXTERNAL. */
export type Connection = components['schemas']['HpmConnection'];
export type Push = components['schemas']['HpmPush'];
export type PushPage = components['schemas']['HpmPushPage'];
export type PushResult = components['schemas']['HpmPushResult'];
export type Correction = components['schemas']['HpmCorrection'];
export type CorrectionPage = components['schemas']['HpmCorrectionPage'];
export type PushStatus = Push['status'];
export type CorrectionState = Correction['state'];

export const CONNECTOR_CODE = 'hpm.reports';
export const PERIOD_PATTERN = /^\d{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$/;
export const LAYOUT_PATTERN = /^[A-Z][A-Z0-9_-]{1,59}$/;
export const SHA_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PAGE_SIZE = 25;
export const PUSH_STATUSES: readonly PushStatus[] = ['PENDING', 'WRITTEN', 'FAILED', 'ACCEPTED', 'REJECTED'];
export const CORRECTION_STATES: readonly CorrectionState[] = ['PROPOSED', 'APPROVED', 'REJECTED', 'CONSUMED'];

// ---- reading the answer ----------------------------------------------------------------------------------------------------------------------------------------------

export const toConnection = (raw: unknown): Connection =>
  shaped<Connection>(raw, 'HPM connection', ['supported_formats', 'pending_external', 'accepted_series', 'history'], ['api_adapter', 'health', 'counts', 'actions']);

export const toPushPage = (raw: unknown): PushPage => shaped<PushPage>(raw, 'HPM push page', ['items'], []);
export const toCorrectionPage = (raw: unknown): CorrectionPage => shaped<CorrectionPage>(raw, 'HPM correction page', ['items'], []);
export const toPushResult = (raw: unknown): PushResult => shaped<PushResult>(raw, 'HPM push result', [], ['push']);

// ---- the state of a push -----------------------------------------------------------------------------------------------------------------------------------------------

const PUSH_TONE: Readonly<Record<PushStatus, Tone>> = { PENDING: 'neutral', WRITTEN: 'info', FAILED: 'danger', ACCEPTED: 'success', REJECTED: 'danger' };
const PUSH_ICON: Readonly<Record<PushStatus, string>> = { PENDING: '○', WRITTEN: '▤', FAILED: '!', ACCEPTED: '✓', REJECTED: '✕' };
export const pushTone = (status: PushStatus): Tone => PUSH_TONE[status];
export const pushIcon = (status: PushStatus): string => PUSH_ICON[status];

const CORRECTION_TONE: Readonly<Record<CorrectionState, Tone>> = { PROPOSED: 'info', APPROVED: 'success', REJECTED: 'danger', CONSUMED: 'neutral' };
export const correctionTone = (state: CorrectionState): Tone => CORRECTION_TONE[state];

// ---- the form of a push ------------------------------------------------------------------------------------------------------------------------------------------------

export interface PushForm {
  layoutCode: string;
  period: string;
  revision: string;
  sha256: string;
  fileObjectKey: string;
  /** The issued copy of the report engine: when it is named the copy holds the file, so the key of a file is not asked. */
  issueId: string;
  correctionId: string;
}

export const EMPTY_PUSH_FORM: PushForm = { layoutCode: '', period: '', revision: '1', sha256: '', fileObjectKey: '', issueId: '', correctionId: '' };

export type PushField = 'layoutCode' | 'period' | 'revision' | 'sha256' | 'fileObjectKey' | 'issueId' | 'correctionId';
export type FieldProblem = 'REQUIRED' | 'FORMAT';

/** The fields of the form that the contract would refuse, found before anything is sent. */
export function pushProblems(form: PushForm): Partial<Record<PushField, FieldProblem>> {
  const found: Partial<Record<PushField, FieldProblem>> = {};
  const check = (field: PushField, value: string, pattern: RegExp): void => {
    if (value.trim() === '') found[field] = 'REQUIRED';
    else if (!pattern.test(value.trim())) found[field] = 'FORMAT';
  };
  check('layoutCode', form.layoutCode, LAYOUT_PATTERN);
  check('period', form.period, PERIOD_PATTERN);
  check('revision', form.revision, /^[1-9]\d{0,3}$|^10000$/);
  check('sha256', form.sha256, SHA_PATTERN);
  if (form.issueId.trim() !== '' && !UUID_PATTERN.test(form.issueId.trim())) found.issueId = 'FORMAT';
  if (form.issueId.trim() === '' && form.fileObjectKey.trim().length < 10) found.fileObjectKey = form.fileObjectKey.trim() === '' ? 'REQUIRED' : 'FORMAT';
  if (form.correctionId.trim() !== '' && !UUID_PATTERN.test(form.correctionId.trim())) found.correctionId = 'FORMAT';
  return found;
}

/** The body of the command from a valid form (the correction only when one is named). */
export function pushBody(form: PushForm) {
  return {
    layout_code: form.layoutCode.trim(),
    period: form.period.trim(),
    revision: Number(form.revision),
    sha256: form.sha256.trim(),
    ...(form.fileObjectKey.trim() === '' ? {} : { file_object_key: form.fileObjectKey.trim() }),
    ...(form.issueId.trim() === '' ? {} : { issue_id: form.issueId.trim().toLowerCase() }),
    ...(form.correctionId.trim() === '' ? {} : { correction_id: form.correctionId.trim().toLowerCase() }),
  };
}

export interface CorrectionForm {
  layoutCode: string;
  period: string;
  fromRevision: string;
  periodReopenId: string;
  reason: string;
}

export const EMPTY_CORRECTION_FORM: CorrectionForm = { layoutCode: '', period: '', fromRevision: '1', periodReopenId: '', reason: '' };
export type CorrectionField = 'layoutCode' | 'period' | 'fromRevision' | 'periodReopenId' | 'reason';

export function correctionProblems(form: CorrectionForm): Partial<Record<CorrectionField, FieldProblem>> {
  const found: Partial<Record<CorrectionField, FieldProblem>> = {};
  const check = (field: CorrectionField, value: string, pattern: RegExp): void => {
    if (value.trim() === '') found[field] = 'REQUIRED';
    else if (!pattern.test(value.trim())) found[field] = 'FORMAT';
  };
  check('layoutCode', form.layoutCode, LAYOUT_PATTERN);
  check('period', form.period, PERIOD_PATTERN);
  check('fromRevision', form.fromRevision, /^[1-9]\d{0,3}$|^10000$/);
  check('periodReopenId', form.periodReopenId, UUID_PATTERN);
  if (form.reason.trim() === '') found.reason = 'REQUIRED';
  else if (form.reason.trim().length < 10) found.reason = 'FORMAT';
  return found;
}

export function correctionBody(form: CorrectionForm) {
  return { layout_code: form.layoutCode.trim(), period: form.period.trim(), from_revision: Number(form.fromRevision), period_reopen_id: form.periodReopenId.trim().toLowerCase(), reason: form.reason.trim() };
}

/** The length the screen asks of a note when the receiver rejects a push (the contract asks ten characters). */
export const MIN_NOTE = 10;

export interface ReceiptForm {
  outcome: 'ACCEPTED' | 'REJECTED';
  reference: string;
  note: string;
}

export const EMPTY_RECEIPT_FORM: ReceiptForm = { outcome: 'ACCEPTED', reference: '', note: '' };
export type ReceiptField = 'reference' | 'note';

export function receiptProblems(form: ReceiptForm, demo: boolean): Partial<Record<ReceiptField | 'outcome', FieldProblem>> {
  const found: Partial<Record<ReceiptField | 'outcome', FieldProblem>> = {};
  if (form.reference.trim() === '') found.reference = 'REQUIRED';
  if (form.outcome === 'REJECTED' && form.note.trim().length < MIN_NOTE) found.note = form.note.trim() === '' ? 'REQUIRED' : 'FORMAT';
  // A copy made on a DEMO form is shown, never accepted (R18).
  if (demo && form.outcome === 'ACCEPTED') found.outcome = 'FORMAT';
  return found;
}

/** The pushes that need a person now: failed ones to retry and written ones that wait for a receipt. */
export const needsAttention = (rows: readonly Push[]): { failed: number; waiting: number } => ({ failed: rows.filter((row) => row.status === 'FAILED').length, waiting: rows.filter((row) => row.status === 'WRITTEN').length });

export const isDemo = (push: Push): boolean => push.form_status === 'DEMO';

/** The status filter of the log: only a status the contract knows. */
export const statusFilterOf = (value: string): PushStatus | undefined => PUSH_STATUSES.find((status) => status === value);

export type PushBody = ReturnType<typeof pushBody>;
export type CorrectionBody = ReturnType<typeof correctionBody>;
