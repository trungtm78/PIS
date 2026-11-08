import type { components } from '@machvon/contracts';
import type { StepperStep, Tone } from '../../../ui';

export { dayText, failureCode, failureDetail, failureStatus, numberText, vietnamStamp } from '../../bid/egp/connection-model';

/** VND-01 to VND-06: the management of contractors and suppliers. The shapes are the contract's; nothing here is invented. */
type S = components['schemas'];
export type RegisterLine = S['VendorRegisterLine'];
export type RegisterPage = S['VendorRegisterPage'];
export type Figures = S['VendorFigures'];
export type Policy = S['VendorPolicyInfo'];
export type Coverage = S['VendorCoverage'];
export type ProfileView = S['VendorProfileView'];
export type Profile = S['VendorProfile'];
export type Owner = S['VendorOwner'];
export type Account = S['VendorPayeeAccount'];
export type Verdict = S['VendorPayeeVerdict'];
export type PayeeChange = S['VendorPayeeChange'];
export type PayeeChangeList = S['VendorPayeeChangeList'];
export type BankEvent = S['VendorBankEvent'];
export type Qualification = S['VendorQualification'];
export type KeyStaff = S['VendorKeyStaff'];
export type RestrictionLine = S['VendorRestrictionLine'];
export type CaseLine = S['VendorCaseLine'];
export type CasePage = S['VendorCasePage'];
export type CaseDetail = S['VendorCaseDetail'];
export type CaseEvent = S['VendorCaseEvent'];
export type CaseMember = S['VendorCaseMember'];
export type ReputationEvent = S['VendorReputationEvent'];
export type ReputationPage = S['VendorReputationPage'];
export type Duplicate = S['VendorDuplicate'];
export type Venture = S['VendorVenture'];
export type VenturePage = S['VendorVenturePage'];
export type ExpiryItem = S['VendorExpiryItem'];
export type ExpiryList = S['VendorExpiryList'];
export type GateCheck = S['VendorGateCheck'];
export type Requirement = S['VendorRequirement'];
export type PackageRequirements = S['VendorPackageRequirements'];
export type TaxCheck = S['VendorTaxCheck'];
export type BidSecurity = S['VendorBidSecurityFactor'];
export type Clock = CaseLine['clock'];
export type CaseStatus = CaseLine['status'];
export type CertificateState = Qualification['state'];
export type CertificateKind = Qualification['kind'];
export type StaffRole = KeyStaff['staff_role'];
export type Behaviour = ReputationEvent['behaviour_code'];
export type Grade = NonNullable<Qualification['grade']>;
export type Gap = S['VendorRequirementFinding']['gap'];
export type GateAction = GateCheck['action'];
export type ProfileField = Coverage['required'][number];
export type DuplicateSignal = Duplicate['signals'][number];
export type Scope = NonNullable<CaseLine['decision_scope']>;
export type TriggerKind = S['VendorCaseNew']['trigger_kind'];
export type Escalation = CaseDetail['escalation'];

/** The permissions of the module (the server decides every one of them again). */
export const PERMISSION = {
  read: 'vnd.read',
  profileWrite: 'vnd.profile.write',
  duplicateDecide: 'vnd.duplicate.decide',
  bankRequest: 'vnd.bank.request',
  bankApprove: 'vnd.bank.approve',
  bankCallback: 'vnd.bank.callback',
  qualificationWrite: 'vnd.qualification.write',
  qualificationVerify: 'vnd.qualification.verify',
  restrictionPropose: 'vnd.restriction.propose',
  restrictionDecide: 'vnd.restriction.decide',
  reputationWrite: 'vnd.reputation.write',
  reputationPost: 'vnd.reputation.post',
  ventureWrite: 'vnd.venture.write',
} as const;

// ---- the closed lists of the contract, written once so the screens and the tests walk the same lists ---------------------------------------------------------------------

