import { MAX_TEXT, isDate, isUuid } from '../workspace/model';
import type { FormProblem, HaltAction } from '../workspace/model';

/** The longest extension of the schedule a resumption may ask for, in days (the server refuses more). */
export const MAX_EXTENSION_DAYS = 3650;

export const GUARANTEE_ACTIONS = ['CALL', 'RELEASE', 'HOLD'] as const;
export type GuaranteeAction = (typeof GUARANTEE_ACTIONS)[number];

/** The permissions of the three commands (x-permission in openapi.json); the server judges each one again, with the scope and, for the termination, the delegation limit. */
export const SUSPEND_PERMISSION = 'contract.suspend';
export const TERMINATE_PERMISSION = 'contract.terminate';

export interface HaltForm {
  action: HaltAction | '';
  reason: string;
  documentVersionId: string;
  /** The day it takes effect: the first day of the suspension, the day of the resumption, the day of the termination. */
  day: string;
  /** Days of extension asked for on a resumption; empty for none. */
  extensionDays: string;
  guaranteeAction: GuaranteeAction | '';
  /** The termination cannot be undone: the person says they know. */
  confirmed: boolean;
}

export const emptyHalt = (today: string, action: HaltAction | ''): HaltForm => ({ action, reason: '', documentVersionId: '', day: today, extensionDays: '', guaranteeAction: '', confirmed: false });

type Problems = Partial<Record<keyof HaltForm, FormProblem>>;

const wholeDays = (value: string): number | undefined => (/^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : undefined);

/** What the person has not yet said, in the order of the form; an action has to be chosen first. */
export function validateHalt(form: HaltForm, today: string): Problems {
  const problems: Problems = {};
  if (form.action === '') {
    problems.action = 'required';
    return problems;
  }
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  if (form.documentVersionId.trim() === '') problems.documentVersionId = 'required';
  else if (!isUuid(form.documentVersionId)) problems.documentVersionId = 'uuid';
  if (form.day.trim() === '') problems.day = 'required';
  else if (!isDate(form.day)) problems.day = 'date';
  else if (form.day.trim() > today) problems.day = 'future';
  if (form.action === 'resume' && form.extensionDays.trim() !== '') {
    const days = wholeDays(form.extensionDays);
    if (days === undefined || days < 1 || days > MAX_EXTENSION_DAYS) problems.extensionDays = 'extension';
  }
  if (form.action === 'terminate') {
    if (form.guaranteeAction === '') problems.guaranteeAction = 'required';
    if (!form.confirmed) problems.confirmed = 'confirm';
  }
  return problems;
}

export interface SuspendBody {
  reason: string;
  decision_document_version_id: string;
  suspended_from: string;
}

export interface ResumeBody {
  reason: string;
  decision_document_version_id: string;
  resumed_on: string;
  extension_days?: number;
}

export interface TerminateBody {
  reason: string;
  decision_document_version_id: string;
  terminated_on: string;
  guarantee_action: GuaranteeAction;
}

export type HaltBody = SuspendBody | ResumeBody | TerminateBody;

/** The body of the command the form asks for; call it once the form is valid. */
export function haltBody(form: HaltForm): HaltBody {
  const common = { reason: form.reason.trim(), decision_document_version_id: form.documentVersionId.trim().toLowerCase() };
  const day = form.day.trim();
  switch (form.action) {
    case 'resume': {
      const days = wholeDays(form.extensionDays);
      return { ...common, resumed_on: day, ...(days === undefined ? {} : { extension_days: days }) };
    }
    case 'terminate':
      return { ...common, terminated_on: day, guarantee_action: form.guaranteeAction === '' ? 'HOLD' : form.guaranteeAction };
    default:
      return { ...common, suspended_from: day };
  }
}

/** The operation each action runs. */
export const OPERATIONS: Record<HaltAction, 'suspendContract' | 'resumeContract' | 'terminateContract'> = {
  suspend: 'suspendContract',
  resume: 'resumeContract',
  terminate: 'terminateContract',
};
