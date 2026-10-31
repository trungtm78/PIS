import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'project.read';
export const UPDATE_PERMISSION = 'project.update';
/** A project that is closed, rejected or cancelled takes no change. */
export const FROZEN_STAGES: readonly string[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

export const MILESTONE_STATUSES = ['PLANNED', 'DONE', 'DELAYED', 'CANCELLED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface ComponentView {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  plannedValueVnd: string;
  validFrom: string;
  depth: number;
}

export interface ComponentRegister {
  items: ComponentView[];
  wbsTotalVnd: string;
  projectTotalVnd: string;
  exceedsTotal: boolean;
}

function toComponent(raw: unknown): ComponentView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const value = text(row?.planned_value_vnd);
  if (row === undefined || id === undefined || code === undefined || value === undefined || typeof row.depth !== 'number') return undefined;
  return { id, parentId: nullableText(row.parent_component_id), code, name: text(row.name) ?? '', plannedValueVnd: value, validFrom: text(row.valid_from) ?? '', depth: row.depth };
}

export function toComponentRegister(raw: unknown): ComponentRegister {
  const page = asRecord(raw);
  return {
    items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toComponent(item) ?? []),
    wbsTotalVnd: text(page?.wbs_total_vnd) ?? '0',
    projectTotalVnd: text(page?.project_total_vnd) ?? '0',
    exceedsTotal: page?.exceeds_total === true,
  };
}

export interface MilestoneView {
  id: string;
  code: string;
  name: string;
  componentCode: string | null;
  baselineDate: string;
  plannedDate: string;
  actualDate: string | null;
  dependsOn: { id: string; code: string } | null;
  status: MilestoneStatus;
  reason: string | null;
  delayDays: number;
  delayed: boolean;
  version: number;
}

function toMilestone(raw: unknown): MilestoneView | undefined {
  const row = asRecord(raw);
  const status = MILESTONE_STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const code = text(row?.code);
  const baseline = text(row?.baseline_date);
  const planned = text(row?.planned_date);
  if (row === undefined || status === undefined || id === undefined || code === undefined || baseline === undefined || planned === undefined || typeof row.version !== 'number') return undefined;
  const depends = asRecord(row.depends_on);
  const dependsId = text(depends?.id);
  return {
    id,
    code,
    name: text(row.name) ?? '',
    componentCode: text(asRecord(row.component)?.code) ?? null,
    baselineDate: baseline,
    plannedDate: planned,
    actualDate: nullableText(row.actual_date),
    dependsOn: dependsId === undefined ? null : { id: dependsId, code: text(depends?.code) ?? '' },
    status,
    reason: nullableText(row.reason),
    delayDays: typeof row.delay_days === 'number' ? row.delay_days : 0,
    delayed: row.delayed === true,
    version: row.version,
  };
}

export const toMilestones = (raw: unknown): MilestoneView[] => (Array.isArray(asRecord(raw)?.items) ? (asRecord(raw)?.items as unknown[]) : []).flatMap((item) => toMilestone(item) ?? []);

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** A milestone that is done or cancelled changes no more. */
export const isOpen = (status: MilestoneStatus): boolean => status === 'PLANNED' || status === 'DELAYED';

