import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of these screens; the server decides again on every request (scope included). */
export const READ_PERMISSION = 'project.read';
export const CREATE_PERMISSION = 'project.create';
export const UPDATE_PERMISSION = 'project.update';

export const LIST_PATH = '/prj/prj-01';
export const CREATE_PATH = '/prj/prj-02';
export const WORKSPACE_PATH = '/prj/prj-03';

export const PROJECT_STATUSES = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * The project a screen of one project shows when it is opened without one: the first of the register in the stage the screen is for (the appraisal screens: a project in appraisal), else the first one that is
 * still alive. Undefined when the register is empty or every project has ended.
 */
export function defaultProject(lines: readonly ProjectLine[], stage?: ProjectStatus): ProjectLine | undefined {
  const alive = lines.filter((line) => !FROZEN_STATUSES.includes(line.status));
  return (stage === undefined ? undefined : alive.find((line) => line.status === stage)) ?? alive[0];
}

/** The stages in which a project no longer changes: it is closed, rejected or cancelled. */
export const FROZEN_STATUSES: readonly ProjectStatus[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 500;
export const CODE_MAX_LENGTH = 50;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;
const AMOUNT = /^(0|[1-9]\d{0,23})$/;
const YEAR = /^\d{4}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;

/** One line of the register (PRJ-01). */
export interface ProjectLine {
  id: string;
  code: string;
  name: string;
  ownerUnitId: string;
  ownerUnitName: string;
  investorUnitId: string | null;
  investorUnitName: string | null;
  projectGroup: string | null;
  status: ProjectStatus;
  nationalProjectCode: string | null;
  leaderName: string | null;
  version: number;
}

/** An entry of master data by the version a project refers to. */
export interface MasterRef {
  versionId: string;
  businessKey: string;
  label: string;
}

/** The group the rule data suggests, with the rule version it came from; a rule that waits for its confirmation says so. */
export interface GroupSuggestion {
  groupKey: string;
  sectorKey: string | null;
  asOf: string;
  ruleRevision: number;
  legalBasis: string;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

/** The workspace of one project (PRJ-03). */
export interface ProjectView extends ProjectLine {
  decisionAuthorityUnitName: string | null;
  area: MasterRef;
  sector: MasterRef | null;
  projectType: MasterRef | null;
  program: MasterRef | null;
  classification: Classification;
  totalInvestmentVnd: string;
  startYear: number | null;
  endYear: number | null;
  appraisalScore: string | null;
  statusChangedAt: string;
  createdAt: string;
  proposedOn: string;
  suggestion: GroupSuggestion | null;
}

export function toProjectLine(raw: unknown): ProjectLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const code = text(row.code);
  const name = text(row.name);
  const status = text(row.status);
  const version = whole(row.version);
  if (id === undefined || code === undefined || name === undefined || status === undefined || version === undefined || !(PROJECT_STATUSES as readonly string[]).includes(status)) return undefined;
  const leader = asRecord(row.leader_in_charge);
  return {
    id,
    code,
    name,
    ownerUnitId: text(row.owner_unit_id) ?? '',
    ownerUnitName: text(row.owner_unit_name) ?? '',
    investorUnitId: nullableText(row.investor_unit_id),
    investorUnitName: nullableText(row.investor_unit_name),
    projectGroup: nullableText(row.project_group),
    status: status as ProjectStatus,
    nationalProjectCode: nullableText(row.national_project_code),
    leaderName: leader === undefined ? null : nullableText(leader.display_name),
    version,
  };
}

function masterRefOf(value: unknown): MasterRef | null {
  const row = asRecord(value);
  const versionId = text(row?.version_id);
  const businessKey = text(row?.business_key);
  if (row === undefined || versionId === undefined || businessKey === undefined) return null;
  return { versionId, businessKey, label: text(row.label) ?? businessKey };
}

function suggestionOf(value: unknown): GroupSuggestion | null {
  const row = asRecord(value);
  const groupKey = text(row?.group_key);
  if (row === undefined || groupKey === undefined) return null;
  return {
    groupKey,
    sectorKey: nullableText(row.sector_key),
    asOf: text(row.as_of) ?? '',
    ruleRevision: whole(row.rule_revision) ?? 0,
    legalBasis: text(row.legal_basis) ?? '',
    awaitingConfirmation: row.awaiting_confirmation === true,
    cxn: nullableText(row.cxn),
  };
}

export function toProjectView(raw: unknown): ProjectView | undefined {
  const line = toProjectLine(raw);
  const row = asRecord(raw);
  const area = masterRefOf(row?.area);
  const total = text(row?.total_investment_vnd);
  const classification = text(row?.classification);
  if (line === undefined || row === undefined || area === null || total === undefined || classification === undefined || !(CLASSIFICATIONS as readonly string[]).includes(classification)) return undefined;
  return {
    ...line,
    decisionAuthorityUnitName: nullableText(row.decision_authority_unit_name),
    area,
    sector: masterRefOf(row.sector),
    projectType: masterRefOf(row.project_type),
    program: masterRefOf(row.program),
    classification: classification as Classification,
    totalInvestmentVnd: total,
    startYear: nullableWhole(row.start_year),
    endYear: nullableWhole(row.end_year),
    appraisalScore: nullableText(row.appraisal_score),
    statusChangedAt: text(row.status_changed_at) ?? '',
    createdAt: text(row.created_at) ?? '',
    proposedOn: text(row.proposed_on) ?? '',
    suggestion: suggestionOf(row.group_suggestion),
  };
}

/** An organisation unit as the form offers it. */
export interface UnitOption {
  id: string;
  code: string;
  name: string;
}

export function toUnitOption(raw: unknown): UnitOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  return row === undefined || id === undefined ? [] : [{ id, code: text(row.code) ?? '', name: text(row.name) ?? '' }];
}

