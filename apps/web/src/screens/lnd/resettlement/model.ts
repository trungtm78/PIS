import { ApiError } from '@machvon/api-client';
import { isArea } from '../model';

/** LND-12: the resettlement of the households whose land is recovered (ST-LND-012, LND 3.1, UAT-PLAN-31). */
export const ALLOCATE_PERMISSION = 'land.resettle.write';

export const UNIT_KINDS = ['PLOT', 'APARTMENT', 'HOUSE'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export const STATUSES = ['ELIGIBLE', 'ALLOCATED', 'HANDED_OVER', 'DECLINED'] as const;
export type Status = (typeof STATUSES)[number];
export const ITEM_KINDS = ['RESETTLEMENT_LAND', 'RESETTLEMENT_HOUSE'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** The household as the allocation shows it: its code and the masked name of its head, and nothing else. */
export interface MaskedHousehold {
  id: string;
  code: string;
  headName: string;
}

export interface AllocationLine {
  id: string;
  household: MaskedHousehold;
  unitKind: UnitKind;
  unitCode: string;
  siteText: string;
  areaM2: string | null;
  priorityRank: number | null;
  allocatedOn: string | null;
  handedOn: string | null;
  status: Status;
}

export interface Candidate {
  planItemId: string;
  household: MaskedHousehold;
  ownerUnitId: string;
  itemKind: ItemKind;
  unitKinds: UnitKind[];
}

function toHousehold(raw: unknown): MaskedHousehold | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.household_code);
  return row === undefined || id === undefined || code === undefined ? undefined : { id, code, headName: text(row.head_name) ?? '' };
}

export function toAllocation(raw: unknown): AllocationLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const household = toHousehold(row?.household);
  const unitKind = oneOf(UNIT_KINDS, row?.unit_kind);
  const status = oneOf(STATUSES, row?.status);
  const unitCode = text(row?.unit_code);
  if (row === undefined || id === undefined || household === undefined || unitKind === undefined || status === undefined || unitCode === undefined) return undefined;
  return {
    id,
    household,
    unitKind,
    unitCode,
    siteText: text(row.site_text) ?? '',
    areaM2: nullableText(row.area_m2),
    priorityRank: typeof row.priority_rank === 'number' ? row.priority_rank : null,
    allocatedOn: nullableText(row.allocated_on),
    handedOn: nullableText(row.handed_on),
    status,
  };
}

export function toCandidate(raw: unknown): Candidate | undefined {
  const row = asRecord(raw);
  const planItemId = text(row?.plan_item_id);
  const household = toHousehold(row?.household);
  const ownerUnitId = text(row?.owner_unit_id);
  const itemKind = oneOf(ITEM_KINDS, row?.item_kind);
  if (row === undefined || planItemId === undefined || household === undefined || ownerUnitId === undefined || itemKind === undefined) return undefined;
  const unitKinds = (Array.isArray(row.unit_kinds) ? row.unit_kinds : []).flatMap((kind) => oneOf(UNIT_KINDS, kind) ?? []);
  return { planItemId, household, ownerUnitId, itemKind, unitKinds };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canAllocate = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(ALLOCATE_PERMISSION)) && mode !== 'READ_ONLY';

// ---- the form ----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type FormField = 'candidate' | 'unitKind' | 'unitCode' | 'siteText' | 'area' | 'rank';

export interface AllocationForm {
  /** The plan item chosen: it names the household, the unit that answers and the kinds of unit it gives. */
  planItemId: string;
  unitKind: string;
  unitCode: string;
  siteText: string;
  area: string;
  rank: string;
}

export const EMPTY_FORM: AllocationForm = { planItemId: '', unitKind: '', unitCode: '', siteText: '', area: '', rank: '' };
export const CODE_MAX = 60;
export const SITE_MAX = 300;
export const RANK_MAX = 100_000;

export function validateForm(form: AllocationForm, candidates: readonly Candidate[]): Partial<Record<FormField, FormProblem>> {
  const found: Partial<Record<FormField, FormProblem>> = {};
  const candidate = candidates.find((item) => item.planItemId === form.planItemId);
  if (form.planItemId === '') found.candidate = 'required';
  else if (candidate === undefined) found.candidate = 'invalid';
  if (form.unitKind === '') found.unitKind = 'required';
  else if (candidate !== undefined && !(candidate.unitKinds as readonly string[]).includes(form.unitKind)) found.unitKind = 'invalid';
  const code = form.unitCode.trim();
  if (code === '') found.unitCode = 'required';
  else if (code.length > CODE_MAX) found.unitCode = 'invalid';
  const site = form.siteText.trim();
  if (site === '') found.siteText = 'required';
  else if (site.length > SITE_MAX) found.siteText = 'invalid';
  if (form.area.trim() !== '' && (!isArea(form.area) || Number(form.area) <= 0)) found.area = 'invalid';
  if (form.rank.trim() !== '' && !(/^[1-9][0-9]{0,5}$/.test(form.rank.trim()) && Number(form.rank.trim()) <= RANK_MAX)) found.rank = 'invalid';
  return found;
}

/** The body of the command for a form that passed `validateForm`. */
export function allocationBody(form: AllocationForm, candidates: readonly Candidate[]): Record<string, unknown> {
  const candidate = candidates.find((item) => item.planItemId === form.planItemId);
  return {
    household_id: candidate?.household.id ?? '',
    plan_item_id: form.planItemId,
    owner_unit_id: candidate?.ownerUnitId ?? '',
    unit_kind: form.unitKind,
    unit_code: form.unitCode.trim(),
    site_text: form.siteText.trim(),
    ...(form.area.trim() === '' ? {} : { area_m2: form.area.trim() }),
    ...(form.rank.trim() === '' ? {} : { priority_rank: Number(form.rank.trim()) }),
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type Problem = 'unitTaken' | 'notEligible' | 'scopeDenied' | 'notFound' | 'validation' | 'general';
export type EligibilityReason = 'NO_PLAN_ITEM' | 'PLAN_ITEM_NOT_FOUND' | 'PLAN_ITEM_OF_ANOTHER_HOUSEHOLD' | 'PLAN_NOT_APPROVED' | 'NOT_A_RESETTLEMENT_ITEM' | 'UNIT_KIND_MISMATCH' | 'ALREADY_ALLOCATED';
const REASONS: readonly EligibilityReason[] = ['NO_PLAN_ITEM', 'PLAN_ITEM_NOT_FOUND', 'PLAN_ITEM_OF_ANOTHER_HOUSEHOLD', 'PLAN_NOT_APPROVED', 'NOT_A_RESETTLEMENT_ITEM', 'UNIT_KIND_MISMATCH', 'ALREADY_ALLOCATED'];

export interface Refusal {
  problem: Problem;
  reason: EligibilityReason | undefined;
}

const BY_CODE: Readonly<Record<string, Problem>> = {
  UNIT_ALREADY_ALLOCATED: 'unitTaken',
  HOUSEHOLD_NOT_ELIGIBLE: 'notEligible',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', reason: undefined };
  const reason = oneOf(REASONS, error.extensions.reason);
  return { problem: BY_CODE[error.code] ?? 'general', reason };
}
