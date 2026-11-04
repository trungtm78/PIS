import { ApiError } from '@machvon/api-client';
import { hasControlCharacter } from '../control-characters';

/** AUD-02 and AUD-03: the audit and inspection engagements and the file of one of them (ST-AUD-001, AUD 3.1). */
export const ENGAGEMENTS_PATH = '/aud/aud-02';
export const ENGAGEMENT_PATH = '/aud/aud-03';

/** The permissions that gate the buttons of these screens; the server decides again on every request, and an engagement outside the scope of the caller is not found. */
export const MANAGE_PERMISSION = 'aud.engagement.manage';

export const ENGAGEMENT_STATUSES = ['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION', 'FOLLOW_UP', 'CLOSED', 'CANCELLED'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const ENGAGEMENT_TYPES = ['ADMINISTRATIVE_INSPECTION', 'SPECIALIZED_INSPECTION', 'STATE_AUDIT', 'INTERNAL_AUDIT', 'SUPERVISORY_CHECK'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const AUTHORITY_KINDS = ['GOVERNMENT_INSPECTORATE', 'PROVINCIAL_INSPECTORATE', 'MINISTRY_INSPECTORATE', 'STATE_AUDIT_OFFICE', 'INTERNAL'] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

export const SCOPE_KINDS = ['UNIT', 'PROJECT', 'CONTRACT'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const HOLD_STATUSES = ['Active', 'Released'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const TEXT_MAX_LENGTH = 2000;
export const MAX_SCOPE_ITEMS = 500;
const CODE_MIN = 3;
const CODE_MAX = 60;
const AUTHORITY_MAX = 300;
const TITLE_MAX = 500;
const REASON_MIN = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (value: string): boolean => UUID.test(value.trim());
export const isDay = (value: string): boolean => {
  const day = value.trim();
  if (!ISO_DATE.test(day)) return false;
  // A day that does not exist (month 13, the 31st of April) is not a day: the date parses to nothing or to another day.
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};
/** The day it is in Vietnam, where the days of an engagement are counted. */
export const todayInVietnam = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** An engagement as the list answers it. */
export interface EngagementLine {
  id: string;
  code: string;
  type: EngagementType;
  authorityKind: AuthorityKind;
  authorityName: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  status: EngagementStatus;
  coordinatorId: string;
  coordinatorName: string;
  holdId: string | null;
  holdStatus: HoldStatus | null;
  scopeCount: number;
  version: number;
}

export interface ScopeItem {
  kind: ScopeKind;
  id: string;
  code: string;
  name: string;
}

/** An engagement with its file: the decision, the days, the reason of a cancellation and the scope with names. */
export interface EngagementDetail extends EngagementLine {
  decision: { documentId: string; title: string; symbol: string | null; issuedOn: string | null; effectStatus: string };
  startedOn: string | null;
  fieldworkEndedOn: string | null;
  closedOn: string | null;
  cancelReason: string | null;
  scope: ScopeItem[];
}

/** An engagement the screen cannot read is dropped rather than shown half. */
export function toEngagementLine(raw: unknown): EngagementLine | undefined {
  const row = asRecord(raw);
  const coordinator = asRecord(row?.coordinator);
  const hold = asRecord(row?.legal_hold);
  const id = text(row?.id);
  const code = text(row?.engagement_code);
  const type = oneOf(ENGAGEMENT_TYPES, row?.engagement_type);
  const authorityKind = oneOf(AUTHORITY_KINDS, row?.authority_kind);
  const authorityName = text(row?.authority_name);
  const title = text(row?.title);
  const periodFrom = text(row?.period_from);
  const periodTo = text(row?.period_to);
  const status = oneOf(ENGAGEMENT_STATUSES, row?.status);
  const coordinatorId = text(coordinator?.id);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || code === undefined || type === undefined || authorityKind === undefined || authorityName === undefined || title === undefined) return undefined;
  if (periodFrom === undefined || periodTo === undefined || status === undefined || coordinatorId === undefined || version === undefined) return undefined;
  return {
    id,
    code,
    type,
    authorityKind,
    authorityName,
    title,
    periodFrom,
    periodTo,
    status,
    coordinatorId,
    coordinatorName: text(coordinator?.display_name) ?? '',
    holdId: text(hold?.id) ?? null,
    holdStatus: oneOf(HOLD_STATUSES, hold?.status) ?? null,
    scopeCount: whole(row.scope_count) ?? 0,
    version,
  };
}

export function toEngagementDetail(raw: unknown): EngagementDetail | undefined {
  const line = toEngagementLine(raw);
  const row = asRecord(raw);
  const decision = asRecord(row?.decision);
  const documentId = text(decision?.document_id);
  if (line === undefined || row === undefined || documentId === undefined) return undefined;
  return {
    ...line,
    decision: {
      documentId,
      title: text(decision?.title) ?? '',
      symbol: nullableText(decision?.symbol),
      issuedOn: nullableText(decision?.issued_on),
      effectStatus: text(decision?.effect_status) ?? '',
    },
    startedOn: nullableText(row.started_on),
    fieldworkEndedOn: nullableText(row.fieldwork_ended_on),
    closedOn: nullableText(row.closed_on),
    cancelReason: nullableText(row.cancel_reason),
    scope: (Array.isArray(row.scope) ? row.scope : []).flatMap((item): ScopeItem[] => {
      const entry = asRecord(item);
      const kind = oneOf(SCOPE_KINDS, entry?.kind);
      const id = text(entry?.id);
      return kind === undefined || id === undefined ? [] : [{ kind, id, code: text(entry?.code) ?? '', name: text(entry?.name) ?? '' }];
    }),
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The buttons of the commands: the permission to manage, in a tenant that is not read only. */
export const canManage = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';

export type EngagementAction = 'start' | 'endFieldwork' | 'cancel';

/** The commands an engagement allows in its state (the server judges again): start a planned one, end the fieldwork of one that is ongoing, cancel one that has no conclusion. */
export function actionsOf(status: EngagementStatus): readonly EngagementAction[] {
  switch (status) {
    case 'PLANNED':
      return ['start', 'cancel'];
    case 'ONGOING':
      return ['endFieldwork', 'cancel'];
    case 'AWAITING_CONCLUSION':
      return ['cancel'];
    case 'FOLLOW_UP':
    case 'CLOSED':
    case 'CANCELLED':
      return [];
  }
}

/** The engagements that match the words typed: the code, the title and the authority. */
export function engagementsMatching(lines: readonly EngagementLine[], words: string): EngagementLine[] {
  const needle = words.trim().toLowerCase();
  if (needle === '') return [...lines];
  return lines.filter((line) => `${line.code} ${line.title} ${line.authorityName}`.toLowerCase().includes(needle));
}

export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'invalid' | 'future' | 'early' | 'order';

const wordsProblem = (value: string, max: number, min = 1): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length < min) return 'tooShort';
  if (words.length > max) return 'tooLong';
  return hasControlCharacter(words) ? 'invalid' : undefined;
};

const dayProblem = (value: string): FormProblem | undefined => {
  const day = value.trim();
  if (day === '') return 'required';
  return isDay(day) ? undefined : 'invalid';
};

export interface CreateForm {
  code: string;
  type: '' | EngagementType;
  authorityKind: '' | AuthorityKind;
  authorityName: string;
  decisionDocumentId: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  coordinatorId: string;
  scope: ScopeItem[];
}

export const EMPTY_CREATE_FORM: CreateForm = {
  code: '',
  type: '',
  authorityKind: '',
  authorityName: '',
  decisionDocumentId: '',
  title: '',
  periodFrom: '',
  periodTo: '',
  coordinatorId: '',
  scope: [],
};

/** What is wrong with an engagement before it is sent: the code, the kind, the authority, the decision, the title, the period, the coordinator and at least one place. */
export function validateCreate(form: CreateForm): Partial<Record<keyof CreateForm, FormProblem>> {
  const problems: Partial<Record<keyof CreateForm, FormProblem>> = {};
  const code = wordsProblem(form.code, CODE_MAX, CODE_MIN);
  if (code !== undefined) problems.code = code;
  if (form.type === '') problems.type = 'required';
  if (form.authorityKind === '') problems.authorityKind = 'required';
  const authority = wordsProblem(form.authorityName, AUTHORITY_MAX, CODE_MIN);
  if (authority !== undefined) problems.authorityName = authority;
  const decision = form.decisionDocumentId.trim();
  if (decision === '') problems.decisionDocumentId = 'required';
  else if (!isUuid(decision)) problems.decisionDocumentId = 'invalid';
  const title = wordsProblem(form.title, TITLE_MAX, CODE_MIN);
  if (title !== undefined) problems.title = title;
  const from = dayProblem(form.periodFrom);
  if (from !== undefined) problems.periodFrom = from;
  const to = dayProblem(form.periodTo);
  if (to !== undefined) problems.periodTo = to;
  else if (from === undefined && form.periodTo.trim() < form.periodFrom.trim()) problems.periodTo = 'order';
  if (form.coordinatorId === '') problems.coordinatorId = 'required';
  if (form.scope.length === 0) problems.scope = 'required';
  else if (form.scope.length > MAX_SCOPE_ITEMS) problems.scope = 'tooLong';
  return problems;
}

export interface CreateBody {
  engagement_code: string;
  engagement_type: EngagementType;
  authority_kind: AuthorityKind;
  authority_name: string;
  decision_document_id: string;
  title: string;
  period_from: string;
  period_to: string;
  coordinator_user_id: string;
  scope: Array<{ kind: ScopeKind; id: string }>;
}

export function createBody(form: CreateForm): CreateBody {
  return {
    engagement_code: form.code.trim(),
    engagement_type: form.type as EngagementType,
    authority_kind: form.authorityKind as AuthorityKind,
    authority_name: form.authorityName.trim(),
    decision_document_id: form.decisionDocumentId.trim().toLowerCase(),
    title: form.title.trim(),
    period_from: form.periodFrom.trim(),
    period_to: form.periodTo.trim(),
    coordinator_user_id: form.coordinatorId,
    scope: form.scope.map((item) => ({ kind: item.kind, id: item.id })),
  };
}

export interface StartForm {
  startedOn: string;
  placeLegalHold: boolean;
}

export const EMPTY_START_FORM: StartForm = { startedOn: '', placeLegalHold: true };

/** The start is dated a day that has come. */
export function validateStart(form: StartForm, today: string): Partial<Record<keyof StartForm, FormProblem>> {
  const problem = dayProblem(form.startedOn);
  if (problem !== undefined) return { startedOn: problem };
  return form.startedOn.trim() > today ? { startedOn: 'future' } : {};
}

export interface StartBody {
  started_on: string;
  place_legal_hold: boolean;
}

export const startBody = (form: StartForm): StartBody => ({ started_on: form.startedOn.trim(), place_legal_hold: form.placeLegalHold });

export interface EndForm {
  onDate: string;
}

export const EMPTY_END_FORM: EndForm = { onDate: '' };

/** The end of the fieldwork is a day between the start and today. */
export function validateEnd(form: EndForm, engagement: EngagementDetail, today: string): Partial<Record<keyof EndForm, FormProblem>> {
  const problem = dayProblem(form.onDate);
  if (problem !== undefined) return { onDate: problem };
  const day = form.onDate.trim();
  if (day > today) return { onDate: 'future' };
  return engagement.startedOn !== null && day < engagement.startedOn ? { onDate: 'early' } : {};
}

export interface StatusBody {
  on_date: string;
  reason?: string;
}

export const endBody = (form: EndForm): StatusBody => ({ on_date: form.onDate.trim() });

export interface CancelForm {
  onDate: string;
  reason: string;
}

export const EMPTY_CANCEL_FORM: CancelForm = { onDate: '', reason: '' };

/** A cancellation has a day that has come and a reason in words. */
export function validateCancel(form: CancelForm, today: string): Partial<Record<keyof CancelForm, FormProblem>> {
  const problems: Partial<Record<keyof CancelForm, FormProblem>> = {};
  const day = dayProblem(form.onDate);
  if (day !== undefined) problems.onDate = day;
  else if (form.onDate.trim() > today) problems.onDate = 'future';
  const reason = wordsProblem(form.reason, TEXT_MAX_LENGTH, REASON_MIN);
  if (reason !== undefined) problems.reason = reason;
  return problems;
}

export const cancelBody = (form: CancelForm): StatusBody => ({ on_date: form.onDate.trim(), reason: form.reason.trim() });

export type CommandProblem =
  | 'codeDuplicate'
  | 'decisionNotEffective'
  | 'stateInvalid'
  | 'conclusionExists'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  ENGAGEMENT_CODE_DUPLICATE: 'codeDuplicate',
  DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionNotEffective',
  ENGAGEMENT_STATE_INVALID: 'stateInvalid',
  CONCLUSION_EXISTS: 'conclusionExists',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
