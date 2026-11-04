import { ApiError } from '@machvon/api-client';
import { digitsOf } from '../conclusion/model';
import type { ConclusionFormProblem } from '../conclusion/model';
import { isDay, isUuid } from '../model';
import type { FormProblem } from '../model';
import { hasControlCharacter } from '../../control-characters';

/** AUD-01 and AUD-08: the overview of the engagements and the ledger of the recoveries of the recommendations (ST-AUD-004, AUD 3.4). */
export const OVERVIEW_PATH = '/aud/aud-01';
export const RECOVERY_PATH = '/aud/aud-08';

/** The permission that gates the buttons of the ledger; the server decides again on every request. */
export const RECORD_RECOVERY_PERMISSION = 'aud.recovery.record';

export const SOURCE_KINDS = ['PAY_RECOVERY', 'PAY_DEDUCTION', 'TREASURY_REMITTANCE', 'MANUAL_EVIDENCE'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What a person may enter by hand: what PAY does not report. The other two arrive by the events of PAY. */
export const MANUAL_SOURCES = ['TREASURY_REMITTANCE', 'MANUAL_EVIDENCE'] as const satisfies readonly SourceKind[];
export type ManualSource = (typeof MANUAL_SOURCES)[number];

export const EXCEPTION_KINDS = ['OVER_RECOVERY', 'UNMATCHED_REVERSAL', 'NOT_APPLICABLE'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

const REASON_MIN = 10;
const REASON_MAX = 1000;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^-?[0-9]{1,24}$/.test(value) ? value : undefined);

/** A rate with its numerator and its denominator, always (BR-AUD-04); the percentage is absent when the denominator is zero ("not applicable", never 0%). */
export interface Rate {
  numerator: string;
  denominator: string;
  percent: string | null;
}

export function toRate(raw: unknown): Rate | undefined {
  const row = asRecord(raw);
  const numerator = dong(row?.numerator);
  const denominator = dong(row?.denominator);
  if (row === undefined || numerator === undefined || denominator === undefined) return undefined;
  const percent = row.percent;
  return { numerator, denominator, percent: typeof percent === 'string' && /^[0-9]+\.[0-9]{2}$/.test(percent) ? percent : null };
}

/** A line of the ledger as AUD-08 lists it: the amount carries its sign, and a line that was reversed says so. */
export interface RecoveryLine {
  id: string;
  recommendationId: string;
  code: string;
  sourceKind: SourceKind;
  amountVnd: string;
  recordedOn: string;
  evidenceDocumentId: string | null;
  reversalOfId: string | null;
  reversed: boolean;
  note: string | null;
  cumulativeVnd: string;
  remainingVnd: string;
}

export function toRecoveryLine(raw: unknown): RecoveryLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const recommendationId = text(row?.recommendation_id);
  const code = text(row?.rec_code);
  const sourceKind = oneOf(SOURCE_KINDS, row?.source_kind);
  const amountVnd = dong(row?.amount_vnd);
  const recordedOn = text(row?.recorded_on);
  const cumulativeVnd = dong(row?.cumulative_vnd);
  const remainingVnd = dong(row?.remaining_vnd);
  if (row === undefined || id === undefined || recommendationId === undefined || code === undefined || sourceKind === undefined) return undefined;
  if (amountVnd === undefined || recordedOn === undefined || cumulativeVnd === undefined || remainingVnd === undefined) return undefined;
  return {
    id,
    recommendationId,
    code,
    sourceKind,
    amountVnd,
    recordedOn,
    evidenceDocumentId: nullableText(row.evidence_document_id),
    reversalOfId: nullableText(row.reversal_of_id),
    reversed: row.reversed === true,
    note: nullableText(row.note),
    cumulativeVnd,
    remainingVnd,
  };
}

/** A recommendation of the summary, with the version a line entered by hand is posted under. */
export interface SummaryItem {
  recommendationId: string;
  code: string;
  status: string;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  lineCount: number;
  version: number;
}

/** What the ledger could not take, kept for the accountant. */
export interface RecoveryException {
  id: string;
  recommendationId: string;
  code: string;
  kind: ExceptionKind;
  sourceKind: SourceKind;
  amountVnd: string;
  recordedOn: string;
}

export interface RecoverySummary {
  engagementId: string;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  moneyRate: Rate;
  countRate: Rate;
  recommendations: SummaryItem[];
  exceptions: RecoveryException[];
}

