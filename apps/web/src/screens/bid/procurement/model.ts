import { ApiError } from '@machvon/api-client';

/** The permissions of BID-17 and BID-19 (x-permission of the operations in openapi.json). */
export const READ_PERMISSION = 'bid.read';
export const MANAGE_PERMISSION = 'bid.plan.manage';
export const IMPORT_PERMISSION = 'bid.import';

/** The milestones of the choice of a contractor, in the order they happen (BID 3 F8). */
export const MILESTONE_KINDS = ['INVITATION_PUBLISHED', 'CLARIFICATION_DEADLINE', 'BID_CLOSING', 'BID_OPENING', 'EVALUATION_DONE', 'RESULT_APPROVED', 'RESULT_PUBLISHED', 'CONTRACT_SIGNED'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
export const MILESTONE_SOURCES = ['MANUAL', 'IMPORT'] as const;
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number];
export const DIFF_STATUSES = ['IN_SYNC', 'DIFFERENT', 'MISSING_EXTERNAL'] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

/** A package takes milestones once its plan is approved: the others have no tender to follow. */
export const PACKAGE_STATUSES_WITHOUT_MILESTONES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED'];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

/** The Vietnam calendar day (UTC+7, no daylight saving) of a moment; an empty text for what is not a moment. */
export function vietnamDay(moment: string | null): string {
  if (moment === null) return '';
  const at = Date.parse(moment);
  return Number.isNaN(at) ? '' : new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** A moment as a Vietnam wall-clock `YYYY-MM-DDTHH:mm`, the value of a `datetime-local` control; empty for none. */
export function localInput(moment: string | null): string {
  if (moment === null) return '';
  const at = Date.parse(moment);
  return Number.isNaN(at) ? '' : new Date(at + 7 * 3_600_000).toISOString().slice(0, 16);
}

/** The ISO moment of a `datetime-local` value read as Vietnam time; undefined when it is empty or not a real time. */
export function momentOfInput(value: string): string | undefined {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return undefined;
  const at = Date.parse(`${text}:00+07:00`);
  if (Number.isNaN(at)) return undefined;
  const iso = new Date(at).toISOString();
  // A day that does not exist (the 30th of February) is moved by the parser to another day: only a time that reads back as it was typed is a time.
  return localInput(iso) === text ? iso : undefined;
}

export interface TrackedPackage {
  id: string;
  code: string;
  title: string | null;
  status: string;
  version: number;
  project: { id: string; code: string; name: string };
}

export function toTrackedPackage(raw: unknown): TrackedPackage | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const project = isRecord(row?.project) ? row.project : undefined;
  const id = text(row?.id);
  const code = text(row?.code);
  const status = text(row?.status);
  const version = whole(row?.version);
  const projectId = text(project?.id);
  if (row === undefined || id === undefined || code === undefined || status === undefined || version === undefined || projectId === undefined) return undefined;
  return { id, code, title: nullableText(row.title), status, version, project: { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' } };
}

export interface MilestoneLine {
  id: string;
  packageId: string;
  kind: MilestoneKind;
  plannedAt: string | null;
  actualAt: string | null;
  source: MilestoneSource;
}

export function toMilestone(raw: unknown): MilestoneLine | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const id = text(row?.id);
  const packageId = text(row?.package_id);
  const kind = oneOf(MILESTONE_KINDS, row?.milestone_kind);
  const source = oneOf(MILESTONE_SOURCES, row?.source);
  if (row === undefined || id === undefined || packageId === undefined || kind === undefined || source === undefined) return undefined;
  return { id, packageId, kind, plannedAt: nullableText(row.planned_at), actualAt: nullableText(row.actual_at), source };
}

/** The milestones of one package in the order of the kinds. */
export function milestonesOf(packageId: string, lines: readonly MilestoneLine[]): MilestoneLine[] {
  return lines.filter((line) => line.packageId === packageId).sort((a, b) => MILESTONE_KINDS.indexOf(a.kind) - MILESTONE_KINDS.indexOf(b.kind));
}

/** The packages the tracker follows: those of a plan in force, of the project chosen, by code. */
export function trackedPackages(packages: readonly TrackedPackage[], projectId: string): TrackedPackage[] {
  return packages
    .filter((pack) => !PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status) && (projectId === '' || pack.project.id === projectId))
    .sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}

/** The projects of the packages that can be followed, by code, for the choice. */
export function projectsOf(packages: readonly TrackedPackage[]): Array<{ id: string; code: string; name: string }> {
  const seen = new Map<string, { id: string; code: string; name: string }>();
  for (const pack of packages) if (!PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status)) seen.set(pack.project.id, pack.project);
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export const canManage = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(MANAGE_PERMISSION);
export const canImport = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(IMPORT_PERMISSION);

// ---- the form of a milestone -------------------------------------------------------------------------------------------------------------

export interface MilestoneForm {
  kind: MilestoneKind | '';
  plannedAt: string;
  actualAt: string;
}

export const EMPTY_MILESTONE_FORM: MilestoneForm = { kind: '', plannedAt: '', actualAt: '' };

export const formOf = (line: MilestoneLine): MilestoneForm => ({ kind: line.kind, plannedAt: localInput(line.plannedAt), actualAt: localInput(line.actualAt) });

export type FieldProblem = 'required' | 'date' | 'future' | 'noDate';

