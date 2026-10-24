import { ApiError } from '@machvon/api-client';

/**
 * PRJ-17 and PRJ-18: who answers for a project, and the task forces that press its disbursement (ST-PRJ-005, PRJ 3.1 F9, BR-PRJ-10; Directive
 * 162/CD-TTg). The readers below are defensive: a row of another shape is left out, never trusted.
 */
export const ASSIGN_PERMISSION = 'project.accountability.assign';
export const TASK_FORCE_PERMISSION = 'taskforce.manage';
export const ASSIGNMENTS_PATH = '/prj/prj-17';
export const TASK_FORCES_PATH = '/prj/prj-18';

export const ACCOUNTABILITY_ROLES = ['LEADER_IN_CHARGE', 'DEPUTY_LEADER', 'FOCAL_OFFICER'] as const;
export type AccountabilityRole = (typeof ACCOUNTABILITY_ROLES)[number];
export const MEMBER_ROLES = ['MEMBER', 'SECRETARY'] as const;
export type MemberRole = 'LEAD' | (typeof MEMBER_ROLES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MIN = 5;
const REASON_MAX = 2000;
const CODE_MAX = 30;
const NAME_MIN = 3;
const NAME_MAX = 300;
const PURPOSE_MIN = 10;
const PURPOSE_MAX = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

/** Today in Viet Nam as `YYYY-MM-DD`: an assignment or a term starts today at the latest, and ends no later than today. */
export function vietnamToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const LINE_BREAKS: readonly number[] = [0x0a, 0x0d];

/** Whether the text holds a control character; a line break is one unless `lineBreaks` lets it through. */
function hasControl(value: string, lineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !(lineBreaks && LINE_BREAKS.includes(code))) return true;
  }
  return false;
}

export type AssignmentStatus = 'ACTIVE' | 'ENDED';

/** One assignment of the register of PRJ-17. */
export interface AssignmentLine {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  leaderMembershipId: string;
  leaderName: string | null;
  role: AccountabilityRole;
  documentId: string | null;
  validFrom: string;
  validUntil: string | null;
  status: AssignmentStatus;
  endReason: string | null;
  version: number;
}

const isRole = (value: unknown): value is AccountabilityRole => (ACCOUNTABILITY_ROLES as readonly unknown[]).includes(value);

export function toAssignmentLine(raw: unknown): AssignmentLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const leader = asRecord(row.leader);
  const id = text(row.id);
  const projectId = text(row.project_id);
  const projectCode = text(row.project_code);
  const leaderId = text(leader?.membership_id);
  const validFrom = text(row.valid_from);
  const version = whole(row.version);
  const role = row.accountability_role;
  if (id === undefined || projectId === undefined || projectCode === undefined || leaderId === undefined || validFrom === undefined || version === undefined || !isRole(role)) return undefined;
  if (row.status !== 'ACTIVE' && row.status !== 'ENDED') return undefined;
  return {
    id,
    projectId,
    projectCode,
    projectName: text(row.project_name) ?? '',
    leaderMembershipId: leaderId,
    leaderName: nullableText(leader?.display_name),
    role,
    documentId: nullableText(row.assignment_document_id),
    validFrom,
    validUntil: nullableText(row.valid_until),
    status: row.status,
    endReason: nullableText(row.end_reason),
    version,
  };
}

/** An assignment can be ended while it is ACTIVE, by whoever may administer assignments. */
export const canEndAssignment = (line: AssignmentLine, mayAssign: boolean): boolean => mayAssign && line.status === 'ACTIVE';

export interface MemberLine {
  id: string;
  membershipId: string;
  displayName: string | null;
  role: MemberRole;
  projectCode: string | null;
  projectName: string | null;
  validFrom: string;
  validUntil: string | null;
}

export type TaskForceStatus = 'ACTIVE' | 'DISSOLVED';

/** One task force of PRJ-18 with its terms. */
export interface TaskForceLine {
  id: string;
  code: string;
  name: string;
  purpose: string;
  leadName: string | null;
  leadMembershipId: string;
  scopeUnitId: string;
  scopeUnitName: string;
  documentId: string | null;
  validFrom: string;
  validUntil: string | null;
  status: TaskForceStatus;
  version: number;
  members: MemberLine[];
}

