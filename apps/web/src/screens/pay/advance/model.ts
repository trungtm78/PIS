import { ApiError } from '@machvon/api-client';
import { MAX_TEXT, isUuid, signedAmountText } from '../../ctr/change/model';
import type { FormProblem } from '../payment/model';

export { signedAmountText };

/** The permissions of the commands and of the reads (x-permission in openapi.json); the server judges them again, with the scope. */
export const CANCEL_PERMISSION = 'advance.cancel';
export const RECOVER_PERMISSION = 'advance.recover';
export const READ_PERMISSION = 'advance.read';
export const REQUEST_PERMISSION = 'advance.request';
export const ACKNOWLEDGE_PERMISSION = 'advance.alert.ack';

export const LIST_PATH = '/pay/pay-07';
export const BOARD_PATH = '/pay/pay-12';
export const SCHEDULE_PATH = '/ctr/ctr-06';

/** The advances of a contract, or all of them (PAY-07). */
export const listLink = (contractId?: string): string => (contractId === undefined ? LIST_PATH : `${LIST_PATH}?${new URLSearchParams({ contract: contractId }).toString()}`);
/** The schedule of the recovery of the advances of a contract, with one of them in view when it is named (CTR-06). */
export const scheduleLink = (contractId: string, advanceId?: string): string =>
  `${SCHEDULE_PATH}?${new URLSearchParams(advanceId === undefined ? { contract: contractId } : { contract: contractId, advance: advanceId }).toString()}`;

export const STATUSES = ['PLANNED', 'REQUESTED', 'PAID', 'RECOVERING', 'FULLY_RECOVERED', 'CANCELLED'] as const;
export type AdvanceStatus = (typeof STATUSES)[number];

export const KINDS = ['CONTRACT', 'GPMB'] as const;
export type AdvanceKind = (typeof KINDS)[number];

export const BASES = ['COMPENSATION_PAYMENT', 'REFUND', 'OTHER'] as const;
export type RecoveryBasis = (typeof BASES)[number];

const WHOLE = /^(0|[1-9][0-9]{0,23})$/;

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const amount = (value: unknown): string | undefined => (typeof value === 'string' && WHOLE.test(value) ? value : undefined);

export interface Advance {
  id: string;
  status: AdvanceStatus;
  contract: { id: string; code: string; status: string; valueVnd: string; advanceCategory: string };
  projectId: string;
  party: { id: string; role: string; name: string | null; workValueVnd: string };
  trancheNo: number;
  kind: AdvanceKind;
  amountVnd: string;
  capVnd: string;
  capPct: string | null;
  capRuleAwaitingConfirmation: boolean;
  capRuleCxn: string | null;
  paidVnd: string;
  recoveredVnd: string;
  outstandingVnd: string;
  paidOn: string | null;
  thresholdPct: string;
  recoveryDeadline: string | null;
  overdueDays: number | null;
  overdueSince: string | null;
  /** The highest level of the alert that went: 0 for none, 1 to 4 (PAY 3.2 step 4). */
  lastAlertLevel: number;
  /** The plan the person who answers gave for an advance that is overdue: a note and the day it is due. */
  acknowledgement: { note: string; planDueOn: string; by: string; byName: string | null; at: string } | null;
  actions: { cancel: boolean; recordRecovery: boolean; acknowledgeAlert: boolean };
  version: number;
}