/** An entry of master data in force that the form offers, by the id of its version (what a project stores). */
export interface MasterOption {
  versionId: string;
  masterType: string;
  businessKey: string;
  label: string;
}

export function toMasterOption(raw: unknown): MasterOption[] {
  const row = asRecord(raw);
  const versionId = text(row?.version_id);
  const masterType = text(row?.master_type);
  const businessKey = text(row?.business_key);
  if (row === undefined || versionId === undefined || masterType === undefined || businessKey === undefined || row.status !== 'EFFECTIVE') return [];
  return [{ versionId, masterType, businessKey, label: text(row.label) ?? businessKey }];
}

/** The master types a field of the form takes its entries from. */
export const AREA_TYPES = ['AREA', 'ADMIN_UNIT'] as const;
export const SECTOR_TYPES = ['SECTOR'] as const;
export const PROJECT_TYPE_TYPES = ['PROJECT_TYPE'] as const;
export const PROGRAM_TYPES = ['PROGRAM'] as const;

/** Whether the project is in a stage from which only a revision decided by the authority changes the fields of its dossier. */
export function isDossierLocked(status: ProjectStatus): boolean {
  return status !== 'CONCEPT';
}

export const isFrozen = (status: ProjectStatus): boolean => FROZEN_STATUSES.includes(status);

/** An amount in VND from its decimal string: the digits are grouped by the language of the screen and the string is never turned into a float. */
export function amountText(amount: string, locale: string): string {
  const [whole = ''] = amount.split('.');
  return /^\d+$/.test(whole) ? new Intl.NumberFormat(locale).format(BigInt(whole)) : amount;
}

// ---- the form ---------------------------------------------------------------------------------------------------------

export interface ProjectForm {
  code: string;
  name: string;
  ownerUnitId: string;
  investorUnitId: string;
  decisionAuthorityUnitId: string;
  areaVersionId: string;
  sectorVersionId: string;
  projectTypeVersionId: string;
  programVersionId: string;
  totalInvestment: string;
  startYear: string;
  endYear: string;
  classification: Classification;
}

