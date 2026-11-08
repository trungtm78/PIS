import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/**
 * VND-16 to VND-21: the contractor portal and the staff screens that manage it (lane VND-3, docs/vendor-investigation.md section 5). The shapes are the contract's; nothing here is invented.
 * The portal renders from the fields named below only: whatever else a payload carries (it must never carry a red flag, a risk grade or another contractor, and the database refuses the portal path those tables) is never drawn.
 */
type S = components['schemas'];
export type PortalHome = S['PortalHome'];
export type PortalProfile = S['PortalProfile'];
export type PortalReconfirmation = S['PortalReconfirmation'];
export type PortalRequest = S['PortalRequest'];
export type PortalRequestPage = S['PortalRequestPage'];
export type PortalQualificationList = S['PortalQualificationList'];
export type PortalQualification = S['PortalQualification'];
export type PortalKeyStaff = S['PortalKeyStaff'];
export type PortalEvaluationList = S['PortalEvaluationList'];
export type PortalEvaluation = S['PortalEvaluation'];
export type PortalPlanList = S['PortalPlanList'];
export type PortalPlan = S['PortalPlan'];
export type PortalAction = S['PortalActionLine'];
export type StaffRequest = S['VendorRequestLine'];
export type StaffRequestPage = S['VendorRequestPage'];
export type ReconfirmationLine = S['VendorReconfirmationLine'];
export type ReconfirmationPage = S['VendorReconfirmationPage'];
export type PlanLine = S['VendorRemediationPlanLine'];
export type PlanDetail = S['VendorRemediationPlanDetail'];
export type PlanPage = S['VendorRemediationPlanPage'];
export type PlanActionLine = S['VendorRemediationActionLine'];
export type PlanEvent = S['VendorRemediationEvent'];
export type InvPolicy = S['VendorInvPolicyInfo'];

export type RequestKind = PortalRequest['kind'];
export type RequestStatus = PortalRequest['status'];
export type RequestClock = PortalRequest['clock'];
export type ReconfirmState = PortalReconfirmation['state'];
export type PlanStatus = PortalPlan['status'];
export type ActionStatus = PortalAction['status'];
export type Rating = PortalEvaluation['rating'];
export type SubjectType = NonNullable<S['VendorPortalRequestNew']['subject_type']>;

/** The permissions of the portal (held by the guest role) and of its staff side (the server decides every one of them again). */
export const PORTAL_PERMISSION = {
  read: 'vnd.portal.read',
  respond: 'vnd.portal.respond',
  certificate: 'vnd.portal.certificate',
  reconfirm: 'vnd.portal.reconfirm',
  remediation: 'vnd.portal.remediation',
  manage: 'vnd.portal.manage',
  remediationManage: 'vnd.remediation.manage',
  staffRead: 'vnd.read',
} as const;

/** A caller is on the portal when it holds the right to read it and none of the staff reading rights of the register: the shell then shows the reduced frame. */
export function isPortalCaller(permissions: readonly string[] | undefined): boolean {
  if (permissions === undefined) return false;
  return permissions.includes(PORTAL_PERMISSION.read) && !permissions.includes(PORTAL_PERMISSION.staffRead) && !permissions.includes(PORTAL_PERMISSION.manage);
}