export function toRecoverySummary(raw: unknown): RecoverySummary | undefined {
  const row = asRecord(raw);
  const engagementId = text(row?.engagement_id);
  const amountVnd = dong(row?.amount_vnd);
  const recoveredVnd = dong(row?.recovered_vnd);
  const remainingVnd = dong(row?.remaining_vnd);
  const moneyRate = toRate(row?.money_rate);
  const countRate = toRate(row?.count_rate);
  if (row === undefined || engagementId === undefined || amountVnd === undefined || recoveredVnd === undefined || remainingVnd === undefined || moneyRate === undefined || countRate === undefined) return undefined;
  return {
    engagementId,
    amountVnd,
    recoveredVnd,
    remainingVnd,
    moneyRate,
    countRate,
    recommendations: (Array.isArray(row.recommendations) ? row.recommendations : []).flatMap((item): SummaryItem[] => {
      const entry = asRecord(item);
      const recommendationId = text(entry?.recommendation_id);
      const code = text(entry?.rec_code);
      const status = text(entry?.status);
      const amount = dong(entry?.amount_vnd);
      const recovered = dong(entry?.recovered_vnd);
      const remaining = dong(entry?.remaining_vnd);
      const version = whole(entry?.version);
      if (entry === undefined || recommendationId === undefined || code === undefined || status === undefined || amount === undefined || recovered === undefined || remaining === undefined || version === undefined) return [];
      return [{ recommendationId, code, status, amountVnd: amount, recoveredVnd: recovered, remainingVnd: remaining, lineCount: whole(entry.line_count) ?? 0, version }];
    }),
    exceptions: (Array.isArray(row.exceptions) ? row.exceptions : []).flatMap((item): RecoveryException[] => {
      const entry = asRecord(item);
      const id = text(entry?.id);
      const recommendationId = text(entry?.recommendation_id);
      const code = text(entry?.rec_code);
      const kind = oneOf(EXCEPTION_KINDS, entry?.kind);
      const sourceKind = oneOf(SOURCE_KINDS, entry?.source_kind);
      const amount = dong(entry?.amount_vnd);
      const recordedOn = text(entry?.recorded_on);
      if (entry === undefined || id === undefined || recommendationId === undefined || code === undefined || kind === undefined || sourceKind === undefined || amount === undefined || recordedOn === undefined) return [];
      return [{ id, recommendationId, code, kind, sourceKind, amountVnd: amount, recordedOn }];
    }),
  };
}

/** An engagement of the watch list of the overview. */
export interface WatchedEngagement {
  id: string;
  code: string;
  title: string;
  status: string;
  recommendationsOpen: number;
  recommendationsOverdue: number;
  amountVnd: string;
  recoveredVnd: string;
}

export interface Overview {
  engagementsOngoing: number;
  engagementsFollowUp: number;
  recommendationsOpen: number;
  recommendationsOverdue: number;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  moneyRate: Rate;
  countRate: Rate;
  exceptionsOpen: number;
  engagements: WatchedEngagement[];
}

