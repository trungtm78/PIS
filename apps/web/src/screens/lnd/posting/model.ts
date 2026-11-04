import { ApiError } from '@machvon/api-client';
import { TIMER_CODES, daysBetween, isDay, isUuid } from '../model';
import type { TimerCode } from '../model';
import type { PlanLine } from '../plan/model';
import { hasControlCharacter } from '../../control-characters';

/** LND-06: the posting of a plan to the households for the days of the rule, the opinions on it, the closing of the posting and the approval (ST-LND-006, LND 3.1 steps 5-6, BR-LND-02). */
export const POSTING_PATH = '/lnd/lnd-06';

/** The permissions that gate the buttons of this screen; the server decides again on every request (the project and the units of the households included). */
export const WRITE_PERMISSION = 'land.plan.write';
export const APPROVE_PERMISSION = 'land.plan.approve';

export const FEEDBACK_CHANNELS = ['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING'] as const;
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

export const FEEDBACK_STATUSES = ['OPEN', 'HANDLED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const TIMER_STATUSES = ['RUNNING', 'SATISFIED', 'BREACHED', 'CANCELLED'] as const;
export type TimerStatus = (typeof TIMER_STATUSES)[number];

export const TEXT_MAX_LENGTH = 2000;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** An opinion on a plan, as the list answers it; the words are read only inside the unit they came from. */
export interface FeedbackLine {
  id: string;
  householdId: string | null;
  householdCode: string | null;
  channel: FeedbackChannel;
  summary: string;
  status: FeedbackStatus;
  recordedOn: string;
  handledOn: string | null;
  handlingNote: string | null;
}

/** An opinion the screen cannot read is dropped rather than shown half. */
export function toFeedbackLine(raw: unknown): FeedbackLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const channel = oneOf(FEEDBACK_CHANNELS, row?.channel);
  const summary = text(row?.summary);
  const status = oneOf(FEEDBACK_STATUSES, row?.status);
  const recordedOn = text(row?.recorded_on);
  if (row === undefined || id === undefined || channel === undefined || summary === undefined || status === undefined || recordedOn === undefined) return undefined;
  return {
    id,
    householdId: nullableText(row.household_id),
    householdCode: nullableText(row.household_code),
    channel,
    summary,
    status,
    recordedOn,
    handledOn: nullableText(row.handled_on),
    handlingNote: nullableText(row.handling_note),
  };
}

/** A timer of the plan with the rule that counted it and what is left of it on the day the server answered. */
export interface TimerLine {
  id: string;
  timerCode: TimerCode;
  daysApplied: number;
  startedOn: string;
  dueOn: string;
  satisfiedOn: string | null;
  status: TimerStatus;
  remainingDays: number | null;
  legalBasis: string | null;
  awaitingConfirmation: boolean;
}

/** The timers of a plan and its opinions counted (numbers, never words). */
export interface PlanTimers {
  planId: string;
  status: string;
  postingStartedOn: string | null;
  postingEndsOn: string | null;
  approvedOn: string | null;
  paymentDueOn: string | null;
  paymentRemainingDays: number | null;
  feedbackOpen: number;
  feedbackHandled: number;
  deadlines: TimerLine[];
}

function toTimerLine(raw: unknown): TimerLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const timerCode = oneOf(TIMER_CODES, row?.timer_code);
  const daysApplied = whole(row?.days_applied);
  const startedOn = text(row?.started_on);
  const dueOn = text(row?.due_on);
  const status = oneOf(TIMER_STATUSES, row?.status);
  if (row === undefined || id === undefined || timerCode === undefined || daysApplied === undefined || startedOn === undefined || dueOn === undefined || status === undefined) return undefined;
  return {
    id,
    timerCode,
    daysApplied,
    startedOn,
    dueOn,
    satisfiedOn: nullableText(row.satisfied_on),
    status,
    remainingDays: nullableWhole(row.remaining_days),
    legalBasis: nullableText(row.legal_basis),
    awaitingConfirmation: row.awaiting_confirmation === true,
  };
}

/** The timers as the read answers them; an answer that is not one is nothing rather than a guess. */
export function toPlanTimers(raw: unknown): PlanTimers | undefined {
  const row = asRecord(raw);
  const planId = text(row?.plan_id);
  const status = text(row?.status);
  const open = whole(row?.feedback_open);
  const handled = whole(row?.feedback_handled);
  if (row === undefined || planId === undefined || status === undefined || open === undefined || handled === undefined) return undefined;
  return {
    planId,
    status,
    postingStartedOn: nullableText(row.posting_started_on),
    postingEndsOn: nullableText(row.posting_ends_on),
    approvedOn: nullableText(row.approved_on),
    paymentDueOn: nullableText(row.payment_due_on),
    paymentRemainingDays: nullableWhole(row.payment_remaining_days),
    feedbackOpen: open,
    feedbackHandled: handled,
    deadlines: (Array.isArray(row.deadlines) ? row.deadlines : []).flatMap((entry) => toTimerLine(entry) ?? []),
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
export const canWritePosting = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, WRITE_PERMISSION, mode);
export const canApprovePlan = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, APPROVE_PERMISSION, mode);

/** The plans that have something to do with a posting: a draft that can be posted, a plan that is posted, one whose posting closed and one that was approved. */
export const POSTING_STATUSES: readonly PlanLine['status'][] = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED'];
export const postingPlans = (plans: readonly PlanLine[]): PlanLine[] => plans.filter((plan) => POSTING_STATUSES.includes(plan.status));

