import { DomainError } from './errors.ts';

/**
 * The contractor portal (VND-3, research V15, V16, V17, V18; docs/vendor-investigation.md sections 5 to 8). A contractor is a guest member bound to one contractor (ADM-17). The portal shows it its own profile, its
 * evaluations, its requests and its remediation plans, lets it answer a request within the clock, put a certificate on file, re-confirm its profile every year and sign the declaration of integrity. It never shows a red
 * flag, a lead, a screening hit, a risk grade or another contractor: `projectPortalProfile` is a whitelist, and the database refuses the portal path every table of the investigation (migration V2446).
 * Pure rules only here: the clock of a request, the state of a request, the re-confirmation, the plan of remediation, the statistics of disputes and the parties of an OCDS export.
 */

// -- The whitelist of what a contractor sees of its own profile ---------------------------------------------------------------------------------------------------------------------------------------------

export const PORTAL_PROFILE_FIELDS = ['id', 'legal_name', 'tax_identifier', 'verification_status', 'legal_rep_name', 'legal_rep_position', 'registered_address', 'phone', 'email', 'business_registration_no', 'ownership_declaration', 'next_review_due', 'profile_reviewed_at', 'version'] as const;
export type PortalProfileField = (typeof PORTAL_PROFILE_FIELDS)[number];

/** Names that must never reach a contractor through the portal, whatever a store returns (the test of the projection offers them all). */
export const PORTAL_FORBIDDEN_FIELDS: readonly string[] = ['red_flag', 'red_flags', 'lead', 'leads', 'screening', 'screening_hit', 'screening_hits', 'risk_tier', 'risk_grade', 'party_link', 'party_links', 'link_cluster', 'investigation', 'duplicate_suggestions', 'internal_note', 'reviewer', 'other_contractors'];

/** The fields of a record that a contractor may see: the whitelist, nothing else, in the order of the list. */
export function projectPortalProfile(source: Readonly<Record<string, unknown>>): Partial<Record<PortalProfileField, unknown>> {
  const out: Partial<Record<PortalProfileField, unknown>> = {};
  for (const field of PORTAL_PROFILE_FIELDS) if (field in source) out[field] = source[field];
  return out;
}

// -- A request to the contractor and its answer ------------------------------------------------------------------------------------------------------------------------------------------------------

export const PORTAL_REQUEST_KINDS = ['EVALUATION_RESPONSE', 'CERTIFICATE_UPLOAD', 'PROFILE_UPDATE', 'INFORMATION', 'SCREENING_CLARIFICATION', 'REMEDIATION_RESPONSE', 'OTHER'] as const;
export type PortalRequestKind = (typeof PORTAL_REQUEST_KINDS)[number];
export const PORTAL_REQUEST_STATUSES = ['OPEN', 'RESPONDED', 'ACCEPTED', 'RETURNED', 'CANCELLED'] as const;
export type PortalRequestStatus = (typeof PORTAL_REQUEST_STATUSES)[number];
export const PORTAL_REQUEST_MOVES = ['RESPOND', 'ACCEPT', 'RETURN', 'CANCEL'] as const;
export type PortalRequestMove = (typeof PORTAL_REQUEST_MOVES)[number];

/** Rule `VENDOR_PORTAL`, one code per kind of request: the days the contractor has (counted on the working calendar when the unit says so), and the days before the end at which the alert is raised. */
export interface PortalClockPolicy {
  response_days: number;
  day_unit: 'CALENDAR_DAYS' | 'WORKING_DAYS';
  remind_before_days: number;
}

export function portalClockPolicyOf(params: unknown): PortalClockPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  const whole = (field: string, min: number, max: number): number => {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  if (record.day_unit !== 'CALENDAR_DAYS' && record.day_unit !== 'WORKING_DAYS') throw bad('day_unit');
  return { response_days: whole('response_days', 1, 365), day_unit: record.day_unit, remind_before_days: whole('remind_before_days', 0, 60) };
}

/** Starting values: the research reads the 20 days of Điều 20 NĐ 214/2025 for the answer to an evaluation; the others are our own choice. All flagged unverified. */
export const PORTAL_CLOCK_DEFAULTS: Readonly<Record<PortalRequestKind, PortalClockPolicy>> = {
  EVALUATION_RESPONSE: { response_days: 20, day_unit: 'CALENDAR_DAYS', remind_before_days: 5 },
  CERTIFICATE_UPLOAD: { response_days: 15, day_unit: 'CALENDAR_DAYS', remind_before_days: 3 },
  PROFILE_UPDATE: { response_days: 15, day_unit: 'CALENDAR_DAYS', remind_before_days: 3 },
  INFORMATION: { response_days: 10, day_unit: 'WORKING_DAYS', remind_before_days: 2 },
  SCREENING_CLARIFICATION: { response_days: 7, day_unit: 'WORKING_DAYS', remind_before_days: 2 },
  REMEDIATION_RESPONSE: { response_days: 15, day_unit: 'CALENDAR_DAYS', remind_before_days: 3 },
  OTHER: { response_days: 10, day_unit: 'CALENDAR_DAYS', remind_before_days: 2 },
};

