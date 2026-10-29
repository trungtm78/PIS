import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'workflow_version.read';
export const MANAGE_PERMISSION = 'adm.workflow.manage';
export const PUBLISH_PERMISSION = 'adm.workflow.publish';

/** The business types the platform knows and the command each end of a workflow calls in the owning module (ADM 3.7); the server judges the same table. */
export const BUSINESS_TYPES = [
  { code: 'report.accept', commands: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } },
  { code: 'plan.publish', commands: { approved: 'publishPlan', returned: 'returnPlan', rejected: 'rejectPlan' } },
  { code: 'payment.approve', commands: { approved: 'approvePaymentRequest', returned: 'returnPaymentRequest', rejected: 'rejectPaymentRequest' } },
  { code: 'contract.change', commands: { approved: 'approveContractChange', returned: 'returnContractChange', rejected: 'rejectContractChange' } },
  { code: 'period.reopen', commands: { approved: 'reopenPeriod', returned: 'returnPeriodReopen', rejected: 'rejectPeriodReopen' } },
] as const;
export type BusinessTypeCode = (typeof BUSINESS_TYPES)[number]['code'];
export const commandsOf = (code: string) => BUSINESS_TYPES.find((type) => type.code === code)?.commands;

export const RULE_TYPES = ['DOA', 'ROLE_IN_UNIT', 'SPECIFIC'] as const;
export const TIMEOUTS = ['REMIND', 'ESCALATE', 'EXPIRE'] as const;
export const VERSION_STATUSES = ['Draft', 'Published', 'Superseded', 'Retired'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
const STEP_ID = /^[a-z][a-z0-9_-]{1,39}$/;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface VersionView {
  id: string;
  businessType: string;
  revision: number;
  status: VersionStatus;
  definition: unknown;
  createdBy: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  version: number;
}

export function toVersion(raw: unknown): VersionView | undefined {
  const row = record(raw);
  const status = VERSION_STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const businessType = text(row?.business_type);
  if (row === undefined || status === undefined || id === undefined || businessType === undefined || typeof row.revision !== 'number' || typeof row.version !== 'number') return undefined;
  return { id, businessType, revision: row.revision, status, definition: row.definition, createdBy: text(row.created_by) ?? '', publishedBy: text(row.published_by) ?? null, createdAt: text(row.created_at) ?? '', publishedAt: text(row.published_at) ?? null, version: row.version };
}

// ---- the step builder -------------------------------------------------------------------------------------------------------------

export interface StepForm {
  id: string;
  name: string;
  ruleType: (typeof RULE_TYPES)[number];
  roleCode: string;
  unitId: string;
  members: string;
  minApprovals: string;
  slaHours: string;
  onTimeout: (typeof TIMEOUTS)[number];
  escalateTo: string;
  allowReturnTo: string;
}

export const emptyStep = (index: number): StepForm => ({ id: `step-${index + 1}`, name: '', ruleType: 'DOA', roleCode: '', unitId: '', members: '', minApprovals: '1', slaHours: '16', onTimeout: 'REMIND', escalateTo: '', allowReturnTo: '' });

const listOf = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

/** The definition the form says, in the language the server validates; a field the type does not use is left out. */
export function toDefinition(businessType: string, steps: readonly StepForm[]): Record<string, unknown> {
  const commands = commandsOf(businessType);
  return {
    steps: steps.map((step) => ({
      id: step.id.trim(),
      name: step.name.trim(),
      assignee_rule: step.ruleType === 'DOA' ? { type: 'DOA' } : step.ruleType === 'ROLE_IN_UNIT' ? { type: 'ROLE_IN_UNIT', role_code: step.roleCode.trim(), unit_id: step.unitId.trim() } : { type: 'SPECIFIC', membership_ids: listOf(step.members) },
      min_approvals: Number(step.minApprovals),
      sla_working_hours: Number(step.slaHours),
      on_timeout: step.onTimeout,
      ...(step.onTimeout === 'ESCALATE' ? { escalate_to: step.escalateTo.trim() } : {}),
      ...(step.allowReturnTo === '' ? {} : { allow_return_to: step.allowReturnTo }),
    })),
    terminal: { approved: commands?.approved ?? '', returned: commands?.returned ?? '', rejected: commands?.rejected ?? '' },
  };
}

/** The form of a stored definition; what is not in the language is shown empty and the server says why when it is saved. */
export function fromDefinition(definition: unknown): StepForm[] {
  const steps = record(definition)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((raw, index) => {
    const step = record(raw) ?? {};
    const rule = record(step.assignee_rule) ?? {};
    const ruleType = RULE_TYPES.find((candidate) => candidate === rule.type) ?? 'DOA';
    const timeout = TIMEOUTS.find((candidate) => candidate === step.on_timeout) ?? 'REMIND';
    return {
      ...emptyStep(index),
      id: text(step.id) ?? '',
      name: text(step.name) ?? '',
      ruleType,
      roleCode: text(rule.role_code) ?? '',
      unitId: text(rule.unit_id) ?? '',
      members: Array.isArray(rule.membership_ids) ? rule.membership_ids.filter((entry): entry is string => typeof entry === 'string').join(', ') : '',
      minApprovals: typeof step.min_approvals === 'number' ? String(step.min_approvals) : '1',
      slaHours: typeof step.sla_working_hours === 'number' ? String(step.sla_working_hours) : '16',
      onTimeout: timeout,
      escalateTo: text(step.escalate_to) ?? '',
      allowReturnTo: text(step.allow_return_to) ?? '',
    };
  });
}

export type StepProblem = 'idInvalid' | 'idDuplicate' | 'nameRequired' | 'numberInvalid';

/** What can be told without the server: an id that is malformed or used twice, a missing name, a number that is not one. The server judges the rest and says where. */
export function localProblems(steps: readonly StepForm[]): Array<Partial<Record<'id' | 'name' | 'minApprovals' | 'slaHours', StepProblem>>> {
  return steps.map((step, index) => {
    const problems: Partial<Record<'id' | 'name' | 'minApprovals' | 'slaHours', StepProblem>> = {};
    if (!STEP_ID.test(step.id.trim())) problems.id = 'idInvalid';
    else if (steps.findIndex((other) => other.id.trim() === step.id.trim()) !== index) problems.id = 'idDuplicate';
    if (step.name.trim().length < 2) problems.name = 'nameRequired';
    if (!/^\d+$/.test(step.minApprovals.trim())) problems.minApprovals = 'numberInvalid';
    if (!/^\d+(\.\d+)?$/.test(step.slaHours.trim())) problems.slaHours = 'numberInvalid';
    return problems;
  });
}

// ---- what the server says is wrong --------------------------------------------------------------------------------------------------

export interface Defect {
  path: string;
  code: string;
}

/** The defects of a refused definition, each with its JSON path; none for any other refusal. */
export function readDefects(error: unknown): Defect[] {
  if (!(error instanceof ApiError) || error.code !== 'WORKFLOW_DEFINITION_INVALID') return [];
  const list = record(error.extensions)?.defects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): Defect[] => {
    const item = record(entry);
    return typeof item?.path === 'string' && typeof item.code === 'string' ? [{ path: item.path, code: item.code }] : [];
  });
}

