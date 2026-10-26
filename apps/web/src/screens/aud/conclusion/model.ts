import { ApiError } from '@machvon/api-client';
import { isDay, isUuid } from '../model';
import type { EngagementStatus, FormProblem, ScopeItem, ScopeKind } from '../model';

/** AUD-04 and AUD-05: what an authority concluded about an engagement, the findings in it and the recommendations on it (ST-AUD-002, AUD 3.2). */
export const CONCLUSIONS_PATH = '/aud/aud-04';
export const FINDINGS_PATH = '/aud/aud-05';

/** The permission that gates the buttons of these screens; the server decides again on every request. */
export const RECORD_PERMISSION = 'aud.conclusion.record';

export const CONCLUSION_KINDS = ['INSPECTION_CONCLUSION', 'AUDIT_REPORT', 'AUDIT_NOTICE', 'INTERNAL_REPORT'] as const;
export type ConclusionKind = (typeof CONCLUSION_KINDS)[number];

export const CONCLUSION_STATUSES = ['RECEIVED', 'ANALYSED', 'SUPERSEDED', 'CLOSED'] as const;
export type ConclusionStatus = (typeof CONCLUSION_STATUSES)[number];

export const FINDING_CATEGORIES = ['FINANCIAL', 'PROCEDURE', 'PROCUREMENT', 'QUALITY', 'LAND', 'PLANNING', 'OTHER'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const RECOMMENDATION_TYPES = ['FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT', 'PROCESS_CORRECTION', 'ACCOUNTABILITY', 'REFERRAL', 'POLICY_CHANGE'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED', 'DISPUTED', 'CANCELLED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const isFinancial = (type: RecommendationType): boolean => type === 'FINANCIAL_RECOVERY' || type === 'FINANCIAL_ADJUSTMENT';

const SUMMARY_MIN = 10;
const SUMMARY_MAX = 8000;
const CODE_MAX = 40;
const LEGAL_BASIS_MAX = 2000;
const AMOUNT_DIGITS = 24;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const flag = (value: unknown): boolean => value === true;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value : undefined);

/** A whole amount of dong in the way it is read, with a dot between the thousands. */
export const formatVnd = (amount: string): string => amount.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** The digits of an amount typed with or without separators ("1.250.000.000", "1,250,000,000", "1 250 000 000"); anything else is not an amount. */
export function digitsOf(typed: string): string | undefined {
  const compact = typed.trim().replace(/[.,\s]/g, '');
  if (!/^[0-9]+$/.test(compact) || compact.length > AMOUNT_DIGITS) return undefined;
  return BigInt(compact).toString();
}

/** The conclusion of an engagement as AUD-04 reads it. */
export interface ConclusionLine {
  id: string;
  engagementId: string;
  kind: ConclusionKind;
  document: { id: string; title: string; symbol: string | null };
  revision: number;
  issuedOn: string;
  receivedOn: string;
  implementationDueOn: string | null;
  reportDueOn: string | null;
  summary: string;
  totalVnd: string;
  recommendedVnd: string;
  shortfallVnd: string;
  isPublic: boolean;
  status: ConclusionStatus;
  findingCount: number;
  recommendationCount: number;
  version: number;
}

export function toConclusion(raw: unknown): ConclusionLine | undefined {
  const row = asRecord(raw);
  const document = asRecord(row?.document);
  const id = text(row?.id);
  const engagementId = text(row?.engagement_id);
  const kind = oneOf(CONCLUSION_KINDS, row?.conclusion_kind);
  const documentId = text(document?.id);
  const revision = whole(row?.revision);
  const issuedOn = text(row?.issued_on);
  const receivedOn = text(row?.received_on);
  const summary = text(row?.summary);
  const totalVnd = dong(row?.total_financial_vnd);
  const recommendedVnd = dong(row?.recommended_vnd);
  const shortfallVnd = dong(row?.shortfall_vnd);
  const status = oneOf(CONCLUSION_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || engagementId === undefined || kind === undefined || documentId === undefined || revision === undefined) return undefined;
  if (issuedOn === undefined || receivedOn === undefined || summary === undefined || totalVnd === undefined || recommendedVnd === undefined || shortfallVnd === undefined) return undefined;
  if (status === undefined || version === undefined) return undefined;
  return {
    id,
    engagementId,
    kind,
    document: { id: documentId, title: text(document?.title) ?? '', symbol: nullableText(document?.symbol) },
    revision,
    issuedOn,
    receivedOn,
    implementationDueOn: nullableText(row.implementation_due_on),
    reportDueOn: nullableText(row.report_due_on),
    summary,
    totalVnd,
    recommendedVnd,
    shortfallVnd,
    isPublic: flag(row.is_public),
    status,
    findingCount: whole(row.finding_count) ?? 0,
    recommendationCount: whole(row.recommendation_count) ?? 0,
    version,
  };
}

/** A finding as AUD-05 lists it: the places it is about by code and name. */
export interface FindingLine {
  id: string;
  code: string;
  category: FindingCategory;
  project: { id: string; code: string; name: string } | null;
  contract: { id: string; code: string } | null;
  unit: { id: string; code: string; name: string } | null;
  description: string;
  legalBasis: string | null;
  amountVnd: string | null;
  severity: FindingSeverity;
}

export function toFinding(raw: unknown): FindingLine | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const contract = asRecord(row?.contract);
  const unit = asRecord(row?.organization_unit);
  const id = text(row?.id);
  const code = text(row?.finding_code);
  const category = oneOf(FINDING_CATEGORIES, row?.category);
  const description = text(row?.description);
  const severity = oneOf(FINDING_SEVERITIES, row?.severity);
  if (row === undefined || id === undefined || code === undefined || category === undefined || description === undefined || severity === undefined) return undefined;
  const projectId = text(project?.id);
  const contractId = text(contract?.id);
  const unitId = text(unit?.id);
  return {
    id,
    code,
    category,
    project: projectId === undefined ? null : { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' },
    contract: contractId === undefined ? null : { id: contractId, code: text(contract?.code) ?? '' },
    unit: unitId === undefined ? null : { id: unitId, code: text(unit?.code) ?? '', name: text(unit?.name) ?? '' },
    description,
    legalBasis: nullableText(row.legal_basis_cited),
    amountVnd: dong(row.amount_vnd) ?? null,
    severity,
  };
}

/** A recommendation as AUD-04 lists it. */
export interface RecommendationLine {
  id: string;
  code: string;
  type: RecommendationType;
  description: string;
  amountVnd: string | null;
  recoveredVnd: string;
  status: RecommendationStatus;
  findingId: string | null;
}

export function toRecommendation(raw: unknown): RecommendationLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.rec_code);
  const type = oneOf(RECOMMENDATION_TYPES, row?.rec_type);
  const description = text(row?.description);
  const status = oneOf(RECOMMENDATION_STATUSES, row?.status);
  if (row === undefined || id === undefined || code === undefined || type === undefined || description === undefined || status === undefined) return undefined;
  return { id, code, type, description, amountVnd: dong(row.amount_vnd) ?? null, recoveredVnd: dong(row.recovered_vnd) ?? '0', status, findingId: nullableText(row.finding_id) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The buttons of the commands: the permission to record, in a tenant that is not read only. */
export const canRecord = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(RECORD_PERMISSION)) && mode !== 'READ_ONLY';