export const PROFILE_FIELDS: readonly ProfileField[] = ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'BUSINESS_REGISTRATION', 'OWNERSHIP'];
export const CERTIFICATE_KINDS: readonly CertificateKind[] = [
  'CONSTRUCTION_ACTIVITY',
  'DESIGN_CONSULTING',
  'SUPERVISION_CONSULTING',
  'SAFETY_CERTIFICATE',
  'QUALITY_MANAGEMENT_ISO9001',
  'BUSINESS_REGISTRATION',
  'TAX_CLEARANCE',
  'SOCIAL_INSURANCE_CLEARANCE',
  'EQUIPMENT_OWNERSHIP',
  'OTHER',
];
export const STAFF_ROLES: readonly StaffRole[] = ['PROJECT_MANAGER', 'SITE_ENGINEER', 'DESIGN_LEAD', 'SUPERVISOR', 'SAFETY_OFFICER', 'QUALITY_OFFICER', 'SURVEYOR', 'OTHER'];
export const CERTIFICATE_STATES: readonly CertificateState[] = ['VALID', 'EXPIRING_FIRST', 'EXPIRING_SECOND', 'EXPIRED', 'NOT_STARTED', 'REVOKED'];
export const BEHAVIOURS: readonly Behaviour[] = [
  'NOT_COMPARING_DOCUMENTS',
  'NOT_NEGOTIATING',
  'WINNING_WITHOUT_SIGNING',
  'WITHDRAWING_AFTER_CLOSING',
  'NO_BID_SECURITY',
  'NO_PERFORMANCE_SECURITY',
  'NO_AWARD_CONFIRMATION',
  'NO_KEY_RESOURCES',
  'OTHER_BY_LAW',
];
export const GRADES: readonly Grade[] = ['III', 'II', 'I'];
export const GAPS: readonly Gap[] = ['MISSING', 'NOT_VERIFIED', 'EXPIRED', 'NOT_STARTED', 'REVOKED', 'GRADE_LOW', 'SCOPE_NOT_COVERED'];
export const GATE_ACTIONS: readonly GateAction[] = ['BID_SUBMISSION', 'RESULT', 'CONTRACT_ACTIVATION', 'SUBCONTRACT', 'PAYMENT'];
export const GATE_CHECKS: readonly GateCheck['checks'][number][] = ['RESTRICTION', 'VERIFICATION', 'PROFILE', 'QUALIFICATION', 'PAYEE'];
export const CLOCKS: readonly Clock[] = ['ON_TIME', 'DUE_SOON', 'OVERDUE', 'MET', 'MET_LATE'];
export const CASE_STATUSES: readonly CaseStatus[] = ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED', 'EFFECTIVE', 'EXPIRED', 'LIFTED', 'DISMISSED'];
export const TRIGGER_KINDS: readonly TriggerKind[] = ['INVESTOR_PROPOSAL', 'INSPECTION_CONCLUSION', 'AUDIT_CONCLUSION', 'PETITION_RESOLUTION', 'OWN_INITIATIVE'];
export const SCOPES: readonly Scope[] = ['TENANT', 'PROVINCE', 'NATIONWIDE'];
export const DUPLICATE_SIGNALS: readonly DuplicateSignal[] = ['TAX_HEAD', 'ADDRESS', 'PHONE', 'EMAIL', 'LEGAL_REPRESENTATIVE', 'OWNER', 'BANK_ACCOUNT', 'NAME'];
export const VIOLATION_GROUPS = ['GROUP_1', 'GROUP_2', 'GROUP_3'] as const;
export const VERIFICATIONS: readonly Profile['verification_status'][] = ['UNVERIFIED', 'VERIFIED', 'REJECTED'];
export const CONTROL_BASES = ['SHARE_CAPITAL', 'VOTING_RIGHTS', 'APPOINTS_MANAGEMENT', 'OTHER_CONTROL'] as const;
export const PAYEE_REASONS: readonly NonNullable<Verdict['reason']>[] = ['NO_ACCOUNT_REGISTERED', 'IN_WAITING_PERIOD', 'NO_VALID_ACCOUNT', 'CHANGE_UNDER_REVIEW'];
export const CHANGE_STATUSES: readonly PayeeChange['status'][] = ['REQUESTED', 'ACTIVATED', 'REJECTED', 'CANCELLED', 'EXPIRED'];
export const CHANGE_STEPS: readonly PayeeChange['remaining'][number][] = ['CONTRACT_MATCH', 'ACCOUNT_MATCH', 'CALLBACK'];

