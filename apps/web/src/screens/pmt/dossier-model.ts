import { ApiError } from '@machvon/api-client';

/** The permission that opens a dossier, adds a permit and records a milestone (PMT 2), and the one that decides, renews and revokes. */
export const MANAGE_PERMISSION = 'permit.manage';
export const RECORD_PERMISSION = 'permit.record';
export const READ_PERMISSION = 'permit.read';

export const DOSSIER_PATH = '/pmt/pmt-01';
export const PERMIT_PATH = '/pmt/pmt-02';
/** A permit that ends within this many days is shown as expiring (the first alert level of BR-PMT-06). */
export const EXPIRING_DAYS = 60;

export const PERMIT_STATUSES = ['PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'REJECTED', 'EXPIRED', 'REVOKED', 'SUPERSEDED', 'EXEMPTED'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];
export const DOSSIER_STATUSES = ['OPEN', 'COMPLETE', 'CLOSED'] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];
export const MILESTONE_STEPS = ['SUBMITTED', 'ACKNOWLEDGED', 'APPRAISAL_MEETING', 'SUPPLEMENT_REQUESTED', 'SUPPLEMENT_SUBMITTED', 'DECISION', 'HANDED_OVER'] as const;
export type MilestoneStep = (typeof MILESTONE_STEPS)[number];

const MAX_TEXT = 2000;
const MAX_PERMIT_NO = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export interface PersonView {
  membershipId: string;
  displayName: string;
}

export interface DossierLineView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectComponentCode: string | null;
  ownerUnitName: string;
  owner: PersonView | null;
  status: DossierStatus;
  /** The share of the required types that a valid permit or an exemption covers, as the decimal text the server stores. */
  readinessPct: string;
  requiredCount: number;
  satisfiedCount: number;
  issuedCount: number;
  expiringCount: number;
  unconfirmedCount: number;
  version: number;
}

export interface PermitLineView {
  id: string;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeRevision: number;
  permitTypeName: string;
  /** The confirmation id the type version still waits for; null once confirmed. */
  cxnRef: string | null;
  exemptionAllowed: boolean;
  isRequired: boolean;
  status: PermitStatus;
  permitNo: string | null;
  authorityName: string | null;
  submittedOn: string | null;
  expectedDecisionOn: string | null;
  issuedOn: string | null;
  validFrom: string | null;
  /** The last day the permit is valid (inclusive). */
  validUntil: string | null;
  noExpiry: boolean;
  supersedesId: string | null;
  responsible: PersonView | null;
  version: number;
}

export interface DossierView extends DossierLineView {
  permits: PermitLineView[];
}

export interface MilestoneView {
  id: string;
  stepCode: MilestoneStep;
  plannedOn: string | null;
  actualOn: string | null;
  note: string | null;
  documentVersionId: string | null;
  createdAt: string;
}

export interface PermitDetailView extends PermitLineView {
  dossierId: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  documentVersionId: string | null;
  exemptionBasis: string | null;
  revokeReason: string | null;
  milestones: MilestoneView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

function personOf(raw: unknown): PersonView | null {
  if (!isRecord(raw)) return null;
  const membershipId = text(raw.membership_id);
  return membershipId === undefined ? null : { membershipId, displayName: text(raw.display_name) ?? '' };
}

/** A row of the dossier list as a DossierLineView, or undefined when it lacks what the screen needs (the screen shows what it can trust). */
export function toDossierLine(raw: unknown): DossierLineView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const projectId = text(raw.project_id);
  const projectCode = text(raw.project_code);
  const projectName = text(raw.project_name);
  const ownerUnitName = text(raw.owner_unit_name);
  const status = text(raw.status) as DossierStatus | undefined;
  const readinessPct = text(raw.readiness_pct);
  const counts = [raw.required_count, raw.satisfied_count, raw.issued_count, raw.expiring_count, raw.unconfirmed_count].map(whole);
  const version = whole(raw.version);
  if (
    id === undefined || projectId === undefined || projectCode === undefined || projectName === undefined || ownerUnitName === undefined ||
    status === undefined || !DOSSIER_STATUSES.includes(status) || readinessPct === undefined || !/^\d+(\.\d+)?$/.test(readinessPct) ||
    version === undefined || counts.some((count) => count === undefined)
  ) {
    return undefined;
  }
  const [requiredCount, satisfiedCount, issuedCount, expiringCount, unconfirmedCount] = counts as [number, number, number, number, number];
  return {
    id,
    projectId,
    projectCode,
    projectName,
    projectComponentCode: text(raw.project_component_code) ?? null,
    ownerUnitName,
    owner: personOf(raw.owner_membership),
    status,
    readinessPct,
    requiredCount,
    satisfiedCount,
    issuedCount,
    expiringCount,
    unconfirmedCount,
    version,
  };
}

