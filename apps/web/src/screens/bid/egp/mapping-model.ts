import { ApiError } from '@machvon/api-client';

/** BID-23, "Ánh xạ": the pure part. The answer of the API is read defensively, the filters live in the address, and the rules of a proposal are checked here before the server checks them again. */

export const SUBJECT_TYPES = ['PROJECT', 'PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;
export type MappingStatus = (typeof STATUSES)[number];

export type MatchMethod = 'MANUAL' | 'IMPORT' | 'RULE';

/** How the row says it was made, in the words of the screen: a MANUAL row that carries a confidence is a suggestion a person confirmed. */
export type MethodKind = 'IMPORT' | 'RULE' | 'MANUAL' | 'SUGGESTION';

/** The right to propose and to retire a mapping; approving has its own right, which the server tells per row (`can_decide`). */
export const MAP_PERMISSION = 'bid.egp.map';
export const PAGE_SIZE = 50;
export const MIN_REASON = 10;
export const MAX_CODE = 100;
/** The subjects of a package: two packages of one code are told apart by the code of their project. */
export const PACKAGE_LIKE: readonly SubjectType[] = ['PACKAGE', 'NOTICE', 'RESULT'];
export const isPackageLike = (subject: SubjectType): boolean => PACKAGE_LIKE.includes(subject);

export interface MappingRow {
  id: string;
  subjectType: SubjectType;
  ourCode: string | null;
  projectCode: string | null;
  externalType: string;
  externalCode: string;
  matchMethod: MatchMethod;
  confidence: number | null;
  validFrom: string;
  validUntil: string | null;
  status: MappingStatus;
  proposedBy: string | null;
  proposedByName: string | null;
  proposalReason: string | null;
  importId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  retiredByName: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  version: number;
  createdAt: string | null;
  canDecide: boolean;
  canRetire: boolean;
}

export interface MappingCounts {
  PROPOSED: number;
  ACTIVE: number;
  REJECTED: number;
  RETIRED: number;
}

export interface MappingPage {
  items: MappingRow[];
  nextCursor: string | null;
  counts: MappingCounts;
  asOf: string;
}

export interface Candidate {
  packageId: string;
  code: string;
  name: string;
  budgetVnd: string;
  confidence: number;
}

export interface Suggestion {
  externalCode: string;
  importedName: string;
  importedPriceVnd: string;
  planCode: string;
  importId: string;
  candidates: Candidate[];
}

export interface SuggestionList {
  items: Suggestion[];
  threshold: number;
  formula: string;
  source: string;
  legalStatus: string;
  asOf: string;
}

// ---- reading the answer ---------------------------------------------------------------------------------------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const oneOf = <T extends string>(value: unknown, list: readonly T[]): T | undefined => list.find((item) => item === value);

export function toMapping(raw: unknown): MappingRow[] {
  const row = record(raw);
  const id = text(row.id);
  const subjectType = oneOf(row.subject_type, SUBJECT_TYPES);
  const status = oneOf(row.status, STATUSES);
  const externalCode = text(row.external_code);
  if (id === null || subjectType === undefined || status === undefined || externalCode === null) return [];
  return [
    {
      id,
      subjectType,
      ourCode: text(row.our_code),
      projectCode: text(row.project_code),
      externalType: text(row.external_type) ?? '',
      externalCode,
      matchMethod: oneOf(row.match_method, ['MANUAL', 'IMPORT', 'RULE'] as const) ?? 'MANUAL',
      confidence: typeof row.confidence === 'number' ? row.confidence : null,
      validFrom: text(row.valid_from) ?? '',
      validUntil: text(row.valid_until),
      status,
      proposedBy: text(row.proposed_by),
      proposedByName: text(row.proposed_by_name),
      proposalReason: text(row.proposal_reason),
      importId: text(row.import_id),
      approvedByName: text(row.approved_by_name),
      approvedAt: text(row.approved_at),
      decisionReason: text(row.decision_reason),
      retiredByName: text(row.retired_by_name),
      retiredAt: text(row.retired_at),
      retireReason: text(row.retire_reason),
      version: typeof row.version === 'number' ? row.version : 0,
      createdAt: text(row.created_at),
      canDecide: row.can_decide === true,
      canRetire: row.can_retire === true,
    },
  ];
}

export function toMappingPage(raw: unknown): MappingPage {
  const page = record(raw);
  if (!Array.isArray(page.items)) throw new Error('mapping-page-invalid');
  const counts = record(page.counts);
  return {
    items: page.items.flatMap(toMapping),
    nextCursor: text(page.next_cursor),
    counts: { PROPOSED: count(counts.PROPOSED), ACTIVE: count(counts.ACTIVE), REJECTED: count(counts.REJECTED), RETIRED: count(counts.RETIRED) },
    asOf: text(page.as_of) ?? '',
  };
}

export function toSuggestionList(raw: unknown): SuggestionList {
  const list = record(raw);
  if (!Array.isArray(list.items)) throw new Error('suggestion-list-invalid');
  return {
    items: list.items.flatMap((entry): Suggestion[] => {
      const item = record(entry);
      const externalCode = text(item.external_code);
      if (externalCode === null) return [];
      const candidates = Array.isArray(item.candidates)
        ? item.candidates.flatMap((candidate): Candidate[] => {
            const one = record(candidate);
            const packageId = text(one.package_id);
            const code = text(one.code);
            return packageId === null || code === null || typeof one.confidence !== 'number'
              ? []
              : [{ packageId, code, name: text(one.name) ?? '', budgetVnd: text(one.budget_vnd) ?? '', confidence: one.confidence }];
          })
        : [];
      return [{ externalCode, importedName: text(item.imported_name) ?? '', importedPriceVnd: text(item.imported_price_vnd) ?? '', planCode: text(item.plan_code) ?? '', importId: text(item.import_id) ?? '', candidates }];
    }),
    threshold: typeof list.threshold === 'number' ? list.threshold : 0,
    formula: text(list.formula) ?? '',
    source: text(list.source) ?? '',
    legalStatus: text(list.legal_status) ?? '',
    asOf: text(list.as_of) ?? '',
  };
}

export const methodKind = (row: Pick<MappingRow, 'matchMethod' | 'confidence'>): MethodKind =>
  row.matchMethod === 'IMPORT' ? 'IMPORT' : row.matchMethod === 'RULE' ? 'RULE' : row.confidence !== null ? 'SUGGESTION' : 'MANUAL';

export const totalOf = (counts: MappingCounts): number => counts.PROPOSED + counts.ACTIVE + counts.REJECTED + counts.RETIRED;

// ---- the filters, kept in the address -------------------------------------------------------------------------------------------------------------------------------------------

export interface Filters {
  subject_type?: SubjectType;
  status?: MappingStatus;
  q?: string;
}

export function filtersOf(search: URLSearchParams): Filters {
  const filters: Filters = {};
  const subject = oneOf(search.get('subject_type'), SUBJECT_TYPES);
  if (subject !== undefined) filters.subject_type = subject;
  const status = oneOf(search.get('status'), STATUSES);
  if (status !== undefined) filters.status = status;
  const q = (search.get('q') ?? '').trim();
  if (q !== '') filters.q = q;
  return filters;
}

export function searchOf(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.subject_type !== undefined) params.set('subject_type', filters.subject_type);
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.q !== undefined && filters.q !== '') params.set('q', filters.q);
  return params;
}

