import { ApiError } from '@machvon/api-client';
import { EQUIPMENT_GUIDE_STEPS, EQUIPMENT_STAGES } from '@machvon/kernel/src/equipment-procurement.ts';
import type { EquipmentGuideStep, EquipmentStage, MaskedFigure } from '@machvon/kernel/src/equipment-procurement.ts';

/** The screens of the equipment procurement of the Ban Thuong mai (CN.02): the paths of the route table, the permissions of the operations. */
export const LIST_PATH = '/eqp/eqp-01';
export const DETAIL_PATH = '/eqp/eqp-02';
export const MANAGE_PERMISSION = 'bid.plan.manage';
export { EQUIPMENT_STAGES };
export type { EquipmentStage };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface Line {
  id: string;
  code: string;
  name: string;
  planRef: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  source: 'MANUAL' | 'EGP_FILE';
  stage: EquipmentStage;
  project: { id: string; code: string; name: string };
  ownerUnit: { id: string; name: string };
  plannedValueVnd: string;
  package: { id: string; code: string; title: string | null; status: string; externalCode: string | null } | null;
  selection: { outcome: string; status: string; awardPriceVnd: string | null; winnerName: string | null } | null;
  contract: { id: string; code: string; status: string } | null;
  contractValueVnd: string | null;
  planVarianceVnd: string | null;
  paidVnd: string | null;
  disbursementPercent: string | null;
  masked: MaskedFigure[];
  externalLink: { externalCode: string; diffStatus: string } | null;
  version: number;
}

export interface Guide {
  state: 'NEVER_IMPORTED' | 'FRESH' | 'AGING' | 'STALE';
  ageHours: number | null;
  layoutVersion: string;
  acceptance: string;
  steps: EquipmentGuideStep[];
}

export interface ListResult {
  items: Line[];
  guide: Guide;
}

function toLine(raw: unknown): Line | undefined {
  if (!isRecord(raw) || !isRecord(raw.project) || !isRecord(raw.owner_unit)) return undefined;
  const id = text(raw.id);
  const code = text(raw.code);
  const name = text(raw.name);
  const planned = text(raw.planned_value_vnd);
  const stage = raw.stage;
  if (id === undefined || code === undefined || name === undefined || planned === undefined || typeof raw.version !== 'number' || !(EQUIPMENT_STAGES as readonly unknown[]).includes(stage)) return undefined;
  const pack = isRecord(raw.package) ? raw.package : undefined;
  const selection = isRecord(raw.selection) ? raw.selection : undefined;
  const contract = isRecord(raw.contract) ? raw.contract : undefined;
  const link = isRecord(raw.external_link) ? raw.external_link : undefined;
  return {
    id,
    code,
    name,
    planRef: nullableText(raw.plan_ref),
    status: raw.status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE',
    source: raw.source === 'EGP_FILE' ? 'EGP_FILE' : 'MANUAL',
    stage: stage as EquipmentStage,
    project: { id: text(raw.project.id) ?? '', code: text(raw.project.code) ?? '', name: text(raw.project.name) ?? '' },
    ownerUnit: { id: text(raw.owner_unit.id) ?? '', name: text(raw.owner_unit.name) ?? '' },
    plannedValueVnd: planned,
    package: pack === undefined ? null : { id: text(pack.id) ?? '', code: text(pack.code) ?? '', title: nullableText(pack.title), status: text(pack.status) ?? '', externalCode: nullableText(pack.external_code) },
    selection: selection === undefined ? null : { outcome: text(selection.outcome) ?? '', status: text(selection.status) ?? '', awardPriceVnd: nullableText(selection.award_price_vnd), winnerName: nullableText(selection.winner_name) },
    contract: contract === undefined ? null : { id: text(contract.id) ?? '', code: text(contract.code) ?? '', status: text(contract.status) ?? '' },
    contractValueVnd: nullableText(raw.contract_value_vnd),
    planVarianceVnd: nullableText(raw.plan_variance_vnd),
    paidVnd: nullableText(raw.paid_vnd),
    disbursementPercent: nullableText(raw.disbursement_percent),
    masked: Array.isArray(raw.masked) ? raw.masked.filter((entry): entry is MaskedFigure => entry === 'CONTRACT' || entry === 'PAYMENT') : [],
    externalLink: link === undefined ? null : { externalCode: text(link.external_code) ?? '', diffStatus: text(link.diff_status) ?? '' },
    version: raw.version,
  };
}