/** The states of an engagement in which its conclusion can be recorded: the fieldwork is going on or has ended. */
export const awaitsConclusion = (status: EngagementStatus): boolean => status === 'ONGOING' || status === 'AWAITING_CONCLUSION';

/** The engagements the screens are about: the ones that can take a conclusion or have one. */
export const concludable = (status: EngagementStatus): boolean => awaitsConclusion(status) || status === 'FOLLOW_UP' || status === 'CLOSED';

/** A conclusion takes findings and recommendations while it is the current revision of an engagement that is followed up. */
export const takesMore = (engagementStatus: EngagementStatus, conclusion: ConclusionLine): boolean =>
  engagementStatus === 'FOLLOW_UP' && (conclusion.status === 'RECEIVED' || conclusion.status === 'ANALYSED');

/** The conclusion that is current: the newest revision that was not superseded. */
export const currentOf = (conclusions: readonly ConclusionLine[]): ConclusionLine | undefined =>
  [...conclusions].filter((line) => line.status !== 'SUPERSEDED').sort((a, b) => b.revision - a.revision)[0];

export type ConclusionFormProblem = FormProblem | 'exceeds';

type Problems<F> = Partial<Record<keyof F, ConclusionFormProblem>>;

const wordsProblem = (value: string, max: number, min = 1): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length < min) return 'tooShort';
  if (words.length > max) return 'tooLong';
  return CONTROL.test(words) ? 'invalid' : undefined;
};

const dayProblem = (value: string): FormProblem | undefined => {
  const day = value.trim();
  if (day === '') return 'required';
  return isDay(day) ? undefined : 'invalid';
};

const optionalDayProblem = (value: string, issuedOn: string): FormProblem | undefined => {
  if (value.trim() === '') return undefined;
  const problem = dayProblem(value);
  if (problem !== undefined) return problem;
  return isDay(issuedOn) && value.trim() < issuedOn.trim() ? 'early' : undefined;
};