export const appliedCount = (filters: Filters): number => Object.keys(filters).length;

/** The query of the list: the filters and the page size; the cursor is added per page. */
export const queryOf = (filters: Filters, cursor?: string): Record<string, string | number> => ({ ...filters, limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });

// ---- days and numbers -----------------------------------------------------------------------------------------------------------------------------------------------------

/** `2026-11-09` as `09/11/2026`; anything else as it came. */
export const dayText = (day: string): string => (/^\d{4}-\d{2}-\d{2}/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day);

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
/** The day (Vietnam time) of an instant, as `dd/mm/yyyy`. */
export const instantDay = (instant: string): string => {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? instant : dayText(new Date(at + VIETNAM_OFFSET_MS).toISOString().slice(0, 10));
};
export const instantTime = (instant: string): string => {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? '' : new Date(at + VIETNAM_OFFSET_MS).toISOString().slice(11, 16);
};

export const likenessText = (value: number, locale: string): string => value.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/** An amount in whole dong (a decimal string) with the thousands marked by the locale. */
export function dongText(amount: string, locale: string): string {
  if (!/^-?\d+$/.test(amount)) return amount;
  try {
    return BigInt(amount).toLocaleString(locale);
  } catch {
    return amount;
  }
}

// ---- the proposal ---------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ProposeForm {
  subjectType: SubjectType;
  ourCode: string;
  projectCode: string;
  externalCode: string;
  validFrom: string;
  validUntil: string;
  /** Set when the form confirms a suggestion of the system: the likeness it was made with. */
  suggestionConfidence?: number | undefined;
}

