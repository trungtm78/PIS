import { ApiError } from '@machvon/api-client';
import { GATE_CODES } from './gate-model';
import type { GateCode } from './gate-model';

/** The permission that gates the buttons of the waivers; the server decides again on every request. */
export const WAIVE_PERMISSION = 'permit.gate.waive';
/** The longest a waiver may last, from the day it is granted, last day included (BR-PMT-05; a working assumption until the tenant confirms it, R-PMT-03). */
export const WAIVER_MAX_DAYS = 90;
export const WAIVER_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type WaiverStatus = (typeof WAIVER_STATUSES)[number];
export const MAX_TEXT = 2000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <Value extends string>(list: readonly Value[], value: unknown): Value | undefined => list.find((candidate) => candidate === value);

/** One waiver of a gate as the read model gives it. */
export interface WaiverView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  gateCode: GateCode;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeName: string;
  reason: string;
  decisionDocumentVersionId: string;
  /** The last day the waiver lets the gate pass (inclusive). */
  validUntil: string;
  grantedOn: string;
  status: WaiverStatus;
  revokedOn: string | null;
  revokedReason: string | null;
  version: number;
}

export function toWaiver(raw: unknown): WaiverView | undefined {
  if (!isRecord(raw)) return undefined;
  const project = isRecord(raw.project) ? raw.project : undefined;
  const id = text(raw.id);
  const projectId = text(project?.id);
  const gateCode = oneOf(GATE_CODES, raw.gate_code);
  const status = oneOf(WAIVER_STATUSES, raw.status);
  const permitTypeId = text(raw.permit_type_id);
  const permitTypeCode = text(raw.permit_type_code);
  const reason = text(raw.reason);
  const documentId = text(raw.decision_document_version_id);
  const validUntil = text(raw.valid_until);
  const grantedOn = text(raw.granted_on);
  const version = whole(raw.version);
  if (id === undefined || projectId === undefined || gateCode === undefined || status === undefined || permitTypeId === undefined || permitTypeCode === undefined) return undefined;
  if (reason === undefined || documentId === undefined || validUntil === undefined || grantedOn === undefined || version === undefined) return undefined;
  return {
    id,
    projectId,
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    gateCode,
    permitTypeId,
    permitTypeCode,
    permitTypeName: text(raw.permit_type_name) ?? permitTypeCode,
    reason,
    decisionDocumentVersionId: documentId,
    validUntil,
    grantedOn,
    status,
    revokedOn: text(raw.revoked_on) ?? null,
    revokedReason: text(raw.revoked_reason) ?? null,
    version,
  };
}

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The last day a waiver granted today may reach: the longest it may last, today included. */
export const latestWaiverDay = (today: string): string => shiftDay(today, WAIVER_MAX_DAYS - 1);