export function toAdvance(raw: unknown): Advance | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const party = asRecord(row?.party);
  const actions = asRecord(row?.actions);
  const id = text(row?.id);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const kind = KINDS.find((candidate) => candidate === row?.kind);
  const contractId = text(contract?.id);
  const partyId = text(party?.id);
  const amountVnd = amount(row?.amount_vnd);
  const capVnd = amount(row?.cap_vnd);
  const paidVnd = amount(row?.paid_vnd);
  const recoveredVnd = amount(row?.recovered_vnd);
  const outstandingVnd = amount(row?.outstanding_vnd);
  const valueVnd = amount(contract?.value_vnd);
  const workValueVnd = amount(party?.work_value_vnd);
  const trancheNo = whole(row?.tranche_no);
  const version = whole(row?.version);
  const acknowledged = asRecord(row?.acknowledgement);
  if (
    row === undefined || id === undefined || status === undefined || kind === undefined || contractId === undefined || partyId === undefined || amountVnd === undefined || capVnd === undefined ||
    paidVnd === undefined || recoveredVnd === undefined || outstandingVnd === undefined || valueVnd === undefined || workValueVnd === undefined || trancheNo === undefined || version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    status,
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '', valueVnd, advanceCategory: text(contract?.advance_category) ?? '' },
    projectId: text(row.project_id) ?? '',
    party: { id: partyId, role: text(party?.role) ?? '', name: nullableText(party?.name), workValueVnd },
    trancheNo,
    kind,
    amountVnd,
    capVnd,
    capPct: nullableText(row.cap_pct),
    capRuleAwaitingConfirmation: row.cap_rule_awaiting_confirmation === true,
    capRuleCxn: nullableText(row.cap_rule_cxn),
    paidVnd,
    recoveredVnd,
    outstandingVnd,
    paidOn: nullableText(row.paid_on),
    thresholdPct: text(row.recovery_threshold_pct) ?? '',
    recoveryDeadline: nullableText(row.recovery_deadline),
    overdueDays: whole(row.overdue_days) ?? null,
    overdueSince: nullableText(row.overdue_since),
    lastAlertLevel: whole(row.last_alert_level) ?? 0,
    acknowledgement:
      text(acknowledged?.note) === undefined || text(acknowledged?.action_plan_due_on) === undefined
        ? null
        : { note: text(acknowledged?.note) ?? '', planDueOn: text(acknowledged?.action_plan_due_on) ?? '', by: text(acknowledged?.acknowledged_by) ?? '', byName: nullableText(acknowledged?.acknowledged_by_name), at: text(acknowledged?.acknowledged_at) ?? '' },
    actions: { cancel: actions?.cancel === true, recordRecovery: actions?.record_recovery === true, acknowledgeAlert: actions?.acknowledge_alert === true },
    version,
  };
}

export interface Milestone {
  atPct: number;
  atGrossVnd: string;
  recoveredVnd: string;
}

export interface AdvancePlan {
  advance: Advance;
  thresholdValueVnd: string;
  grossToDateVnd: string;
  remainingToThresholdVnd: string;
  targetRecoveredVnd: string;
  recoveredVnd: string;
  outstandingVnd: string;
  behindVnd: string;
  milestones: Milestone[];
  /** The working assumptions the plan rests on, by code (RULE_AWAITING_CONFIRMATION). */
  warnings: string[];
}

export function toPlan(raw: unknown): AdvancePlan | undefined {
  const row = asRecord(raw);
  const advance = toAdvance(row?.advance);
  const thresholdValueVnd = amount(row?.threshold_value_vnd);
  const grossToDateVnd = amount(row?.gross_to_date_vnd);
  const remainingToThresholdVnd = amount(row?.remaining_to_threshold_vnd);
  const targetRecoveredVnd = amount(row?.target_recovered_vnd);
  const recoveredVnd = amount(row?.recovered_vnd);
  const outstandingVnd = amount(row?.outstanding_vnd);
  const behindVnd = amount(row?.behind_vnd);
  if (row === undefined || advance === undefined || thresholdValueVnd === undefined || grossToDateVnd === undefined || remainingToThresholdVnd === undefined || targetRecoveredVnd === undefined || recoveredVnd === undefined || outstandingVnd === undefined || behindVnd === undefined) {
    return undefined;
  }
  const milestones = (Array.isArray(row.milestones) ? row.milestones : []).flatMap((entry): Milestone[] => {
    const item = asRecord(entry);
    const atPct = whole(item?.at_pct);
    const atGrossVnd = amount(item?.at_gross_vnd);
    const milestoneRecovered = amount(item?.recovered_vnd);
    return atPct === undefined || atGrossVnd === undefined || milestoneRecovered === undefined ? [] : [{ atPct, atGrossVnd, recoveredVnd: milestoneRecovered }];
  });
  const warnings = (Array.isArray(row.warnings) ? row.warnings : []).flatMap((entry) => text(asRecord(entry)?.code) ?? []);
  return { advance, thresholdValueVnd, grossToDateVnd, remainingToThresholdVnd, targetRecoveredVnd, recoveredVnd, outstandingVnd, behindVnd, milestones, warnings };
}

export interface AdvanceAnswer {
  id: string;
  status: string;
  version: number;
  recoveredVnd: string;
  outstandingVnd: string;
}

export function toAnswer(value: unknown): AdvanceAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  const recoveredVnd = amount(row?.recovered_vnd);
  const outstandingVnd = amount(row?.outstanding_vnd);
  if (row === undefined || id === undefined || version === undefined || recoveredVnd === undefined || outstandingVnd === undefined) return undefined;
  return { id, status: text(row.status) ?? '', version, recoveredVnd, outstandingVnd };
}

