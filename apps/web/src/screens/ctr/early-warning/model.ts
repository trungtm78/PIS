import type { components } from '@machvon/contracts';
import { daysProblem, isDay, isUuid, isWholeAmount, optionalNumber, optionalText, textProblem } from '../claims/common';
import type { FormProblem } from '../claims/common';

type Schemas = components['schemas'];

export type WarningPage = Schemas['CtrEarlyWarningPage'];
export type WarningLine = Schemas['CtrEarlyWarningLine'];
export type Warning = Schemas['CtrEarlyWarning'];
export type WarningAction = Schemas['CtrEarlyWarningAction'];
export type WarningSummary = Schemas['CtrEarlyWarningSummary'];
export type Register = Schemas['CtrEarlyWarningRegister'];
export type RegisterClock = Schemas['CtrRegisterClock'];
export type RegisterMeeting = Schemas['CtrEarlyWarningMeeting'];
export type RegisterIssue = Schemas['CtrEarlyWarningIssue'];

export const READ_PERMISSION = 'early_warning.read';
export const RAISE_PERMISSION = 'early_warning.raise';
export const MANAGE_PERMISSION = 'early_warning.manage';
export const CLOSE_PERMISSION = 'early_warning.close';

export const PATHS = { register: '/ctr/ctr-35', record: '/ctr/ctr-36', claim: '/ctr/ctr-33' } as const;

export const STATUSES: readonly Warning['status'][] = ['RAISED', 'ASSESSED', 'MITIGATING', 'CLOSED_RESOLVED', 'CLOSED_MATERIALISED', 'CLOSED_WITHDRAWN'];
export const CATEGORIES: readonly Warning['category'][] = ['TIME', 'COST', 'QUALITY', 'SAFETY', 'SCOPE', 'LEGAL', 'ENVIRONMENT', 'OTHER'];
export const PARTIES: readonly Warning['raised_by_party'][] = ['OWNER', 'CONTRACTOR', 'SUPERVISOR', 'DESIGNER', 'OTHER'];
export const LIKELIHOODS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const REVIEW_OUTCOMES = ['NO_CHANGE', 'UPDATED', 'ACTION_AGREED', 'CLOSURE_PROPOSED', 'ESCALATED'] as const;
export const CLOSE_OUTCOMES = ['RESOLVED', 'MATERIALISED', 'WITHDRAWN'] as const;
export const MIN_TEXT = 5;
export const MIN_REASON = 10;
export const MAX_TITLE = 200;
export const MAX_TEXT = 2000;

export const isOpen = (status: Warning['status']): boolean => status === 'RAISED' || status === 'ASSESSED' || status === 'MITIGATING';

// ---- the filter -------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WarningFilter {
  contractId: string;
  status: string;
  category: string;
  party: string;
  open: boolean;
  mine: boolean;
}

export const EMPTY_FILTER: WarningFilter = { contractId: '', status: '', category: '', party: '', open: false, mine: false };
export const isFiltered = (filter: WarningFilter): boolean => JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);