export function toPermitLine(raw: unknown): PermitLineView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const permitTypeId = text(raw.permit_type_id);
  const permitTypeCode = text(raw.permit_type_code);
  const permitTypeName = text(raw.permit_type_name);
  const revision = whole(raw.permit_type_revision);
  const status = text(raw.status) as PermitStatus | undefined;
  const version = whole(raw.version);
  if (
    id === undefined || permitTypeId === undefined || permitTypeCode === undefined || permitTypeName === undefined || revision === undefined ||
    status === undefined || !PERMIT_STATUSES.includes(status) || version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    permitTypeId,
    permitTypeCode,
    permitTypeRevision: revision,
    permitTypeName,
    cxnRef: text(raw.cxn_ref) ?? null,
    exemptionAllowed: raw.exemption_allowed === true,
    isRequired: raw.is_required === true,
    status,
    permitNo: text(raw.permit_no) ?? null,
    authorityName: text(raw.authority_name) ?? null,
    submittedOn: text(raw.submitted_on) ?? null,
    expectedDecisionOn: text(raw.expected_decision_on) ?? null,
    issuedOn: text(raw.issued_on) ?? null,
    validFrom: text(raw.valid_from) ?? null,
    validUntil: text(raw.valid_until) ?? null,
    noExpiry: raw.no_expiry === true,
    supersedesId: text(raw.supersedes_id) ?? null,
    responsible: personOf(raw.responsible_membership),
    version,
  };
}

/** A dossier with its permits; a permit row the screen cannot trust is left out. */
export function toDossier(raw: unknown): DossierView | undefined {
  const line = toDossierLine(raw);
  if (line === undefined || !isRecord(raw)) return undefined;
  const permits = Array.isArray(raw.permits) ? raw.permits.flatMap((permit) => toPermitLine(permit) ?? []) : [];
  return { ...line, permits };
}

function toMilestone(raw: unknown): MilestoneView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const stepCode = text(raw.step_code) as MilestoneStep | undefined;
  const createdAt = text(raw.created_at);
  if (id === undefined || stepCode === undefined || !MILESTONE_STEPS.includes(stepCode) || createdAt === undefined) return undefined;
  return {
    id,
    stepCode,
    plannedOn: text(raw.planned_on) ?? null,
    actualOn: text(raw.actual_on) ?? null,
    note: text(raw.note) ?? null,
    documentVersionId: text(raw.document_version_id) ?? null,
    createdAt,
  };
}

export function toPermitDetail(raw: unknown): PermitDetailView | undefined {
  const line = toPermitLine(raw);
  if (line === undefined || !isRecord(raw)) return undefined;
  const dossierId = text(raw.dossier_id);
  const projectId = text(raw.project_id);
  const projectCode = text(raw.project_code);
  const projectName = text(raw.project_name);
  if (dossierId === undefined || projectId === undefined || projectCode === undefined || projectName === undefined) return undefined;
  return {
    ...line,
    dossierId,
    projectId,
    projectCode,
    projectName,
    documentVersionId: text(raw.document_version_id) ?? null,
    exemptionBasis: text(raw.exemption_basis) ?? null,
    revokeReason: text(raw.revoke_reason) ?? null,
    milestones: Array.isArray(raw.milestones) ? raw.milestones.flatMap((milestone) => toMilestone(milestone) ?? []) : [],
  };
}

