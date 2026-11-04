import { ApiError } from '@machvon/api-client';
import { formatVnd } from '../inventory/model';
import { hasControlCharacter } from '../../control-characters';

export { formatVnd };

/** LND-05: the plan of compensation, support and resettlement, composed from confirmed inventory and revised into new revisions (ST-LND-005, LND 3.3, BR-LND-05). */
export const PLANS_PATH = '/lnd/lnd-05';

/** The permission that gates the buttons of this screen; the server decides again on every request (the project and the units of the households included). */
export const WRITE_PERMISSION = 'land.plan.write';

export const EXECUTOR_KINDS = ['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

export const PLAN_STATUSES = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const ITEM_KINDS = ['COMPENSATION_LAND', 'COMPENSATION_ASSET', 'SUPPORT_LIVELIHOOD', 'SUPPORT_RELOCATION', 'SUPPORT_TRAINING', 'RESETTLEMENT_LAND', 'RESETTLEMENT_HOUSE'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** A plan that is a draft takes items; a plan that was posted or approved is revised, never edited. */
export const REVISABLE_STATUSES: readonly PlanStatus[] = ['POSTING', 'POSTING_CLOSED', 'APPROVED'];

export const CODE_MAX_LENGTH = 50;
export const LEGAL_BASIS_MAX_LENGTH = 500;
export const REASON_MAX_LENGTH = 2000;
const AMOUNT = /^(0|[1-9]\d{0,23})$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** A plan, one revision of it. */
export interface PlanLine {
  id: string;
  projectId: string;
  executorUnitId: string;
  executorKind: ExecutorKind;
  planCode: string;
  revision: number;
  supersedesId: string | null;
  revisionReason: string | null;
  totalCompensationVnd: string;
  totalSupportVnd: string;
  totalResettlementVnd: string;
  grandTotalVnd: string;
  status: PlanStatus;
  postingStartedOn: string | null;
  postingEndsOn: string | null;
  postingPlaceText: string | null;
  feedbackSummary: string | null;
  approvedOn: string | null;
  paymentDueOn: string | null;
  decisionDocumentVersionId: string | null;
  version: number;
}

/** A plan the screen cannot read is dropped rather than shown half. */
export function toPlanLine(raw: unknown): PlanLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const executorUnitId = text(row?.executor_unit_id);
  const executorKind = oneOf(EXECUTOR_KINDS, row?.executor_kind);
  const planCode = text(row?.plan_code);
  const revision = whole(row?.revision);
  const compensation = text(row?.total_compensation_vnd);
  const support = text(row?.total_support_vnd);
  const resettlement = text(row?.total_resettlement_vnd);
  const grand = text(row?.grand_total_vnd);
  const status = oneOf(PLAN_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || projectId === undefined || executorUnitId === undefined || executorKind === undefined || planCode === undefined || revision === undefined) return undefined;
  if (compensation === undefined || support === undefined || resettlement === undefined || grand === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    projectId,
    executorUnitId,
    executorKind,
    planCode,
    revision,
    supersedesId: nullableText(row.supersedes_id),
    revisionReason: nullableText(row.revision_reason),
    totalCompensationVnd: compensation,
    totalSupportVnd: support,
    totalResettlementVnd: resettlement,
    grandTotalVnd: grand,
    status,
    postingStartedOn: nullableText(row.posting_started_on),
    postingEndsOn: nullableText(row.posting_ends_on),
    postingPlaceText: nullableText(row.posting_place_text),
    feedbackSummary: nullableText(row.feedback_summary),
    approvedOn: nullableText(row.approved_on),
    paymentDueOn: nullableText(row.payment_due_on),
    decisionDocumentVersionId: nullableText(row.decision_document_version_id),
    version,
  };
}

/** An item of a plan, as the list answers it. */
export interface PlanItem {
  id: string;
  householdId: string;
  householdCode: string;
  parcelCode: string | null;
  itemKind: ItemKind;
  amountVnd: string;
  basisInventoryId: string | null;
  quantity: string | null;
  unitCode: string | null;
  unitPriceVnd: string | null;
  priceDecisionRef: string | null;
  priceDecisionRevision: number | null;
  legalBasis: string;
}

export function toPlanItem(raw: unknown): PlanItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const householdId = text(row?.household_id);
  const householdCode = text(row?.household_code);
  const itemKind = oneOf(ITEM_KINDS, row?.item_kind);
  const amount = text(row?.amount_vnd);
  const legalBasis = text(row?.legal_basis);
  if (row === undefined || id === undefined || householdId === undefined || householdCode === undefined || itemKind === undefined || amount === undefined || legalBasis === undefined) return undefined;
  return {
    id,
    householdId,
    householdCode,
    parcelCode: nullableText(row.parcel_code),
    itemKind,
    amountVnd: amount,
    basisInventoryId: nullableText(row.basis_inventory_id),
    quantity: nullableText(row.quantity),
    unitCode: nullableText(row.unit_code),
    unitPriceVnd: nullableText(row.unit_price_vnd),
    priceDecisionRef: nullableText(row.price_decision_ref),
    priceDecisionRevision: whole(row.price_decision_revision) ?? null,
    legalBasis,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

export const canWritePlan = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(WRITE_PERMISSION)) && mode !== 'READ_ONLY';
export const acceptsItems = (plan: PlanLine): boolean => plan.status === 'DRAFT';
export const canRevise = (plan: PlanLine): boolean => REVISABLE_STATUSES.includes(plan.status);
export const restsOnInventory = (kind: ItemKind): boolean => kind === 'COMPENSATION_LAND' || kind === 'COMPENSATION_ASSET';

/** The plans of a status, in the order of the read, or all of them. */
export const plansOf = (plans: readonly PlanLine[], status: '' | PlanStatus): PlanLine[] => (status === '' ? [...plans] : plans.filter((plan) => plan.status === status));

export type FormProblem = 'required' | 'tooLong' | 'invalid';

export interface DraftForm {
  executorUnitId: string;
  executorKind: '' | ExecutorKind;
  planCode: string;
}

export const EMPTY_DRAFT_FORM: DraftForm = { executorUnitId: '', executorKind: '', planCode: '' };

export function validateDraft(form: DraftForm): Partial<Record<keyof DraftForm, FormProblem>> {
  const problems: Partial<Record<keyof DraftForm, FormProblem>> = {};
  if (form.executorUnitId === '') problems.executorUnitId = 'required';
  if (form.executorKind === '') problems.executorKind = 'required';
  const code = form.planCode.trim();
  if (code === '') problems.planCode = 'required';
  else if (code.length > CODE_MAX_LENGTH) problems.planCode = 'tooLong';
  else if (hasControlCharacter(code)) problems.planCode = 'invalid';
  return problems;
}

export interface DraftBody {
  project_id: string;
  executor_unit_id: string;
  executor_kind: ExecutorKind;
  plan_code: string;
}

export const draftBody = (projectId: string, form: DraftForm): DraftBody => ({
  project_id: projectId,
  executor_unit_id: form.executorUnitId,
  executor_kind: form.executorKind as ExecutorKind,
  plan_code: form.planCode.trim(),
});

export interface ItemForm {
  householdId: string;
  itemKind: '' | ItemKind;
  basisInventoryId: string;
  amountVnd: string;
  legalBasis: string;
}

export const EMPTY_ITEM_FORM: ItemForm = { householdId: '', itemKind: '', basisInventoryId: '', amountVnd: '', legalBasis: '' };

/** What is wrong with an item before it is sent: a compensation names the record it rests on, a support or a resettlement states its amount, and every item says its legal basis. */
export function validateItem(form: ItemForm): Partial<Record<keyof ItemForm, FormProblem>> {
  const problems: Partial<Record<keyof ItemForm, FormProblem>> = {};
  if (form.householdId === '') problems.householdId = 'required';
  if (form.itemKind === '') problems.itemKind = 'required';
  else if (restsOnInventory(form.itemKind)) {
    if (form.basisInventoryId === '') problems.basisInventoryId = 'required';
  } else {
    const amount = form.amountVnd.trim();
    if (amount === '') problems.amountVnd = 'required';
    else if (!AMOUNT.test(amount)) problems.amountVnd = 'invalid';
  }
  const basis = form.legalBasis.trim();
  if (basis === '') problems.legalBasis = 'required';
  else if (basis.length > LEGAL_BASIS_MAX_LENGTH) problems.legalBasis = 'tooLong';
  else if (hasControlCharacter(basis)) problems.legalBasis = 'invalid';
  return problems;
}

export type ItemBody = {
  household_id: string;
  item_kind: ItemKind;
  legal_basis: string;
  basis_inventory_id?: string;
  amount_vnd?: string;
};

export function itemBody(form: ItemForm): ItemBody {
  const kind = form.itemKind as ItemKind;
  const body: ItemBody = { household_id: form.householdId, item_kind: kind, legal_basis: form.legalBasis.trim() };
  if (restsOnInventory(kind)) body.basis_inventory_id = form.basisInventoryId;
  else body.amount_vnd = form.amountVnd.trim();
  return body;
}

/** The kind of item a record of the inventory gives (land is compensated as land, every other asset as an asset). */
export const compensationKindOf = (assetKind: string): ItemKind => (assetKind === 'LAND' ? 'COMPENSATION_LAND' : 'COMPENSATION_ASSET');

export interface ReviseForm {
  reason: string;
}

export function validateRevise(form: ReviseForm): Partial<Record<keyof ReviseForm, FormProblem>> {
  const reason = form.reason.trim();
  if (reason === '') return { reason: 'required' };
  if (reason.length > REASON_MAX_LENGTH) return { reason: 'tooLong' };
  return hasControlCharacter(reason) ? { reason: 'invalid' } : {};
}

export type CommandProblem = 'codeDuplicate' | 'stateInvalid' | 'notConfirmed' | 'versionConflict' | 'scopeDenied' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  PLAN_CODE_DUPLICATE: 'codeDuplicate',
  PLAN_STATE_INVALID: 'stateInvalid',
  INVENTORY_NOT_CONFIRMED: 'notConfirmed',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