/** A draft with something in it is posted (the server refuses an empty one again). */
export const canPost = (plan: PlanLine): boolean => plan.status === 'DRAFT' && plan.grandTotalVnd !== '0';
export const takesFeedback = (plan: PlanLine): boolean => plan.status === 'POSTING';
export const handlesFeedback = (plan: PlanLine): boolean => plan.status === 'POSTING' || plan.status === 'POSTING_CLOSED';
export const canApproveIt = (plan: PlanLine): boolean => plan.status === 'POSTING_CLOSED';

/** The posting is closed on the day it ends or after it, never before (the server counts again). */
export const postingElapsed = (plan: PlanLine, today: string): boolean => plan.status === 'POSTING' && plan.postingEndsOn !== null && today >= plan.postingEndsOn;
export const daysLeft = (plan: PlanLine, today: string): number | null => (plan.postingEndsOn === null ? null : daysBetween(today, plan.postingEndsOn));

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'future' | 'early';

const wordsProblem = (value: string): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length > TEXT_MAX_LENGTH) return 'tooLong';
  return hasControlCharacter(words) ? 'invalid' : undefined;
};

export interface PostForm {
  postingStartedOn: string;
  postingPlaceText: string;
}

export const EMPTY_POST_FORM: PostForm = { postingStartedOn: '', postingPlaceText: '' };

/** A posting starts on a day that has come; the days it lasts are those of the rule, said after. */
export function validatePost(form: PostForm, today: string): Partial<Record<keyof PostForm, FormProblem>> {
  const problems: Partial<Record<keyof PostForm, FormProblem>> = {};
  const day = form.postingStartedOn.trim();
  if (day === '') problems.postingStartedOn = 'required';
  else if (!isDay(day)) problems.postingStartedOn = 'invalid';
  else if (day > today) problems.postingStartedOn = 'future';
  const place = wordsProblem(form.postingPlaceText);
  if (place !== undefined) problems.postingPlaceText = place;
  return problems;
}

export const postBody = (form: PostForm): { posting_started_on: string; posting_place_text: string } => ({ posting_started_on: form.postingStartedOn.trim(), posting_place_text: form.postingPlaceText.trim() });

export interface FeedbackForm {
  householdId: string;
  channel: '' | FeedbackChannel;
  summary: string;
}

export const EMPTY_FEEDBACK_FORM: FeedbackForm = { householdId: '', channel: '', summary: '' };

export function validateFeedback(form: FeedbackForm): Partial<Record<keyof FeedbackForm, FormProblem>> {
  const problems: Partial<Record<keyof FeedbackForm, FormProblem>> = {};
  if (form.channel === '') problems.channel = 'required';
  const summary = wordsProblem(form.summary);
  if (summary !== undefined) problems.summary = summary;
  return problems;
}

export interface FeedbackBody {
  summary: string;
  channel: FeedbackChannel;
  household_id?: string;
}

/** An opinion names the household it came from when it came from one on the list; otherwise it is the opinion of somebody else. */
export function feedbackBody(form: FeedbackForm): FeedbackBody {
  const body: FeedbackBody = { summary: form.summary.trim(), channel: form.channel as FeedbackChannel };
  if (form.householdId !== '') body.household_id = form.householdId;
  return body;
}

export interface NoteForm {
  note: string;
}

export const EMPTY_NOTE_FORM: NoteForm = { note: '' };

/** The words of a handling and of the summary of the opinions at the closing: in words, up to 2000 characters. */
export function validateNote(form: NoteForm): Partial<Record<keyof NoteForm, FormProblem>> {
  const problem = wordsProblem(form.note);
  return problem === undefined ? {} : { note: problem };
}

export interface ApproveForm {
  approvedOn: string;
  decisionDocumentVersionId: string;
}

export const EMPTY_APPROVE_FORM: ApproveForm = { approvedOn: '', decisionDocumentVersionId: '' };

/** An approval is dated a day that has come and is not before the posting ended, and rests on a decision document. */
export function validateApprove(form: ApproveForm, plan: PlanLine, today: string): Partial<Record<keyof ApproveForm, FormProblem>> {
  const problems: Partial<Record<keyof ApproveForm, FormProblem>> = {};
  const day = form.approvedOn.trim();
  if (day === '') problems.approvedOn = 'required';
  else if (!isDay(day)) problems.approvedOn = 'invalid';
  else if (day > today) problems.approvedOn = 'future';
  else if (plan.postingEndsOn !== null && day < plan.postingEndsOn) problems.approvedOn = 'early';
  const document = form.decisionDocumentVersionId.trim();
  if (document === '') problems.decisionDocumentVersionId = 'required';
  else if (!isUuid(document)) problems.decisionDocumentVersionId = 'invalid';
  return problems;
}

export const approveBody = (form: ApproveForm): { approved_on: string; decision_document_version_id: string } => ({
  approved_on: form.approvedOn.trim(),
  decision_document_version_id: form.decisionDocumentVersionId.trim().toLowerCase(),
});

export type CommandProblem =
  | 'stateInvalid'
  | 'noItems'
  | 'notConfirmed'
  | 'ruleUnconfirmed'
  | 'notElapsed'
  | 'unresolved'
  | 'selfApproval'
  | 'decisionRequired'
  | 'documentNotClean'
  | 'alreadyHandled'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  PLAN_STATE_INVALID: 'stateInvalid',
  PLAN_HAS_NO_ITEMS: 'noItems',
  INVENTORY_NOT_CONFIRMED: 'notConfirmed',
  TIMER_RULE_UNCONFIRMED: 'ruleUnconfirmed',
  POSTING_PERIOD_NOT_ELAPSED: 'notElapsed',
  UNRESOLVED_FEEDBACK: 'unresolved',
  SELF_APPROVAL_DENIED: 'selfApproval',
  DECISION_DOCUMENT_REQUIRED: 'decisionRequired',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  FEEDBACK_ALREADY_HANDLED: 'alreadyHandled',
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