export const dossierLink = (dossierId: string): string => `${DOSSIER_PATH}?dossier=${encodeURIComponent(dossierId)}`;
export const permitLink = (permitId: string): string => `${PERMIT_PATH}?permit=${encodeURIComponent(permitId)}`;

export type StatusTone = 'green' | 'warn' | 'red' | 'gray';

/** The tone of the pill of a permit status; the pill always carries the word as well. */
export function statusTone(status: PermitStatus): StatusTone {
  switch (status) {
    case 'ISSUED':
    case 'EXEMPTED':
      return 'green';
    case 'SUBMITTED':
    case 'IN_APPRAISAL':
    case 'SUPPLEMENT_REQUESTED':
      return 'warn';
    case 'REJECTED':
    case 'REVOKED':
    case 'EXPIRED':
      return 'red';
    case 'PLANNED':
    case 'SUPERSEDED':
      return 'gray';
  }
}

const dayNumber = (value: string): number => Date.parse(`${value}T00:00:00Z`) / DAY_MS;

/** The days from `today` to the last day of validity (negative once it has passed); null for a permit without an end. */
export function daysRemaining(validUntil: string | null, today: string): number | null {
  return validUntil === null ? null : Math.round(dayNumber(validUntil) - dayNumber(today));
}

/** Whether an issued permit is valid on a day: its first and last day both count (BR-PMT-01). */
export function isValidOn(permit: Pick<PermitLineView, 'status' | 'validFrom' | 'validUntil' | 'noExpiry'>, day: string): boolean {
  if (permit.status !== 'ISSUED') return false;
  if (permit.validFrom !== null && permit.validFrom > day) return false;
  return permit.noExpiry || (permit.validUntil !== null && permit.validUntil >= day);
}

/** Whether a valid permit ends within the expiring window. */
export function isExpiring(permit: PermitLineView, today: string): boolean {
  const days = isValidOn(permit, today) ? daysRemaining(permit.validUntil, today) : null;
  return days !== null && days <= EXPIRING_DAYS;
}

/** The milestone steps a status allows (PMT 4), in the order of the process. */
export function stepsFor(status: PermitStatus): MilestoneStep[] {
  switch (status) {
    case 'PLANNED':
      return ['SUBMITTED'];
    case 'SUBMITTED':
      return ['ACKNOWLEDGED'];
    case 'IN_APPRAISAL':
      return ['APPRAISAL_MEETING', 'SUPPLEMENT_REQUESTED', 'DECISION'];
    case 'SUPPLEMENT_REQUESTED':
      return ['SUPPLEMENT_SUBMITTED'];
    case 'ISSUED':
      return ['HANDED_OVER'];
    default:
      return [];
  }
}

/** The steps that are facts: they carry the day they happened on. */
export const HAPPENED_STEPS: readonly MilestoneStep[] = ['SUBMITTED', 'ACKNOWLEDGED', 'SUPPLEMENT_REQUESTED', 'SUPPLEMENT_SUBMITTED', 'HANDED_OVER'];

/** The actions the form of PMT-02 offers for a permit: what the status allows. */
export interface PermitActionSet {
  steps: MilestoneStep[];
  decide: boolean;
  renew: boolean;
  revoke: boolean;
}

export function actionsFor(permit: Pick<PermitLineView, 'status' | 'noExpiry'>): PermitActionSet {
  return {
    steps: stepsFor(permit.status),
    decide: permit.status === 'IN_APPRAISAL',
    renew: (permit.status === 'ISSUED' || permit.status === 'EXPIRED') && !permit.noExpiry,
    revoke: permit.status === 'ISSUED',
  };
}

export type FieldProblem = 'required' | 'invalidDate' | 'future' | 'past' | 'tooLong' | 'invalidId' | 'dateOrder' | 'endOrExpiry' | 'scanRequired' | 'notAllowed';

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