/** What is wrong with a milestone before it is sent: a kind, at least one date, real dates, and an actual date that has come. `now` is the moment of the check. */
export function validateMilestone(form: MilestoneForm, now: Date): Partial<Record<keyof MilestoneForm, FieldProblem>> {
  const problems: Partial<Record<keyof MilestoneForm, FieldProblem>> = {};
  if (form.kind === '') problems.kind = 'required';
  const planned = form.plannedAt.trim() === '' ? undefined : momentOfInput(form.plannedAt);
  const actual = form.actualAt.trim() === '' ? undefined : momentOfInput(form.actualAt);
  if (form.plannedAt.trim() !== '' && planned === undefined) problems.plannedAt = 'date';
  if (form.actualAt.trim() !== '' && actual === undefined) problems.actualAt = 'date';
  if (actual !== undefined && Date.parse(actual) > now.getTime()) problems.actualAt = 'future';
  if (form.plannedAt.trim() === '' && form.actualAt.trim() === '') problems.plannedAt = 'noDate';
  return problems;
}

export interface MilestoneBody {
  milestone_kind: MilestoneKind;
  planned_at?: string;
  actual_at?: string;
}

/** The body of the record: a date left empty is left out, so the server keeps the date it holds. */
export function milestoneBody(form: MilestoneForm): MilestoneBody {
  const planned = momentOfInput(form.plannedAt);
  const actual = momentOfInput(form.actualAt);
  return { milestone_kind: form.kind as MilestoneKind, ...(planned === undefined ? {} : { planned_at: planned }), ...(actual === undefined ? {} : { actual_at: actual }) };
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------

export type Problem = 'orderInvalid' | 'versionConflict' | 'packageState' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  problem: Problem;
  /** For a broken order: the two milestones that disagree, earlier first. */
  earlier: MilestoneKind | undefined;
  later: MilestoneKind | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { problem: 'general', earlier: undefined, later: undefined };
  const earlier = oneOf(MILESTONE_KINDS, error.extensions.earlier_kind);
  const later = oneOf(MILESTONE_KINDS, error.extensions.later_kind);
  switch (error.code) {
    case 'MILESTONE_ORDER_INVALID':
      return { problem: 'orderInvalid', earlier, later };
    case 'VERSION_CONFLICT':
      return { problem: 'versionConflict', earlier, later };
    case 'PACKAGE_STATE_INVALID':
      return { problem: 'packageState', earlier, later };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { problem: 'validation', earlier, later };
    case 'RESOURCE_NOT_FOUND':
      return { problem: 'notFound', earlier, later };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return { problem: 'denied', earlier, later };
    case 'SESSION_EXPIRED':
      return { problem: 'session', earlier, later };
    default:
      return { problem: 'general', earlier, later };
  }
}

// ---- the links to the national bidding network -------------------------------------------------------------------------------------------

export interface LinkDifference {
  kind: MilestoneKind;
  register: string;
  file: string;
}

export interface LinkLine {
  id: string;
  packageId: string;
  packageCode: string;
  packageTitle: string | null;
  projectCode: string;
  externalCode: string;
  diffStatus: DiffStatus;
  /** The milestones whose date the register and the file disagree on. */
  milestoneDifferences: LinkDifference[];
  /** The code the register holds and the one the file gives, when they disagree. */
  codeDifference: { register: string; file: string } | null;
  ownerName: string | null;
  fileSha256: string | null;
  adapterStatus: string | null;
  appliedAt: string | null;
}

export function toLink(raw: unknown): LinkLine | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const id = text(row?.id);
  const packageId = text(row?.package_id);
  const packageCode = text(row?.package_code);
  const externalCode = text(row?.external_code);
  const diffStatus = oneOf(DIFF_STATUSES, row?.diff_status);
  if (row === undefined || id === undefined || packageId === undefined || packageCode === undefined || externalCode === undefined || diffStatus === undefined) return undefined;
  const diff = isRecord(row.diff) ? row.diff : {};
  const milestones = isRecord(diff.milestones) ? diff.milestones : {};
  const code = isRecord(diff.external_code) ? diff.external_code : undefined;
  const owner = isRecord(row.diff_owner) ? row.diff_owner : undefined;
  const batch = isRecord(row.batch) ? row.batch : undefined;
  return {
    id,
    packageId,
    packageCode,
    packageTitle: nullableText(row.package_title),
    projectCode: text(isRecord(row.project) ? row.project.code : undefined) ?? '',
    externalCode,
    diffStatus,
    milestoneDifferences: MILESTONE_KINDS.flatMap((kind) => {
      const entry = isRecord(milestones[kind]) ? (milestones[kind] as Raw) : undefined;
      const register = text(entry?.register);
      const file = text(entry?.file);
      return register === undefined || file === undefined ? [] : [{ kind, register, file }];
    }),
    codeDifference: code === undefined || text(code.register) === undefined || text(code.file) === undefined ? null : { register: text(code.register) as string, file: text(code.file) as string },
    ownerName: text(owner?.display_name) ?? null,
    fileSha256: text(batch?.file_sha256) ?? null,
    adapterStatus: text(batch?.adapter_status) ?? null,
    appliedAt: text(batch?.applied_at) ?? null,
  };
}

export type StatusFilter = DiffStatus | '';

export function filterLinks(links: readonly LinkLine[], status: StatusFilter): LinkLine[] {
  return links.filter((link) => status === '' || link.diffStatus === status);
}

/** The first characters of a hash, enough to tell two files apart on a screen. */
export const shortHash = (hash: string | null): string => (hash === null ? '' : hash.slice(0, 12));
