import { ApiError } from '@machvon/api-client';
import type { Acceptance } from '../acceptance/model';
import { isUuid, reasonProblem } from '../change/model';
import type { ChangeRequest, FormProblem } from '../change/model';
import { parseLines } from '../revision/model';
import { isDate } from '../workspace/model';

export const RETROACTIVE_PATH = '/ctr/ctr-14';

/** The permission of the adjustment (x-permission in openapi.json); the server judges it again, with the scope, the people of the chain, the document, the settlements and the delegation limit. */
export const ADJUST_PERMISSION = 'change.retroactive.approve';

const MAX_AFFECTED = 500;
const SIGNED_AMOUNT = /^-?\d{1,24}$/;

const link = (path: string, params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams(Object.entries(params).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as [string, string]]))).toString();
  return query === '' ? path : `${path}?${query}`;
};
/** The screen of the delays of a contract and of the retroactive adjustment of its change orders (CTR-14), narrowed to one change order when it is named. */
export const retroactiveLink = (contractId: string, requestId?: string): string => link(RETROACTIVE_PATH, { id: contractId, request: requestId });

// ---- the delays -------------------------------------------------------------------------------------------------------------

export interface DelaySummary {
  /** The days the approved change orders of the contract move the schedule by, signed: positive extends the time. */
  approvedDays: number;
  /** The days the change orders that were assessed and wait for a decision would move it by. */
  waitingDays: number;
  /** The completion day the contract carries, and the day it moves to with the approved changes; null when the contract has none. */
  plannedDue: string | null;
  forecastDue: string | null;
  /** The change orders that move the schedule, approved or waiting, in the order of the board. */
  lines: Array<{ id: string; code: string | null; status: 'APPROVED' | 'EVALUATED'; days: number; retroactive: boolean }>;
}

