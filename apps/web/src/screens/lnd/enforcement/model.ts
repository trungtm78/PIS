import { ApiError } from '@machvon/api-client';

/** LND-09: the enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, UAT-AC385). */
export const ENFORCE_PERMISSION = 'land.enforce.write';

export const STEPS = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED', 'SUSPENDED'] as const;
export type Step = (typeof STEPS)[number];

/** The steps a case goes through, in order; a case may be suspended from any of them but the last. */
const FLOW: readonly Step[] = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED'];
const DECISION_STEPS: readonly Step[] = ['ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING'];
/** The parcels a case may be opened for, and the plans whose payment can have been offered. */
export const ENFORCEABLE_PARCELS: readonly string[] = ['PLAN_APPROVED', 'PAID', 'DISPUTED'];
export const STANDING_PLANS: readonly string[] = ['APPROVED', 'PAYING', 'COMPLETED'];

export const TEXT_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** The day in Vietnam (UTC+7), the day a case starts and is carried out is judged by. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** The step after the given one in the flow; undefined for the last and for a suspended case. */
export const stepAfter = (step: Step): Step | undefined => {
  const at = FLOW.indexOf(step);
  return at < 0 ? undefined : FLOW[at + 1];
};

export interface CaseHousehold {
  id: string;
  code: string;
  headName: string;
}

export interface CaseLine {
  id: string;
  parcelId: string;
  parcelCode: string;
  household: CaseHousehold | null;
  step: Step;
  suspendedFrom: Step | null;
  startedOn: string;
  decisionDocumentVersionId: string | null;
  plannedOn: string | null;
  executedOn: string | null;
  legalBasis: string;
  suspendReason: string | null;
  mayAdvance: boolean;
  maySuspend: boolean;
  version: number;
}

function toHousehold(raw: unknown): CaseHousehold | null {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.household_code);
  return row === undefined || id === undefined || code === undefined ? null : { id, code, headName: text(row.head_name) ?? '' };
}

/** A case the screen cannot read is dropped rather than shown half. */
export function toCase(raw: unknown): CaseLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const parcel = asRecord(row?.parcel);
  const parcelId = text(parcel?.id);
  const parcelCode = text(parcel?.parcel_code);
  const step = oneOf(STEPS, row?.step);
  const startedOn = text(row?.started_on);
  const allowed = asRecord(row?.allowed);
  if (row === undefined || id === undefined || parcelId === undefined || parcelCode === undefined || step === undefined || startedOn === undefined || typeof row.version !== 'number') return undefined;
  return {
    id,
    parcelId,
    parcelCode,
    household: toHousehold(row.household),
    step,
    suspendedFrom: oneOf(STEPS, row.suspended_from) ?? null,
    startedOn,
    decisionDocumentVersionId: nullableText(row.decision_document_version_id),
    plannedOn: nullableText(row.planned_on),
    executedOn: nullableText(row.executed_on),
    legalBasis: text(row.legal_basis) ?? '',
    suspendReason: nullableText(row.suspend_reason),
    mayAdvance: allowed?.advance === true,
    maySuspend: allowed?.suspend === true,
    version: row.version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canEnforce = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(ENFORCE_PERMISSION)) && mode !== 'READ_ONLY';

/** The steps a case can be moved to: the next one, the suspension, and for a suspended case the step it was suspended from or the one after it (the server judges the move again). */
export function moveChoices(line: CaseLine): Step[] {
  if (!line.mayAdvance) return [];
  if (line.step === 'SUSPENDED') {
    const from = line.suspendedFrom;
    return from === null ? [] : [from, stepAfter(from)].flatMap((step) => (step === undefined || step === 'PERSUASION' ? [] : [step]));
  }
  const next = stepAfter(line.step);
  return [...(next === undefined ? [] : [next]), ...(line.maySuspend ? (['SUSPENDED'] as const) : [])];
}

export const needsDocument = (to: string): boolean => (DECISION_STEPS as readonly string[]).includes(to);

// ---- the start form ----------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'future';
export type StartField = 'parcel' | 'household' | 'plan' | 'authority' | 'basis' | 'startedOn';

export interface StartForm {
  parcelId: string;
  householdId: string;
  planId: string;
  authorityUnitId: string;
  legalBasis: string;
  startedOn: string;
}

export const EMPTY_START: StartForm = { parcelId: '', householdId: '', planId: '', authorityUnitId: '', legalBasis: '', startedOn: '' };

export function validateStart(form: StartForm, today: string): Partial<Record<StartField, FormProblem>> {
  const found: Partial<Record<StartField, FormProblem>> = {};
  if (form.parcelId === '') found.parcel = 'required';
  if (form.householdId === '') found.household = 'required';
  if (form.planId === '') found.plan = 'required';
  if (form.authorityUnitId === '') found.authority = 'required';
  const basis = form.legalBasis.trim();
  if (basis === '') found.basis = 'required';
  else if (basis.length > TEXT_MAX) found.basis = 'invalid';
  if (form.startedOn === '') found.startedOn = 'required';
  else if (!isDay(form.startedOn)) found.startedOn = 'invalid';
  else if (form.startedOn > today) found.startedOn = 'future';
  return found;
}