/** The days from today to the last day of a waiver: zero on the last day, negative once it has passed. */
export const daysLeft = (waiver: Pick<WaiverView, 'validUntil'>, today: string): number => Math.round((Date.parse(`${waiver.validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

/** In force (it lets the gate pass today), lapsed (its last day has passed; the nightly job marks it EXPIRED) or revoked. */
export type WaiverPhase = 'inForce' | 'lapsed' | 'revoked';

export function phaseOf(waiver: Pick<WaiverView, 'status' | 'validUntil'>, today: string): WaiverPhase {
  if (waiver.status === 'REVOKED') return 'revoked';
  if (waiver.status === 'EXPIRED') return 'lapsed';
  return daysLeft(waiver, today) < 0 ? 'lapsed' : 'inForce';
}

export interface WaiverFilter {
  status: WaiverStatus | '';
}
export const EMPTY_WAIVER_FILTER: WaiverFilter = { status: '' };

export const filterWaivers = (waivers: readonly WaiverView[], filter: WaiverFilter): WaiverView[] => waivers.filter((waiver) => filter.status === '' || waiver.status === filter.status);

// ---- the form ---------------------------------------------------------------------------------------------------------

export type WaiverFieldProblem = 'required' | 'tooLong' | 'invalidId' | 'invalidDate' | 'pastDate' | 'beyondMaximum';
export type WaiverField = 'projectId' | 'gateCode' | 'permitTypeId' | 'reason' | 'documentVersionId' | 'validUntil';

export interface WaiverForm {
  projectId: string;
  gateCode: GateCode;
  permitTypeId: string;
  reason: string;
  documentVersionId: string;
  validUntil: string;
}

export const EMPTY_WAIVER_FORM: WaiverForm = { projectId: '', gateCode: GATE_CODES[1], permitTypeId: '', reason: '', documentVersionId: '', validUntil: '' };

export type WaiverErrors = Partial<Record<WaiverField, WaiverFieldProblem>>;

export function validateWaiver(form: WaiverForm, today: string): WaiverErrors {
  const errors: WaiverErrors = {};
  if (form.projectId === '') errors.projectId = 'required';
  if (form.permitTypeId === '') errors.permitTypeId = 'required';
  if (form.reason.trim() === '') errors.reason = 'required';
  else if (form.reason.trim().length > MAX_TEXT) errors.reason = 'tooLong';
  if (form.documentVersionId.trim() === '') errors.documentVersionId = 'required';
  else if (!UUID.test(form.documentVersionId.trim())) errors.documentVersionId = 'invalidId';
  if (form.validUntil === '') errors.validUntil = 'required';
  else if (!isRealDate(form.validUntil)) errors.validUntil = 'invalidDate';
  else if (form.validUntil < today) errors.validUntil = 'pastDate';
  else if (form.validUntil > latestWaiverDay(today)) errors.validUntil = 'beyondMaximum';
  return errors;
}

export const hasErrors = (errors: WaiverErrors): boolean => Object.keys(errors).length > 0;

export interface GrantBody {
  project_id: string;
  gate_code: GateCode;
  permit_type_id: string;
  reason: string;
  decision_document_version_id: string;
  valid_until: string;
}

/** The body of grantPermitGateWaiver: the allowlist of the contract, trimmed. */
export function grantBody(form: WaiverForm): GrantBody {
  return {
    project_id: form.projectId,
    gate_code: form.gateCode,
    permit_type_id: form.permitTypeId,
    reason: form.reason.trim(),
    decision_document_version_id: form.documentVersionId.trim().toLowerCase(),
    valid_until: form.validUntil,
  };
}

export type RevokeProblem = 'required' | 'tooLong';

export function validateRevoke(reason: string): RevokeProblem | undefined {
  if (reason.trim() === '') return 'required';
  return reason.trim().length > MAX_TEXT ? 'tooLong' : undefined;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type WaiverReason = 'tooLong' | 'selfApproval' | 'documentRequired' | 'stateInvalid' | 'validation' | 'notFound' | 'denied' | 'general';

export interface WaiverProblemView {
  reason: WaiverReason;
  field: string | undefined;
  /** The longest a waiver may last and the last day it may reach, as the server counts them (WAIVER_TOO_LONG). */
  maxDays: number | undefined;
  latestDay: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, WaiverReason>> = {
  WAIVER_TOO_LONG: 'tooLong',
  SELF_APPROVAL_DENIED: 'selfApproval',
  DECISION_DOCUMENT_REQUIRED: 'documentRequired',
  WAIVER_STATE_INVALID: 'stateInvalid',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

export function describeWaiverProblem(error: unknown): WaiverProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, maxDays: undefined, latestDay: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, maxDays: whole(error.extensions.max_days), latestDay: text(error.extensions.latest_day) };
}

/** The form field a refusal of the server points at, when it points at one. */
export const FIELD_OF_DETAIL: Readonly<Record<string, WaiverField>> = {
  project_id: 'projectId',
  gate_code: 'gateCode',
  permit_type_id: 'permitTypeId',
  reason: 'reason',
  decision_document_version_id: 'documentVersionId',
  valid_until: 'validUntil',
};