export const EMPTY_FORM: ProposeForm = { subjectType: 'PACKAGE', ourCode: '', projectCode: '', externalCode: '', validFrom: '', validUntil: '' };

export type ProposeField = 'ourCode' | 'projectCode' | 'externalCode' | 'validFrom' | 'validUntil' | 'confidence' | 'method';
export type FieldProblem = 'required' | 'tooLong' | 'control' | 'day' | 'range' | 'confidence' | 'contractor';
export type FormErrors = Partial<Record<ProposeField, FieldProblem>>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function codeProblem(value: string): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length > MAX_CODE) return 'tooLong';
  if (CONTROL.test(trimmed)) return 'control';
  return undefined;
}

/** The rules of `validateEgpMapping` and of the proposal that can be checked without the data: a code is present, trimmed and within 100 characters; the days are days and the end is after the start; a suggestion has a likeness in (0, 1] and a contractor never has one. */
export function validatePropose(form: ProposeForm): FormErrors {
  const errors: FormErrors = {};
  const ours = codeProblem(form.ourCode);
  if (ours !== undefined) errors.ourCode = ours;
  const external = codeProblem(form.externalCode);
  if (external !== undefined) errors.externalCode = external;
  if (isPackageLike(form.subjectType) && form.projectCode.trim() !== '') {
    const project = codeProblem(form.projectCode);
    if (project !== undefined) errors.projectCode = project;
  }
  if (form.validFrom !== '' && !isDay(form.validFrom)) errors.validFrom = 'day';
  if (form.validUntil !== '') {
    if (!isDay(form.validUntil)) errors.validUntil = 'day';
    else if (form.validFrom !== '' && isDay(form.validFrom) && form.validUntil <= form.validFrom) errors.validUntil = 'range';
  }
  if (form.suggestionConfidence !== undefined) {
    if (form.subjectType === 'CONTRACTOR') errors.method = 'contractor';
    else if (!(form.suggestionConfidence > 0 && form.suggestionConfidence <= 1)) errors.confidence = 'confidence';
  }
  return errors;
}

export interface ProposeBody {
  subject_type: SubjectType;
  our_code: string;
  our_project_code?: string;
  external_code: string;
  match_method: 'MANUAL' | 'NAME_SUGGESTION';
  confidence?: number;
  valid_from?: string;
  valid_until?: string;
  reason: string;
}

export function proposeBody(form: ProposeForm, reason: string): ProposeBody {
  const project = form.projectCode.trim();
  return {
    subject_type: form.subjectType,
    our_code: form.ourCode.trim(),
    ...(isPackageLike(form.subjectType) && project !== '' ? { our_project_code: project } : {}),
    external_code: form.externalCode.trim(),
    match_method: form.suggestionConfidence === undefined ? 'MANUAL' : 'NAME_SUGGESTION',
    ...(form.suggestionConfidence === undefined ? {} : { confidence: form.suggestionConfidence }),
    ...(form.validFrom === '' ? {} : { valid_from: form.validFrom }),
    ...(form.validUntil === '' ? {} : { valid_until: form.validUntil }),
    reason: reason.trim(),
  };
}