/** A day (`YYYY-MM-DD`) some days later (or earlier); null when the text is no day. */
export function addDays(day: string, days: number): string | null {
  if (!isDate(day)) return null;
  const moved = new Date(`${day}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * What the change orders of a contract do to its schedule. Only a CO moves the schedule (the events and the PCOs lead up to one); an approved CO has moved it, an assessed one would. The
 * staff read the days of the assessment; a guest contractor reads none and sees no lines.
 */
export function delaySummary(requests: readonly ChangeRequest[], contractId: string, completionDue: string | null): DelaySummary {
  const moving = requests.filter((request) => request.contract.id === contractId && request.stage === 'CO' && request.detail !== undefined && (request.status === 'APPROVED' || request.status === 'EVALUATED'));
  const lines = moving.map((request) => ({
    id: request.id,
    code: request.code,
    status: request.status === 'APPROVED' ? ('APPROVED' as const) : ('EVALUATED' as const),
    days: request.detail?.scheduleImpactDays ?? 0,
    retroactive: request.retroactive,
  }));
  const sum = (status: 'APPROVED' | 'EVALUATED'): number => lines.filter((line) => line.status === status).reduce((total, line) => total + line.days, 0);
  const approvedDays = sum('APPROVED');
  return { approvedDays, waitingDays: sum('EVALUATED'), plannedDue: completionDue, forecastDue: completionDue === null ? null : addDays(completionDue, approvedDays), lines };
}

// ---- the form of the adjustment ---------------------------------------------------------------------------------------------

/** The assessed change orders of a contract that the caller may adjust retroactively. */
export const adjustable = (requests: readonly ChangeRequest[], contractId: string): ChangeRequest[] =>
  requests.filter((request) => request.contract.id === contractId && request.stage === 'CO' && request.status === 'EVALUATED' && request.actions?.adjust === true);

export type AdjustProblem = FormProblem | 'date' | 'notPast' | 'json' | 'tooMany';

export interface AdjustForm {
  basis: string;
  documentVersionId: string;
  /** The first day the change applies from: a day before today. */
  effectiveOn: string;
  approvedDeltaVnd: string;
  /** The lines of the new BOQ as a JSON list; empty to start from a copy of the BOQ in force (then no price moves and no acceptance is re-priced). */
  boqLines: string;
  /** The acceptances the person says the change re-prices. */
  affected: string[];
}

export const emptyAdjustment = (evaluatedDeltaVnd: string | null): AdjustForm => ({ basis: '', documentVersionId: '', effectiveOn: '', approvedDeltaVnd: evaluatedDeltaVnd ?? '', boqLines: '', affected: [] });

export function validateAdjustment(form: AdjustForm, today: string): Partial<Record<keyof AdjustForm, AdjustProblem>> {
  const problems: Partial<Record<keyof AdjustForm, AdjustProblem>> = {};
  const basis = reasonProblem(form.basis);
  if (basis !== undefined) problems.basis = basis;
  if (form.documentVersionId.trim() === '') problems.documentVersionId = 'required';
  else if (!isUuid(form.documentVersionId)) problems.documentVersionId = 'uuid';
  if (form.effectiveOn.trim() === '') problems.effectiveOn = 'required';
  else if (!isDate(form.effectiveOn)) problems.effectiveOn = 'date';
  else if (form.effectiveOn.trim() >= today) problems.effectiveOn = 'notPast';
  if (form.approvedDeltaVnd.trim() === '') problems.approvedDeltaVnd = 'required';
  else if (!SIGNED_AMOUNT.test(form.approvedDeltaVnd.trim())) problems.approvedDeltaVnd = 'amount';
  if (parseLines(form.boqLines) === null) problems.boqLines = 'json';
  if (form.affected.length > MAX_AFFECTED) problems.affected = 'tooMany';
  return problems;
}

export interface AdjustBody {
  adjustment_basis: string;
  decision_document_version_id: string;
  affected_acceptance_ids: string[];
  effective_on: string;
  approved_delta_vnd: string;
  boq_lines?: Array<Record<string, unknown>>;
}

/** The body of the adjustment the form asks for; call it once the form is valid. */
export function adjustBody(form: AdjustForm): AdjustBody {
  const lines = parseLines(form.boqLines);
  return {
    adjustment_basis: form.basis.trim(),
    decision_document_version_id: form.documentVersionId.trim().toLowerCase(),
    affected_acceptance_ids: [...new Set(form.affected.map((id) => id.toLowerCase()))].sort(),
    effective_on: form.effectiveOn.trim(),
    approved_delta_vnd: BigInt(form.approvedDeltaVnd.trim()).toString(),
    ...(lines === undefined || lines === null ? {} : { boq_lines: lines }),
  };
}

// ---- the acceptances the change may reach ------------------------------------------------------------------------------------

/** The approved acceptances accepted on the day the change applies from, or after: the ones it can reach. The server decides which of them it does reach. */
export const reachable = (acceptances: readonly Acceptance[], effectiveOn: string): Acceptance[] =>
  isDate(effectiveOn) ? acceptances.filter((acceptance) => acceptance.status === 'APPROVED' && acceptance.acceptedOn >= effectiveOn) : [];

/** The list with one acceptance more or less. */
export const toggled = (affected: readonly string[], id: string): string[] => (affected.includes(id) ? affected.filter((each) => each !== id) : [...affected, id]);

export interface Mismatch {
  /** The acceptances the change reaches that the list left out. */
  missing: string[];
  /** The acceptances the list named that the change does not reach. */
  unexpected: string[];
}

const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []);

/** What the server said was wrong with the list of acceptances (422 on `affected_acceptance_ids`); undefined for any other refusal. */
export function mismatchOf(error: unknown): Mismatch | undefined {
  if (!(error instanceof ApiError) || error.extensions.reason !== 'AFFECTED_MISMATCH') return undefined;
  return { missing: idsOf(error.extensions.missing_acceptance_ids), unexpected: idsOf(error.extensions.unexpected_acceptance_ids) };
}

/** The list as the server found it: the ones it left out added, the ones that are not affected taken out. */
export const reconciled = (affected: readonly string[], mismatch: Mismatch): string[] => [...affected.filter((id) => !mismatch.unexpected.includes(id)), ...mismatch.missing.filter((id) => !affected.includes(id))];