export type ProjectField = keyof ProjectForm;

export const EMPTY_FORM: ProjectForm = {
  code: '',
  name: '',
  ownerUnitId: '',
  investorUnitId: '',
  decisionAuthorityUnitId: '',
  areaVersionId: '',
  sectorVersionId: '',
  projectTypeVersionId: '',
  programVersionId: '',
  totalInvestment: '',
  startYear: '',
  endYear: '',
  classification: 'INTERNAL',
};

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidAmount' | 'invalidYear' | 'order';

function yearProblem(value: string): FieldProblem | undefined {
  if (value.trim() === '') return undefined;
  const year = Number(value.trim());
  return YEAR.test(value.trim()) && year >= MIN_YEAR && year <= MAX_YEAR ? undefined : 'invalidYear';
}

/** What is wrong with the fields of the form, before anything is sent; the server judges the same rules again. */
export function validateForm(form: ProjectForm, mode: 'create' | 'profile'): Partial<Record<ProjectField, FieldProblem>> {
  const problems: Partial<Record<ProjectField, FieldProblem>> = {};
  const code = form.code.trim();
  if (mode === 'create') {
    if (code === '') problems.code = 'required';
    else if (code.length > CODE_MAX_LENGTH) problems.code = 'tooLong';
    if (form.ownerUnitId === '') problems.ownerUnitId = 'required';
    if (form.areaVersionId === '') problems.areaVersionId = 'required';
    if (form.totalInvestment.trim() === '') problems.totalInvestment = 'required';
    else if (!AMOUNT.test(form.totalInvestment.trim())) problems.totalInvestment = 'invalidAmount';
  }
  const name = form.name.trim();
  if (name === '') problems.name = 'required';
  else if (name.length < NAME_MIN_LENGTH) problems.name = 'tooShort';
  else if (name.length > NAME_MAX_LENGTH) problems.name = 'tooLong';
  const startProblem = yearProblem(form.startYear);
  const endProblem = yearProblem(form.endYear);
  if (startProblem !== undefined) problems.startYear = startProblem;
  if (endProblem !== undefined) problems.endYear = endProblem;
  if (startProblem === undefined && endProblem === undefined && form.startYear.trim() !== '' && form.endYear.trim() !== '' && Number(form.startYear) > Number(form.endYear)) problems.endYear = 'order';
  return problems;
}

const optional = <T extends string>(value: string, key: T): Partial<Record<T, string>> => (value === '' ? {} : ({ [key]: value } as Record<T, string>));

/** The body of `createProject` for a form that passed `validateForm`: what was left empty is not sent. */
export function createBody(form: ProjectForm) {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    owner_unit_id: form.ownerUnitId,
    area_master_version_id: form.areaVersionId,
    total_investment_vnd: form.totalInvestment.trim(),
    classification: form.classification,
    ...optional(form.investorUnitId, 'investor_unit_id'),
    ...optional(form.decisionAuthorityUnitId, 'decision_authority_unit_id'),
    ...optional(form.sectorVersionId, 'sector_master_version_id'),
    ...optional(form.projectTypeVersionId, 'project_type_master_version_id'),
    ...optional(form.programVersionId, 'program_master_version_id'),
    ...(form.startYear.trim() === '' ? {} : { start_year: Number(form.startYear) }),
    ...(form.endYear.trim() === '' ? {} : { end_year: Number(form.endYear) }),
  };
}

export type CreateBody = ReturnType<typeof createBody>;

