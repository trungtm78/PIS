import type { components } from '@machvon/contracts';
import { shaped } from '../shared/format';

/** EBS-01 and EBS-02: the file import and the reconciliation of Oracle EBS by project code. The layout of the file is a working assumption, so everything built on it is PENDING-EXTERNAL. */
export type Connection = components['schemas']['EbsConnection'];
export type Upload = components['schemas']['EbsFileUpload'];
export type Preview = components['schemas']['EbsImportPreview'];
export type Applied = components['schemas']['EbsImportResult'];
export type Difference = components['schemas']['EbsDifference'];
export type DifferencePage = components['schemas']['EbsDifferencePage'];
export type Reconciled = components['schemas']['EbsReconcileResult'];
export type Run = Connection['last_runs'][number];
export type PreviewRow = Preview['rows'][number];
export type ResolutionKind = NonNullable<Difference['resolution']>['kind'];
export type DifferenceState = Difference['state'];

export const CONNECTOR_CODE = 'ebs.ledger';
export const PAGE_SIZE = 25;
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RESOLUTION_KINDS: readonly ResolutionKind[] = ['OURS_WRONG', 'EBS_WRONG', 'TIMING', 'WAIVED'];
export const MIN_REASON = 10;
/** The longest wait the rule allows before a timing difference or a waiver is looked at again, in days. */
export const MAX_REVIEW_DAYS = 365;
/** The rows of a dry run the screen lists before it says the rest is cut. */
export const PREVIEW_ROWS_SHOWN = 100;

// ---- reading the answer ---------------------------------------------------------------------------------------------------------------------------------------------

export const toConnection = (raw: unknown): Connection =>
  shaped<Connection>(raw, 'EBS connection', ['supported_layouts', 'pending_external', 'columns', 'positions', 'last_runs', 'history'], ['api_adapter', 'health', 'record_counts', 'item_counts', 'due_rule', 'actions']);
export const toUpload = (raw: unknown): Upload => shaped<Upload>(raw, 'EBS upload', ['columns', 'missing_columns'], []);
export const toPreview = (raw: unknown): Preview => shaped<Preview>(raw, 'EBS preview', ['rows'], ['counts']);
export const toApplied = (raw: unknown): Applied => shaped<Applied>(raw, 'EBS import result', ['errors'], ['counts']);
export const toDifferencePage = (raw: unknown): DifferencePage => shaped<DifferencePage>(raw, 'EBS difference page', ['items'], ['counts']);
export const toReconciled = (raw: unknown): Reconciled => shaped<Reconciled>(raw, 'EBS reconciliation', ['items'], []);

// ---- the import flow --------------------------------------------------------------------------------------------------------------------------------------------------

export type Step = 'PICK' | 'UPLOADED' | 'PREVIEWED' | 'APPLIED';

/** The step the flow is at: nothing picked, a file stored, a dry run read, the file applied. */
export function stepOf(upload: Upload | undefined, preview: Preview | undefined, applied: Applied | undefined): Step {
  if (applied !== undefined) return 'APPLIED';
  if (preview !== undefined) return 'PREVIEWED';
  return upload === undefined ? 'PICK' : 'UPLOADED';
}

/** Whether the dry run may be followed by the apply: the connection is on, something is valid, the file was not applied before. */
export function applyBlockReason(connection: Connection, preview: Preview): 'DISABLED' | 'NOTHING_VALID' | 'ALREADY_APPLIED' | null {
  if (!connection.enabled) return 'DISABLED';
  if (preview.already_applied) return 'ALREADY_APPLIED';
  return preview.counts.valid === 0 ? 'NOTHING_VALID' : null;
}

/** The rows of a dry run that need a person first: the refused ones, then the rest in file order. */
export function previewOrder(rows: readonly PreviewRow[]): PreviewRow[] {
  const refused = (row: PreviewRow): number => (row.status === 'VALID' ? 1 : 0);
  return [...rows].sort((a, b) => refused(a) - refused(b) || a.line - b.line);
}

// ---- the differences --------------------------------------------------------------------------------------------------------------------------------------------------

export interface Filters {
  state: DifferenceState | undefined;
  projectCode: string;
  period: string;
  overdue: boolean;
}

export const NO_FILTERS: Filters = { state: 'OPEN', projectCode: '', period: '', overdue: false };