function dateProblem(value: string, required: boolean): FieldProblem | undefined {
  if (value === '') return required ? 'required' : undefined;
  return isRealDate(value) ? undefined : 'invalidDate';
}

function idProblem(value: string, required: boolean): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return UUID.test(trimmed) ? undefined : 'invalidId';
}

function textProblem(value: string, required: boolean, max: number): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return trimmed.length > max ? 'tooLong' : undefined;
}

const blank = (value: string): boolean => value.trim() === '';

// ---- milestone ---------------------------------------------------------------------------------------------

export interface MilestoneForm {
  step: MilestoneStep;
  plannedOn: string;
  actualOn: string;
  note: string;
  documentVersionId: string;
}
export type MilestoneField = 'plannedOn' | 'actualOn' | 'note' | 'documentVersionId';
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

export const emptyMilestone = (step: MilestoneStep): MilestoneForm => ({ step, plannedOn: '', actualOn: '', note: '', documentVersionId: '' });

export function validateMilestone(form: MilestoneForm, today: string): FormErrors<MilestoneField> {
  const errors: FormErrors<MilestoneField> = {};
  const happened = HAPPENED_STEPS.includes(form.step);
  const planned = dateProblem(form.plannedOn, false);
  if (planned !== undefined) errors.plannedOn = planned;
  const actual = dateProblem(form.actualOn, happened);
  if (actual !== undefined) errors.actualOn = actual;
  else if (form.actualOn !== '' && form.actualOn > today) errors.actualOn = 'future';
  // A step that did not happen yet needs at least the day it is planned for.
  if (!happened && blank(form.plannedOn) && blank(form.actualOn)) errors.plannedOn = 'required';
  const note = textProblem(form.note, false, MAX_TEXT);
  if (note !== undefined) errors.note = note;
  const document = idProblem(form.documentVersionId, false);
  if (document !== undefined) errors.documentVersionId = document;
  return errors;
}

export interface MilestoneBody {
  step_code: MilestoneStep;
  planned_on?: string;
  actual_on?: string;
  note?: string;
  document_version_id?: string;
}

export function toMilestoneBody(form: MilestoneForm): MilestoneBody {
  return {
    step_code: form.step,
    ...(blank(form.plannedOn) ? {} : { planned_on: form.plannedOn }),
    ...(blank(form.actualOn) ? {} : { actual_on: form.actualOn }),
    ...(blank(form.note) ? {} : { note: form.note.trim() }),
    ...(blank(form.documentVersionId) ? {} : { document_version_id: form.documentVersionId.trim() }),
  };
}

// ---- decision ----------------------------------------------------------------------------------------------

export type DecisionOutcome = 'ISSUED' | 'REJECTED';
export interface DecisionForm {
  outcome: DecisionOutcome;
  permitNo: string;
  issuedOn: string;
  validFrom: string;
  validUntil: string;
  noExpiry: boolean;
  documentVersionId: string;
  reason: string;
}
export type DecisionField = 'permitNo' | 'issuedOn' | 'validFrom' | 'validUntil' | 'documentVersionId' | 'reason';

export const EMPTY_DECISION: DecisionForm = { outcome: 'ISSUED', permitNo: '', issuedOn: '', validFrom: '', validUntil: '', noExpiry: false, documentVersionId: '', reason: '' };