export const REQUEST_KINDS: readonly RequestKind[] = ['EVALUATION_RESPONSE', 'CERTIFICATE_UPLOAD', 'PROFILE_UPDATE', 'INFORMATION', 'SCREENING_CLARIFICATION', 'REMEDIATION_RESPONSE', 'OTHER'];
export const REQUEST_STATUSES: readonly RequestStatus[] = ['OPEN', 'RESPONDED', 'ACCEPTED', 'CANCELLED'];
export const REQUEST_CLOCKS: readonly RequestClock[] = ['ON_TIME', 'DUE_SOON', 'OVERDUE', 'ANSWERED', 'ANSWERED_LATE'];
export const RECONFIRM_STATES: readonly ReconfirmState[] = ['NEVER', 'CURRENT', 'DUE_SOON', 'OVERDUE', 'LAPSED'];
export const PLAN_STATUSES: readonly PlanStatus[] = ['PROPOSED', 'AGREED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'];
export const ACTION_STATUSES: readonly ActionStatus[] = ['OPEN', 'DONE', 'VERIFIED'];
export const RATINGS: readonly Rating[] = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'];
export const SUBJECT_TYPES: readonly SubjectType[] = ['CONTRACT', 'PERFORMANCE', 'QUALIFICATION', 'SCREENING_HIT', 'REMEDIATION_PLAN', 'RESTRICTION_CASE', 'PACKAGE'];
export const TRIGGER_KINDS = ['POOR_EVALUATION', 'NON_CONFORMANCE', 'SCREENING', 'DISPUTE', 'MANUAL'] as const;

/** The fields of the profile a contractor sees of itself, in the order they are drawn: the whitelist of the kernel (`PORTAL_PROFILE_FIELDS`) without the ones that are not facts to read (the id and the version). */
export const PROFILE_FACTS = [
  'legal_name',
  'tax_identifier',
  'legal_rep_name',
  'legal_rep_position',
  'registered_address',
  'phone',
  'email',
  'business_registration_no',
  'ownership_declaration',
  'next_review_due',
] as const;
export type ProfileFact = (typeof PROFILE_FACTS)[number];

/** The facts of the profile that are filled, in the order of the whitelist; a fact that is empty is kept (it is shown as "not on file"), a field outside the whitelist is dropped. */
export function profileFacts(profile: PortalProfile): Array<{ fact: ProfileFact; value: string | null }> {
  const source = profile as unknown as Record<string, unknown>;
  return PROFILE_FACTS.map((fact) => {
    const value = source[fact];
    return { fact, value: typeof value === 'string' && value.trim() !== '' ? value : null };
  });
}

// ---- tones and icons: a state is always said in words too -------------------------------------------------------------------------------------------------------------------------

const CLOCK_TONE: Readonly<Record<RequestClock, Tone>> = { ON_TIME: 'success', DUE_SOON: 'warning', OVERDUE: 'danger', ANSWERED: 'success', ANSWERED_LATE: 'warning' };
const CLOCK_ICON: Readonly<Record<RequestClock, string>> = { ON_TIME: '◔', DUE_SOON: '⚠', OVERDUE: '⛔', ANSWERED: '✓', ANSWERED_LATE: '✓' };
export const requestClockTone = (clock: RequestClock): Tone => CLOCK_TONE[clock];
export const requestClockIcon = (clock: RequestClock): string => CLOCK_ICON[clock];
export const requestClockOpen = (clock: RequestClock): boolean => clock === 'ON_TIME' || clock === 'DUE_SOON' || clock === 'OVERDUE';

const STATUS_TONE: Readonly<Record<RequestStatus, Tone>> = { OPEN: 'info', RESPONDED: 'warning', ACCEPTED: 'success', CANCELLED: 'neutral' };
const STATUS_ICON: Readonly<Record<RequestStatus, string>> = { OPEN: '○', RESPONDED: '◐', ACCEPTED: '✓', CANCELLED: '⊘' };
export const requestStatusTone = (status: RequestStatus): Tone => STATUS_TONE[status];
export const requestStatusIcon = (status: RequestStatus): string => STATUS_ICON[status];

const RECONFIRM_TONE: Readonly<Record<ReconfirmState, Tone>> = { NEVER: 'neutral', CURRENT: 'success', DUE_SOON: 'warning', OVERDUE: 'danger', LAPSED: 'danger' };
const RECONFIRM_ICON: Readonly<Record<ReconfirmState, string>> = { NEVER: '○', CURRENT: '✓', DUE_SOON: '⚠', OVERDUE: '⛔', LAPSED: '⊘' };
export const reconfirmTone = (state: ReconfirmState): Tone => RECONFIRM_TONE[state];
export const reconfirmIcon = (state: ReconfirmState): string => RECONFIRM_ICON[state];
/** The state in which the contractor is asked to confirm now. */
export const reconfirmAsked = (state: ReconfirmState): boolean => state !== 'CURRENT';

