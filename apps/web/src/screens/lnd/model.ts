import { ApiError } from '@machvon/api-client';
import { hasControlCharacter } from '../control-characters';

/** LND-02: the parcels of a project and the notice of recovery that starts their timer (ST-LND-001, LND 3.1 steps 1 and 2, BR-LND-01). */
export const PARCELS_PATH = '/lnd/lnd-02';

/** The permissions that gate the buttons of this screen; the server decides again on every request (the place of the parcel included). */
export const MANAGE_PERMISSION = 'land.manage';
export const PROCESS_PERMISSION = 'land.process';

export const LAND_USE_GROUPS = ['AGRICULTURAL', 'NON_AGRICULTURAL_RESIDENTIAL', 'NON_AGRICULTURAL_OTHER', 'PUBLIC'] as const;
export type LandUseGroup = (typeof LAND_USE_GROUPS)[number];

export const PARCEL_STATUSES = ['SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED', 'PAID', 'HANDED_OVER', 'DISPUTED', 'ENFORCEMENT'] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

/** The stages in which a notice of recovery can still be given: before the money is paid, the land handed over or the force used. */
export const NOTICE_STATUSES: readonly ParcelStatus[] = ['SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED', 'DISPUTED'];

export const TIMER_CODES = ['NOTICE_AGRICULTURAL_90', 'NOTICE_NON_AGRICULTURAL_180', 'PLAN_POSTING_30', 'PAYMENT_30', 'COMPLAINT_RESOLUTION'] as const;
export type TimerCode = (typeof TIMER_CODES)[number];

export const DEADLINE_STATUSES = ['RUNNING', 'SATISFIED', 'BREACHED', 'CANCELLED'] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

export const CODE_MAX_LENGTH = 50;
export const NAME_MAX_LENGTH = 300;
export const ADDRESS_MAX_LENGTH = 500;
const AREA = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;
const KILOMETRE = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;
const PARCEL_CODE = /^[A-Z0-9][A-Z0-9/._-]{0,49}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** The timer of a notice with the rule it was counted by (LND-02 shows the days with their legal basis and the confirmation they wait for). */
export interface ParcelDeadline {
  id: string;
  timerCode: TimerCode;
  daysApplied: number;
  startedOn: string;
  dueOn: string;
  satisfiedOn: string | null;
  status: DeadlineStatus;
  legalBasis: string | null;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

/** One line of the parcels of a project. A parcel is land and nothing more: there is no owner, no user and no household in it. */
export interface ParcelLine {
  id: string;
  projectId: string;
  sectionId: string | null;
  sectionCode: string | null;
  ownerUnitId: string;
  ownerUnitName: string;
  parcelCode: string;
  addressText: string | null;
  landUseGroup: LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  hasBoundary: boolean;
  status: ParcelStatus;
  recoveryNoticeOn: string | null;
  noticeDaysApplied: number | null;
  recoveryDecisionOn: string | null;
  deadline: ParcelDeadline | null;
  version: number;
}

function toDeadline(raw: unknown): ParcelDeadline | null {
  const row = asRecord(raw);
  const id = text(row?.id);
  const timerCode = oneOf(TIMER_CODES, row?.timer_code);
  const status = oneOf(DEADLINE_STATUSES, row?.status);
  const days = whole(row?.days_applied);
  const startedOn = text(row?.started_on);
  const dueOn = text(row?.due_on);
  if (row === undefined || id === undefined || timerCode === undefined || status === undefined || days === undefined || startedOn === undefined || dueOn === undefined) return null;
  return { id, timerCode, daysApplied: days, startedOn, dueOn, satisfiedOn: nullableText(row.satisfied_on), status, legalBasis: nullableText(row.legal_basis), awaitingConfirmation: row.awaiting_confirmation === true, cxn: nullableText(row.cxn) };
}

/** A line of the list; a row the screen cannot read is dropped rather than shown half. */
export function toParcelLine(raw: unknown): ParcelLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const ownerUnitId = text(row?.owner_unit_id);
  const code = text(row?.parcel_code);
  const landUseGroup = oneOf(LAND_USE_GROUPS, row?.land_use_group);
  const status = oneOf(PARCEL_STATUSES, row?.status);
  const total = text(row?.area_total_m2);
  const affected = text(row?.area_affected_m2);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || projectId === undefined || ownerUnitId === undefined || code === undefined || landUseGroup === undefined || status === undefined) return undefined;
  if (total === undefined || affected === undefined || version === undefined) return undefined;
  return {
    id,
    projectId,
    sectionId: nullableText(row.section_id),
    sectionCode: nullableText(row.section_code),
    ownerUnitId,
    ownerUnitName: text(row.owner_unit_name) ?? '',
    parcelCode: code,
    addressText: nullableText(row.address_text),
    landUseGroup,
    areaTotalM2: total,
    areaAffectedM2: affected,
    hasBoundary: row.has_boundary === true,
    status,
    recoveryNoticeOn: nullableText(row.recovery_notice_on),
    noticeDaysApplied: whole(row.notice_days_applied) ?? null,
    recoveryDecisionOn: nullableText(row.recovery_decision_on),
    deadline: toDeadline(row.deadline),
    version,
  };
}