const REQUEST_STEPS: Readonly<Record<PortalRequestMove, { from: readonly PortalRequestStatus[]; to: PortalRequestStatus; reason: boolean; by: 'CONTRACTOR' | 'STAFF' }>> = {
  RESPOND: { from: ['OPEN'], to: 'RESPONDED', reason: false, by: 'CONTRACTOR' },
  ACCEPT: { from: ['RESPONDED'], to: 'ACCEPTED', reason: false, by: 'STAFF' },
  RETURN: { from: ['RESPONDED'], to: 'OPEN', reason: true, by: 'STAFF' },
  CANCEL: { from: ['OPEN', 'RESPONDED'], to: 'CANCELLED', reason: true, by: 'STAFF' },
};

/** The status after a move. A contractor only responds; staff accept, return (with a reason, the request opens again) or cancel (with a reason). 409 PORTAL_REQUEST_STATE_INVALID when the move does not start from the status; 403 when the wrong side moves. */
export function nextPortalRequestStatus(current: PortalRequestStatus, move: PortalRequestMove, side: 'CONTRACTOR' | 'STAFF', reason?: string | null): PortalRequestStatus {
  const step = REQUEST_STEPS[move];
  if (step.by !== side) throw new DomainError('SCOPE_DENIED', 403);
  if (!step.from.includes(current)) throw new DomainError('PORTAL_REQUEST_STATE_INVALID', 409, 'status');
  if (step.reason && (reason === undefined || reason === null || reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return step.to;
}

export type RequestClock = 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'ANSWERED' | 'ANSWERED_LATE';

/** Where the clock of a request stands. A contractor may always answer, also late (the answer is then marked late, never refused); a request that is answered stops being an alert. */
export function requestClock(input: { dueAt: Date; respondedAt: Date | null; now: Date; remindBeforeDays: number }): RequestClock {
  if (input.respondedAt !== null) return input.respondedAt.getTime() <= input.dueAt.getTime() ? 'ANSWERED' : 'ANSWERED_LATE';
  if (input.now.getTime() > input.dueAt.getTime()) return 'OVERDUE';
  return input.dueAt.getTime() - input.now.getTime() <= input.remindBeforeDays * 86_400_000 ? 'DUE_SOON' : 'ON_TIME';
}

// -- The annual re-confirmation and the declaration of integrity -------------------------------------------------------------------------------------------------------------------------------------------

/** Rule `VENDOR_RECONFIRMATION`: how often the contractor confirms its profile, how long before the day it is reminded, and the days of grace after it before it is shown as lapsed. The version names the text of the declaration of integrity the contractor signs. */
export interface ReconfirmationPolicy {
  interval_months: number;
  remind_days: number;
  grace_days: number;
  declaration_version: string;
  declaration_text: string;
}

export function reconfirmationPolicyOf(params: unknown): ReconfirmationPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  const whole = (field: string, min: number, max: number): number => {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const text = (field: string, min: number, max: number): string => {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) throw bad(field);
    return value;
  };
  return { interval_months: whole('interval_months', 1, 60), remind_days: whole('remind_days', 0, 180), grace_days: whole('grace_days', 0, 180), declaration_version: text('declaration_version', 1, 40), declaration_text: text('declaration_text', 20, 4000) };
}

export type ReconfirmationState = 'NEVER' | 'CURRENT' | 'DUE_SOON' | 'OVERDUE' | 'LAPSED';

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** The day after `months` months from `day` (a month end stays a month end: 31 January plus one month is 28 or 29 February). */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const target = year * 12 + (month - 1) + months;
  const y = Math.floor(target / 12);
  const m = target - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

/** The day the next confirmation falls due: the interval after the last one. */
export const nextReconfirmationDue = (confirmedOn: string, policy: Pick<ReconfirmationPolicy, 'interval_months'>): string => addMonths(confirmedOn, policy.interval_months);

/**
 * Where the re-confirmation of a contractor stands on a day: CURRENT until `remind_days` before the due day, DUE_SOON from then to the due day, OVERDUE for `grace_days` after it, LAPSED beyond. A contractor that has not
 * confirmed even once and has no due day is NEVER (shown to the staff as a gap, not as a lapse). A lapse is shown, never a block: the register keeps working with the contractor.
 */
export function reconfirmationState(dueOn: string | null, today: string, policy: Pick<ReconfirmationPolicy, 'remind_days' | 'grace_days'>): ReconfirmationState {
  if (dueOn === null) return 'NEVER';
  const left = dayNumber(dueOn) - dayNumber(today);
  if (left > policy.remind_days) return 'CURRENT';
  if (left >= 0) return 'DUE_SOON';
  return -left <= policy.grace_days ? 'OVERDUE' : 'LAPSED';
}

/** The alert facet of the state: OVERDUE and LAPSED raise one, the others none (the research gives V-A15 as WATCH). */
export const reconfirmationAlertFacet = (state: ReconfirmationState): 'DUE_SOON' | 'OVERDUE' | null => (state === 'DUE_SOON' ? 'DUE_SOON' : state === 'OVERDUE' || state === 'LAPSED' ? 'OVERDUE' : null);

// -- The plan of remediation (V17) --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const REMEDIATION_STATUSES = ['PROPOSED', 'AGREED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];
export const REMEDIATION_MOVES = ['AGREE', 'START', 'COMPLETE', 'FAIL', 'CANCEL'] as const;
export type RemediationMove = (typeof REMEDIATION_MOVES)[number];
export const REMEDIATION_ACTION_STATUSES = ['OPEN', 'DONE', 'VERIFIED'] as const;
export type RemediationActionStatus = (typeof REMEDIATION_ACTION_STATUSES)[number];

const PLAN_STEPS: Readonly<Record<RemediationMove, { from: readonly RemediationStatus[]; to: RemediationStatus; reason: boolean }>> = {
  AGREE: { from: ['PROPOSED'], to: 'AGREED', reason: false },
  START: { from: ['AGREED'], to: 'IN_PROGRESS', reason: false },
  COMPLETE: { from: ['IN_PROGRESS'], to: 'COMPLETED', reason: false },
  FAIL: { from: ['IN_PROGRESS', 'AGREED'], to: 'FAILED', reason: true },
  CANCEL: { from: ['PROPOSED', 'AGREED', 'IN_PROGRESS'], to: 'CANCELLED', reason: true },
};

/**
 * The status of a plan after a move. The plan is proposed by staff and agreed by the contractor (the contractor owns its commitment); it is completed only when every action is verified by staff (409 REMEDIATION_STATE_INVALID
 * if some are not); failing and cancelling need a reason. A plan of the contractor with no actions cannot be agreed (422 VALIDATION_FAILED on `actions`).
 */
export function nextRemediationStatus(current: RemediationStatus, move: RemediationMove, input: { actions: readonly RemediationActionStatus[]; reason?: string | null }): RemediationStatus {
  const step = PLAN_STEPS[move];
  if (!step.from.includes(current)) throw new DomainError('REMEDIATION_STATE_INVALID', 409, 'status');
  if (step.reason && (input.reason === undefined || input.reason === null || input.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (move === 'AGREE' && input.actions.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'actions');
  if (move === 'COMPLETE' && input.actions.some((status) => status !== 'VERIFIED')) throw new DomainError('REMEDIATION_STATE_INVALID', 409, 'actions');
  return step.to;
}

// -- Disputes of a contractor (V16): petitions and claims -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface DisputeFacts {
  kind: 'PETITION' | 'CLAIM';
  /** The status as the source module states it, folded to one of four words by the store. */
  outcome: 'OPEN' | 'UPHELD' | 'REJECTED' | 'WITHDRAWN';
  openedOn: string;
  closedOn: string | null;
  /** True for a petition that was answered or passed up but whose decision is not confirmed yet (PORTAL-2): it stays open in the figures and is counted apart. */
  awaitingOutcome?: boolean;
}

export interface DisputeStats {
  total: number;
  open: number;
  upheld: number;
  rejected: number;
  withdrawn: number;
  /** Open disputes that were answered but wait for a confirmed decision: the share upheld is over decisions only, so this says how many are not in it yet. */
  awaitingOutcome: number;
  /** Whole percent of the decided disputes (upheld or rejected) that were upheld; none while none was decided. */
  upheldPct: number | null;
  /** The mean days from opening to closing over the closed ones, one decimal; none while none was closed. */
  meanDaysToClose: number | null;
}

/** The figures of a list of disputes of one contractor or of the whole register. Counts only: the sum of the four outcomes is the total. */
export function disputeStats(disputes: readonly DisputeFacts[]): DisputeStats {
  const count = (outcome: DisputeFacts['outcome']): number => disputes.filter((dispute) => dispute.outcome === outcome).length;
  const upheld = count('UPHELD');
  const rejected = count('REJECTED');
  const closed = disputes.filter((dispute) => dispute.closedOn !== null);
  return {
    total: disputes.length,
    open: count('OPEN'),
    upheld,
    rejected,
    withdrawn: count('WITHDRAWN'),
    awaitingOutcome: disputes.filter((dispute) => dispute.outcome === 'OPEN' && dispute.awaitingOutcome === true).length,
    upheldPct: upheld + rejected === 0 ? null : Math.round((upheld * 100) / (upheld + rejected)),
    meanDaysToClose: closed.length === 0 ? null : Math.round((closed.reduce((sum, dispute) => sum + (dayNumber(dispute.closedOn as string) - dayNumber(dispute.openedOn)), 0) * 10) / closed.length) / 10,
  };
}

// -- Parties for an OCDS export (V18) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface OcdsPartySource {
  id: string;
  legalName: string;
  taxIdentifier: string;
  registeredAddress: string | null;
  phone: string | null;
  email: string | null;
  legalRepName: string | null;
  roles: readonly ('tenderer' | 'supplier')[];
  /** The beneficial owners: only when the rule allows the export of them (the law on beneficial ownership is not confirmed). */
  owners: ReadonlyArray<{ name: string; sharePct: string | null; kind: 'PERSON' | 'ORGANISATION' }>;
}

export interface OcdsParty {
  id: string;
  name: string;
  identifier: { scheme: 'VN-MST'; id: string; legalName: string };
  address?: { streetAddress: string; countryName: string };
  contactPoint?: { name?: string; telephone?: string; email?: string };
  roles: string[];
  beneficialOwners?: Array<{ name: string; type: string; share?: string }>;
}

/**
 * A party in the shape of the Open Contracting Data Standard (`parties[]` with a main identifier, an address, a contact point and roles). The standard has no field for beneficial owners: they go in `beneficialOwners`
 * (an extension in the way Open Ownership describes), and only when `includeOwners` is true (rule `VENDOR_OCDS_EXPORT`, default off, because the legal basis is not confirmed). The id is the tax code, never an internal id.
 */
export function ocdsParty(source: OcdsPartySource, options: { includeOwners: boolean; includeContact: boolean }): OcdsParty {
  const party: OcdsParty = { id: `VN-MST-${source.taxIdentifier}`, name: source.legalName, identifier: { scheme: 'VN-MST', id: source.taxIdentifier, legalName: source.legalName }, roles: [...source.roles] };
  if (source.registeredAddress !== null) party.address = { streetAddress: source.registeredAddress, countryName: 'Viet Nam' };
  if (options.includeContact) {
    const contact: NonNullable<OcdsParty['contactPoint']> = {};
    if (source.legalRepName !== null) contact.name = source.legalRepName;
    if (source.phone !== null) contact.telephone = source.phone;
    if (source.email !== null) contact.email = source.email;
    if (Object.keys(contact).length > 0) party.contactPoint = contact;
  }
  if (options.includeOwners && source.owners.length > 0) party.beneficialOwners = source.owners.map((owner) => ({ name: owner.name, type: owner.kind === 'PERSON' ? 'person' : 'organisation', ...(owner.sharePct === null ? {} : { share: owner.sharePct }) }));
  return party;
}

// -- The rule of remediation plans -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface RemediationPolicy {
  /** Days before the due day of an action at which its alert is raised. */
  remind_before_days: number;
  /** The longest a plan may run from its start to the last due day of an action. */
  max_plan_days: number;
}

export const REMEDIATION_POLICY_DEFAULTS: RemediationPolicy = { remind_before_days: 3, max_plan_days: 365 };

export function remediationPolicyOf(params: unknown): RemediationPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  const whole = (field: string, min: number, max: number): number => {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  return { remind_before_days: whole('remind_before_days', 0, 60), max_plan_days: whole('max_plan_days', 7, 1095) };
}

/** Rule `VENDOR_OCDS_EXPORT`: whether the export of parties carries the beneficial owners and the contact point. Both off by default: the legal basis for publishing them is not confirmed. */
export interface OcdsExportPolicy {
  include_owners: boolean;
  include_contact: boolean;
}

export const OCDS_EXPORT_DEFAULTS: OcdsExportPolicy = { include_owners: false, include_contact: false };

export function ocdsExportPolicyOf(params: unknown): OcdsExportPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  if (typeof record.include_owners !== 'boolean') throw bad('include_owners');
  if (typeof record.include_contact !== 'boolean') throw bad('include_contact');
  return { include_owners: record.include_owners, include_contact: record.include_contact };
}
