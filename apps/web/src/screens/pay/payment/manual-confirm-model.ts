import { ApiError } from '@machvon/api-client';
import { describeProblem } from './model';
import type { Problem } from './model';

/** The right to confirm a Treasury payment by hand (the operation `confirmTreasuryManually`). */
export const MANUAL_CONFIRM_PERMISSION = 'treasury.confirm_manual';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ManualConfirmForm {
  documentNo: string;
  documentDate: string;
  amountVnd: string;
  /** A local date and time written in the form field. */
  confirmedAt: string;
  evidenceVersionId: string;
}

export type ManualConfirmField = keyof ManualConfirmForm;
export type ManualConfirmProblem = 'required' | 'amount' | 'day' | 'future' | 'instant' | 'uuid' | 'long';

export const emptyManualConfirm = (amountVnd: string): ManualConfirmForm => ({ documentNo: '', documentDate: '', amountVnd, confirmedAt: '', evidenceVersionId: '' });

const isRealDay = (value: string): boolean => {
  const match = DAY.exec(value);
  if (match === null) return false;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return at.toISOString().slice(0, 10) === value;
};

/** The instant of a local date and time field as ISO, or undefined when it is not a date. */
export function confirmedInstant(local: string): string | undefined {
  const time = Date.parse(local);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** What is wrong with the form: every field is needed, the amount is whole dong, the days are real and not in the future, the evidence is the id of a document version. */
export function validateManualConfirm(form: ManualConfirmForm, now: Date): Partial<Record<ManualConfirmField, ManualConfirmProblem>> {
  const found: Partial<Record<ManualConfirmField, ManualConfirmProblem>> = {};
  if (form.documentNo.trim() === '') found.documentNo = 'required';
  else if (form.documentNo.length > 2000) found.documentNo = 'long';
  if (form.documentDate === '') found.documentDate = 'required';
  else if (!isRealDay(form.documentDate)) found.documentDate = 'day';
  else if (form.documentDate > now.toISOString().slice(0, 10)) found.documentDate = 'future';
  if (form.amountVnd === '') found.amountVnd = 'required';
  else if (!/^[0-9]+$/.test(form.amountVnd)) found.amountVnd = 'amount';
  if (form.confirmedAt === '') found.confirmedAt = 'required';
  else {
    const instant = confirmedInstant(form.confirmedAt);
    if (instant === undefined) found.confirmedAt = 'instant';
    else if (Date.parse(instant) > now.getTime()) found.confirmedAt = 'future';
  }
  if (form.evidenceVersionId.trim() === '') found.evidenceVersionId = 'required';
  else if (!UUID.test(form.evidenceVersionId.trim())) found.evidenceVersionId = 'uuid';
  return found;
}

export function manualConfirmBody(requestId: string, form: ManualConfirmForm) {
  return {
    payment_request_id: requestId,
    document_no: form.documentNo.trim(),
    document_date: form.documentDate,
    amount_vnd: form.amountVnd,
    confirmed_at: confirmedInstant(form.confirmedAt) ?? '',
    evidence_document_version_id: form.evidenceVersionId.trim().toLowerCase(),
  };
}

export type ManualConfirmRefusal = 'duplicate' | 'mismatch' | { general: Problem };

/** The refusal of the server in the words of this dialog; a code the dialog has no sentence for goes to the words of the payment screens. */
export function describeManualRefusal(error: unknown): ManualConfirmRefusal {
  if (error instanceof ApiError) {
    if (error.code === 'TREASURY_TRANSACTION_DUPLICATE') return 'duplicate';
    if (error.code === 'AMOUNT_MISMATCH_OPENED') return 'mismatch';
  }
  return { general: describeProblem(error) };
}