const PLAN_TONE: Readonly<Record<PlanStatus, Tone>> = { PROPOSED: 'info', AGREED: 'info', IN_PROGRESS: 'warning', COMPLETED: 'success', FAILED: 'danger', CANCELLED: 'neutral' };
const PLAN_ICON: Readonly<Record<PlanStatus, string>> = { PROPOSED: '○', AGREED: '◔', IN_PROGRESS: '◐', COMPLETED: '✓', FAILED: '⛔', CANCELLED: '⊘' };
export const planTone = (status: PlanStatus): Tone => PLAN_TONE[status];
export const planIcon = (status: PlanStatus): string => PLAN_ICON[status];
export const planClosed = (status: PlanStatus): boolean => status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';

const ACTION_TONE: Readonly<Record<ActionStatus, Tone>> = { OPEN: 'info', DONE: 'warning', VERIFIED: 'success' };
const ACTION_ICON: Readonly<Record<ActionStatus, string>> = { OPEN: '○', DONE: '◐', VERIFIED: '✓' };
export const actionTone = (status: ActionStatus): Tone => ACTION_TONE[status];
export const actionIcon = (status: ActionStatus): string => ACTION_ICON[status];

const RATING_TONE: Readonly<Record<Rating, Tone>> = { EXCELLENT: 'success', GOOD: 'success', FAIR: 'warning', POOR: 'danger' };
const RATING_ICON: Readonly<Record<Rating, string>> = { EXCELLENT: '★', GOOD: '✓', FAIR: '◐', POOR: '⚠' };
export const ratingTone = (rating: Rating): Tone => RATING_TONE[rating];
export const ratingIcon = (rating: Rating): string => RATING_ICON[rating];

/** A request the contractor can answer now: open (a returned one is open again). */
export const canRespond = (request: Pick<PortalRequest, 'status'>): boolean => request.status === 'OPEN';

/** Whether an answer already given was late, said in words next to it. */
export const answeredLate = (request: Pick<PortalRequest, 'response_late' | 'clock'>): boolean => request.response_late === true || request.clock === 'ANSWERED_LATE';

/** How many of the actions of a plan the contractor still owes (not yet marked done). */
export const actionsOwed = (plan: Pick<PortalPlan, 'actions'>): number => plan.actions.filter((action) => action.status === 'OPEN').length;

/** The open request, if any, that asks the contractor to answer the evaluation (the answer button of the evaluation opens its dialog). */
export function responseRequestOf(evaluation: Pick<PortalEvaluation, 'open_request_id'>, requests: readonly PortalRequest[]): PortalRequest | undefined {
  if (evaluation.open_request_id === null) return undefined;
  return requests.find((request) => request.id === evaluation.open_request_id && request.status === 'OPEN');
}

/** The paths of the five portal destinations; the navigation of the reduced frame lists these and nothing else. */
export const PORTAL_DESTINATIONS = [
  { id: 'VND-16', path: '/vnd/vnd-16' },
  { id: 'VND-17', path: '/vnd/vnd-17' },
  { id: 'VND-18', path: '/vnd/vnd-18' },
  { id: 'VND-19', path: '/vnd/vnd-19' },
] as const;
export type PortalDestination = (typeof PORTAL_DESTINATIONS)[number]['id'];

/** Words that a contractor must never read on the portal (the screens test that none of them is drawn, whatever a payload carries). */
export const FORBIDDEN_WORDS: readonly string[] = ['red flag', 'risk grade', 'risk_tier', 'lead', 'screening', 'party_link', 'other_contractors', 'investigation'];