/** The form a suggestion opens: the package of the network and the package of ours, the method NAME_SUGGESTION and the likeness. */
export const formOfSuggestion = (externalCode: string, candidate: Pick<Candidate, 'code' | 'confidence'>): ProposeForm => ({
  ...EMPTY_FORM,
  subjectType: 'PACKAGE',
  ourCode: candidate.code,
  externalCode,
  suggestionConfidence: candidate.confidence,
});

// ---- what a refusal of the server means -------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind =
  | 'externalCodeTaken'
  | 'subjectHasOtherCode'
  | 'unchanged'
  | 'alreadyProposed'
  | 'duplicate'
  | 'selfApproval'
  | 'versionConflict'
  | 'stateInvalid'
  | 'validation'
  | 'forbidden'
  | 'notFound'
  | 'general';

export interface Finding {
  field: string;
  code: string;
}

export interface Problem {
  kind: ProblemKind;
  /** The field of the form a VALIDATION_FAILED names, when it names one. */
  field: 'ourCode' | 'projectCode' | 'externalCode' | 'validFrom' | 'validUntil' | 'confidence' | 'reason' | 'method' | undefined;
  findings: Finding[];
}

const DUPLICATE_REASONS: Readonly<Record<string, ProblemKind>> = {
  EXTERNAL_CODE_TAKEN: 'externalCodeTaken',
  SUBJECT_HAS_OTHER_CODE: 'subjectHasOtherCode',
  UNCHANGED: 'unchanged',
  ALREADY_PROPOSED: 'alreadyProposed',
};

/** The fields a VALIDATION_FAILED can name; a detail that names several ("valid_until must be after valid_from") is about the first one it names. */
const FIELD_NAMES: ReadonlyArray<[string, NonNullable<Problem['field']>]> = [
  ['our_project_code', 'projectCode'],
  ['our_code', 'ourCode'],
  ['external_code', 'externalCode'],
  ['valid_from', 'validFrom'],
  ['valid_until', 'validUntil'],
  ['confidence', 'confidence'],
  ['match_method', 'method'],
  ['reason', 'reason'],
];

export const fieldOfDetail = (detail: string | undefined): Problem['field'] => {
  const lower = (detail ?? '').toLowerCase();
  let best: { at: number; field: NonNullable<Problem['field']> } | undefined;
  for (const [name, field] of FIELD_NAMES) {
    const at = lower.indexOf(name);
    if (at >= 0 && (best === undefined || at < best.at)) best = { at, field };
  }
  return best?.field;
};

function findingsOf(error: ApiError): Finding[] {
  const listed = error.extensions.findings ?? error.extensions.errors;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown): Finding[] => {
    const one = record(entry);
    return typeof one.code === 'string' ? [{ field: typeof one.field === 'string' ? one.field : '', code: one.code }] : [];
  });
}

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined, findings: [] };
  const base = { field: undefined, findings: [] as Finding[] };
  switch (error.code) {
    case 'CROSSWALK_DUPLICATE': {
      const reason = typeof error.extensions.reason === 'string' ? error.extensions.reason : '';
      return { ...base, kind: DUPLICATE_REASONS[reason] ?? 'duplicate' };
    }
    case 'SELF_APPROVAL_DENIED':
      return { ...base, kind: 'selfApproval' };
    case 'VERSION_CONFLICT':
      return { ...base, kind: 'versionConflict' };
    case 'EGP_MAPPING_STATE_INVALID':
      return { ...base, kind: 'stateInvalid' };
    case 'VALIDATION_FAILED':
      return { kind: 'validation', field: fieldOfDetail(error.detail), findings: findingsOf(error) };
    case 'RESOURCE_NOT_FOUND':
      return { ...base, kind: 'notFound' };
    default:
      return { ...base, kind: error.status === 403 ? 'forbidden' : 'general' };
  }
}

/** The camel-case key of a finding code of `validateEgpMapping` (`EXTERNAL_TYPE_MISMATCH` is `externalTypeMismatch`). */
export const findingKey = (code: string): string => code.toLowerCase().replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
