import type { components } from '@machvon/contracts';
import { daysProblem, isDay, isUuid, isWholeAmount, optionalNumber, optionalText, textProblem } from './common';
import type { FormProblem } from './common';

type Schemas = components['schemas'];

export type ClaimPage = Schemas['CtrClaimPage'];
export type ClaimLine = Schemas['CtrClaimLine'];
export type ClaimTotals = Schemas['CtrClaimTotals'];
export type Claim = Schemas['CtrClaim'];
export type ClaimStep = Schemas['CtrClaimStep'];
export type ClaimDeadline = Schemas['CtrClaimDeadline'];
export type ClaimTerm = Schemas['CtrClaimTerm'];
export type ClaimTermList = Schemas['CtrClaimTermList'];
export type ClaimTermTemplate = Schemas['CtrClaimTermTemplate'];

export const READ_PERMISSION = 'claim.read';
export const MANAGE_PERMISSION = 'claim.manage';
export const SETTLE_PERMISSION = 'claim.settle';
export const BAR_PERMISSION = 'claim.bar';
export const TERM_PROPOSE_PERMISSION = 'claim.term.propose';
export const TERM_APPROVE_PERMISSION = 'claim.term.approve';

export const PATHS = { register: '/ctr/ctr-32', record: '/ctr/ctr-33', terms: '/ctr/ctr-34', warnings: '/ctr/ctr-35' } as const;

export const SIDES = ['CONTRACTOR', 'OWNER'] as const;
export type Side = (typeof SIDES)[number];
export const KINDS_BY_SIDE: Readonly<Record<Side, readonly Claim['kind'][]>> = {
  CONTRACTOR: ['EXTENSION_OF_TIME', 'ADDITIONAL_PAYMENT', 'TIME_AND_COST', 'OTHER'],
  OWNER: ['DELAY_DAMAGES', 'DEFECT_COST', 'SET_OFF', 'OTHER'],
};
export const STATUSES: readonly Claim['status'][] = ['EVENT_RECORDED', 'NOTICE_SERVED', 'PARTICULARS_SUBMITTED', 'RESPONDED', 'SETTLEMENT_PROPOSED', 'SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED'];
export const LIMITATIONS: readonly Claim['limitation']['status'][] = ['NO_TERM', 'NOT_DEFINED', 'CALENDAR_UNAVAILABLE', 'RUNNING', 'APPROACHING', 'MISSED', 'MET', 'MET_LATE', 'BARRED', 'CLOSED'];
export const DEADLINE_CODES = ['NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT'] as const;
export const DECISIONS = ['ACCEPTED', 'PARTLY_ACCEPTED', 'REJECTED', 'MORE_INFORMATION_REQUESTED'] as const;
export const RECORDABLE_STEPS = ['NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'WITHDRAWAL', 'REFERRAL'] as const;
export type RecordableStep = (typeof RECORDABLE_STEPS)[number];
export const BASES = ['CALENDAR_DAYS', 'WORKING_DAYS'] as const;
export const EFFECTS = ['BARS_CLAIM', 'REDUCES_RELIEF', 'NONE', 'NOT_STATED'] as const;
export const MIN_TEXT = 5;
export const MAX_TITLE = 200;
export const MAX_TEXT = 2000;
export const MAX_CLAUSE = 200;

// ---- the register filter ------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ClaimFilter {
  contractId: string;
  status: string;
  side: string;
  limitation: string;
  open: boolean;
  mine: boolean;
}

export const EMPTY_FILTER: ClaimFilter = { contractId: '', status: '', side: '', limitation: '', open: false, mine: false };

export const isFiltered = (filter: ClaimFilter): boolean => JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);

