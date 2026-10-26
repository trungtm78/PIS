import { ApiError } from '@machvon/api-client';
import { isDay, isUuid } from '../model';

/** LND-04: the inventory of the assets of an affected household, counted at a price decision in force and answered by the household (ST-LND-004, LND 3.2, BR-LND-04). */
export const INVENTORY_PATH = '/lnd/lnd-04';

/** The permission that gates the buttons of this screen; the server decides again on every request (the unit of the household included). */
export const PROCESS_PERMISSION = 'land.process';

export const ITEM_KINDS = ['LAND', 'HOUSE', 'STRUCTURE', 'CROP', 'TREE', 'GRAVE', 'BUSINESS_LOSS', 'OTHER'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const INVENTORY_STATUSES = ['DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const OUTCOMES = ['CONFIRMED', 'DISPUTED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DESCRIPTION_MAX_LENGTH = 2000;
export const UNIT_CODE_MAX_LENGTH = 50;
export const REFERENCE_MAX_LENGTH = 100;
const QUANTITY = /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/;
const PRICE = /^(0|[1-9]\d{0,23})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** One record of the inventory of a household, as the list answers it. */
export interface InventoryLine {
  id: string;
  householdId: string;
  parcelId: string;
  parcelCode: string;
  itemKind: ItemKind;
  description: string;
  quantity: string;
  unitCode: string;
  unitPriceVnd: string;
  amountVnd: string;
  priceDecisionRef: string;
  priceDecisionRevision: number | null;
  surveyedOn: string;
  surveyedBy: string;
  householdConfirmedOn: string | null;
  confirmedBy: string | null;
  note: string | null;
  status: InventoryStatus;
  version: number;
}

/** A record the screen cannot read is dropped rather than shown half. */
export function toInventoryLine(raw: unknown): InventoryLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const householdId = text(row?.household_id);
  const parcelId = text(row?.parcel_id);
  const parcelCode = text(row?.parcel_code);
  const itemKind = oneOf(ITEM_KINDS, row?.item_kind);
  const description = text(row?.description);
  const quantity = text(row?.quantity);
  const unitCode = text(row?.unit_code);
  const price = text(row?.unit_price_vnd);
  const amount = text(row?.amount_vnd);
  const reference = text(row?.price_decision_ref);
  const surveyedOn = text(row?.surveyed_on);
  const surveyedBy = text(row?.surveyed_by);
  const status = oneOf(INVENTORY_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || householdId === undefined || parcelId === undefined || parcelCode === undefined || itemKind === undefined) return undefined;
  if (description === undefined || quantity === undefined || unitCode === undefined || price === undefined || amount === undefined || reference === undefined) return undefined;
  if (surveyedOn === undefined || surveyedBy === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    householdId,
    parcelId,
    parcelCode,
    itemKind,
    description,
    quantity,
    unitCode,
    unitPriceVnd: price,
    amountVnd: amount,
    priceDecisionRef: reference,
    priceDecisionRevision: whole(row.price_decision_revision) ?? null,
    surveyedOn,
    surveyedBy,
    householdConfirmedOn: nullableText(row.household_confirmed_on),
    confirmedBy: nullableText(row.confirmed_by),
    note: nullableText(row.note),
    status,
    version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

export const canCount = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(PROCESS_PERMISSION)) && mode !== 'READ_ONLY';

/** Whether this person may record the answer of the household to a record: a draft, by someone other than the person who counted it (the server judges the same). */
export const canAnswer = (record: InventoryLine, membershipId: string | undefined, permissions: readonly string[] | undefined, mode: Mode): boolean =>
  canCount(permissions, mode) && record.status === 'DRAFT' && record.surveyedBy.toLowerCase() !== (membershipId ?? '').toLowerCase();

/** `quantity × unit price` rounded half up to the dong, on whole numbers; undefined while the two are not figures (BR-LND-04: 80 m2 × 4.500.000 = 360.000.000). */
export function amountOf(quantity: string, unitPriceVnd: string): string | undefined {
  const q = quantity.trim();
  const p = unitPriceVnd.trim();
  if (!QUANTITY.test(q) || !PRICE.test(p) || /^0(\.0+)?$/.test(q)) return undefined;
  const [integer = '0', fraction = ''] = q.split('.');
  const scale = 1_000_000n;
  return ((BigInt(integer + fraction.padEnd(6, '0')) * BigInt(p) + scale / 2n) / scale).toString();
}

/** A figure of dong with the dots of the thousands, for people to read (the figure itself is whole dong). */
export const formatVnd = (amount: string): string => amount.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** The records of a status, in the order of the read. */
export const recordsOf = (records: readonly InventoryLine[], status: '' | InventoryStatus): InventoryLine[] => (status === '' ? [...records] : records.filter((record) => record.status === status));

/** The total of the confirmed records, the only ones a plan may rest on. */
export function confirmedTotal(records: readonly InventoryLine[]): string {
  return records.filter((record) => record.status === 'CONFIRMED').reduce((sum, record) => sum + BigInt(record.amountVnd), 0n).toString();
}

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'future' | 'beforeSurvey';

export interface RecordForm {
  parcelId: string;
  itemKind: '' | ItemKind;
  description: string;
  quantity: string;
  unitCode: string;
  unitPriceVnd: string;
  priceDecisionRef: string;
  surveyedOn: string;
  documentVersionId: string;
}

export const EMPTY_RECORD_FORM: RecordForm = { parcelId: '', itemKind: '', description: '', quantity: '', unitCode: '', unitPriceVnd: '', priceDecisionRef: '', surveyedOn: '', documentVersionId: '' };

/** What is wrong with the form before anything is sent; the server judges the same rules again, and the price decision of the day. */
export function validateRecord(form: RecordForm, today: string): Partial<Record<keyof RecordForm, FormProblem>> {
  const problems: Partial<Record<keyof RecordForm, FormProblem>> = {};
  if (form.parcelId === '') problems.parcelId = 'required';
  if (form.itemKind === '') problems.itemKind = 'required';
  const description = form.description.trim();
  if (description === '') problems.description = 'required';
  else if (description.length > DESCRIPTION_MAX_LENGTH) problems.description = 'tooLong';
  else if (CONTROL.test(description)) problems.description = 'invalid';
  const quantity = form.quantity.trim();
  if (quantity === '') problems.quantity = 'required';
  else if (!QUANTITY.test(quantity) || /^0(\.0+)?$/.test(quantity)) problems.quantity = 'invalid';
  const unit = form.unitCode.trim();
  if (unit === '') problems.unitCode = 'required';
  else if (unit.length > UNIT_CODE_MAX_LENGTH) problems.unitCode = 'tooLong';
  else if (CONTROL.test(unit)) problems.unitCode = 'invalid';
  const price = form.unitPriceVnd.trim();
  if (price === '') problems.unitPriceVnd = 'required';
  else if (!PRICE.test(price)) problems.unitPriceVnd = 'invalid';
  const reference = form.priceDecisionRef.trim();
  if (reference === '') problems.priceDecisionRef = 'required';
  else if (reference.length > REFERENCE_MAX_LENGTH) problems.priceDecisionRef = 'tooLong';
  else if (CONTROL.test(reference)) problems.priceDecisionRef = 'invalid';
  const surveyed = form.surveyedOn.trim();
  if (surveyed === '') problems.surveyedOn = 'required';
  else if (!isDay(surveyed)) problems.surveyedOn = 'invalid';
  else if (surveyed > today) problems.surveyedOn = 'future';
  const document = form.documentVersionId.trim();
  if (document !== '' && !isUuid(document)) problems.documentVersionId = 'invalid';
  return problems;
}

export interface RecordBody {
  household_id: string;
  parcel_id: string;
  item_kind: ItemKind;
  description: string;
  quantity: string;
  unit_code: string;
  unit_price_vnd: string;
  price_decision_ref: string;
  surveyed_on: string;
  document_version_id?: string;
}

export function recordBody(householdId: string, form: RecordForm): RecordBody {
  const body: RecordBody = {
    household_id: householdId,
    parcel_id: form.parcelId,
    item_kind: form.itemKind as ItemKind,
    description: form.description.trim(),
    quantity: form.quantity.trim(),
    unit_code: form.unitCode.trim(),
    unit_price_vnd: form.unitPriceVnd.trim(),
    price_decision_ref: form.priceDecisionRef.trim(),
    surveyed_on: form.surveyedOn.trim(),
  };
  if (form.documentVersionId.trim() !== '') body.document_version_id = form.documentVersionId.trim().toLowerCase();
  return body;
}

export interface AnswerForm {
  outcome: '' | Outcome;
  answeredOn: string;
  note: string;
}

export const EMPTY_ANSWER_FORM: AnswerForm = { outcome: '', answeredOn: '', note: '' };

/** What is wrong with the answer of the household: an outcome, a day that is not to come and not before the survey, and the note of an objection. */
export function validateAnswer(form: AnswerForm, record: InventoryLine, today: string): Partial<Record<keyof AnswerForm, FormProblem>> {
  const problems: Partial<Record<keyof AnswerForm, FormProblem>> = {};
  if (form.outcome === '') problems.outcome = 'required';
  const on = form.answeredOn.trim();
  if (on === '') problems.answeredOn = 'required';
  else if (!isDay(on)) problems.answeredOn = 'invalid';
  else if (on > today) problems.answeredOn = 'future';
  else if (on < record.surveyedOn) problems.answeredOn = 'beforeSurvey';
  const note = form.note.trim();
  if (form.outcome === 'DISPUTED' && note === '') problems.note = 'required';
  else if (note.length > DESCRIPTION_MAX_LENGTH) problems.note = 'tooLong';
  else if (CONTROL.test(note)) problems.note = 'invalid';
  return problems;
}

export interface AnswerBody {
  outcome: Outcome;
  household_confirmed_on: string;
  note?: string;
}

export function answerBody(form: AnswerForm): AnswerBody {
  const body: AnswerBody = { outcome: form.outcome as Outcome, household_confirmed_on: form.answeredOn.trim() };
  if (form.note.trim() !== '') body.note = form.note.trim();
  return body;
}

export type CommandProblem =
  | 'priceDecision'
  | 'parcelNotLinked'
  | 'selfApproval'
  | 'stateInvalid'
  | 'versionConflict'
  | 'documentNotClean'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  PRICE_DECISION_NOT_EFFECTIVE: 'priceDecision',
  HOUSEHOLD_PARCEL_NOT_LINKED: 'parcelNotLinked',
  SELF_APPROVAL_DENIED: 'selfApproval',
  INVENTORY_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
