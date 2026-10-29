import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'iam.unit.reorganize.read';
export const PROPOSE_PERMISSION = 'iam.unit.reorganize';
export const APPROVE_PERMISSION = 'iam.unit.reorganize.approve';
export const REASON_MIN = 10;
/** The kinds the saga does; a transfer is the move of a unit (ADM-01). */
export const KINDS = ['MERGE', 'SPLIT', 'DISSOLVE', 'RENAME'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['Draft', 'PendingApproval', 'Approved', 'Applying', 'Applied', 'Failed', 'Cancelled'] as const;
export type Status = (typeof STATUSES)[number];
/** The unit types the contract lets a unit be created with (`OrgUnitCreate`). */
export const UNIT_TYPES = ['DEPARTMENT', 'DIVISION', 'PROJECT_MANAGEMENT_BOARD', 'INVESTOR', 'COMMUNE', 'OTHER'] as const;
/** The steps of the wizard: what changes, where things go, what it will do, and the submission. */
export const WIZARD_STEPS = ['choose', 'map', 'preview', 'submit'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface UnitRef {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface StepView {
  key: string;
  doneAt: string;
}

export interface ReorganizationView {
  id: string;
  kind: string;
  effectiveFrom: string;
  legalBasisRef: string;
  status: Status;
  predecessors: UnitRef[];
  successors: UnitRef[];
  newUnitName: string | null;
  mappedMembers: number;
  mappedProjects: number;
  requestedById: string;
  requestedByName: string;
  approvedByName: string;
  decisionReason: string | null;
  summary: Raw | null;
  failedStep: string | null;
  failedCode: string | null;
  steps: StepView[];
  version: number;
  mayDecide: boolean;
}

const toUnit = (raw: unknown): UnitRef | undefined => {
  const row = record(raw);
  const id = text(row?.id);
  return id === undefined ? undefined : { id, code: text(row?.code) ?? '', name: text(row?.name) ?? '', status: text(row?.status) ?? '' };
};

export function toReorganization(raw: unknown): ReorganizationView | undefined {
  const row = record(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const effective = text(row?.effective_from);
  if (row === undefined || status === undefined || id === undefined || effective === undefined || typeof row.version !== 'number') return undefined;
  const summary = record(row.result_summary) ?? null;
  const failed = record(summary?.failed);
  const mapping = record(row.mapping);
  return {
    id,
    kind: text(row.kind) ?? '',
    effectiveFrom: effective,
    legalBasisRef: text(row.legal_basis_ref) ?? '',
    status,
    predecessors: list(row.predecessors).flatMap((entry) => toUnit(entry) ?? []),
    successors: list(row.successors).flatMap((entry) => toUnit(entry) ?? []),
    newUnitName: text(record(row.new_unit)?.name) ?? null,
    mappedMembers: typeof mapping?.memberships === 'number' ? mapping.memberships : 0,
    mappedProjects: typeof mapping?.projects === 'number' ? mapping.projects : 0,
    requestedById: text(record(row.requested_by)?.id) ?? '',
    requestedByName: text(record(row.requested_by)?.name) ?? '',
    approvedByName: text(record(row.approved_by)?.name) ?? '',
    decisionReason: text(row.decision_reason) ?? null,
    summary,
    failedStep: text(failed?.step) ?? null,
    failedCode: text(failed?.code) ?? null,
    steps: list(row.steps).flatMap((entry) => {
      const step = record(entry);
      return text(step?.key) !== undefined && text(step?.done_at) !== undefined ? [{ key: text(step?.key) as string, doneAt: text(step?.done_at) as string }] : [];
    }),
    version: row.version,
    mayDecide: record(row.actions)?.decide === true,
  };
}

/** The kind of a step of the saga from its key (`reorg:{id}:{step}:{item}` as the server records it, or `{step}:{item}`), for the timeline. */
export function stepKind(key: string): 'create-successor' | 'activate-successor' | 'succession' | 'membership' | 'grant' | 'project' | 'retire' | 'other' {
  const parts = key.split(':');
  const name = parts[0] === 'reorg' ? parts[2] : parts[0];
  switch (name) {
    case 'create-successor':
    case 'activate-successor':
    case 'succession':
    case 'membership':
    case 'grant':
    case 'project':
    case 'retire':
      return name;
    default:
      return 'other';
  }
}

/** How many steps of each kind were done, in the order the saga does them, for the timeline. */
export function stepCounts(steps: readonly StepView[]): Array<{ kind: ReturnType<typeof stepKind>; count: number }> {
  const order: Array<ReturnType<typeof stepKind>> = ['create-successor', 'activate-successor', 'succession', 'membership', 'grant', 'project', 'retire'];
  return order.flatMap((kind) => {
    const count = steps.filter((step) => stepKind(step.key) === kind).length;
    return count > 0 ? [{ kind, count }] : [];
  });
}

/** What the signed-in person can decide on a proposal: the proposer can only withdraw it, a saga that failed can only be approved again, a proposal that was sent back can only be withdrawn. */
export function decisionsFor(view: Pick<ReorganizationView, 'status' | 'requestedById'>, membershipId: string | undefined): Array<'approve' | 'return' | 'reject'> {
  if (view.status === 'Failed') return ['approve'];
  if (view.status === 'Draft' || view.requestedById === membershipId) return ['reject'];
  return ['approve', 'return', 'reject'];
}

/** How often the screen reads again while a saga is being carried out by the job (ms): the progress and the retry decision are what the person is waiting for. */
export const WORKING_REFRESH_MS = 5000;

/** Whether a proposal is being worked on by the job (approved, and not yet applied or stopped), so that the screen goes on reading. */
export const isWorking = (status: Status | undefined): boolean => status === 'Approved' || status === 'Applying';

// ---- the wizard -------------------------------------------------------------------------------------------------------------------

export interface Form {
  kind: Kind;
  predecessorIds: string[];
  /** Existing units that take over (a split names two or more; the others one). */
  successorIds: string[];
  /** A new unit instead of an existing one (only when it is the sole successor). */
  newUnit: { code: string; name: string; parentId: string; unitType: string } | undefined;
  defaultSuccessorId: string;
  effectiveFrom: string;
  legalBasis: string;
}

export const emptyForm = (today: string): Form => ({ kind: 'MERGE', predecessorIds: [], successorIds: [], newUnit: undefined, defaultSuccessorId: '', effectiveFrom: today, legalBasis: '' });

export type FormProblem = 'predecessorsRequired' | 'mergeNeedsTwo' | 'onePredecessor' | 'successorRequired' | 'oneSuccessor' | 'splitNeedsTwo' | 'successorIsPredecessor' | 'newUnitIncomplete' | 'dateInvalid' | 'basisShort' | 'defaultRequired';

/** What can be told without the server; the server judges the units themselves and the members and projects they hold. */
export function formProblems(form: Form): FormProblem[] {
  const problems: FormProblem[] = [];
  const predecessors = form.predecessorIds.length;
  if (predecessors === 0) problems.push('predecessorsRequired');
  else if (form.kind === 'MERGE' && predecessors < 2) problems.push('mergeNeedsTwo');
  else if ((form.kind === 'SPLIT' || form.kind === 'RENAME') && predecessors !== 1) problems.push('onePredecessor');
  const successors = form.successorIds.length + (form.newUnit === undefined ? 0 : 1);
  if (successors === 0) problems.push('successorRequired');
  else if (form.kind === 'SPLIT' ? successors < 2 : successors > 1) problems.push(form.kind === 'SPLIT' ? 'splitNeedsTwo' : 'oneSuccessor');
  if (form.successorIds.some((id) => form.predecessorIds.includes(id))) problems.push('successorIsPredecessor');
  if (form.newUnit !== undefined && (form.newUnit.code.trim() === '' || form.newUnit.name.trim() === '' || form.newUnit.parentId === '')) problems.push('newUnitIncomplete');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom) || Number.isNaN(Date.parse(form.effectiveFrom))) problems.push('dateInvalid');
  if (form.legalBasis.trim().length < 5) problems.push('basisShort');
  if (form.kind === 'SPLIT' && !form.successorIds.includes(form.defaultSuccessorId)) problems.push('defaultRequired');
  return problems;
}

/** The body of `proposeUnitReorganization` for a form that passed `formProblems`. */
export function toBody(form: Form): Record<string, unknown> {
  const successors: Array<Record<string, unknown>> = form.successorIds.map((id) => ({ existing_unit_id: id }));
  if (form.newUnit !== undefined) successors.push({ new_unit: { code: form.newUnit.code.trim(), name: form.newUnit.name.trim(), parent_id: form.newUnit.parentId, unit_type: form.newUnit.unitType, valid_from: form.effectiveFrom } });
  return {
    kind: form.kind,
    effective_from: form.effectiveFrom,
    legal_basis_ref: form.legalBasis.trim(),
    predecessor_unit_ids: form.predecessorIds,
    successors,
    // The default successor is a successor of a split that is still chosen: one left over from another kind or a successor taken off is not sent.
    mapping: form.kind === 'SPLIT' && form.successorIds.includes(form.defaultSuccessorId) ? { default_successor_unit_id: form.defaultSuccessorId } : {},
  };
}

/** The step of the wizard a problem belongs to, so that going on is refused where it can be mended. */
export function stepOf(problem: FormProblem): WizardStep {
  return problem === 'defaultRequired' ? 'map' : 'choose';
}

export function problemsOfStep(form: Form, step: WizardStep): FormProblem[] {
  return formProblems(form).filter((problem) => stepOf(problem) === step);
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------------

export type Problem = 'mappingIncomplete' | 'invalid' | 'unitInvalid' | 'busy' | 'selfApproval' | 'stateInvalid' | 'versionConflict' | 'notFound' | 'denied' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'REORG_MAPPING_INCOMPLETE':
      return 'mappingIncomplete';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'invalid';
    case 'UNIT_VALIDITY_INVALID':
      return 'unitInvalid';
    case 'REORG_STATE_INVALID':
      return error.detail === 'predecessor_unit_ids' ? 'busy' : 'stateInvalid';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}

/** The members and projects the server found without a successor, from a refused proposal. */
export function readMissing(error: unknown): { members: string[]; projects: string[] } {
  if (!(error instanceof ApiError) || error.code !== 'REORG_MAPPING_INCOMPLETE') return { members: [], projects: [] };
  const extensions = record(error.extensions);
  const strings = (value: unknown): string[] => list(value).filter((entry): entry is string => typeof entry === 'string');
  return { members: strings(extensions?.missing_membership_ids), projects: strings(extensions?.missing_project_ids) };
}