/** A section a parcel can be put in. */
export interface SectionOption {
  id: string;
  code: string;
  name: string;
}

export function toSectionOption(raw: unknown): SectionOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  return row === undefined || id === undefined || code === undefined ? [] : [{ id, code, name: text(row.name) ?? '' }];
}

/** A contract of a project that can receive the land of a section. */
export interface ContractOption {
  id: string;
  code: string;
  projectId: string;
}

export function toContractOption(raw: unknown): ContractOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const projectId = text(row?.project_id);
  return row === undefined || id === undefined || code === undefined || projectId === undefined ? [] : [{ id, code, projectId }];
}

/** A unit that can answer for a parcel. */
export interface UnitOption {
  id: string;
  code: string;
  name: string;
}

export function toUnitOption(raw: unknown): UnitOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const name = text(row?.name);
  return row === undefined || id === undefined || code === undefined || name === undefined ? [] : [{ id, code, name }];
}

/** The number of days from one calendar date to another (negative when the second is earlier); dates are `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The state of the notice of a parcel on a day: none yet, running with the days left, over (a decision may be taken), or ended by what happened to it. */
export type NoticeState =
  | { kind: 'NONE' }
  | { kind: 'RUNNING'; daysLeft: number }
  | { kind: 'ELAPSED' }
  | { kind: 'SATISFIED' }
  | { kind: 'BREACHED' }
  | { kind: 'CANCELLED' };

export function noticeState(parcel: ParcelLine, today: string): NoticeState {
  const deadline = parcel.deadline;
  if (deadline === null) return { kind: 'NONE' };
  if (deadline.status !== 'RUNNING') return { kind: deadline.status };
  const left = daysBetween(today, deadline.dueOn);
  return left > 0 ? { kind: 'RUNNING', daysLeft: left } : { kind: 'ELAPSED' };
}

