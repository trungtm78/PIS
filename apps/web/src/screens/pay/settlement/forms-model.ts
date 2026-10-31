import { ApiError } from '@machvon/api-client';
import { daysLeft } from './model';
import type { Scope, Settlement } from './model';

/** PAY-16: the forms of a settlement and the calendar of its verification (ST-PAY-012, PAY 3.5 steps 3 and 4, CXN-09). */
export const GENERATE_PERMISSION = 'settlement.forms.generate';
export const FORMS_PATH = '/pay/pay-16';

export const formsLink = (settlementId?: string): string => (settlementId === undefined ? FORMS_PATH : `${FORMS_PATH}?${new URLSearchParams({ settlement: settlementId }).toString()}`);

export const ANNUAL_FORMS = ['01/QTNĐ', '02/QTNĐ', '03/QTNĐ', '04/QTNĐ', '05/QTNĐ'] as const;
export const PROJECT_FORMS = ['01/QTDA', '02/QTDA', '03/QTDA', '04/QTDA', '05/QTDA', '06/QTDA', '07/QTDA', '08/QTDA', '09/QTDA', '10/QTDA', '11/QTDA', '12/QTDA'] as const;
/** The form that is the decision approving the settlement of a project: it is drawn as the draft of a document that DOC issues by its own steps. */
export const DECISION_FORM = '10/QTDA';
export const PLACE_MAX = 100;

/** The forms a settlement of a scope is drawn up with; a settlement of one contract has none. */
export function formsOf(scope: Scope): readonly string[] {
  if (scope === 'ANNUAL') return ANNUAL_FORMS;
  return scope === 'PROJECT' ? PROJECT_FORMS : [];
}

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const FORM_STATUSES = ['REQUESTED', 'GENERATED', 'FAILED', 'SUPERSEDED'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/** A form as the screen shows it: the template revision it was drawn from with the legal basis and the hash of the file. */
export interface SettlementForm {
  id: string;
  formCode: string;
  status: FormStatus;
  templateCode: string | null;
  templateRevision: number | null;
  legalBasis: string;
  fileSha256: string | null;
  generatedAt: string | null;
}

export function toSettlementForm(raw: unknown): SettlementForm | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const formCode = text(row?.form_code);
  const status = FORM_STATUSES.find((candidate) => candidate === row?.status);
  if (row === undefined || id === undefined || formCode === undefined || status === undefined) return undefined;
  return {
    id,
    formCode,
    status,
    templateCode: nullableText(row.template_code),
    templateRevision: typeof row.template_revision === 'number' ? row.template_revision : null,
    legalBasis: text(row.legal_basis) ?? '',
    fileSha256: nullableText(row.file_sha256),
    generatedAt: nullableText(row.generated_at),
  };
}

/** The forms that stand, one for each code: what the settlement is drawn up with now. */
export const standing = (forms: readonly SettlementForm[]): SettlementForm[] => forms.filter((form) => form.status === 'GENERATED');

// ---- the calendar ----------------------------------------------------------------------------------------------------------

export type Stage = 'OVERDUE' | 'T7' | 'T30' | 'LATER';

/** The stage of the reminders of a settlement that waits for its verification: past its last day, within 7 days, within 30 days, later. */
export function stageOf(dueOn: string, today: string): Stage | undefined {
  const left = daysLeft(dueOn, today);
  if (left === undefined) return undefined;
  if (left < 0) return 'OVERDUE';
  if (left <= 7) return 'T7';
  return left <= 30 ? 'T30' : 'LATER';
}

export interface CalendarLine {
  settlement: Settlement;
  dueOn: string;
  daysLeft: number;
  stage: Stage;
}

/** The settlements that were sent and wait for their verification, the earliest last day first (the calendar of PAY-16). */
export function calendarOf(settlements: readonly Settlement[], today: string): CalendarLine[] {
  const lines: CalendarLine[] = [];
  for (const settlement of settlements) {
    if (settlement.status !== 'SUBMITTED' && settlement.status !== 'VERIFYING') continue;
    const dueOn = settlement.verificationDueOn;
    const left = dueOn === null ? undefined : daysLeft(dueOn, today);
    const stage = dueOn === null ? undefined : stageOf(dueOn, today);
    if (dueOn !== null && left !== undefined && stage !== undefined) lines.push({ settlement, dueOn, daysLeft: left, stage });
  }
  return lines.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.settlement.id.localeCompare(b.settlement.id));
}

// ---- the form of the command -----------------------------------------------------------------------------------------------

export type FormProblem = 'codes' | 'place' | 'placeLong';

export interface GenerateForm {
  codes: string[];
  place: string;
}

export const EMPTY_GENERATE: GenerateForm = { codes: [], place: '' };

export function validateGenerate(form: GenerateForm, scope: Scope): Partial<Record<keyof GenerateForm, FormProblem>> {
  const found: Partial<Record<keyof GenerateForm, FormProblem>> = {};
  const allowed = formsOf(scope);
  if (form.codes.length === 0 || form.codes.some((code) => !allowed.includes(code))) found.codes = 'codes';
  const place = form.place.trim();
  if (place === '') found.place = 'place';
  else if (place.length > PLACE_MAX) found.place = 'placeLong';
  return found;
}

/** The body of the command for a form that passed `validateGenerate`: the codes in the order of the list. */
export const generateBody = (form: GenerateForm, scope: Scope): { form_codes: string[]; place: string } => ({ form_codes: formsOf(scope).filter((code) => form.codes.includes(code)), place: form.place.trim() });

// ---- what the server refuses -----------------------------------------------------------------------------------------------

export type Problem = 'templateUnconfirmed' | 'templateNotEffective' | 'stateInvalid' | 'validation' | 'unavailable' | 'notFound' | 'denied' | 'session' | 'general';

export interface Refusal {
  problem: Problem;
  /** The form the refusal is about, when the server names it. */
  formCode: string | null;
}

const BY_CODE: Readonly<Record<string, Problem>> = {
  TEMPLATE_UNCONFIRMED: 'templateUnconfirmed',
  TEMPLATE_NOT_EFFECTIVE: 'templateNotEffective',
  SETTLEMENT_STATE_INVALID: 'stateInvalid',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  PROVIDER_UNAVAILABLE: 'unavailable',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', formCode: null };
  const form = error.extensions.form_code;
  return { problem: BY_CODE[error.code] ?? 'general', formCode: typeof form === 'string' ? form : null };
}