/** The milestones a milestone could wait for: the others of the project, and none that already waits (through others) for it. */
export function dependencyChoices(items: readonly MilestoneView[], id: string): MilestoneView[] {
  const waitsFor = new Map(items.map((item) => [item.id, item.dependsOn?.id ?? null]));
  const loops = (candidate: string): boolean => {
    const seen = new Set<string>();
    let current: string | null | undefined = candidate;
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (current === id) return true;
      seen.add(current);
      current = waitsFor.get(current);
    }
    return false;
  };
  return items.filter((item) => item.id !== id && !loops(item.id));
}

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const MONEY = /^(0|[1-9][0-9]*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isDay(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return DATE.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** The day of the form in Vietnam (UTC+7), as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export type ComponentField = 'code' | 'name' | 'parent' | 'value' | 'validFrom' | 'sortOrder';

export interface ComponentForm {
  code: string;
  name: string;
  parent: string;
  value: string;
  validFrom: string;
  sortOrder: string;
}

export const EMPTY_COMPONENT: ComponentForm = { code: '', name: '', parent: '', value: '', validFrom: '', sortOrder: '' };

export function validateComponent(form: ComponentForm): Partial<Record<ComponentField, FormProblem>> {
  const found: Partial<Record<ComponentField, FormProblem>> = {};
  const code = form.code.trim();
  if (code === '') found.code = 'required';
  else if (!CODE.test(code)) found.code = 'invalid';
  const name = form.name.trim();
  if (name === '') found.name = 'required';
  else if (name.length < 2 || name.length > 300) found.name = 'invalid';
  if (form.parent !== '' && !UUID.test(form.parent)) found.parent = 'invalid';
  const value = form.value.trim();
  if (value === '') found.value = 'required';
  else if (!MONEY.test(value) || value.length > 24) found.value = 'invalid';
  if (form.validFrom === '') found.validFrom = 'required';
  else if (!isDay(form.validFrom)) found.validFrom = 'invalid';
  const sort = form.sortOrder.trim();
  if (sort !== '' && !(/^\d+$/.test(sort) && Number(sort) <= 100_000)) found.sortOrder = 'invalid';
  return found;
}

export const componentBody = (form: ComponentForm): Record<string, unknown> => ({
  code: form.code.trim(),
  name: form.name.trim(),
  planned_value_vnd: form.value.trim(),
  valid_from: form.validFrom,
  ...(form.parent === '' ? {} : { parent_component_id: form.parent }),
  ...(form.sortOrder.trim() === '' ? {} : { sort_order: Number(form.sortOrder) }),
});

export type MilestoneField = 'code' | 'name' | 'component' | 'baseline' | 'planned' | 'dependsOn';

export interface MilestoneForm {
  code: string;
  name: string;
  component: string;
  baseline: string;
  planned: string;
  dependsOn: string;
}

export const EMPTY_MILESTONE: MilestoneForm = { code: '', name: '', component: '', baseline: '', planned: '', dependsOn: '' };

export function validateMilestone(form: MilestoneForm): Partial<Record<MilestoneField, FormProblem>> {
  const found: Partial<Record<MilestoneField, FormProblem>> = {};
  const code = form.code.trim();
  if (code === '') found.code = 'required';
  else if (!CODE.test(code)) found.code = 'invalid';
  const name = form.name.trim();
  if (name === '') found.name = 'required';
  else if (name.length < 2 || name.length > 300) found.name = 'invalid';
  for (const [field, value] of [['baseline', form.baseline], ['planned', form.planned]] as const) {
    if (value === '') found[field] = 'required';
    else if (!isDay(value)) found[field] = 'invalid';
  }
  return found;
}

export const milestoneBody = (form: MilestoneForm): Record<string, unknown> => ({
  code: form.code.trim(),
  name: form.name.trim(),
  baseline_date: form.baseline,
  planned_date: form.planned,
  ...(form.component === '' ? {} : { component_id: form.component }),
  ...(form.dependsOn === '' ? {} : { depends_on_milestone_id: form.dependsOn }),
});

export const OUTCOMES = ['DONE', 'DELAYED', 'CANCELLED'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type ProgressField = 'actual' | 'planned' | 'reason';

export interface ProgressForm {
  outcome: Outcome;
  actual: string;
  planned: string;
  reason: string;
}

export const EMPTY_PROGRESS: ProgressForm = { outcome: 'DONE', actual: '', planned: '', reason: '' };

/** What the screen can tell before it asks: the day it was done is a real day that has come, a delay names a later day and a reason, a cancellation a reason. */
export function validateProgress(form: ProgressForm, current: Pick<MilestoneView, 'plannedDate'>, today: string): Partial<Record<ProgressField, FormProblem>> {
  const found: Partial<Record<ProgressField, FormProblem>> = {};
  const reason = form.reason.trim();
  const needReason = form.outcome !== 'DONE';
  if (needReason && reason === '') found.reason = 'required';
  else if (reason !== '' && (reason.length < 5 || reason.length > 2000)) found.reason = 'invalid';
  if (form.outcome === 'DONE') {
    if (form.actual === '') found.actual = 'required';
    else if (!isDay(form.actual) || form.actual > today) found.actual = 'invalid';
  }
  if (form.outcome === 'DELAYED') {
    if (form.planned === '') found.planned = 'required';
    else if (!isDay(form.planned) || form.planned <= current.plannedDate) found.planned = 'invalid';
  }
  return found;
}

export function progressBody(form: ProgressForm): Record<string, unknown> {
  const reason = form.reason.trim();
  switch (form.outcome) {
    case 'DONE':
      return { status: 'DONE', actual_date: form.actual, ...(reason === '' ? {} : { reason }) };
    case 'DELAYED':
      return { status: 'DELAYED', planned_date: form.planned, reason };
    case 'CANCELLED':
      return { status: 'CANCELLED', reason };
  }
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type PlanProblem = 'componentDuplicate' | 'milestoneDuplicate' | 'cycle' | 'stateInvalid' | 'versionConflict' | 'scopeDenied' | 'stageClosed' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, PlanProblem>> = {
  COMPONENT_CODE_DUPLICATE: 'componentDuplicate',
  MILESTONE_CODE_DUPLICATE: 'milestoneDuplicate',
  DEPENDENCY_CYCLE: 'cycle',
  MILESTONE_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  PROJECT_STAGE_INVALID: 'stageClosed',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describePlan = (error: unknown): PlanProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