/** The text of a code as the keys of the catalogue write it: `NOT_COMPARING_DOCUMENTS` is `notComparingDocuments`, `key-staff` is `keyStaff`. */
export function camel(code: string): string {
  return code.toLowerCase().replace(/[_-]+([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

// ---- days -----------------------------------------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** The Vietnam day (`YYYY-MM-DD`) of an instant; an unreadable value gives an empty text. */
export function vietnamDay(instant: string | null | undefined): string {
  if (instant === null || instant === undefined) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant;
  const moment = Date.parse(instant);
  return Number.isNaN(moment) ? '' : new Date(moment + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from one day to another (`to` minus `from`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86_400_000);
}

export interface Countdown {
  /** The waiting is over. */
  done: boolean;
  days: number;
  hours: number;
}

/** What is left until an instant, counted from the moment of the answer (`asOf`), never from this machine's clock. A moment already passed is done. */
export function countdown(until: string, asOf: string): Countdown {
  const end = Date.parse(until);
  const start = Date.parse(asOf);
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return { done: true, days: 0, hours: 0 };
  const hours = Math.ceil((end - start) / 3_600_000);
  return { done: false, days: Math.floor(hours / 24), hours: hours % 24 };
}

// ---- tones ----------------------------------------------------------------------------------------------------------------------------------------------------------------

const CLOCK_TONE: Readonly<Record<Clock, Tone>> = { ON_TIME: 'success', DUE_SOON: 'warning', OVERDUE: 'danger', MET: 'success', MET_LATE: 'warning' };
const CLOCK_ICON: Readonly<Record<Clock, string>> = { ON_TIME: '◔', DUE_SOON: '⚠', OVERDUE: '⛔', MET: '✓', MET_LATE: '✓' };
export const clockTone = (clock: Clock): Tone => CLOCK_TONE[clock];
export const clockIcon = (clock: Clock): string => CLOCK_ICON[clock];
/** A clock that still runs: the thing is not done, so the days left matter. */
export const clockOpen = (clock: Clock): boolean => clock === 'ON_TIME' || clock === 'DUE_SOON' || clock === 'OVERDUE';

const CERT_TONE: Readonly<Record<CertificateState, Tone>> = { VALID: 'success', EXPIRING_FIRST: 'info', EXPIRING_SECOND: 'warning', EXPIRED: 'danger', NOT_STARTED: 'neutral', REVOKED: 'danger' };
const CERT_ICON: Readonly<Record<CertificateState, string>> = { VALID: '✓', EXPIRING_FIRST: '◔', EXPIRING_SECOND: '⚠', EXPIRED: '⛔', NOT_STARTED: '○', REVOKED: '⊘' };
export const certificateTone = (state: CertificateState): Tone => CERT_TONE[state];
export const certificateIcon = (state: CertificateState): string => CERT_ICON[state];

const VERIFICATION_TONE: Readonly<Record<Profile['verification_status'], Tone>> = { UNVERIFIED: 'warning', VERIFIED: 'success', REJECTED: 'danger' };
export const verificationTone = (status: Profile['verification_status']): Tone => VERIFICATION_TONE[status];

const STATUS_TONE: Readonly<Record<CaseStatus, Tone>> = { PROPOSED: 'info', NOTICE_SENT: 'info', RESPONSE_RECEIVED: 'info', DECIDED: 'warning', EFFECTIVE: 'danger', EXPIRED: 'neutral', LIFTED: 'neutral', DISMISSED: 'neutral' };
export const caseStatusTone = (status: CaseStatus): Tone => STATUS_TONE[status];

export const isFinalStatus = (status: CaseStatus): boolean => status === 'EXPIRED' || status === 'LIFTED' || status === 'DISMISSED';

// ---- the case: steps and the ban period -------------------------------------------------------------------------------------------------------------------------------

export const CASE_STEPS = ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED', 'EFFECTIVE'] as const;
export type CaseStep = (typeof CASE_STEPS)[number] | 'END';

/**
 * The steps of a case for the stepper: the five steps in order and a last one that is the way the case ended (expired, lifted or dismissed). Before the end the step the case is at is current and the later ones are upcoming. After the end
 * a step the case went through is done, a step it never reached (a dismissal before any decision, no response) is skipped, and the last step is the current one.
 */
export function caseSteps(line: Pick<CaseLine, 'status'>, events: readonly Pick<CaseEvent, 'to_status'>[]): Array<{ code: CaseStep; status: StepperStep['status'] }> {
  const reached = new Set<string>(['PROPOSED', ...events.map((event) => event.to_status)]);
  const index = (CASE_STEPS as readonly string[]).indexOf(line.status);
  const final = isFinalStatus(line.status);
  const steps = CASE_STEPS.map((code, position): { code: CaseStep; status: StepperStep['status'] } => {
    if (final) return { code, status: reached.has(code) ? 'done' : 'skipped' };
    if (position < index) return { code, status: 'done' };
    return { code, status: position === index ? 'current' : 'upcoming' };
  });
  return [...steps, { code: 'END', status: final ? 'current' : 'upcoming' }];
}

export interface DebarmentPeriod {
  min_months: number;
  max_months: number;
  behaviours: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The periods of the violation groups as the answer carries them (a group whose numbers are not whole numbers is left out). */
export function periodsOf(raw: unknown): Record<string, DebarmentPeriod> {
  const record = asRecord(raw) ?? {};
  const result: Record<string, DebarmentPeriod> = {};
  for (const [group, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (entry === undefined || typeof entry.min_months !== 'number' || typeof entry.max_months !== 'number') continue;
    result[group] = { min_months: entry.min_months, max_months: entry.max_months, behaviours: typeof entry.behaviours === 'string' ? entry.behaviours : '' };
  }
  return result;
}

/** A number of the rule in force (`policy.params`), when it is one. */
export function paramNumber(policy: Policy | undefined, name: string): number | undefined {
  const value = asRecord(policy?.params)?.[name];
  return typeof value === 'number' ? value : undefined;
}

/** The months the violation groups allow: from the longest of the shortest bans to the sum of the longest, cut at the cumulative maximum of the rule. Null when a group has no period. */
export function banRange(groups: readonly string[], periods: Readonly<Record<string, DebarmentPeriod>>, cumulativeMax: number | undefined): { min: number; max: number } | null {
  if (groups.length === 0) return null;
  let min = 0;
  let max = 0;
  for (const group of groups) {
    const period = periods[group];
    if (period === undefined) return null;
    min = Math.max(min, period.min_months);
    max += period.max_months;
  }
  return { min, max: cumulativeMax === undefined ? max : Math.min(max, cumulativeMax) };
}

/** The last day of a ban that starts on `from` and runs `months` months (the day before the same day months later). */
export function banLastDay(from: string, months: number): string {
  const start = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return '';
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const end = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(start.getUTCDate(), lastOfMonth)) - 86_400_000;
  return new Date(end).toISOString().slice(0, 10);
}

// ---- the account number: only ever masked ---------------------------------------------------------------------------------------------------------------------------

/**
 * The number of an account as the screen may show it. The server sends it masked; a run of more than four digits that is not masked is cut to its last four, so a server that forgot to mask can not put a whole
 * number on the screen. The screen never asks for the whole number except in the field of the request form.
 */
export function maskedAccount(value: string): string {
  return value.replace(/\d{5,}/g, (run) => `••••${run.slice(-4)}`);
}

// ---- profile coverage -----------------------------------------------------------------------------------------------------------------------------------------------

/** The share of the required fields that are present, as a whole percent (the server's own figure is shown; this is for the bar of a line without one). */
export const coverageWidth = (coverage: Coverage): number => Math.max(0, Math.min(100, coverage.coverage_pct));

// ---- certificates against the requirements of a package ------------------------------------------------------------------------------------------------------------

const GRADE_RANK: Readonly<Record<Grade, number>> = { III: 1, II: 2, I: 3 };
const GAP_ORDER: Readonly<Record<Exclude<Gap, 'MISSING'>, number>> = { SCOPE_NOT_COVERED: 1, GRADE_LOW: 2, NOT_VERIFIED: 3, EXPIRED: 4, NOT_STARTED: 4, REVOKED: 5 };

export interface RequirementFinding {
  kind: CertificateKind;
  gap: Gap | null;
  qualificationId: string | null;
}

function gapOf(requirement: Requirement, qualification: Qualification): Exclude<Gap, 'MISSING'> | null {
  if (qualification.state === 'REVOKED') return 'REVOKED';
  if (qualification.state === 'EXPIRED') return 'EXPIRED';
  if (qualification.state === 'NOT_STARTED') return 'NOT_STARTED';
  if (qualification.verified_at === null) return 'NOT_VERIFIED';
  if (requirement.min_grade !== null && requirement.min_grade !== undefined && (qualification.grade === null || GRADE_RANK[qualification.grade] < GRADE_RANK[requirement.min_grade])) return 'GRADE_LOW';
  const keyword = requirement.scope_keyword?.trim().toLowerCase() ?? '';
  if (keyword !== '' && !(qualification.scope ?? '').toLowerCase().includes(keyword)) return 'SCOPE_NOT_COVERED';
  return null;
}

/**
 * Where the certificates of a contractor fall short of the requirements of a package: a requirement is met by a certificate of its kind that is verified, in force, of at least the grade asked and whose scope names the keyword. When none
 * does, the gap is the one of the certificate that is nearest to meeting it (no certificate of the kind is a missing one). This is a preview for the person who sets the requirements: the check at the evaluation of the bids is the server's.
 */
export function requirementFindings(requirements: readonly Requirement[], qualifications: readonly Qualification[]): RequirementFinding[] {
  return requirements.map((requirement) => {
    const candidates = qualifications.filter((qualification) => qualification.kind === requirement.kind);
    if (candidates.length === 0) return { kind: requirement.kind, gap: 'MISSING', qualificationId: null };
    let best: { gap: Exclude<Gap, 'MISSING'>; id: string } | null = null;
    for (const candidate of candidates) {
      const gap = gapOf(requirement, candidate);
      if (gap === null) return { kind: requirement.kind, gap: null, qualificationId: candidate.id };
      if (best === null || GAP_ORDER[gap] < GAP_ORDER[best.gap]) best = { gap, id: candidate.id };
    }
    return { kind: requirement.kind, gap: best?.gap ?? 'MISSING', qualificationId: best?.id ?? null };
  });
}

// ---- joint ventures ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface VentureDraftMember {
  contractorId: string;
  share: string;
  lead: boolean;
}

export type VentureProblem = 'MEMBERS' | 'SHARE' | 'DUPLICATE' | 'LEAD' | 'TOTAL';

/** Shares are compared in hundredths of a percent, so 33.33 + 33.33 + 33.34 is exactly 100. A share that is not a number above zero is NaN. */
export function shareValue(text: string): number {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return Number.NaN;
  return Math.round(Number(trimmed) * 100);
}

export function ventureTotal(members: readonly VentureDraftMember[]): number {
  return members.reduce((sum, member) => sum + (Number.isNaN(shareValue(member.share)) ? 0 : shareValue(member.share)), 0) / 100;
}

/** What keeps a joint venture from being created: two members at least, every member chosen once with a share above zero, exactly one lead, shares that total 100. */
export function ventureProblems(members: readonly VentureDraftMember[]): VentureProblem[] {
  const problems: VentureProblem[] = [];
  if (members.length < 2 || members.some((member) => !isUuid(member.contractorId))) problems.push('MEMBERS');
  if (members.some((member) => Number.isNaN(shareValue(member.share)) || shareValue(member.share) <= 0 || shareValue(member.share) > 10_000)) problems.push('SHARE');
  const ids = members.map((member) => member.contractorId.trim().toLowerCase());
  if (new Set(ids).size !== ids.length) problems.push('DUPLICATE');
  if (members.filter((member) => member.lead).length !== 1) problems.push('LEAD');
  if (!problems.includes('SHARE') && Math.round(ventureTotal(members) * 100) !== 10_000) problems.push('TOTAL');
  return problems;
}

// ---- reasons and fields -----------------------------------------------------------------------------------------------------------------------------------------------

/** Why a text is not accepted by the length the contract gives it (the trimmed length counts). */
export function textProblem(value: string, min: number, max: number, required = true): 'EMPTY' | 'SHORT' | 'LONG' | null {
  const text = value.trim();
  if (text === '') return required ? 'EMPTY' : null;
  if (text.length < min) return 'SHORT';
  return text.length > max ? 'LONG' : null;
}

/** The first day of an input of a day: a day that is not a calendar day is not accepted. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const moment = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(moment) && new Date(moment).toISOString().slice(0, 10) === value;
}

/** A percent as the figures of the answer carry it (null when there is nothing to divide). */
export function percentText(value: number | null, locale: string): string {
  return value === null ? '–' : `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
}

// ---- where the screens of the module live (the alert centre and the screens link by these) -------------------------------------------------------------------------

export const PATHS = {
  register: '/vnd/vnd-01',
  profile: (contractor: string): string => `/vnd/vnd-02?contractor=${encodeURIComponent(contractor)}`,
  cases: '/vnd/vnd-03',
  caseOf: (id: string): string => `/vnd/vnd-03?case=${encodeURIComponent(id)}`,
  payee: (contractor?: string): string => (contractor === undefined ? '/vnd/vnd-04' : `/vnd/vnd-04?contractor=${encodeURIComponent(contractor)}`),
  certificates: (contractor?: string): string => (contractor === undefined ? '/vnd/vnd-05' : `/vnd/vnd-05?contractor=${encodeURIComponent(contractor)}`),
  reputation: (event?: string): string => (event === undefined ? '/vnd/vnd-06' : `/vnd/vnd-06?event=${encodeURIComponent(event)}`),
} as const;

// ---- the body of the update of a profile -----------------------------------------------------------------------------------------------------------------------------

export const PROFILE_TEXT_FIELDS = ['legal_rep_name', 'legal_rep_position', 'registered_address', 'phone', 'email', 'business_registration_no'] as const;
export type ProfileTextField = (typeof PROFILE_TEXT_FIELDS)[number];

/** Only what changed: a field whose text differs from the profile is sent (an emptied field is sent as null, which clears it); a field that is the same is not sent at all. */
export function profileUpdateBody(original: Profile, values: Readonly<Record<string, unknown>>): Partial<Record<ProfileTextField, string | null>> {
  const body: Partial<Record<ProfileTextField, string | null>> = {};
  for (const field of PROFILE_TEXT_FIELDS) {
    const raw = values[field];
    const next = typeof raw === 'string' ? raw.trim() : '';
    const before = (original[field] ?? '').trim();
    if (next !== before) body[field] = next === '' ? null : next;
  }
  return body;
}

/** A share of the capital as the request takes it: a number of at most two decimals from 0 to 100, as text. */
export const SHARE_PATTERN = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

// ---- who did it, and what a case can do next ----------------------------------------------------------------------------------------------------------------------------

/** The two letters of a name for the round mark of a timeline entry (the first letters of the last two words). */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [words[0] ?? ''] : words.slice(-2);
  return letters
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase('vi');
}

export type CaseMoveCode = 'SEND_NOTICE' | 'RECORD_RESPONSE' | 'CLOSE_NO_RESPONSE' | 'WITHDRAW';

/** The moves a case in this status can make (the server refuses any other with RESTRICTION_CASE_STATE_INVALID; the screen simply does not offer them). */
export function caseMoves(status: CaseStatus): CaseMoveCode[] {
  switch (status) {
    case 'PROPOSED':
      return ['SEND_NOTICE', 'WITHDRAW'];
    case 'NOTICE_SENT':
      return ['RECORD_RESPONSE', 'CLOSE_NO_RESPONSE', 'WITHDRAW'];
    case 'RESPONSE_RECEIVED':
      return ['WITHDRAW'];
    default:
      return [];
  }
}

/** The proposer of a case may not decide it (maker and checker are two people): the screen turns the decision off for the signed-in person who proposed it; the server enforces it again (403 SELF_APPROVAL_DENIED). */
export const isProposer = (line: Pick<CaseLine, 'proposed_by_name'>, me: string | undefined): boolean => me !== undefined && me.trim() !== '' && line.proposed_by_name !== null && line.proposed_by_name.trim() === me.trim();

/** The id of the resource a command made (`resource_id` of the command result), when it gave one. */
export function resourceId(result: unknown): string | undefined {
  const value = asRecord(result)?.resource_id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}