export function queryOf(filter: WarningFilter, cursor?: string): Record<string, string | number | boolean> {
  return {
    limit: 50,
    ...(filter.contractId === '' ? {} : { contract_id: filter.contractId }),
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.category === '' ? {} : { category: filter.category }),
    ...(filter.party === '' ? {} : { raised_by_party: filter.party }),
    ...(filter.open ? { open: true } : {}),
    ...(filter.mine ? { mine: true } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

// ---- forms ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type FormErrors<F> = Partial<Record<keyof F, FormProblem>>;

export interface RaiseForm {
  title: string;
  description: string;
  category: string;
  party: string;
  raisedOn: string;
}
export const emptyRaise = (today: string): RaiseForm => ({ title: '', description: '', category: 'TIME', party: 'CONTRACTOR', raisedOn: today });

export function validateRaise(form: RaiseForm, today: string): FormErrors<RaiseForm> {
  const errors: FormErrors<RaiseForm> = {};
  const title = textProblem(form.title, MIN_TEXT, MAX_TITLE);
  if (title !== undefined) errors.title = title;
  const description = textProblem(form.description, MIN_TEXT, MAX_TEXT);
  if (description !== undefined) errors.description = description;
  if (!(CATEGORIES as readonly string[]).includes(form.category)) errors.category = 'pickOne';
  if (!(PARTIES as readonly string[]).includes(form.party)) errors.party = 'pickOne';
  if (!isDay(form.raisedOn) || form.raisedOn > today) errors.raisedOn = 'invalidDay';
  return errors;
}

export const raiseBody = (form: RaiseForm): Schemas['CtrEarlyWarningRaise'] => ({
  title: form.title.trim(),
  description: form.description.trim(),
  category: form.category as Warning['category'],
  raised_by_party: form.party as Warning['raised_by_party'],
  raised_on: form.raisedOn,
});

export interface AssessForm {
  ownerId: string;
  likelihood: string;
  timeDays: string;
  costVnd: string;
  noImpact: boolean;
}
export const assessFormOf = (warning: Pick<Warning, 'owner_membership_id' | 'likelihood' | 'expected_time_days' | 'expected_cost_vnd' | 'no_impact_expected'>): AssessForm => ({
  ownerId: warning.owner_membership_id ?? '',
  likelihood: warning.likelihood ?? '',
  timeDays: warning.expected_time_days === null ? '' : String(warning.expected_time_days),
  costVnd: warning.expected_cost_vnd ?? '',
  noImpact: warning.no_impact_expected,
});

/** An assessment names the person who answers for the warning, the likelihood and the expected impact on time and cost: a figure, or the statement that none is expected (never a blank). */
export function validateAssess(form: AssessForm): FormErrors<AssessForm> {
  const errors: FormErrors<AssessForm> = {};
  if (!isUuid(form.ownerId)) errors.ownerId = 'pickOne';
  if (!(LIKELIHOODS as readonly string[]).includes(form.likelihood)) errors.likelihood = 'pickOne';
  const days = daysProblem(form.timeDays, 0, 3650);
  if (days !== undefined) errors.timeDays = days;
  if (form.costVnd.trim() !== '' && !isWholeAmount(form.costVnd.trim())) errors.costVnd = 'invalidAmount';
  const hasFigure = form.timeDays.trim() !== '' || form.costVnd.trim() !== '';
  if (form.noImpact && hasFigure) errors.noImpact = 'pickOne';
  if (!form.noImpact && !hasFigure && errors.timeDays === undefined) errors.timeDays = 'required';
  return errors;
}

export function assessBody(form: AssessForm): Schemas['CtrEarlyWarningAssess'] {
  const days = optionalNumber(form.timeDays);
  const cost = optionalText(form.costVnd);
  return {
    owner_membership_id: form.ownerId,
    likelihood: form.likelihood as (typeof LIKELIHOODS)[number],
    ...(days === undefined ? {} : { expected_time_days: days }),
    ...(cost === undefined ? {} : { expected_cost_vnd: cost }),
    ...(form.noImpact ? { no_impact_expected: true } : {}),
  };
}

export interface ActionForm {
  description: string;
  ownerId: string;
  dueOn: string;
}
export const emptyAction = (today: string): ActionForm => ({ description: '', ownerId: '', dueOn: today });

export function validateAction(form: ActionForm, today: string): FormErrors<ActionForm> {
  const errors: FormErrors<ActionForm> = {};
  const description = textProblem(form.description, MIN_TEXT, MAX_TEXT);
  if (description !== undefined) errors.description = description;
  if (!isUuid(form.ownerId)) errors.ownerId = 'pickOne';
  if (!isDay(form.dueOn) || form.dueOn < today) errors.dueOn = 'invalidDay';
  return errors;
}

export const actionBody = (form: ActionForm): Schemas['CtrEarlyWarningActionCreate'] => ({ description: form.description.trim(), owner_membership_id: form.ownerId, due_on: form.dueOn });

export interface CloseForm {
  outcome: string;
  into: string;
  materialisedId: string;
}
export const emptyClose = (): CloseForm => ({ outcome: 'RESOLVED', into: 'CHANGE_REQUEST', materialisedId: '' });

export function validateClose(form: CloseForm, reason: string, openActions: number): { errors: FormErrors<CloseForm>; reason: FormProblem | undefined; actionsOpen: boolean } {
  const errors: FormErrors<CloseForm> = {};
  if (!(CLOSE_OUTCOMES as readonly string[]).includes(form.outcome)) errors.outcome = 'pickOne';
  if (form.outcome === 'MATERIALISED') {
    if (!['CHANGE_REQUEST', 'CLAIM'].includes(form.into)) errors.into = 'pickOne';
    if (!isUuid(form.materialisedId.trim())) errors.materialisedId = 'invalidId';
  }
  return { errors, reason: textProblem(reason, MIN_REASON, MAX_TEXT), actionsOpen: form.outcome === 'RESOLVED' && openActions > 0 };
}

export const closeBody = (form: CloseForm, reason: string): Schemas['CtrEarlyWarningClose'] => ({
  outcome: form.outcome as (typeof CLOSE_OUTCOMES)[number],
  reason: reason.trim(),
  ...(form.outcome === 'MATERIALISED' ? { materialised_into: form.into as 'CHANGE_REQUEST' | 'CLAIM', materialised_id: form.materialisedId.trim() } : {}),
});

export interface MeetingForm {
  heldOn: string;
  attendees: string;
  notes: string;
  /** What the meeting concluded about each open warning, by id; an open warning without an outcome is a review that was skipped. */
  outcomes: Record<string, string>;
  notesOf: Record<string, string>;
}
export const emptyMeeting = (today: string): MeetingForm => ({ heldOn: today, attendees: '', notes: '', outcomes: {}, notesOf: {} });

/** The meeting reviews every warning that is open, exactly once: the form refuses one that leaves an open warning without a conclusion. */
export function validateMeeting(form: MeetingForm, open: readonly string[], today: string, lastMeetingOn: string | null, startOn: string | null): { errors: FormErrors<MeetingForm>; missing: string[] } {
  const errors: FormErrors<MeetingForm> = {};
  if (!isDay(form.heldOn) || form.heldOn > today || (lastMeetingOn !== null && form.heldOn <= lastMeetingOn) || (startOn !== null && form.heldOn < startOn)) errors.heldOn = 'invalidDay';
  const attendees = textProblem(form.attendees, MIN_TEXT, MAX_TEXT);
  if (attendees !== undefined) errors.attendees = attendees;
  const missing = open.filter((id) => !(REVIEW_OUTCOMES as readonly string[]).includes(form.outcomes[id] ?? ''));
  return { errors, missing };
}

export function meetingBody(form: MeetingForm, open: readonly string[]): Schemas['CtrEarlyWarningMeetingRecord'] {
  const notes = optionalText(form.notes);
  return {
    held_on: form.heldOn,
    attendees: form.attendees.trim(),
    ...(notes === undefined ? {} : { notes }),
    reviews: open.map((id) => {
      const note = optionalText(form.notesOf[id] ?? '');
      return { warning_id: id, outcome: form.outcomes[id] as (typeof REVIEW_OUTCOMES)[number], ...(note === undefined ? {} : { note }) };
    }),
  };
}

export interface IssueForm {
  issuedOn: string;
  meetingId: string;
}

export function validateIssue(form: IssueForm, today: string): FormErrors<IssueForm> {
  const errors: FormErrors<IssueForm> = {};
  if (!isDay(form.issuedOn) || form.issuedOn > today) errors.issuedOn = 'invalidDay';
  return errors;
}

export const issueBody = (form: IssueForm): Schemas['CtrEarlyWarningIssueRecord'] => ({ issued_on: form.issuedOn, ...(form.meetingId === '' ? {} : { meeting_id: form.meetingId }) });

/** The meetings that still wait for the register to be issued again (latest first). */
export const meetingsAwaitingIssue = (register: Pick<Register, 'meetings'>): RegisterMeeting[] => register.meetings.filter((meeting) => meeting.reissued_on === null);