// ---- what the screens decide -----------------------------------------------------------------------------------------------

/** Whether the day an advance had to be back by has gone by with something still owed (PAY-07). */
export const isOverdue = (advance: Advance): boolean => advance.overdueDays !== null && advance.overdueDays > 0;

/** The levels of the alert of PAY-12, from the warning before the deadline to the escalation to the leader. */
export const ALERT_LEVELS = [1, 2, 3, 4] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** The share of the advance that has come back, as a whole percentage for the bar of the schedule (nothing paid is nothing recovered). */
export function recoveredShare(advance: Pick<Advance, 'paidVnd' | 'recoveredVnd'>): number {
  const paid = BigInt(advance.paidVnd);
  return paid === 0n ? 0 : Number((BigInt(advance.recoveredVnd) * 100n) / paid);
}

// ---- the commands ------------------------------------------------------------------------------------------------------------

type FormProblems<F> = Partial<Record<keyof F, FormProblem>>;

const requiredText = (value: string, max: number): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > max ? 'tooLong' : undefined);

export interface RecoveryForm {
  amount: string;
  basis: RecoveryBasis | '';
  sourceRef: string;
  evidenceId: string;
}

export const EMPTY_RECOVERY: RecoveryForm = { amount: '', basis: '', sourceRef: '', evidenceId: '' };

export function validateRecovery(form: RecoveryForm): FormProblems<RecoveryForm> {
  const problems: FormProblems<RecoveryForm> = {};
  const value = form.amount.trim();
  if (value === '') problems.amount = 'required';
  else if (!WHOLE.test(value) || BigInt(value) === 0n) problems.amount = 'amount';
  if (form.basis === '') problems.basis = 'required';
  if (form.sourceRef.trim() !== '' && !isUuid(form.sourceRef.trim())) problems.sourceRef = 'uuid';
  const evidence = form.evidenceId.trim();
  if (evidence === '') problems.evidenceId = 'required';
  else if (!isUuid(evidence)) problems.evidenceId = 'uuid';
  return problems;
}

export interface RecoveryBody {
  amount_vnd: string;
  basis: RecoveryBasis;
  source_ref_id?: string;
  evidence_document_version_id: string;
}

export function recoveryBody(form: RecoveryForm): RecoveryBody {
  const source = form.sourceRef.trim().toLowerCase();
  return {
    amount_vnd: form.amount.trim(),
    basis: form.basis === '' ? 'OTHER' : form.basis,
    ...(source === '' ? {} : { source_ref_id: source }),
    evidence_document_version_id: form.evidenceId.trim().toLowerCase(),
  };
}

export interface AcknowledgeForm {
  note: string;
  planDueOn: string;
}

export const EMPTY_ACKNOWLEDGE: AcknowledgeForm = { note: '', planDueOn: '' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** The day in Vietnam (UTC+7), the day a plan is judged by. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** The plan of recovery of an advance that is overdue: a note, and a day that is not before today. */
export function validateAcknowledge(form: AcknowledgeForm, today: string): FormProblems<AcknowledgeForm> {
  const problems: FormProblems<AcknowledgeForm> = {};
  const note = requiredText(form.note, MAX_TEXT);
  if (note !== undefined) problems.note = note;
  if (form.planDueOn === '') problems.planDueOn = 'required';
  else if (!isDay(form.planDueOn) || form.planDueOn < today) problems.planDueOn = 'date';
  return problems;
}

export const acknowledgeBody = (form: AcknowledgeForm): { note: string; action_plan_due_on: string } => ({ note: form.note.trim(), action_plan_due_on: form.planDueOn });

export interface CancelForm {
  reason: string;
}

export const EMPTY_CANCEL: CancelForm = { reason: '' };

export function validateCancel(form: CancelForm): FormProblems<CancelForm> {
  const problem = requiredText(form.reason, MAX_TEXT);
  return problem === undefined ? {} : { reason: problem };
}

export const cancelBody = (form: CancelForm): { reason: string } => ({ reason: form.reason.trim() });

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'notOverdue'
  | 'recoveryExceeded'
  | 'stateInvalid'
  | 'documentNotClean'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'ADVANCE_NOT_OVERDUE':
      return 'notOverdue';
    case 'ADVANCE_RECOVERY_EXCEEDED':
      return 'recoveryExceeded';
    case 'ADVANCE_STATE_INVALID':
      return 'stateInvalid';
    case 'DOCUMENT_NOT_CLEAN':
      return 'documentNotClean';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