const amountProblem = (value: string, required: boolean, allowZero = false): FormProblem | undefined => {
  if (value.trim() === '') return required ? 'required' : undefined;
  const digits = digitsOf(value);
  if (digits === undefined) return 'invalid';
  return required && !allowZero && digits === '0' ? 'invalid' : undefined;
};

export interface ConclusionForm {
  kind: '' | ConclusionKind;
  documentId: string;
  issuedOn: string;
  receivedOn: string;
  implementationDueOn: string;
  reportDueOn: string;
  totalVnd: string;
  summary: string;
  isPublic: boolean;
}

export const EMPTY_CONCLUSION_FORM: ConclusionForm = {
  kind: '',
  documentId: '',
  issuedOn: '',
  receivedOn: '',
  implementationDueOn: '',
  reportDueOn: '',
  totalVnd: '',
  summary: '',
  isPublic: false,
};

/** What is wrong with a conclusion before it is sent: the kind, the document, the days in order and not ahead of today, the due days not before the issue, the total and the summary. */
export function validateConclusion(form: ConclusionForm, today: string): Problems<ConclusionForm> {
  const problems: Problems<ConclusionForm> = {};
  if (form.kind === '') problems.kind = 'required';
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!isUuid(document)) problems.documentId = 'invalid';
  const issued = dayProblem(form.issuedOn);
  if (issued !== undefined) problems.issuedOn = issued;
  else if (form.issuedOn.trim() > today) problems.issuedOn = 'future';
  const received = dayProblem(form.receivedOn);
  if (received !== undefined) problems.receivedOn = received;
  else if (form.receivedOn.trim() > today) problems.receivedOn = 'future';
  else if (issued === undefined && form.receivedOn.trim() < form.issuedOn.trim()) problems.receivedOn = 'order';
  const implementation = optionalDayProblem(form.implementationDueOn, form.issuedOn);
  if (implementation !== undefined) problems.implementationDueOn = implementation;
  const report = optionalDayProblem(form.reportDueOn, form.issuedOn);
  if (report !== undefined) problems.reportDueOn = report;
  const total = amountProblem(form.totalVnd, true, true);
  if (total !== undefined) problems.totalVnd = total;
  const summary = wordsProblem(form.summary, SUMMARY_MAX, SUMMARY_MIN);
  if (summary !== undefined) problems.summary = summary;
  return problems;
}

export interface ConclusionBody {
  conclusion_kind: ConclusionKind;
  conclusion_document_id: string;
  issued_on: string;
  received_on: string;
  implementation_due_on?: string;
  report_due_on?: string;
  summary: string;
  total_financial_vnd: string;
  is_public: boolean;
}

export function conclusionBody(form: ConclusionForm): ConclusionBody {
  return {
    conclusion_kind: form.kind as ConclusionKind,
    conclusion_document_id: form.documentId.trim().toLowerCase(),
    issued_on: form.issuedOn.trim(),
    received_on: form.receivedOn.trim(),
    ...(form.implementationDueOn.trim() === '' ? {} : { implementation_due_on: form.implementationDueOn.trim() }),
    ...(form.reportDueOn.trim() === '' ? {} : { report_due_on: form.reportDueOn.trim() }),
    summary: form.summary.trim(),
    total_financial_vnd: digitsOf(form.totalVnd) ?? '0',
    is_public: form.isPublic,
  };
}

/** The place a finding is about is one of the scope items of the engagement, chosen as "KIND:id". */
export type PlaceChoice = '' | `${ScopeKind}:${string}`;

export const placeChoiceOf = (item: ScopeItem): PlaceChoice => `${item.kind}:${item.id}`;

export interface FindingForm {
  code: string;
  category: '' | FindingCategory;
  severity: '' | FindingSeverity;
  place: PlaceChoice;
  description: string;
  legalBasis: string;
  amountVnd: string;
}

export const EMPTY_FINDING_FORM: FindingForm = { code: '', category: '', severity: '', place: '', description: '', legalBasis: '', amountVnd: '' };

/** What is wrong with a finding before it is sent. */
export function validateFinding(form: FindingForm): Problems<FindingForm> {
  const problems: Problems<FindingForm> = {};
  const code = wordsProblem(form.code, CODE_MAX);
  if (code !== undefined) problems.code = code;
  if (form.category === '') problems.category = 'required';
  if (form.severity === '') problems.severity = 'required';
  const description = wordsProblem(form.description, SUMMARY_MAX, SUMMARY_MIN);
  if (description !== undefined) problems.description = description;
  if (form.legalBasis.trim().length > LEGAL_BASIS_MAX) problems.legalBasis = 'tooLong';
  else if (CONTROL.test(form.legalBasis.replace(/[\n\r\t]/g, ''))) problems.legalBasis = 'invalid';
  const amount = amountProblem(form.amountVnd, false);
  if (amount !== undefined) problems.amountVnd = amount;
  return problems;
}