/** The body of the command for a form that passed `validateStart`; the unit that answers is the unit of the household. */
export function startBody(form: StartForm, projectId: string, ownerUnitId: string): Record<string, unknown> {
  return {
    project_id: projectId,
    parcel_id: form.parcelId,
    household_id: form.householdId,
    plan_id: form.planId,
    owner_unit_id: ownerUnitId,
    authority_unit_id: form.authorityUnitId,
    legal_basis: form.legalBasis.trim(),
    started_on: form.startedOn,
  };
}

// ---- the advance form --------------------------------------------------------------------------------------------------------

export type AdvanceField = 'toStep' | 'document' | 'plannedOn' | 'executedOn' | 'reason';

export interface AdvanceForm {
  toStep: string;
  document: string;
  plannedOn: string;
  executedOn: string;
  reason: string;
}

export const EMPTY_ADVANCE: AdvanceForm = { toStep: '', document: '', plannedOn: '', executedOn: '', reason: '' };

export function validateAdvance(form: AdvanceForm, line: CaseLine, today: string): Partial<Record<AdvanceField, FormProblem>> {
  const found: Partial<Record<AdvanceField, FormProblem>> = {};
  const choices = moveChoices(line) as readonly string[];
  if (form.toStep === '') found.toStep = 'required';
  else if (!choices.includes(form.toStep)) found.toStep = 'invalid';
  const document = form.document.trim();
  if (needsDocument(form.toStep)) {
    if (document === '') found.document = 'required';
    else if (!UUID.test(document)) found.document = 'invalid';
  }
  if (form.toStep === 'EXECUTING') {
    if (form.plannedOn === '') found.plannedOn = 'required';
    else if (!isDay(form.plannedOn) || form.plannedOn < line.startedOn) found.plannedOn = 'invalid';
  }
  if (form.toStep === 'COMPLETED') {
    if (form.executedOn === '') found.executedOn = 'required';
    else if (!isDay(form.executedOn) || form.executedOn < line.startedOn) found.executedOn = 'invalid';
    else if (form.executedOn > today) found.executedOn = 'future';
  }
  if (form.toStep === 'SUSPENDED') {
    const reason = form.reason.trim();
    if (reason === '') found.reason = 'required';
    else if (reason.length > TEXT_MAX) found.reason = 'invalid';
  }
  return found;
}

/** The body of the command for a form that passed `validateAdvance`: only what the step asks for is sent. */
export function advanceBody(form: AdvanceForm): Record<string, unknown> {
  return {
    to_step: form.toStep,
    ...(needsDocument(form.toStep) ? { decision_document_version_id: form.document.trim().toLowerCase() } : {}),
    ...(form.toStep === 'EXECUTING' ? { planned_on: form.plannedOn } : {}),
    ...(form.toStep === 'COMPLETED' ? { executed_on: form.executedOn } : {}),
    ...(form.toStep === 'SUSPENDED' ? { suspend_reason: form.reason.trim() } : {}),
  };
}

// ---- what the server refuses -------------------------------------------------------------------------------------------------

export type Problem =
  | 'precondition'
  | 'paymentNotOffered'
  | 'caseExists'
  | 'stepInvalid'
  | 'documentRequired'
  | 'selfApproval'
  | 'versionConflict'
  | 'scopeDenied'
  | 'notFound'
  | 'validation'
  | 'general';

export type Reason = 'PARCEL_STATUS' | 'RECOVERY_DECISION_MISSING' | 'PLAN_NOT_APPROVED' | 'HOUSEHOLD_NOT_ON_PARCEL' | 'NO_PLAN_OR_HOUSEHOLD' | 'PLAN_DOES_NOT_COVER_PARCEL' | 'NOT_PAID_OR_DEPOSITED';
const REASONS: readonly Reason[] = ['PARCEL_STATUS', 'RECOVERY_DECISION_MISSING', 'PLAN_NOT_APPROVED', 'HOUSEHOLD_NOT_ON_PARCEL', 'NO_PLAN_OR_HOUSEHOLD', 'PLAN_DOES_NOT_COVER_PARCEL', 'NOT_PAID_OR_DEPOSITED'];

export interface Refusal {
  problem: Problem;
  reason: Reason | undefined;
}

const BY_CODE: Readonly<Record<string, Problem>> = {
  PRECONDITION_NOT_MET: 'precondition',
  PAYMENT_NOT_OFFERED: 'paymentNotOffered',
  ENFORCEMENT_CASE_EXISTS: 'caseExists',
  ENFORCEMENT_STEP_INVALID: 'stepInvalid',
  DECISION_DOCUMENT_REQUIRED: 'documentRequired',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', reason: undefined };
  return { problem: BY_CODE[error.code] ?? 'general', reason: oneOf(REASONS, error.extensions.reason) };
}