function toMemberLine(raw: unknown): MemberLine | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const id = text(row?.id);
  const membershipId = text(row?.membership_id);
  const validFrom = text(row?.valid_from);
  const role = row?.role;
  if (id === undefined || membershipId === undefined || validFrom === undefined || (role !== 'LEAD' && role !== 'MEMBER' && role !== 'SECRETARY')) return undefined;
  return { id, membershipId, displayName: nullableText(row?.display_name), role, projectCode: nullableText(project?.code), projectName: nullableText(project?.name), validFrom, validUntil: nullableText(row?.valid_until) };
}

export function toTaskForceLine(raw: unknown): TaskForceLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const lead = asRecord(row.lead);
  const unit = asRecord(row.scope_unit);
  const id = text(row.id);
  const code = text(row.code);
  const name = text(row.name);
  const leadId = text(lead?.membership_id);
  const unitId = text(unit?.id);
  const validFrom = text(row.valid_from);
  const version = whole(row.version);
  if (id === undefined || code === undefined || name === undefined || leadId === undefined || unitId === undefined || validFrom === undefined || version === undefined) return undefined;
  if (row.status !== 'ACTIVE' && row.status !== 'DISSOLVED') return undefined;
  return {
    id,
    code,
    name,
    purpose: text(row.purpose) ?? '',
    leadName: nullableText(lead?.display_name),
    leadMembershipId: leadId,
    scopeUnitId: unitId,
    scopeUnitName: text(unit?.name) ?? '',
    documentId: nullableText(row.establishment_document_id),
    validFrom,
    validUntil: nullableText(row.valid_until),
    status: row.status,
    version,
    members: (Array.isArray(row.members) ? row.members : []).flatMap((member) => toMemberLine(member) ?? []),
  };
}

/** The terms in force: the ones that have not ended. */
export const openMembers = (force: TaskForceLine): MemberLine[] => force.members.filter((member) => member.validUntil === null);

export interface Option {
  id: string;
  label: string;
}

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem =
  | 'required'
  | 'invalidId'
  | 'invalidDate'
  | 'future'
  | 'beforeStart'
  | 'tooShort'
  | 'tooLong'
  | 'invalidText'
  | 'invalidRole';

export type FormErrors<Form> = Partial<Record<keyof Form, FormProblem>>;

const checkId = (value: string, required: boolean): FormProblem | undefined => {
  const id = value.trim();
  if (id === '') return required ? 'required' : undefined;
  return UUID.test(id) ? undefined : 'invalidId';
};

function checkDay(value: string, today: string, after?: string): FormProblem | undefined {
  if (value === '') return 'required';
  if (!isDate(value)) return 'invalidDate';
  if (value > today) return 'future';
  if (after !== undefined && value < after) return 'beforeStart';
  return undefined;
}

function checkText(value: string, limits: { min: number; max: number; lineBreaks?: boolean }): FormProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < limits.min) return 'tooShort';
  if (trimmed.length > limits.max) return 'tooLong';
  return hasControl(trimmed, limits.lineBreaks === true) ? 'invalidText' : undefined;
}

const compact = <Form>(errors: FormErrors<Form>): FormErrors<Form> => Object.fromEntries(Object.entries(errors).filter(([, problem]) => problem !== undefined)) as FormErrors<Form>;

export interface AssignForm {
  projectId: string;
  leaderId: string;
  role: string;
  validFrom: string;
  documentId: string;
}
export const EMPTY_ASSIGN: AssignForm = { projectId: '', leaderId: '', role: 'LEADER_IN_CHARGE', validFrom: '', documentId: '' };

export function validateAssign(form: AssignForm, today: string): FormErrors<AssignForm> {
  return compact<AssignForm>({
    projectId: form.projectId === '' ? 'required' : undefined,
    leaderId: form.leaderId === '' ? 'required' : undefined,
    role: isRole(form.role) ? undefined : 'invalidRole',
    validFrom: checkDay(form.validFrom, today),
    documentId: checkId(form.documentId, false),
  });
}

export function assignBody(form: AssignForm): { leader_membership_id: string; accountability_role: AccountabilityRole; valid_from: string; assignment_document_id?: string } {
  const document = form.documentId.trim().toLowerCase();
  return {
    leader_membership_id: form.leaderId,
    accountability_role: form.role as AccountabilityRole,
    valid_from: form.validFrom,
    ...(document === '' ? {} : { assignment_document_id: document }),
  };
}