export interface FindingBody {
  finding_code: string;
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  project_id?: string;
  contract_id?: string;
  organization_unit_id?: string;
  legal_basis_cited?: string;
  amount_vnd?: string;
}

export function findingBody(form: FindingForm): FindingBody {
  const [kind, ...rest] = form.place.split(':');
  const place = rest.join(':');
  const basis = form.legalBasis.trim();
  const amount = form.amountVnd.trim() === '' ? undefined : digitsOf(form.amountVnd);
  return {
    finding_code: form.code.trim(),
    category: form.category as FindingCategory,
    severity: form.severity as FindingSeverity,
    description: form.description.trim(),
    ...(form.place === '' ? {} : kind === 'PROJECT' ? { project_id: place } : kind === 'CONTRACT' ? { contract_id: place } : { organization_unit_id: place }),
    ...(basis === '' ? {} : { legal_basis_cited: basis }),
    ...(amount === undefined ? {} : { amount_vnd: amount }),
  };
}

export interface RecommendationForm {
  code: string;
  type: '' | RecommendationType;
  description: string;
  amountVnd: string;
  findingId: string;
}

export const EMPTY_RECOMMENDATION_FORM: RecommendationForm = { code: '', type: '', description: '', amountVnd: '', findingId: '' };

/**
 * What is wrong with a recommendation before it is sent: a financial one names an amount above zero that fits in what is left of the total of the conclusion (BR-AUD-05); one that is not
 * financial names none. The server checks the same again, under a lock, so that two at once cannot both fit.
 */
export function validateRecommendation(form: RecommendationForm, remainingVnd: string): Problems<RecommendationForm> {
  const problems: Problems<RecommendationForm> = {};
  const code = wordsProblem(form.code, CODE_MAX);
  if (code !== undefined) problems.code = code;
  if (form.type === '') problems.type = 'required';
  const description = wordsProblem(form.description, SUMMARY_MAX, SUMMARY_MIN);
  if (description !== undefined) problems.description = description;
  if (form.type !== '' && isFinancial(form.type)) {
    const amount = amountProblem(form.amountVnd, true);
    if (amount !== undefined) problems.amountVnd = amount;
    else if (BigInt(digitsOf(form.amountVnd) ?? '0') > BigInt(remainingVnd)) problems.amountVnd = 'exceeds';
  }
  return problems;
}

export interface RecommendationBody {
  rec_code: string;
  rec_type: RecommendationType;
  description: string;
  amount_vnd?: string;
  finding_id?: string;
}

export function recommendationBody(form: RecommendationForm): RecommendationBody {
  const type = form.type as RecommendationType;
  return {
    rec_code: form.code.trim(),
    rec_type: type,
    description: form.description.trim(),
    ...(isFinancial(type) ? { amount_vnd: digitsOf(form.amountVnd) ?? '0' } : {}),
    ...(form.findingId === '' ? {} : { finding_id: form.findingId }),
  };
}

export type ConclusionProblem =
  | 'decisionNotEffective'
  | 'stateInvalid'
  | 'revisionInvalid'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'findingDuplicate'
  | 'recommendationDuplicate'
  | 'amountRequired'
  | 'totalMismatch'
  | 'targetOutside'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ConclusionProblem>> = {
  DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionNotEffective',
  ENGAGEMENT_STATE_INVALID: 'stateInvalid',
  CONCLUSION_REVISION_INVALID: 'revisionInvalid',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  FINDING_CODE_DUPLICATE: 'findingDuplicate',
  REC_CODE_DUPLICATE: 'recommendationDuplicate',
  AMOUNT_REQUIRED: 'amountRequired',
  FINANCIAL_TOTAL_MISMATCH: 'totalMismatch',
  TARGET_OUT_OF_ENGAGEMENT: 'targetOutside',
};

export interface DescribedProblem {
  problem: ConclusionProblem;
  /** What is left of the total of the conclusion, when the server refused an amount that did not fit. */
  remainingVnd: string | undefined;
}

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message, and a refusal of the total carries what the server says is left. */
export function describeProblem(error: unknown): DescribedProblem {
  if (!(error instanceof ApiError)) return { problem: 'general', remainingVnd: undefined };
  return { problem: PROBLEM_BY_CODE[error.code] ?? 'general', remainingVnd: error.code === 'FINANCIAL_TOTAL_MISMATCH' ? dong(error.extensions.remaining_vnd) : undefined };
}