export function validateDecision(form: DecisionForm, today: string): FormErrors<DecisionField> {
  const errors: FormErrors<DecisionField> = {};
  const document = idProblem(form.documentVersionId, false);
  if (document !== undefined) errors.documentVersionId = document;
  if (form.outcome === 'REJECTED') {
    const reason = textProblem(form.reason, true, MAX_TEXT);
    if (reason !== undefined) errors.reason = reason;
    // A rejection has no number and no days.
    if (!blank(form.permitNo)) errors.permitNo = 'notAllowed';
    if (!blank(form.issuedOn)) errors.issuedOn = 'notAllowed';
    if (!blank(form.validFrom)) errors.validFrom = 'notAllowed';
    if (!blank(form.validUntil) || form.noExpiry) errors.validUntil = 'notAllowed';
    return errors;
  }
  const permitNo = textProblem(form.permitNo, true, MAX_PERMIT_NO);
  if (permitNo !== undefined) errors.permitNo = permitNo;
  const issued = dateProblem(form.issuedOn, false);
  if (issued !== undefined) errors.issuedOn = issued;
  else if (form.issuedOn > today) errors.issuedOn = 'future';
  const from = dateProblem(form.validFrom, false);
  if (from !== undefined) errors.validFrom = from;
  const until = dateProblem(form.validUntil, false);
  if (until !== undefined) errors.validUntil = until;
  else if (form.noExpiry && !blank(form.validUntil)) errors.validUntil = 'endOrExpiry';
  else if (from === undefined && form.validFrom !== '' && form.validUntil !== '' && form.validUntil < form.validFrom) errors.validUntil = 'dateOrder';
  // The scan of the permit is what makes it a permit: the form says so before the server does.
  if (blank(form.documentVersionId)) errors.documentVersionId = 'scanRequired';
  return errors;
}

export interface DecisionBody {
  outcome: DecisionOutcome;
  permit_no?: string;
  issued_on?: string;
  valid_from?: string;
  valid_until?: string;
  no_expiry?: boolean;
  document_version_id?: string;
  reason?: string;
}

export function toDecisionBody(form: DecisionForm): DecisionBody {
  const document = blank(form.documentVersionId) ? {} : { document_version_id: form.documentVersionId.trim() };
  if (form.outcome === 'REJECTED') return { outcome: 'REJECTED', reason: form.reason.trim(), ...document };
  return {
    outcome: 'ISSUED',
    permit_no: form.permitNo.trim(),
    ...(blank(form.issuedOn) ? {} : { issued_on: form.issuedOn }),
    ...(blank(form.validFrom) ? {} : { valid_from: form.validFrom }),
    ...(form.noExpiry ? { no_expiry: true } : blank(form.validUntil) ? {} : { valid_until: form.validUntil }),
    ...document,
  };
}

// ---- renewal and revocation ---------------------------------------------------------------------------------

export interface RenewalForm {
  newPermitNo: string;
  newValidUntil: string;
  documentVersionId: string;
}
export type RenewalField = keyof RenewalForm;
export const EMPTY_RENEWAL: RenewalForm = { newPermitNo: '', newValidUntil: '', documentVersionId: '' };

/** A renewal: a new number, a last day that is not in days that are gone (and, for a permit with an end, later than that end), and the new scan. */
export function validateRenewal(form: RenewalForm, current: Pick<PermitLineView, 'validUntil'>, today: string): FormErrors<RenewalField> {
  const errors: FormErrors<RenewalField> = {};
  const no = textProblem(form.newPermitNo, true, MAX_PERMIT_NO);
  if (no !== undefined) errors.newPermitNo = no;
  const until = dateProblem(form.newValidUntil, true);
  if (until !== undefined) errors.newValidUntil = until;
  else if (form.newValidUntil < today) errors.newValidUntil = 'past';
  else if (current.validUntil !== null && form.newValidUntil <= current.validUntil) errors.newValidUntil = 'dateOrder';
  const document = idProblem(form.documentVersionId, true);
  if (document !== undefined) errors.documentVersionId = document;
  return errors;
}

export interface RenewalBody {
  new_permit_no: string;
  new_valid_until: string;
  document_version_id: string;
}

export const toRenewalBody = (form: RenewalForm): RenewalBody => ({
  new_permit_no: form.newPermitNo.trim(),
  new_valid_until: form.newValidUntil,
  document_version_id: form.documentVersionId.trim(),
});

export interface RevocationForm {
  reason: string;
  decisionDocumentVersionId: string;
}
export type RevocationField = keyof RevocationForm;
export const EMPTY_REVOCATION: RevocationForm = { reason: '', decisionDocumentVersionId: '' };