export interface EndForm {
  validUntil: string;
  reason: string;
}
export const EMPTY_END: EndForm = { validUntil: '', reason: '' };

export function validateEnd(form: EndForm, today: string, startedOn: string): FormErrors<EndForm> {
  return compact<EndForm>({ validUntil: checkDay(form.validUntil, today, startedOn), reason: checkText(form.reason, { min: REASON_MIN, max: REASON_MAX, lineBreaks: true }) });
}

export const endBody = (form: EndForm): { valid_until: string; end_reason: string } => ({ valid_until: form.validUntil, end_reason: form.reason.trim() });

export interface TaskForceForm {
  code: string;
  name: string;
  purpose: string;
  leadId: string;
  scopeUnitId: string;
  validFrom: string;
  documentId: string;
}
export const EMPTY_TASK_FORCE: TaskForceForm = { code: '', name: '', purpose: '', leadId: '', scopeUnitId: '', validFrom: '', documentId: '' };

export function validateTaskForce(form: TaskForceForm, today: string): FormErrors<TaskForceForm> {
  return compact<TaskForceForm>({
    code: checkText(form.code, { min: 1, max: CODE_MAX }),
    name: checkText(form.name, { min: NAME_MIN, max: NAME_MAX }),
    purpose: checkText(form.purpose, { min: PURPOSE_MIN, max: PURPOSE_MAX, lineBreaks: true }),
    leadId: form.leadId === '' ? 'required' : undefined,
    scopeUnitId: form.scopeUnitId === '' ? 'required' : undefined,
    validFrom: checkDay(form.validFrom, today),
    documentId: checkId(form.documentId, false),
  });
}

export function taskForceBody(form: TaskForceForm) {
  const document = form.documentId.trim().toLowerCase();
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    purpose: form.purpose.trim(),
    lead_membership_id: form.leadId,
    scope_unit_id: form.scopeUnitId,
    valid_from: form.validFrom,
    ...(document === '' ? {} : { establishment_document_id: document }),
  };
}

export interface MemberForm {
  membershipId: string;
  role: string;
  projectId: string;
  validFrom: string;
}
export const EMPTY_MEMBER: MemberForm = { membershipId: '', role: 'MEMBER', projectId: '', validFrom: '' };

export function validateMember(form: MemberForm, today: string, forceStartedOn: string): FormErrors<MemberForm> {
  return compact<MemberForm>({
    membershipId: form.membershipId === '' ? 'required' : undefined,
    role: (MEMBER_ROLES as readonly string[]).includes(form.role) ? undefined : 'invalidRole',
    validFrom: checkDay(form.validFrom, today, forceStartedOn),
  });
}

export const memberBody = (form: MemberForm): { membership_id: string; member_role: (typeof MEMBER_ROLES)[number]; valid_from: string; project_id?: string } => ({
  membership_id: form.membershipId,
  member_role: form.role as (typeof MEMBER_ROLES)[number],
  valid_from: form.validFrom,
  ...(form.projectId === '' ? {} : { project_id: form.projectId }),
});

export interface DissolveForm {
  reason: string;
}
export const EMPTY_DISSOLVE: DissolveForm = { reason: '' };

export const validateDissolve = (form: DissolveForm): FormErrors<DissolveForm> => compact<DissolveForm>({ reason: checkText(form.reason, { min: REASON_MIN, max: REASON_MAX, lineBreaks: true }) });

// ---- what the server refuses -------------------------------------------------------------------------------------------------

export type AccountabilityProblem =
  | 'leaderTaken'
  | 'leaderNotEligible'
  | 'alreadyEnded'
  | 'codeTaken'
  | 'outOfScope'
  | 'dissolved'
  | 'memberTaken'
  | 'documentInvalid'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, AccountabilityProblem>> = {
  LEADER_ALREADY_ASSIGNED: 'leaderTaken',
  LEADER_NOT_ELIGIBLE: 'leaderNotEligible',
  STAGE_TRANSITION_DENIED: 'alreadyEnded',
  TASK_FORCE_CODE_DUPLICATE: 'codeTaken',
  MEMBER_OUT_OF_SCOPE: 'outOfScope',
  TASK_FORCE_DISSOLVED: 'dissolved',
  DUPLICATE_KEY: 'memberTaken',
  DECISION_REQUIRED: 'documentInvalid',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command to what the dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): AccountabilityProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