/** The form as it stands for a project that is opened to be changed. */
export function formOf(project: ProjectView): ProjectForm {
  return {
    code: project.code,
    name: project.name,
    ownerUnitId: project.ownerUnitId,
    investorUnitId: project.investorUnitId ?? '',
    decisionAuthorityUnitId: '',
    areaVersionId: project.area.versionId,
    sectorVersionId: project.sector?.versionId ?? '',
    projectTypeVersionId: project.projectType?.versionId ?? '',
    programVersionId: project.program?.versionId ?? '',
    totalInvestment: project.totalInvestmentVnd,
    startYear: project.startYear === null ? '' : String(project.startYear),
    endYear: project.endYear === null ? '' : String(project.endYear),
    classification: project.classification,
  };
}

export interface ProfileBody {
  name?: string;
  classification?: Classification;
  investor_unit_id?: string;
  area_master_version_id?: string;
  sector_master_version_id?: string;
  project_type_master_version_id?: string;
  program_master_version_id?: string;
  start_year?: number;
  end_year?: number;
}

/**
 * The body of `updateProjectProfile`: only what differs from the project, and only the fields the allowlist has (the code, the status and
 * the money are not in it). Once the dossier is locked only the name and the classification can go.
 */
export function profileBody(project: ProjectView, form: ProjectForm): ProfileBody {
  const body: ProfileBody = {};
  const name = form.name.trim();
  if (name !== project.name) body.name = name;
  if (form.classification !== project.classification) body.classification = form.classification;
  if (isDossierLocked(project.status)) return body;
  if (form.investorUnitId !== '' && form.investorUnitId !== (project.investorUnitId ?? '')) body.investor_unit_id = form.investorUnitId;
  if (form.areaVersionId !== project.area.versionId) body.area_master_version_id = form.areaVersionId;
  if (form.sectorVersionId !== '' && form.sectorVersionId !== (project.sector?.versionId ?? '')) body.sector_master_version_id = form.sectorVersionId;
  if (form.projectTypeVersionId !== '' && form.projectTypeVersionId !== (project.projectType?.versionId ?? '')) body.project_type_master_version_id = form.projectTypeVersionId;
  if (form.programVersionId !== '' && form.programVersionId !== (project.program?.versionId ?? '')) body.program_master_version_id = form.programVersionId;
  const start = form.startYear.trim() === '' ? null : Number(form.startYear);
  const end = form.endYear.trim() === '' ? null : Number(form.endYear);
  if (start !== null && start !== project.startYear) body.start_year = start;
  if (end !== null && end !== project.endYear) body.end_year = end;
  return body;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason = 'duplicateCode' | 'masterNotEffective' | 'versionConflict' | 'stageLocked' | 'notAllowed' | 'validation' | 'notFound' | 'denied' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PROJECT_CODE_DUPLICATE: 'duplicateCode',
  MASTER_NOT_EFFECTIVE: 'masterNotEffective',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_LOCKED_FIELD: 'stageLocked',
  FIELD_NOT_ALLOWED: 'notAllowed',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** The group a table of the list is sorted by is the one of the server (by code); the filters narrow what was read. */
export interface ListFilter {
  query: string;
  status: ProjectStatus | '';
  missingNationalCode: boolean;
}

export const EMPTY_FILTER: ListFilter = { query: '', status: '', missingNationalCode: false };

export function filterProjects(projects: readonly ProjectLine[], filter: ListFilter): ProjectLine[] {
  const query = filter.query.trim().toLowerCase();
  return projects.filter(
    (project) =>
      (query === '' || project.code.toLowerCase().includes(query) || project.name.toLowerCase().includes(query)) &&
      (filter.status === '' || project.status === filter.status) &&
      (!filter.missingNationalCode || project.nationalProjectCode === null),
  );
}

/** The address of the workspace of a project. */
export function workspaceLink(projectId: string): string {
  return `${WORKSPACE_PATH}?${new URLSearchParams({ id: projectId }).toString()}`;
}

/** `HH:mm dd/MM/yyyy` in Vietnam time: when the numbers of a screen were read (the freshness of its context bar). */
export function readAtLabel(milliseconds: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    new Date(milliseconds),
  );
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('day')}/${part('month')}/${part('year')}`;
}
