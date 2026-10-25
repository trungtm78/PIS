import { ApiError } from '@machvon/api-client';
import { isUuid } from '../../ctr/change/model';
import type { FormProblem, PaymentRequest } from '../payment/model';

export const GENERATE_PERMISSION = 'payment.forms.generate';
export const SEND_PERMISSION = 'payment.treasury.send';
export const READ_PERMISSION = 'payment_request.read';

export const BOARD_PATH = '/pay/pay-04';
export const FORMS_PATH = '/pay/pay-14';

/** The board of the requests that are on their way to the Treasury (PAY-04). */
export const boardLink = (): string => BOARD_PATH;
/** The Treasury forms of a request (PAY-14). */
export const formsLink = (id: string): string => `${FORMS_PATH}?${new URLSearchParams({ request: id }).toString()}`;

/** The four forms a request goes to the Treasury with (CXN-08; the database holds the same four). */
export const FORM_CODES = ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT'] as const;
export type FormCode = (typeof FORM_CODES)[number];

/** The statuses of the requests the board follows: checked and waiting for the forms, and sent. */
export const BOARD_STATUSES = ['VERIFIED', 'SENT_TREASURY'] as const;

const MAX_PLACE = 100;
const MAX_REF = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{64}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

export type FormStatus = 'REQUESTED' | 'GENERATED' | 'FAILED' | 'SUPERSEDED';
const FORM_STATUSES: readonly FormStatus[] = ['REQUESTED', 'GENERATED', 'FAILED', 'SUPERSEDED'];

export interface PaymentForm {
  id: string;
  paymentRequestId: string;
  formCode: string;
  status: FormStatus;
  templateCode: string | null;
  templateRevision: number | null;
  legalBasis: string;
  documentVersionId: string | null;
  fileSha256: string | null;
  payloadSha256: string | null;
  generatedAt: string | null;
}

export function toForm(raw: unknown): PaymentForm | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const paymentRequestId = text(row?.payment_request_id);
  const formCode = text(row?.form_code);
  const status = FORM_STATUSES.find((candidate) => candidate === row?.status);
  if (row === undefined || id === undefined || paymentRequestId === undefined || formCode === undefined || status === undefined) return undefined;
  const file = text(row.file_sha256);
  const payload = text(row.payload_sha256);
  return {
    id,
    paymentRequestId,
    formCode,
    status,
    templateCode: nullableText(row.template_code),
    templateRevision: whole(row.template_revision),
    legalBasis: text(row.legal_basis) ?? '',
    documentVersionId: nullableText(row.document_version_id),
    fileSha256: file !== undefined && SHA.test(file) ? file : null,
    payloadSha256: payload !== undefined && SHA.test(payload) ? payload : null,
    generatedAt: nullableText(row.generated_at),
  };
}

export function toForms(value: unknown): PaymentForm[] {
  const items = asRecord(value)?.items;
  return (Array.isArray(items) ? items : []).flatMap((item) => toForm(item) ?? []);
}

/** The form that stands for each of the four kinds, or none. */
export function standingForms(forms: readonly PaymentForm[]): Map<string, PaymentForm> {
  const standing = new Map<string, PaymentForm>();
  for (const form of forms) if (form.status === 'GENERATED') standing.set(form.formCode, form);
  return standing;
}

/** The forms a request still lacks, in the order of the list. */
export const formsMissing = (forms: readonly PaymentForm[]): FormCode[] => FORM_CODES.filter((code) => !standingForms(forms).has(code));

/** How many forms stand for a request, of the four. */
export const standingCount = (request: Pick<PaymentRequest, 'formsStanding'>): number => FORM_CODES.filter((code) => request.formsStanding.includes(code)).length;

export interface AnswerOfForms {
  id: string;
  status: string;
  version: number;
  forms: PaymentForm[];
}

export function toFormsAnswer(value: unknown): AnswerOfForms | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  if (row === undefined || id === undefined || version === null) return undefined;
  return { id, status: text(row.status) ?? '', version, forms: (Array.isArray(row.forms) ? row.forms : []).flatMap((item) => toForm(item) ?? []) };
}

// ---- the commands ------------------------------------------------------------------------------------------------------------

export interface GenerateForm {
  place: string;
}

export const EMPTY_GENERATE: GenerateForm = { place: '' };

export function validateGenerate(form: GenerateForm): Partial<Record<keyof GenerateForm, FormProblem>> {
  const place = form.place.trim();
  if (place === '') return { place: 'required' };
  return place.length > MAX_PLACE ? { place: 'tooLong' } : {};
}

export const generateBody = (codes: readonly FormCode[], form: GenerateForm): { form_codes: FormCode[]; place: string } => ({ form_codes: [...codes], place: form.place.trim() });

export interface SendForm {
  sentOn: string;
  treasuryRef: string;
}

export const EMPTY_SEND: SendForm = { sentOn: '', treasuryRef: '' };

export function validateSend(form: SendForm, today: string): Partial<Record<keyof SendForm, FormProblem>> {
  const problems: Partial<Record<keyof SendForm, FormProblem>> = {};
  const day = form.sentOn.trim();
  if (day === '') problems.sentOn = 'required';
  else if (!DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || day > today) problems.sentOn = 'date';
  if (form.treasuryRef.trim().length > MAX_REF) problems.treasuryRef = 'tooLong';
  return problems;
}

export interface SendBody {
  treasury_submitted_on: string;
  treasury_ref?: string;
  form_instance_ids: string[];
}

export function sendBody(form: SendForm, forms: readonly PaymentForm[]): SendBody {
  const ref = form.treasuryRef.trim();
  return { treasury_submitted_on: form.sentOn.trim(), ...(ref === '' ? {} : { treasury_ref: ref }), form_instance_ids: [...standingForms(forms).values()].map((form) => form.id) };
}

export const looksLikeId = isUuid;

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem = 'unconfirmed' | 'notEffective' | 'formsMissing' | 'paymentState' | 'unavailable' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export interface Refusal {
  problem: Problem;
  /** The form a refusal of the library of templates is about. */
  formCode: string | null;
  /** The forms still lacking, when the file cannot be sent. */
  missing: string[];
}

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Refusal {
  const refusal = (problem: Problem, formCode: string | null = null, missing: string[] = []): Refusal => ({ problem, formCode, missing });
  if (!(error instanceof ApiError)) return refusal('general');
  const extensions = error.extensions;
  const formCode = typeof extensions.form_code === 'string' ? extensions.form_code : null;
  switch (error.code) {
    case 'TEMPLATE_UNCONFIRMED':
      return refusal('unconfirmed', formCode);
    case 'TEMPLATE_NOT_EFFECTIVE':
      return refusal('notEffective', formCode);
    case 'FORMS_NOT_GENERATED':
      return refusal('formsMissing', null, Array.isArray(extensions.missing_form_codes) ? extensions.missing_form_codes.filter((code): code is string => typeof code === 'string') : []);
    case 'PAYMENT_STATE_INVALID':
      return refusal('paymentState');
    case 'PROVIDER_UNAVAILABLE':
      return refusal('unavailable');
    case 'VERSION_CONFLICT':
      return refusal('versionConflict');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return refusal('validation');
    case 'RESOURCE_NOT_FOUND':
      return refusal('notFound');
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return refusal('denied');
    case 'SESSION_EXPIRED':
      return refusal('session');
    default:
      return refusal('general');
  }
}