/** The query of the register read: only what the person chose is sent. */
export function queryOf(filter: ClaimFilter, cursor?: string): Record<string, string | number | boolean> {
  return {
    limit: 50,
    ...(filter.contractId === '' ? {} : { contract_id: filter.contractId }),
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.side === '' ? {} : { claimant_side: filter.side }),
    ...(filter.limitation === '' ? {} : { limitation: filter.limitation }),
    ...(filter.open ? { open: true } : {}),
    ...(filter.mine ? { mine: true } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The date a row of the register is counted by: the nearest limitation day, or nothing. */
export const limitationDay = (line: Pick<ClaimLine, 'limitation'>): string | null => line.limitation.due_on;

// ---- forms --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type FormErrors<F> = Partial<Record<keyof F, FormProblem>>;

export interface RegisterForm {
  contractId: string;
  side: Side;
  kind: string;
  title: string;
  description: string;
  eventOn: string;
  awarenessOn: string;
  amount: string;
  days: string;
}

export const emptyRegister = (today: string, contractId = ''): RegisterForm => ({ contractId, side: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: '', description: '', eventOn: today, awarenessOn: today, amount: '', days: '' });

export function validateRegister(form: RegisterForm, today: string): FormErrors<RegisterForm> {
  const errors: FormErrors<RegisterForm> = {};
  if (!isUuid(form.contractId)) errors.contractId = 'pickOne';
  if (!KINDS_BY_SIDE[form.side].includes(form.kind as Claim['kind'])) errors.kind = 'pickOne';
  const title = textProblem(form.title, MIN_TEXT, MAX_TITLE);
  if (title !== undefined) errors.title = title;
  const description = textProblem(form.description, MIN_TEXT, MAX_TEXT);
  if (description !== undefined) errors.description = description;
  if (!isDay(form.eventOn) || form.eventOn > today) errors.eventOn = 'invalidDay';
  if (!isDay(form.awarenessOn) || form.awarenessOn > today || form.awarenessOn < form.eventOn) errors.awarenessOn = 'invalidDay';
  if (form.amount.trim() !== '' && !isWholeAmount(form.amount.trim())) errors.amount = 'invalidAmount';
  const days = daysProblem(form.days, 0, 3650);
  if (days !== undefined) errors.days = days;
  return errors;
}

export function registerBody(form: RegisterForm): components['schemas']['CtrClaimRegister'] {
  const amount = optionalText(form.amount);
  const days = optionalNumber(form.days);
  return {
    claimant_side: form.side,
    kind: form.kind as components['schemas']['CtrClaimRegister']['kind'],
    title: form.title.trim(),
    event_description: form.description.trim(),
    event_on: form.eventOn,
    awareness_on: form.awarenessOn,
    ...(amount === undefined ? {} : { claimed_amount_vnd: amount }),
    ...(days === undefined ? {} : { claimed_days: days }),
  };
}

export interface StepForm {
  kind: RecordableStep;
  occurredOn: string;
  note: string;
  decision: string;
  claimedAmount: string;
  claimedDays: string;
  settledAmount: string;
  grantedDays: string;
}

export const emptyStep = (kind: RecordableStep, today: string): StepForm => ({ kind, occurredOn: today, note: '', decision: '', claimedAmount: '', claimedDays: '', settledAmount: '', grantedDays: '' });

/** The step as the timeline will hold it: a day not in the future, not before awareness and not before the latest step; words; a decision for a response; the figures where the step carries them. */
export function validateStep(form: StepForm, claim: Pick<Claim, 'awareness_on' | 'steps'>, today: string): FormErrors<StepForm> {
  const errors: FormErrors<StepForm> = {};
  const latest = claim.steps.reduce((day, step) => (step.occurred_on > day ? step.occurred_on : day), claim.awareness_on);
  if (!isDay(form.occurredOn) || form.occurredOn > today || form.occurredOn < latest) errors.occurredOn = 'invalidDay';
  const note = textProblem(form.note, MIN_TEXT, MAX_TEXT);
  if (note !== undefined) errors.note = note;
  if (form.kind === 'RESPONSE' && !(DECISIONS as readonly string[]).includes(form.decision)) errors.decision = 'pickOne';
  if (form.kind === 'PARTICULARS') {
    if (form.claimedAmount.trim() !== '' && !isWholeAmount(form.claimedAmount.trim())) errors.claimedAmount = 'invalidAmount';
    const days = daysProblem(form.claimedDays, 0, 3650);
    if (days !== undefined) errors.claimedDays = days;
  }
  if (form.kind === 'SETTLEMENT_PROPOSAL') {
    if (form.settledAmount.trim() !== '' && !isWholeAmount(form.settledAmount.trim())) errors.settledAmount = 'invalidAmount';
    const days = daysProblem(form.grantedDays, 0, 3650);
    if (days !== undefined) errors.grantedDays = days;
    if (form.settledAmount.trim() === '' && form.grantedDays.trim() === '' && errors.settledAmount === undefined) errors.settledAmount = 'required';
  }
  return errors;
}

export function stepBody(form: StepForm): components['schemas']['CtrClaimStepRecord'] {
  const claimedAmount = optionalText(form.claimedAmount);
  const claimedDays = optionalNumber(form.claimedDays);
  const settledAmount = optionalText(form.settledAmount);
  const grantedDays = optionalNumber(form.grantedDays);
  return {
    kind: form.kind,
    occurred_on: form.occurredOn,
    note: form.note.trim(),
    ...(form.kind === 'RESPONSE' ? { decision: form.decision as (typeof DECISIONS)[number] } : {}),
    ...(form.kind === 'PARTICULARS' && claimedAmount !== undefined ? { claimed_amount_vnd: claimedAmount } : {}),
    ...(form.kind === 'PARTICULARS' && claimedDays !== undefined ? { claimed_days: claimedDays } : {}),
    ...(form.kind === 'SETTLEMENT_PROPOSAL' && settledAmount !== undefined ? { settled_amount_vnd: settledAmount } : {}),
    ...(form.kind === 'SETTLEMENT_PROPOSAL' && grantedDays !== undefined ? { granted_days: grantedDays } : {}),
  };
}

export interface LinkForm {
  changeRequestId: string;
  paymentRequestId: string;
}

export function validateLinks(form: LinkForm): FormErrors<LinkForm> {
  const errors: FormErrors<LinkForm> = {};
  const change = form.changeRequestId.trim();
  const payment = form.paymentRequestId.trim();
  if (change === '' && payment === '') errors.changeRequestId = 'required';
  if (change !== '' && !isUuid(change)) errors.changeRequestId = 'invalidId';
  if (payment !== '' && !isUuid(payment)) errors.paymentRequestId = 'invalidId';
  return errors;
}

export function linksBody(form: LinkForm): components['schemas']['CtrClaimLinks'] {
  return {
    ...(form.changeRequestId.trim() === '' ? {} : { change_request_id: form.changeRequestId.trim() }),
    ...(form.paymentRequestId.trim() === '' ? {} : { payment_request_id: form.paymentRequestId.trim() }),
  };
}

export interface NoteForm {
  note: string;
}

export const validateNote = (note: string): FormProblem | undefined => textProblem(note, MIN_TEXT, MAX_TEXT);

export interface TermForm {
  side: Side;
  noticeDays: string;
  particularsDays: string;
  responseDays: string;
  settlementDays: string;
  basis: (typeof BASES)[number];
  particularsFrom: 'AWARENESS' | 'NOTICE';
  barEffect: (typeof EFFECTS)[number];
  clause: string;
  templateCode: string;
}

export const emptyTerm = (side: Side = 'CONTRACTOR'): TermForm => ({ side, noticeDays: '', particularsDays: '', responseDays: '', settlementDays: '', basis: 'CALENDAR_DAYS', particularsFrom: 'NOTICE', barEffect: 'NOT_STATED', clause: '', templateCode: '' });

/** What copying a template does: the numbers go into the form for a person to check against the contract, the clause stays empty and the code of the template is remembered; nothing is applied. */
export function copyTemplate(form: TermForm, template: ClaimTermTemplate): TermForm {
  const text = (value: number | null): string => (value === null ? '' : String(value));
  return {
    ...form,
    noticeDays: text(template.notice_days),
    particularsDays: text(template.particulars_days),
    responseDays: text(template.response_days),
    settlementDays: text(template.settlement_days),
    basis: template.basis,
    particularsFrom: template.particulars_from,
    barEffect: template.bar_effect,
    templateCode: template.code,
  };
}

/** The term as the server judges it: at least one period, a bar effect that has a period to apply to, particulars counted from the notice only when there is a notice period, and the clause of the contract named. */
export function validateTerm(form: TermForm): FormErrors<TermForm> {
  const errors: FormErrors<TermForm> = {};
  const fields = [
    ['noticeDays', form.noticeDays],
    ['particularsDays', form.particularsDays],
    ['responseDays', form.responseDays],
    ['settlementDays', form.settlementDays],
  ] as const;
  for (const [name, value] of fields) {
    const problem = daysProblem(value, 1, 3650);
    if (problem !== undefined) errors[name] = problem;
  }
  if (fields.every(([, value]) => value.trim() === '') && errors.noticeDays === undefined) errors.noticeDays = 'required';
  if ((form.barEffect === 'BARS_CLAIM' || form.barEffect === 'REDUCES_RELIEF') && form.noticeDays.trim() === '' && form.particularsDays.trim() === '') errors.barEffect = 'pickOne';
  if (form.particularsFrom === 'NOTICE' && form.particularsDays.trim() !== '' && form.noticeDays.trim() === '') errors.particularsFrom = 'pickOne';
  const clause = textProblem(form.clause, 3, MAX_CLAUSE);
  if (clause !== undefined) errors.clause = clause;
  return errors;
}

export function termBody(form: TermForm): components['schemas']['CtrClaimTermPropose'] {
  const notice = optionalNumber(form.noticeDays);
  const particulars = optionalNumber(form.particularsDays);
  const response = optionalNumber(form.responseDays);
  const settlement = optionalNumber(form.settlementDays);
  return {
    claimant_side: form.side,
    clause_reference: form.clause.trim(),
    basis: form.basis,
    particulars_from: form.particularsFrom,
    bar_effect: form.barEffect,
    ...(notice === undefined ? {} : { notice_days: notice }),
    ...(particulars === undefined ? {} : { particulars_days: particulars }),
    ...(response === undefined ? {} : { response_days: response }),
    ...(settlement === undefined ? {} : { settlement_days: settlement }),
    ...(form.templateCode === '' ? {} : { template_code: form.templateCode }),
  };
}

/** The periods of a term the contract gives, in the order the clocks run. */
export function periodsOf(term: Pick<ClaimTerm, 'notice_days' | 'particulars_days' | 'response_days' | 'settlement_days'>): Array<{ code: (typeof DEADLINE_CODES)[number]; days: number }> {
  const all: Array<[(typeof DEADLINE_CODES)[number], number | null]> = [
    ['NOTICE', term.notice_days],
    ['PARTICULARS', term.particulars_days],
    ['RESPONSE', term.response_days],
    ['SETTLEMENT', term.settlement_days],
  ];
  return all.flatMap(([code, days]) => (days === null ? [] : [{ code, days }]));
}