export const isFiltered = (filters: Filters): boolean => filters.state !== NO_FILTERS.state || filters.projectCode.trim() !== '' || filters.period.trim() !== '' || filters.overdue;

/** The query of the list: only what the person asked for (a period that is not YYYY-MM is left out until it is). */
export function queryOf(filters: Filters, cursor: string | undefined): Record<string, string | number> {
  return {
    ...(filters.state === undefined ? {} : { state: filters.state }),
    ...(filters.projectCode.trim() === '' ? {} : { project_code: filters.projectCode.trim() }),
    ...(PERIOD_PATTERN.test(filters.period.trim()) ? { period: filters.period.trim() } : {}),
    ...(filters.overdue ? { overdue: 'true' } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    limit: PAGE_SIZE,
  };
}

export type FieldProblem = 'REQUIRED' | 'FORMAT';

export interface ResolveForm {
  kind: ResolutionKind;
  reason: string;
  evidenceRef: string;
  reviewOn: string;
}

export const EMPTY_RESOLVE_FORM: ResolveForm = { kind: 'OURS_WRONG', reason: '', evidenceRef: '', reviewOn: '' };
export type ResolveField = 'reason' | 'evidenceRef' | 'reviewOn';

export const needsEvidence = (kind: ResolutionKind): boolean => kind === 'OURS_WRONG' || kind === 'EBS_WRONG';
export const needsReview = (kind: ResolutionKind): boolean => kind === 'TIMING' || kind === 'WAIVED';

const DAY = 86_400_000;

/** The fields of an explanation that the contract would refuse: the reason (ten characters), the evidence of a correction, and for a timing difference or a waiver a day from tomorrow to a year ahead. */
export function resolveProblems(form: ResolveForm, today: string): Partial<Record<ResolveField, FieldProblem>> {
  const found: Partial<Record<ResolveField, FieldProblem>> = {};
  if (form.reason.trim() === '') found.reason = 'REQUIRED';
  else if (form.reason.trim().length < MIN_REASON) found.reason = 'FORMAT';
  if (needsEvidence(form.kind) && form.evidenceRef.trim() === '') found.evidenceRef = 'REQUIRED';
  if (needsReview(form.kind)) {
    const day = form.reviewOn.trim();
    if (day === '') found.reviewOn = 'REQUIRED';
    else {
      const days = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(days) || days < 1 || days > MAX_REVIEW_DAYS) found.reviewOn = 'FORMAT';
    }
  }
  return found;
}

/** The body of the explanation: the evidence only for a correction, the day only for a timing difference or a waiver. */
export function resolveBody(form: ResolveForm) {
  return {
    kind: form.kind,
    reason: form.reason.trim(),
    ...(needsEvidence(form.kind) ? { evidence_ref: form.evidenceRef.trim() } : {}),
    ...(needsReview(form.kind) ? { review_on: form.reviewOn.trim() } : {}),
  };
}

export type ResolveBody = ReturnType<typeof resolveBody>;

export interface ReconcileForm {
  period: string;
  ownerId: string;
}

export const EMPTY_RECONCILE_FORM: ReconcileForm = { period: '', ownerId: '' };

export function reconcileProblems(form: ReconcileForm): Partial<Record<'period' | 'ownerId', FieldProblem>> {
  const found: Partial<Record<'period' | 'ownerId', FieldProblem>> = {};
  if (form.period.trim() !== '' && !PERIOD_PATTERN.test(form.period.trim())) found.period = 'FORMAT';
  if (form.ownerId.trim() !== '' && !UUID_PATTERN.test(form.ownerId.trim())) found.ownerId = 'FORMAT';
  return found;
}

export function reconcileBody(form: ReconcileForm) {
  return { ...(form.period.trim() === '' ? {} : { period: form.period.trim() }), ...(form.ownerId.trim() === '' ? {} : { owner_id: form.ownerId.trim().toLowerCase() }) };
}

export type ReconcileBody = ReturnType<typeof reconcileBody>;

/** The Vietnam day of an instant, as `YYYY-MM-DD`: the day a review is counted from. */
export function vietnamDay(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** The signed gap as a plain sign for the eye: a positive gap means EBS says more than we hold. */
export const gapSign = (delta: string | null): 'PLUS' | 'MINUS' | 'NONE' => (delta === null || /^-?0(\.0+)?$/.test(delta) ? 'NONE' : delta.startsWith('-') ? 'MINUS' : 'PLUS');