/** Whether the notice of recovery can be recorded for the parcel by this caller: the stage allows it, none was given yet, and the caller holds the permission. */
export function canRecordNotice(parcel: ParcelLine, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean {
  return (permissions === undefined || permissions.includes(PROCESS_PERMISSION)) && mode !== 'READ_ONLY' && parcel.recoveryNoticeOn === null && NOTICE_STATUSES.includes(parcel.status);
}

/** What the forms of the handover check by the same rules as the sections and the notices: an area of at most two decimals, a uuid, a day that exists. */
export const isArea = (value: string): boolean => AREA.test(value.trim());
export const isUuid = (value: string): boolean => UUID.test(value.trim());
export const isDay = (value: string): boolean => ISO_DATE.test(value.trim()) && new Date(`${value.trim()}T00:00:00Z`).toISOString().slice(0, 10) === value.trim();

export const canManage = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';

export interface ParcelFilter {
  query: string;
  status: '' | ParcelStatus;
  sectionId: string;
}

export const EMPTY_FILTER: ParcelFilter = { query: '', status: '', sectionId: '' };

/** The parcels that match the filter: the query is looked for in the code, the address and the unit, ignoring capitals; the list keeps the order of the read. */
export function filterParcels(parcels: readonly ParcelLine[], filter: ParcelFilter): ParcelLine[] {
  const query = filter.query.trim().toLowerCase();
  return parcels.filter(
    (parcel) =>
      (filter.status === '' || parcel.status === filter.status) &&
      (filter.sectionId === '' || parcel.sectionId === filter.sectionId) &&
      (query === '' || [parcel.parcelCode, parcel.addressText ?? '', parcel.ownerUnitName].some((value) => value.toLowerCase().includes(query))),
  );
}

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'future';

export interface ParcelForm {
  parcelCode: string;
  ownerUnitId: string;
  landUseGroup: '' | LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  addressText: string;
  sectionId: string;
}

export const EMPTY_PARCEL_FORM: ParcelForm = { parcelCode: '', ownerUnitId: '', landUseGroup: '', areaTotalM2: '', areaAffectedM2: '', addressText: '', sectionId: '' };

/** What is wrong with the form before anything is sent; the server judges the same rules again (and the place of the parcel). */
export function validateParcel(form: ParcelForm): Partial<Record<keyof ParcelForm, FormProblem>> {
  const problems: Partial<Record<keyof ParcelForm, FormProblem>> = {};
  const code = form.parcelCode.trim().toUpperCase();
  if (code === '') problems.parcelCode = 'required';
  else if (code.length > CODE_MAX_LENGTH) problems.parcelCode = 'tooLong';
  else if (!PARCEL_CODE.test(code)) problems.parcelCode = 'invalid';
  if (form.ownerUnitId === '') problems.ownerUnitId = 'required';
  if (form.landUseGroup === '') problems.landUseGroup = 'required';
  const total = form.areaTotalM2.trim();
  const affected = form.areaAffectedM2.trim();
  if (total === '') problems.areaTotalM2 = 'required';
  else if (!AREA.test(total) || Number(total) <= 0) problems.areaTotalM2 = 'invalid';
  if (affected === '') problems.areaAffectedM2 = 'required';
  else if (!AREA.test(affected) || (problems.areaTotalM2 === undefined && Number(affected) > Number(total))) problems.areaAffectedM2 = 'invalid';
  const address = form.addressText.trim();
  if (address.length > ADDRESS_MAX_LENGTH) problems.addressText = 'tooLong';
  else if (hasControlCharacter(address)) problems.addressText = 'invalid';
  return problems;
}

export interface ParcelBody {
  project_id: string;
  owner_unit_id: string;
  parcel_code: string;
  land_use_group: LandUseGroup;
  area_total_m2: string;
  area_affected_m2: string;
  address_text?: string;
  section_id?: string;
}

export function parcelBody(projectId: string, form: ParcelForm): ParcelBody {
  const body: ParcelBody = {
    project_id: projectId,
    owner_unit_id: form.ownerUnitId,
    parcel_code: form.parcelCode.trim().toUpperCase(),
    land_use_group: form.landUseGroup as LandUseGroup,
    area_total_m2: form.areaTotalM2.trim(),
    area_affected_m2: form.areaAffectedM2.trim(),
  };
  if (form.addressText.trim() !== '') body.address_text = form.addressText.trim();
  if (form.sectionId !== '') body.section_id = form.sectionId;
  return body;
}

export interface SectionForm {
  code: string;
  name: string;
  fromKm: string;
  toKm: string;
  requiredAreaM2: string;
  targetDate: string;
  /** The construction contract that receives the land of the section; empty when none is named yet. */
  contractId: string;
}

export const EMPTY_SECTION_FORM: SectionForm = { code: '', name: '', fromKm: '', toKm: '', requiredAreaM2: '', targetDate: '', contractId: '' };

export function validateSection(form: SectionForm): Partial<Record<keyof SectionForm, FormProblem>> {
  const problems: Partial<Record<keyof SectionForm, FormProblem>> = {};
  const code = form.code.trim();
  if (code === '') problems.code = 'required';
  else if (code.length > CODE_MAX_LENGTH || hasControlCharacter(code)) problems.code = code.length > CODE_MAX_LENGTH ? 'tooLong' : 'invalid';
  const name = form.name.trim();
  if (name === '') problems.name = 'required';
  else if (name.length > NAME_MAX_LENGTH) problems.name = 'tooLong';
  else if (hasControlCharacter(name)) problems.name = 'invalid';
  const area = form.requiredAreaM2.trim();
  if (area === '') problems.requiredAreaM2 = 'required';
  else if (!AREA.test(area)) problems.requiredAreaM2 = 'invalid';
  const from = form.fromKm.trim();
  const to = form.toKm.trim();
  if (from !== '' && !KILOMETRE.test(from)) problems.fromKm = 'invalid';
  if (to !== '' && !KILOMETRE.test(to)) problems.toKm = 'invalid';
  else if (to !== '' && from !== '' && problems.fromKm === undefined && Number(from) > Number(to)) problems.toKm = 'invalid';
  const target = form.targetDate.trim();
  if (target !== '' && (!ISO_DATE.test(target) || Number.isNaN(Date.parse(`${target}T00:00:00Z`)))) problems.targetDate = 'invalid';
  return problems;
}

export interface SectionBody {
  project_id: string;
  code: string;
  name: string;
  required_area_m2: string;
  from_km?: string;
  to_km?: string;
  target_date?: string;
  contract_id?: string;
}

export function sectionBody(projectId: string, form: SectionForm): SectionBody {
  const body: SectionBody = { project_id: projectId, code: form.code.trim(), name: form.name.trim(), required_area_m2: form.requiredAreaM2.trim() };
  if (form.fromKm.trim() !== '') body.from_km = form.fromKm.trim();
  if (form.toKm.trim() !== '') body.to_km = form.toKm.trim();
  if (form.targetDate.trim() !== '') body.target_date = form.targetDate.trim();
  if (form.contractId !== '') body.contract_id = form.contractId;
  return body;
}

export interface NoticeForm {
  noticeOn: string;
  documentVersionId: string;
}

export const EMPTY_NOTICE_FORM: NoticeForm = { noticeOn: '', documentVersionId: '' };

/** What is wrong with the notice before it is sent: a real date that is not in the future, and the document that is the notice. */
export function validateNotice(form: NoticeForm, today: string): Partial<Record<keyof NoticeForm, FormProblem>> {
  const problems: Partial<Record<keyof NoticeForm, FormProblem>> = {};
  const on = form.noticeOn.trim();
  if (on === '') problems.noticeOn = 'required';
  else if (!ISO_DATE.test(on) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) problems.noticeOn = 'invalid';
  else if (on > today) problems.noticeOn = 'future';
  const document = form.documentVersionId.trim();
  if (document === '') problems.documentVersionId = 'required';
  else if (!UUID.test(document)) problems.documentVersionId = 'invalid';
  return problems;
}

export interface NoticeBody {
  notice_on: string;
  notice_document_version_id: string;
}

export const noticeBody = (form: NoticeForm): NoticeBody => ({ notice_on: form.noticeOn.trim(), notice_document_version_id: form.documentVersionId.trim().toLowerCase() });

export type CommandProblem =
  | 'areaExceeded'
  | 'parcelsNotReady'
  | 'contractNotActive'
  | 'noContract'
  | 'notBuilding'
  | 'codeDuplicate'
  | 'areaInvalid'
  | 'ruleUnconfirmed'
  | 'stateInvalid'
  | 'documentNotClean'
  | 'masterNotEffective'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  HANDED_AREA_EXCEEDS_REQUIRED: 'areaExceeded',
  PARCELS_NOT_READY: 'parcelsNotReady',
  CONTRACT_STATE_INVALID: 'contractNotActive',
  PARCEL_CODE_DUPLICATE: 'codeDuplicate',
  SECTION_CODE_DUPLICATE: 'codeDuplicate',
  AREA_INVALID: 'areaInvalid',
  TIMER_RULE_UNCONFIRMED: 'ruleUnconfirmed',
  PARCEL_STATE_INVALID: 'stateInvalid',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  MASTER_NOT_EFFECTIVE: 'masterNotEffective',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  if (!(error instanceof ApiError)) return 'general';
  // A section that has no contract, or one that does not build, is told apart from a request that is wrong in another way.
  if (error.code === 'VALIDATION_FAILED' && error.extensions.reason === 'NO_CONTRACT') return 'noContract';
  if (error.code === 'VALIDATION_FAILED' && error.extensions.reason === 'NOT_A_CONSTRUCTION_CONTRACT') return 'notBuilding';
  return PROBLEM_BY_CODE[error.code] ?? 'general';
}

/** The timer a notice will start for a land use (BR-LND-01): the short notice for agricultural land, the long one for every other land use. */
export const noticeTimerOf = (group: LandUseGroup): TimerCode => (group === 'AGRICULTURAL' ? 'NOTICE_AGRICULTURAL_90' : 'NOTICE_NON_AGRICULTURAL_180');

/** Today's date in Vietnam (UTC+7, no daylight saving): the day a notice is judged against and the days left are counted from. */
export const todayInVietnam = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