export type Problem = 'invalidDefinition' | 'versionConflict' | 'notDraft' | 'selfPublish' | 'denied' | 'notFound' | 'validation' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'WORKFLOW_DEFINITION_INVALID':
      return 'invalidDefinition';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'WORKFLOW_NOT_DRAFT':
      return 'notDraft';
    case 'SELF_APPROVAL_DENIED':
      return 'selfPublish';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    default:
      return 'general';
  }
}

// ---- the difference between two versions --------------------------------------------------------------------------------------------

export interface StepDifference {
  id: string;
  kind: 'ADDED' | 'REMOVED' | 'CHANGED' | 'MOVED';
  /** The fields that differ, for a changed step. */
  fields: string[];
}

const FIELDS: Array<[string, (step: StepForm) => string]> = [
  ['name', (step) => step.name],
  ['assignee', (step) => `${step.ruleType}|${step.roleCode}|${step.unitId}|${listOf(step.members).sort().join(',')}`],
  ['minApprovals', (step) => step.minApprovals],
  ['slaHours', (step) => step.slaHours],
  ['onTimeout', (step) => `${step.onTimeout}|${step.escalateTo}`],
  ['allowReturnTo', (step) => step.allowReturnTo],
];

/** The steps added, removed or changed from one definition to the next, by step id, in the order of the newer one and then the removed ones. */
export function diffDefinitions(before: unknown, after: unknown): StepDifference[] {
  const older = fromDefinition(before);
  const newer = fromDefinition(after);
  const list: StepDifference[] = [];
  for (const step of newer) {
    const previous = older.find((candidate) => candidate.id === step.id);
    if (previous === undefined) list.push({ id: step.id, kind: 'ADDED', fields: [] });
    else {
      const fields = FIELDS.filter(([, read]) => read(previous) !== read(step)).map(([name]) => name);
      if (fields.length > 0) list.push({ id: step.id, kind: 'CHANGED', fields });
    }
  }
  for (const step of older) if (!newer.some((candidate) => candidate.id === step.id)) list.push({ id: step.id, kind: 'REMOVED', fields: [] });
  // The steps run in the order they are written: a step that kept its fields but came before or after another one changed what the approval does.
  const kept = older.filter((step) => newer.some((candidate) => candidate.id === step.id)).map((step) => step.id);
  const keptNow = newer.filter((step) => kept.includes(step.id)).map((step) => step.id);
  for (const [position, id] of keptNow.entries()) if (kept[position] !== id && !list.some((entry) => entry.id === id && entry.kind === 'CHANGED')) list.push({ id, kind: 'MOVED', fields: [] });
  return list;
}