export function validateRevocation(form: RevocationForm): FormErrors<RevocationField> {
  const errors: FormErrors<RevocationField> = {};
  const reason = textProblem(form.reason, true, MAX_TEXT);
  if (reason !== undefined) errors.reason = reason;
  const document = idProblem(form.decisionDocumentVersionId, true);
  if (document !== undefined) errors.decisionDocumentVersionId = document;
  return errors;
}

export interface RevocationBody {
  reason: string;
  decision_document_version_id: string;
}

export const toRevocationBody = (form: RevocationForm): RevocationBody => ({ reason: form.reason.trim(), decision_document_version_id: form.decisionDocumentVersionId.trim() });

// ---- adding a permit and opening a dossier ------------------------------------------------------------------

export interface AddPermitForm {
  permitTypeId: string;
  authorityName: string;
  expectedDecisionOn: string;
}
export type AddPermitField = keyof AddPermitForm;
export const EMPTY_ADD_PERMIT: AddPermitForm = { permitTypeId: '', authorityName: '', expectedDecisionOn: '' };

export function validateAddPermit(form: AddPermitForm): FormErrors<AddPermitField> {
  const errors: FormErrors<AddPermitField> = {};
  if (blank(form.permitTypeId)) errors.permitTypeId = 'required';
  const authority = textProblem(form.authorityName, false, MAX_TEXT);
  if (authority !== undefined) errors.authorityName = authority;
  const expected = dateProblem(form.expectedDecisionOn, false);
  if (expected !== undefined) errors.expectedDecisionOn = expected;
  return errors;
}

export interface AddPermitBody {
  permit_type_id: string;
  authority_name?: string;
  expected_decision_on?: string;
}

export const toAddPermitBody = (form: AddPermitForm): AddPermitBody => ({
  permit_type_id: form.permitTypeId,
  ...(blank(form.authorityName) ? {} : { authority_name: form.authorityName.trim() }),
  ...(blank(form.expectedDecisionOn) ? {} : { expected_decision_on: form.expectedDecisionOn }),
});

/** A project the caller may read: the dossier is opened for one of them, owned by the unit that owns the project. */
export interface ProjectOption {
  id: string;
  code: string;
  name: string;
  ownerUnitId: string;
}

/** A project option from a row of the project register read, or undefined when the row lacks what is needed. */
export function toProjectOption(raw: unknown): ProjectOption | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const code = text(raw.code);
  const name = text(raw.name);
  const ownerUnitId = text(raw.owner_unit_id);
  return id === undefined || code === undefined || name === undefined || ownerUnitId === undefined ? undefined : { id, code, name, ownerUnitId };
}

/** The projects that have no dossier yet: a project has one dossier, and a second is refused. */
export const projectsWithoutDossier = (projects: readonly ProjectOption[], dossiers: readonly DossierLineView[]): ProjectOption[] => {
  const taken = new Set(dossiers.filter((dossier) => dossier.projectComponentCode === null).map((dossier) => dossier.projectId));
  return projects.filter((project) => !taken.has(project.id));
};

export interface OpenDossierBody {
  owner_unit_id: string;
}

// ---- failures ------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'stateInvalid'
  | 'versionConflict'
  | 'numberDuplicate'
  | 'alreadyCurrent'
  | 'documentRequired'
  | 'typeNotEffective'
  | 'dossierExists'
  | 'validation'
  | 'denied'
  | 'notFound'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PERMIT_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  PERMIT_NO_DUPLICATE: 'numberDuplicate',
  PERMIT_ALREADY_CURRENT: 'alreadyCurrent',
  PERMIT_DOCUMENT_REQUIRED: 'documentRequired',
  PERMIT_TYPE_NOT_EFFECTIVE: 'typeNotEffective',
  DOSSIER_EXISTS: 'dossierExists',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface PermitProblem {
  reason: ProblemReason;
  field: string | undefined;
}

/** Maps the failure of a command of PMT-01 or PMT-02 to what the screen shows; an unknown failure is the general message. */
export function describePermitProblem(error: unknown): PermitProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