function toGuide(raw: unknown): Guide {
  const base: Guide = { state: 'NEVER_IMPORTED', ageHours: null, layoutVersion: '', acceptance: 'PENDING_EXTERNAL', steps: [...EQUIPMENT_GUIDE_STEPS] };
  if (!isRecord(raw)) return base;
  const state = raw.state;
  return {
    state: state === 'FRESH' || state === 'AGING' || state === 'STALE' || state === 'NEVER_IMPORTED' ? state : base.state,
    ageHours: typeof raw.age_hours === 'number' ? raw.age_hours : null,
    layoutVersion: text(raw.layout_version) ?? '',
    acceptance: text(raw.acceptance) ?? base.acceptance,
    steps: Array.isArray(raw.steps) ? raw.steps.filter((step): step is EquipmentGuideStep => (EQUIPMENT_GUIDE_STEPS as readonly unknown[]).includes(step)) : base.steps,
  };
}

export function toList(raw: unknown): ListResult {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  return { items: items.flatMap((item: unknown) => toLine(item) ?? []), guide: toGuide(isRecord(raw) ? raw.data_guide : undefined) };
}

export function toDetail(raw: unknown): { line: Line; guide: Guide } | undefined {
  if (!isRecord(raw)) return undefined;
  const line = toLine(raw.line);
  return line === undefined ? undefined : { line, guide: toGuide(raw.data_guide) };
}

/** The tone of the pill of a stage: waiting is neutral, work in hand is info, money moving is warning, done is success, a dead end is danger. */
export function stageTone(stage: EquipmentStage): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (stage) {
    case 'PLANNED':
      return 'neutral';
    case 'PACKAGED':
    case 'SELECTED':
    case 'CONTRACTED':
      return 'info';
    case 'DISBURSING':
      return 'warning';
    case 'DISBURSED':
      return 'success';
    case 'NO_AWARD':
    case 'CANCELLED':
      return 'danger';
  }
}

export interface CreateForm {
  projectId: string;
  code: string;
  name: string;
  plannedValueVnd: string;
  planRef: string;
}

export const EMPTY_CREATE: CreateForm = { projectId: '', code: '', name: '', plannedValueVnd: '', planRef: '' };
export type CreateField = 'projectId' | 'code' | 'name' | 'plannedValueVnd';
export type CreateProblem = 'required' | 'format';

export function validateCreate(form: CreateForm): Partial<Record<CreateField, CreateProblem>> {
  const errors: Partial<Record<CreateField, CreateProblem>> = {};
  if (form.projectId === '') errors.projectId = 'required';
  if (form.code.trim() === '') errors.code = 'required';
  else if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/.test(form.code.trim())) errors.code = 'format';
  if (form.name.trim().length < 3) errors.name = 'required';
  if (form.plannedValueVnd.trim() === '') errors.plannedValueVnd = 'required';
  else if (!/^[1-9][0-9]{0,23}$/.test(form.plannedValueVnd.trim())) errors.plannedValueVnd = 'format';
  return errors;
}

export function toCreateBody(form: CreateForm): Record<string, string> {
  return {
    project_id: form.projectId,
    code: form.code.trim(),
    name: form.name.trim(),
    planned_value_vnd: form.plannedValueVnd.trim(),
    ...(form.planRef.trim() === '' ? {} : { plan_ref: form.planRef.trim() }),
  };
}

export interface LinkForm {
  packageId: string;
  contractId: string;
}

export function validateLink(form: LinkForm, line: Line): 'nothing' | 'format' | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const wantsPackage = line.package === null && form.packageId.trim() !== '';
  const wantsContract = line.contract === null && form.contractId.trim() !== '';
  if (!wantsPackage && !wantsContract) return 'nothing';
  if ((wantsPackage && !uuid.test(form.packageId.trim())) || (wantsContract && !uuid.test(form.contractId.trim()))) return 'format';
  return undefined;
}

export type ProblemReason = 'invalid' | 'codeTaken' | 'state' | 'link' | 'conflict' | 'denied' | 'notFound' | 'general';

export function describeProblem(error: unknown): ProblemReason {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return 'invalid';
    case 'EQUIPMENT_LINE_CODE_TAKEN':
      return 'codeTaken';
    case 'EQUIPMENT_LINE_STATE_INVALID':
      return 'state';
    case 'EQUIPMENT_LINK_INVALID':
      return 'link';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    default:
      return 'general';
  }
}