export function toOverview(raw: unknown): Overview | undefined {
  const row = asRecord(raw);
  const ongoing = whole(row?.engagements_ongoing);
  const followUp = whole(row?.engagements_follow_up);
  const open = whole(row?.recommendations_open);
  const overdue = whole(row?.recommendations_overdue);
  const amountVnd = dong(row?.amount_vnd);
  const recoveredVnd = dong(row?.recovered_vnd);
  const remainingVnd = dong(row?.remaining_vnd);
  const moneyRate = toRate(row?.money_rate);
  const countRate = toRate(row?.count_rate);
  if (row === undefined || ongoing === undefined || followUp === undefined || open === undefined || overdue === undefined) return undefined;
  if (amountVnd === undefined || recoveredVnd === undefined || remainingVnd === undefined || moneyRate === undefined || countRate === undefined) return undefined;
  return {
    engagementsOngoing: ongoing,
    engagementsFollowUp: followUp,
    recommendationsOpen: open,
    recommendationsOverdue: overdue,
    amountVnd,
    recoveredVnd,
    remainingVnd,
    moneyRate,
    countRate,
    exceptionsOpen: whole(row.exceptions_open) ?? 0,
    engagements: (Array.isArray(row.engagements) ? row.engagements : []).flatMap((item): WatchedEngagement[] => {
      const entry = asRecord(item);
      const id = text(entry?.id);
      const code = text(entry?.engagement_code);
      const title = text(entry?.title);
      const status = text(entry?.status);
      const entryOpen = whole(entry?.recommendations_open);
      const entryOverdue = whole(entry?.recommendations_overdue);
      const amount = dong(entry?.amount_vnd);
      const recovered = dong(entry?.recovered_vnd);
      if (entry === undefined || id === undefined || code === undefined || title === undefined || status === undefined || entryOpen === undefined || entryOverdue === undefined || amount === undefined || recovered === undefined) return [];
      return [{ id, code, title, status, recommendationsOpen: entryOpen, recommendationsOverdue: entryOverdue, amountVnd: amount, recoveredVnd: recovered }];
    }),
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The buttons of the ledger: the permission to record, in a tenant that is not read only. */
export const canRecordRecovery = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(RECORD_RECOVERY_PERMISSION)) && mode !== 'READ_ONLY';

/** A line can be reversed once: one that adds money (not a reversal itself) and was not reversed. */
export const canReverse = (line: Pick<RecoveryLine, 'amountVnd' | 'reversed' | 'reversalOfId'>): boolean => line.reversalOfId === null && !line.reversed && !line.amountVnd.startsWith('-');

/** The percentage in the way the language writes it, or `null` for "not applicable". */
export const percentText = (rate: Rate, locale: string): string | null => (rate.percent === null ? null : `${locale === 'vi' ? rate.percent.replace('.', ',') : rate.percent}%`);

/** The recommendations a line can be entered for: financial ones that are not cancelled (they are the ones in the summary). */
export const recoverable = (items: readonly SummaryItem[]): SummaryItem[] => items.filter((item) => item.status !== 'CANCELLED');

type Problems<F> = Partial<Record<keyof F, ConclusionFormProblem>>;

const dayProblem = (value: string): FormProblem | undefined => {
  const day = value.trim();
  if (day === '') return 'required';
  return isDay(day) ? undefined : 'invalid';
};

export interface LinkForm {
  recommendationId: string;
  sourceKind: '' | ManualSource;
  sourceId: string;
  amountVnd: string;
  recordedOn: string;
  evidenceDocumentId: string;
}

export const EMPTY_LINK_FORM: LinkForm = { recommendationId: '', sourceKind: '', sourceId: '', amountVnd: '', recordedOn: '', evidenceDocumentId: '' };

/**
 * What is wrong with a line before it is sent: the recommendation, the source, an amount above zero that fits in what is left of the recommendation (BR-AUD-02), a day that has come and the
 * document that proves it. The server checks the same again under a lock, so two accountants at once cannot both fit.
 */
export function validateLink(form: LinkForm, remainingVnd: string | undefined, today: string): Problems<LinkForm> {
  const problems: Problems<LinkForm> = {};
  if (form.recommendationId === '') problems.recommendationId = 'required';
  if (form.sourceKind === '') problems.sourceKind = 'required';
  if (form.sourceId.trim() !== '' && !isUuid(form.sourceId)) problems.sourceId = 'invalid';
  if (form.amountVnd.trim() === '') problems.amountVnd = 'required';
  else {
    const digits = digitsOf(form.amountVnd);
    if (digits === undefined || digits === '0') problems.amountVnd = 'invalid';
    else if (remainingVnd !== undefined && BigInt(digits) > BigInt(remainingVnd)) problems.amountVnd = 'exceeds';
  }
  const day = dayProblem(form.recordedOn);
  if (day !== undefined) problems.recordedOn = day;
  else if (form.recordedOn.trim() > today) problems.recordedOn = 'future';
  const evidence = form.evidenceDocumentId.trim();
  if (evidence === '') problems.evidenceDocumentId = 'required';
  else if (!isUuid(evidence)) problems.evidenceDocumentId = 'invalid';
  return problems;
}

export interface LinkBody {
  source_kind: ManualSource;
  source_id?: string;
  amount_vnd: string;
  recorded_on: string;
  evidence_document_id: string;
}

export const linkBody = (form: LinkForm): LinkBody => ({
  source_kind: form.sourceKind as ManualSource,
  ...(form.sourceId.trim() === '' ? {} : { source_id: form.sourceId.trim().toLowerCase() }),
  amount_vnd: digitsOf(form.amountVnd) ?? '0',
  recorded_on: form.recordedOn.trim(),
  evidence_document_id: form.evidenceDocumentId.trim().toLowerCase(),
});

export interface ReverseForm {
  reason: string;
}

export const EMPTY_REVERSE_FORM: ReverseForm = { reason: '' };

export function validateReverse(form: ReverseForm): Problems<ReverseForm> {
  const reason = form.reason.trim();
  if (reason === '') return { reason: 'required' };
  if (reason.length < REASON_MIN) return { reason: 'tooShort' };
  if (reason.length > REASON_MAX) return { reason: 'tooLong' };
  return hasControlCharacter(reason.replace(/[\n\r\t]/g, '')) ? { reason: 'invalid' } : {};
}

export const reverseBody = (form: ReverseForm): { reason: string } => ({ reason: form.reason.trim() });

export type RecoveryProblem =
  | 'exceeds'
  | 'sourceLinked'
  | 'notFinancial'
  | 'evidenceRequired'
  | 'alreadyReversed'
  | 'recommendationState'
  | 'engagementState'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RecoveryProblem>> = {
  RECOVERY_EXCEEDS_RECOMMENDATION: 'exceeds',
  RECOVERY_SOURCE_ALREADY_LINKED: 'sourceLinked',
  RECOMMENDATION_NOT_FINANCIAL: 'notFinancial',
  EVIDENCE_REQUIRED: 'evidenceRequired',
  RECOVERY_ALREADY_REVERSED: 'alreadyReversed',
  RECOMMENDATION_STATE_INVALID: 'recommendationState',
  ENGAGEMENT_STATE_INVALID: 'engagementState',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface DescribedRecovery {
  problem: RecoveryProblem;
  /** What is left to recover, when the server refused a line that did not fit. */
  remainingVnd: string | undefined;
}

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message, and a refusal of the amount carries what is left. */
export function describeRecovery(error: unknown): DescribedRecovery {
  if (!(error instanceof ApiError)) return { problem: 'general', remainingVnd: undefined };
  return { problem: PROBLEM_BY_CODE[error.code] ?? 'general', remainingVnd: error.code === 'RECOVERY_EXCEEDS_RECOMMENDATION' ? dong(error.extensions.remaining_vnd) : undefined };
}
