import { ApiError } from '@machvon/api-client';

/** Permissions of the governance rules (G0-1): who reads, who drafts and submits, who approves (and, with drafting, retires a version in force). */
export const READ_PERMISSION = 'adm.governance.read';
export const MANAGE_PERMISSION = 'adm.governance.manage';
export const APPROVE_PERMISSION = 'adm.governance.approve';

/** A day long before any rule can begin: the rule in force on it is always the built-in default. */
export const DEFAULT_DAY = '2000-01-01';
export const ALERT_TYPE = 'ALERT_TYPE';

export type RuleStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETIRED';
export type RulePhase = 'DRAFT' | 'SUBMITTED' | 'NEVER_IN_FORCE' | 'SCHEDULED' | 'IN_FORCE' | 'ENDED';
export type LegalStatus = 'VERIFIED' | 'UNVERIFIED';
export type Params = Record<string, unknown>;

export interface Provenance {
  formula: string;
  source: string;
  asOf: string;
  legalStatus: LegalStatus;
}

// ---- The schema of the params, as the catalogue serves it (plain data, a tiny closed language) --------------------------------------------------------------

export type FieldSpec = { optional?: boolean } & (
  | { kind: 'int'; min: number; max: number }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'text'; max: number; allowEmpty?: boolean; pattern?: string }
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'list'; of: FieldSpec; min?: number; max: number }
  | { kind: 'object'; fields: Readonly<Record<string, FieldSpec>> }
);
export type Schema = Readonly<Record<string, FieldSpec>>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toField(raw: unknown): FieldSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const optional = raw.optional === true ? { optional: true } : {};
  switch (raw.kind) {
    case 'int':
    case 'number':
      return typeof raw.min === 'number' && typeof raw.max === 'number' ? { kind: raw.kind, min: raw.min, max: raw.max, ...optional } : undefined;
    case 'boolean':
    case 'date':
    case 'time':
      return { kind: raw.kind, ...optional };
    case 'text':
      return typeof raw.max === 'number' ? { kind: 'text', max: raw.max, ...(raw.allowEmpty === true ? { allowEmpty: true } : {}), ...(typeof raw.pattern === 'string' ? { pattern: raw.pattern } : {}), ...optional } : undefined;
    case 'enum':
      return Array.isArray(raw.values) && raw.values.every((value) => typeof value === 'string') ? { kind: 'enum', values: raw.values as string[], ...optional } : undefined;
    case 'list': {
      const of = toField(raw.of);
      return of === undefined || typeof raw.max !== 'number' ? undefined : { kind: 'list', of, max: raw.max, ...(typeof raw.min === 'number' ? { min: raw.min } : {}), ...optional };
    }
    case 'object': {
      const fields = toFields(raw.fields);
      return fields === undefined ? undefined : { kind: 'object', fields, ...optional };
    }
    default:
      return undefined;
  }
}

function toFields(raw: unknown): Schema | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, FieldSpec> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = toField(value);
    if (field === undefined) return undefined;
    out[key] = field;
  }
  return out;
}

// ---- The catalogue ------------------------------------------------------------------------------------------------------------------------------------------

export interface CodeEntry {
  code: string;
  hasDefault: boolean;
  unverified: boolean;
  provenance: Provenance | null;
  storedVersions: number;
  inForce: 'RULE' | 'DEFAULT' | 'NONE';
  inForceVersion: number;
}

export interface RuleTypeEntry {
  ruleType: string;
  registered: boolean;
  ownerModule: string | null;
  modules: string[];
  formula: string | null;
  source: string | null;
  asOf: string | null;
  legalStatus: LegalStatus | null;
  /** Undefined when the server sent no schema or one this screen does not understand (the form then says so and writes nothing). */
  schema: Schema | undefined;
  codes: CodeEntry[];
}

const legalOf = (value: unknown): LegalStatus | null => (value === 'VERIFIED' || value === 'UNVERIFIED' ? value : null);

function toProvenance(raw: unknown): Provenance | null {
  if (!isRecord(raw)) return null;
  const legalStatus = legalOf(raw.legal_status);
  return legalStatus === null ? null : { formula: text(raw.formula) ?? '', source: text(raw.source) ?? '', asOf: text(raw.as_of) ?? '', legalStatus };
}

function toCode(raw: unknown): CodeEntry | undefined {
  if (!isRecord(raw) || typeof raw.code !== 'string') return undefined;
  const inForce = raw.in_force === 'RULE' || raw.in_force === 'DEFAULT' ? raw.in_force : 'NONE';
  return { code: raw.code, hasDefault: raw.has_default === true, unverified: raw.unverified === true, provenance: toProvenance(raw.provenance), storedVersions: count(raw.stored_versions), inForce, inForceVersion: count(raw.in_force_version) };
}

export function toCatalogue(raw: unknown): RuleTypeEntry[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return raw.items.flatMap((item): RuleTypeEntry[] => {
    if (!isRecord(item) || typeof item.rule_type !== 'string') return [];
    return [
      {
        ruleType: item.rule_type,
        registered: item.registered === true,
        ownerModule: text(item.owner_module),
        modules: array(item.modules).filter((module): module is string => typeof module === 'string'),
        formula: text(item.formula),
        source: text(item.source),
        asOf: text(item.as_of),
        legalStatus: legalOf(item.legal_status),
        schema: toFields(item.schema),
        codes: array(item.codes).flatMap((code) => toCode(code) ?? []),
      },
    ];
  });
}

/** How many codes of a type use a rule of the tenant and how many still use the default that ships with the platform. */
export function forceCounts(entry: RuleTypeEntry): { rules: number; defaults: number; none: number } {
  return {
    rules: entry.codes.filter((code) => code.inForce === 'RULE').length,
    defaults: entry.codes.filter((code) => code.inForce === 'DEFAULT').length,
    none: entry.codes.filter((code) => code.inForce === 'NONE').length,
  };
}

/** A type is "not verified" when its own numbers or the default of any of its codes were not confirmed with the law or the customer. */
export const isUnverified = (entry: RuleTypeEntry): boolean => entry.legalStatus === 'UNVERIFIED' || entry.codes.some((code) => code.unverified);

// ---- Versions, the rule in force and the difference between two ---------------------------------------------------------------------------------------------

export interface RuleVersion {
  id: string;
  ruleType: string;
  code: string;
  version: number;
  unitId: string | null;
  status: RuleStatus;
  phase: RulePhase;
  params: Params;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  resourceVersion: number;
}

const STATUSES: readonly RuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];
const PHASES: readonly RulePhase[] = ['DRAFT', 'SUBMITTED', 'NEVER_IN_FORCE', 'SCHEDULED', 'IN_FORCE', 'ENDED'];

/** The names the server gave beside the ids of the people of a version (`created_by_name` and the like), by membership id: what `personText` says instead of a piece of an id. */
const PERSON_NAMES = new Map<string, string>();
export const personNameOf = (id: string): string | undefined => PERSON_NAMES.get(id);
function rememberPeople(raw: Record<string, unknown>): void {
  for (const field of ['created_by', 'submitted_by', 'approved_by', 'retired_by']) {
    const id = raw[field];
    const name = raw[`${field}_name`];
    if (typeof id === 'string' && typeof name === 'string' && name.trim() !== '') PERSON_NAMES.set(id, name);
  }
}

export function toVersion(raw: unknown): RuleVersion | undefined {
  if (!isRecord(raw)) return undefined;
  rememberPeople(raw);
  const status = STATUSES.find((one) => one === raw.status);
  const phase = PHASES.find((one) => one === raw.phase);
  if (typeof raw.id !== 'string' || typeof raw.rule_type !== 'string' || typeof raw.code !== 'string' || status === undefined || phase === undefined || typeof raw.effective_from !== 'string') return undefined;
  return {
    id: raw.id,
    ruleType: raw.rule_type,
    code: raw.code,
    version: count(raw.version),
    unitId: text(raw.unit_id),
    status,
    phase,
    params: isRecord(raw.params) ? raw.params : {},
    effectiveFrom: raw.effective_from,
    effectiveTo: text(raw.effective_to),
    reason: text(raw.reason) ?? '',
    createdBy: text(raw.created_by) ?? '',
    createdAt: text(raw.created_at) ?? '',
    submittedBy: text(raw.submitted_by),
    submittedAt: text(raw.submitted_at),
    approvedBy: text(raw.approved_by),
    approvedAt: text(raw.approved_at),
    retiredBy: text(raw.retired_by),
    retiredAt: text(raw.retired_at),
    retireReason: text(raw.retire_reason),
    resourceVersion: count(raw.resource_version),
  };
}

export const toVersions = (raw: unknown): RuleVersion[] | undefined => (isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toVersion(item) ?? []) : undefined);

export interface Resolved {
  ruleType: string;
  code: string;
  asOf: string;
  params: Params;
  version: number;
  source: 'RULE' | 'DEFAULT';
  ruleId: string | null;
  unitId: string | null;
  unverified: boolean;
  provenance: Provenance | null;
}

export function toResolved(raw: unknown): Resolved | undefined {
  if (!isRecord(raw) || typeof raw.rule_type !== 'string' || typeof raw.code !== 'string' || !isRecord(raw.params)) return undefined;
  return {
    ruleType: raw.rule_type,
    code: raw.code,
    asOf: text(raw.as_of) ?? '',
    params: raw.params,
    version: count(raw.version),
    source: raw.source === 'RULE' ? 'RULE' : 'DEFAULT',
    ruleId: text(raw.rule_id),
    unitId: text(raw.unit_id),
    unverified: raw.unverified === true,
    provenance: toProvenance(raw.provenance),
  };
}

export type ChangeKind = 'added' | 'removed' | 'changed';
export interface Change {
  path: string;
  kind: ChangeKind;
  before: unknown;
  after: unknown;
}
export interface DiffEnd {
  id: string | null;
  ruleType: string;
  code: string;
  version: number;
  source?: 'RULE' | 'DEFAULT' | 'NONE';
}
export interface DiffView {
  from: DiffEnd;
  to: DiffEnd;
  changes: Change[];
}

function toEnd(raw: unknown, withSource: boolean): DiffEnd | undefined {
  if (!isRecord(raw) || typeof raw.rule_type !== 'string' || typeof raw.code !== 'string') return undefined;
  const source = raw.source === 'RULE' || raw.source === 'DEFAULT' || raw.source === 'NONE' ? raw.source : undefined;
  return { id: text(raw.id), ruleType: raw.rule_type, code: raw.code, version: count(raw.version), ...(withSource && source !== undefined ? { source } : {}) };
}

export function toDiff(raw: unknown): DiffView | undefined {
  if (!isRecord(raw)) return undefined;
  const from = toEnd(raw.from, true);
  const to = toEnd(raw.to, false);
  if (from === undefined || to === undefined || !Array.isArray(raw.changes)) return undefined;
  const changes = raw.changes.flatMap((item): Change[] => {
    if (!isRecord(item) || typeof item.path !== 'string') return [];
    const before = item.before ?? null;
    const after = item.after ?? null;
    return [{ path: item.path, kind: before === null ? 'added' : after === null ? 'removed' : 'changed', before, after }];
  });
  return { from, to, changes };
}

// ---- The registry of alert types (G0-3) ---------------------------------------------------------------------------------------------------------------------

export interface AlertTypeRow {
  code: string;
  source: string | null;
  owner: string | null;
  expectedAction: string | null;
  consequence: string | null;
  responseHours: number | null;
  defaultSeverity: 'URGENT' | 'ACTION' | 'WATCH' | null;
  reasonToExist: string | null;
  reviewOn: string | null;
  reviewOverdue: boolean;
  enabled: boolean | null;
  version: number;
  ruleSource: 'RULE' | 'DEFAULT';
  ruleId: string | null;
  unverified: boolean;
  provenance: Provenance | null;
}

export interface AlertTypeList {
  asOf: string;
  items: AlertTypeRow[];
}

export function toAlertTypes(raw: unknown): AlertTypeList | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const items = raw.items.flatMap((item): AlertTypeRow[] => {
    if (!isRecord(item) || typeof item.code !== 'string') return [];
    const severity = item.default_severity === 'URGENT' || item.default_severity === 'ACTION' || item.default_severity === 'WATCH' ? item.default_severity : null;
    const expected = text(item.expected_action);
    return [
      {
        code: item.code,
        source: text(item.source),
        owner: text(item.owner),
        expectedAction: expected === null || expected.trim() === '' ? null : expected,
        consequence: text(item.consequence),
        responseHours: typeof item.response_hours === 'number' ? item.response_hours : null,
        defaultSeverity: severity,
        reasonToExist: text(item.reason_to_exist),
        reviewOn: text(item.review_on),
        reviewOverdue: item.review_overdue === true,
        enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
        version: count(item.version),
        ruleSource: item.rule_source === 'RULE' ? 'RULE' : 'DEFAULT',
        ruleId: text(item.rule_id),
        unverified: item.unverified === true,
        provenance: toProvenance(item.provenance),
      },
    ];
  });
  return { asOf: text(raw.as_of) ?? '', items };
}

/** A type with no expected action can only be watched: its default level is Watch and nothing else (G0-3). */
export const hasNoExpectedAction = (row: Pick<AlertTypeRow, 'expectedAction'>): boolean => row.expectedAction === null;

/** The days from `today` to the review day (negative: past); null when there is no review day. */
export function daysToReview(reviewOn: string | null, today: string): number | null {
  if (reviewOn === null || !isDay(reviewOn) || !isDay(today)) return null;
  return Math.round((Date.parse(`${reviewOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export const REVIEW_SOON_DAYS = 30;

// ---- Days ---------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `2026-11-08` as `08/11/2026`; anything else as it came. */
export const dayText = (day: string | null | undefined): string => {
  if (day === null || day === undefined || day === '') return '';
  const match = DAY.exec(day.slice(0, 10));
  return match === null ? day : `${match[3]}/${match[2]}/${match[1]}`;
};

/** The instant as the Vietnamese day and minute it was (the system's business day is the day in Vietnam). */
export function momentText(iso: string | null, locale: string): string {
  if (iso === null || iso === '') return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
}

export const shortId = (id: string | null): string => (id === null ? '' : id.slice(0, 8));

// ---- Units of a field ---------------------------------------------------------------------------------------------------------------------------------------

export type UnitKind = 'VND' | 'PCT' | 'HOURS' | 'DAYS';

const lastSegment = (path: string): string => path.replace(/\[\d+\]/g, '').split('.').pop() ?? path;

/** The unit a number is in, read from the name of its field (money is `…_vnd`/`…Vnd`, a share `…_pct`, a time `…_hours`, `…_days`). */
export function unitOfField(path: string): UnitKind | null {
  const leaf = lastSegment(path);
  if (/vnd/i.test(leaf)) return 'VND';
  if (/pct/i.test(leaf)) return 'PCT';
  if (/hours/i.test(leaf)) return 'HOURS';
  if (/days/i.test(leaf)) return 'DAYS';
  return null;
}

// ---- The draft of a form: raw text for what is typed, generated from the schema ------------------------------------------------------------------------------

export type Draft = string | boolean | Draft[] | { [key: string]: Draft };

export function blankDraft(spec: FieldSpec): Draft {
  switch (spec.kind) {
    case 'boolean':
      return false;
    case 'list':
      return Array.from({ length: spec.min ?? 0 }, () => blankDraft(spec.of));
    case 'object':
      return Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, blankDraft(field)]));
    default:
      return '';
  }
}

export const blankParams = (schema: Schema): Draft => blankDraft({ kind: 'object', fields: schema });

/** The typed value of a rule as raw text, the way a form holds it (an absent optional field is empty). */
export function draftOf(spec: FieldSpec, value: unknown): Draft {
  switch (spec.kind) {
    case 'boolean':
      return value === true;
    case 'int':
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    case 'list':
      return Array.isArray(value) ? value.map((item) => draftOf(spec.of, item)) : [];
    case 'object': {
      const source = isRecord(value) ? value : {};
      return Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, draftOf(field, source[key])]));
    }
    default:
      return typeof value === 'string' ? value : '';
  }
}

export const draftOfParams = (schema: Schema, params: Params | undefined): Draft => draftOf({ kind: 'object', fields: schema }, params ?? {});

function isEmptyDraft(spec: FieldSpec, draft: Draft | undefined): boolean {
  if (draft === undefined) return true;
  switch (spec.kind) {
    case 'boolean':
      return false;
    case 'list':
      return !Array.isArray(draft) || draft.length === 0;
    case 'object':
      return typeof draft !== 'object' || Array.isArray(draft) || Object.entries(spec.fields).every(([key, field]) => isEmptyDraft(field, (draft as Record<string, Draft>)[key]));
    default:
      return typeof draft !== 'string' || draft.trim() === '';
  }
}

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;
const WHOLE = /^-?\d+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The number a typed text means (a Vietnamese decimal comma is read as a point). */
const numberOf = (raw: string): number => Number(raw.trim().replace(',', '.'));

/** The params the draft means; what is optional and empty is left out. Only call it on a draft that has no problem. */
export function paramsOf(spec: FieldSpec, draft: Draft | undefined): unknown {
  if (spec.kind !== 'boolean' && spec.optional === true && isEmptyDraft(spec, draft)) return undefined;
  switch (spec.kind) {
    case 'boolean':
      return draft === true;
    case 'int':
    case 'number':
      return typeof draft === 'string' ? numberOf(draft) : undefined;
    case 'list':
      return Array.isArray(draft) ? draft.map((item) => paramsOf(spec.of, item)) : [];
    case 'object': {
      const source = typeof draft === 'object' && draft !== null && !Array.isArray(draft) ? (draft as Record<string, Draft>) : {};
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        const value = paramsOf(field, source[key]);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    default:
      return typeof draft === 'string' ? draft : '';
  }
}

export const paramsOfDraft = (schema: Schema, draft: Draft): Params => paramsOf({ kind: 'object', fields: schema }, draft) as Params;

// ---- Validation: the same checks as the schema of the kernel, worded for a person ------------------------------------------------------------------------------

export type ProblemCode = 'required' | 'integer' | 'number' | 'range' | 'length' | 'trim' | 'pattern' | 'choice' | 'date' | 'time' | 'listSize' | 'watchOnly' | 'server';
export interface Problem {
  path: string;
  code: ProblemCode;
  min?: number;
  max?: number;
}

const patternOf = (source: string): RegExp | undefined => {
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
};

const at = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** The problems of a draft against its field, each at the path the server names (`bands[1].min`). A boolean is always valid. */
export function problemsOf(spec: FieldSpec, draft: Draft | undefined, path: string): Problem[] {
  if (spec.kind !== 'boolean' && isEmptyDraft(spec, draft) && spec.optional === true) return [];
  switch (spec.kind) {
    case 'boolean':
      return [];
    case 'int': {
      const raw = typeof draft === 'string' ? draft.trim() : '';
      if (raw === '') return [{ path, code: 'required' }];
      if (!WHOLE.test(raw)) return [{ path, code: 'integer' }];
      const value = Number(raw);
      return value < spec.min || value > spec.max ? [{ path, code: 'range', min: spec.min, max: spec.max }] : [];
    }
    case 'number': {
      const raw = typeof draft === 'string' ? draft.trim() : '';
      if (raw === '') return [{ path, code: 'required' }];
      if (!NUMBER.test(raw)) return [{ path, code: 'number' }];
      const value = numberOf(raw);
      return value < spec.min || value > spec.max ? [{ path, code: 'range', min: spec.min, max: spec.max }] : [];
    }
    case 'text': {
      const value = typeof draft === 'string' ? draft : '';
      if (value === '') return spec.allowEmpty === true ? [] : [{ path, code: 'required' }];
      if (value.trim() !== value) return [{ path, code: 'trim' }];
      if (value.length > spec.max) return [{ path, code: 'length', max: spec.max }];
      const pattern = spec.pattern === undefined ? undefined : patternOf(spec.pattern);
      return pattern !== undefined && !pattern.test(value) ? [{ path, code: 'pattern' }] : [];
    }
    case 'date': {
      const value = typeof draft === 'string' ? draft : '';
      return value === '' ? [{ path, code: 'required' }] : isDay(value) ? [] : [{ path, code: 'date' }];
    }
    case 'time': {
      const value = typeof draft === 'string' ? draft : '';
      return value === '' ? [{ path, code: 'required' }] : TIME.test(value) ? [] : [{ path, code: 'time' }];
    }
    case 'enum': {
      const value = typeof draft === 'string' ? draft : '';
      return value === '' ? [{ path, code: 'required' }] : spec.values.includes(value) ? [] : [{ path, code: 'choice' }];
    }
    case 'list': {
      const items = Array.isArray(draft) ? draft : [];
      const size: Problem[] = items.length > spec.max || items.length < (spec.min ?? 0) ? [{ path, code: 'listSize', min: spec.min ?? 0, max: spec.max }] : [];
      return [...size, ...items.flatMap((item, index) => problemsOf(spec.of, item, `${path}[${index}]`))];
    }
    case 'object': {
      const source = typeof draft === 'object' && draft !== null && !Array.isArray(draft) ? (draft as Record<string, Draft>) : {};
      return Object.entries(spec.fields).flatMap(([key, field]) => problemsOf(field, source[key], at(path, key)));
    }
  }
}

/**
 * The rules the schema cannot say as a field, that the form can check before it sends. The alert type is the one the roadmap names: a type with no expected action can only be watched (G0-3). Every other
 * type is judged by the server, which names the field (`GOVERNANCE_RULE_PARAMS_INVALID`).
 */
export function crossProblems(ruleType: string, draft: Draft): Problem[] {
  if (ruleType !== ALERT_TYPE || typeof draft !== 'object' || Array.isArray(draft)) return [];
  const expected = typeof draft.expected_action === 'string' ? draft.expected_action.trim() : '';
  return expected === '' && draft.default_severity !== 'WATCH' && draft.default_severity !== '' ? [{ path: 'default_severity', code: 'watchOnly' }] : [];
}

export const allProblems = (ruleType: string, schema: Schema, draft: Draft): Problem[] => [...problemsOf({ kind: 'object', fields: schema }, draft, ''), ...crossProblems(ruleType, draft)];

/** The values of a draft at a path (`bands[1].min`), for the form of a list item. */
export function updateAt(draft: Draft, path: Array<string | number>, value: Draft): Draft {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(draft) && typeof head === 'number') return draft.map((item, index) => (index === head ? updateAt(item, rest, value) : item));
  if (typeof draft === 'object' && !Array.isArray(draft) && typeof head === 'string') return { ...draft, [head]: updateAt(draft[head] as Draft, rest, value) };
  return draft;
}

// ---- The period of a version ------------------------------------------------------------------------------------------------------------------------------

export type PeriodNotice =
  | { kind: 'startPast' }
  | { kind: 'endBeforeStart' }
  | { kind: 'takeover'; version: number; endsOn: string }
  | { kind: 'conflict'; version: number; from: string; to: string | null };

/**
 * What approving a version that runs from `from` to `to` would do to the versions that are approved: it takes over from one that begins earlier and is covered by the new one (that one ends the day this begins)
 * and is refused for any other overlap; a day already past is refused. The server judges again at approval; this is the warning before the draft is written.
 */
export function periodNotices(versions: readonly RuleVersion[], from: string, to: string | null, today: string): PeriodNotice[] {
  const notices: PeriodNotice[] = [];
  if (!isDay(from)) return notices;
  if (today !== '' && from < today) notices.push({ kind: 'startPast' });
  if (to !== null && to <= from) {
    notices.push({ kind: 'endBeforeStart' });
    return notices;
  }
  for (const version of versions) {
    if (version.approvedAt === null) continue;
    const ends = version.effectiveTo;
    if (ends !== null && ends <= version.effectiveFrom) continue;
    const overlaps = (to === null || version.effectiveFrom < to) && (ends === null || ends > from);
    if (!overlaps) continue;
    const startsBefore = version.effectiveFrom < from;
    const covered = to === null || (ends !== null && ends <= to);
    notices.push(startsBefore && covered ? { kind: 'takeover', version: version.version, endsOn: from } : { kind: 'conflict', version: version.version, from: version.effectiveFrom, to: ends });
  }
  return notices;
}

// ---- The moves of a version -----------------------------------------------------------------------------------------------------------------------------

export type Move = 'submit' | 'withdraw' | 'approve' | 'retire';
export type MoveBlock = 'selfApproval' | 'needsBoth' | 'startPassed';
export interface MoveOption {
  move: Move;
  allowed: boolean;
  /** Why a move that applies cannot be made by this person now (said next to the button, not hidden). */
  block?: MoveBlock;
}
export interface MoveContext {
  /** The membership of the person who is signed in; undefined when the session does not say. */
  me: string | undefined;
  canManage: boolean;
  canApprove: boolean;
  today: string;
}

/**
 * The moves that apply to a version, with whether this person can make them. A draft is submitted or discarded; a submitted version is withdrawn, discarded, or approved by a third person (neither the maker nor
 * the submitter); a version in force or waiting for its day is retired by someone who may both draft and approve. A version that ended or was retired has no move.
 */
export function movesOf(version: Pick<RuleVersion, 'status' | 'phase' | 'createdBy' | 'submittedBy' | 'effectiveFrom'>, context: MoveContext): MoveOption[] {
  const { me, canManage, canApprove, today } = context;
  switch (version.status) {
    case 'DRAFT':
      return [
        { move: 'submit', allowed: canManage },
        { move: 'retire', allowed: canManage },
      ];
    case 'SUBMITTED': {
      const same = me !== undefined && (me === version.createdBy || me === version.submittedBy);
      const block: MoveBlock | undefined = same ? 'selfApproval' : today !== '' && version.effectiveFrom < today ? 'startPassed' : undefined;
      return [
        { move: 'withdraw', allowed: canManage },
        { move: 'approve', allowed: canApprove && block === undefined, ...(block === undefined ? {} : { block }) },
        { move: 'retire', allowed: canManage },
      ];
    }
    case 'APPROVED':
      return version.phase === 'SCHEDULED' || version.phase === 'IN_FORCE' ? [{ move: 'retire', allowed: canManage && canApprove, ...(canManage && canApprove ? {} : { block: 'needsBoth' as const }) }] : [];
    case 'RETIRED':
      return [];
  }
}

// ---- What the server refuses -----------------------------------------------------------------------------------------------------------------------------

export type Refusal =
  | { kind: 'selfApproval' }
  | { kind: 'state' }
  | { kind: 'overlap' }
  | { kind: 'params'; path: string | undefined }
  | { kind: 'conflict' }
  | { kind: 'notFound' }
  | { kind: 'denied' }
  | { kind: 'validation'; field: string | undefined }
  | { kind: 'session' }
  | { kind: 'general' };

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { kind: 'general' };
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return { kind: 'selfApproval' };
    case 'GOVERNANCE_RULE_STATE_INVALID':
      return { kind: 'state' };
    case 'GOVERNANCE_RULE_PERIOD_OVERLAP':
      return { kind: 'overlap' };
    case 'GOVERNANCE_RULE_PARAMS_INVALID':
      return { kind: 'params', path: error.detail };
    case 'VERSION_CONFLICT':
      return { kind: 'conflict' };
    case 'RESOURCE_NOT_FOUND':
    case 'GOVERNANCE_RULE_NOT_FOUND':
      return { kind: 'notFound' };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
    case 'PERMISSION_DENIED':
      return { kind: 'denied' };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { kind: 'validation', field: error.detail };
    case 'SESSION_EXPIRED':
      return { kind: 'session' };
    default:
      return { kind: 'general' };
  }
}

/** The id the response of a command names (the version that was written). */
export function resourceIdOf(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.resource_id === 'string' ? raw.resource_id : undefined;
}

/** A query value that is one non-empty string, else undefined. */
export const textParam = (value: string | null): string | undefined => (value === null || value.trim() === '' ? undefined : value.trim());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);
const RULE_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;
const RULE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const isRuleType = (value: string): boolean => RULE_TYPE.test(value);
export const isRuleCode = (value: string): boolean => RULE_CODE.test(value);
/** A reason is trimmed text of 5 to 500 characters (the same bound as the server and the table). */
export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const isReason = (value: string): boolean => value.trim().length >= REASON_MIN && value.trim().length <= REASON_MAX;

// ---- Reading params side by side ------------------------------------------------------------------------------------------------------------------------

/** The leaves of params by path (`bands[1].min`), in the order they are written; an empty list or object is a leaf of its own so that "no entries" is shown, not hidden. */
export function flattenParams(value: unknown, path = ''): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) return value.length === 0 ? (path === '' ? [] : [{ path, value }]) : value.flatMap((item, index) => flattenParams(item, `${path}[${index}]`));
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? (path === '' ? [] : [{ path, value }]) : entries.flatMap(([key, item]) => flattenParams(item, path === '' ? key : `${path}.${key}`));
  }
  return [{ path, value }];
}

/** The two sides of a comparison, one row for each path of either side; `same` is false when the sides differ (a path missing on one side differs). */
export function sideBySide(left: Params | undefined, right: Params | undefined): Array<{ path: string; left: unknown; right: unknown; hasLeft: boolean; hasRight: boolean; same: boolean }> {
  const a = new Map(flattenParams(left ?? {}).map((entry) => [entry.path, entry.value]));
  const b = new Map(flattenParams(right ?? {}).map((entry) => [entry.path, entry.value]));
  const paths = [...new Set([...a.keys(), ...b.keys()])];
  return paths.map((path) => ({ path, left: a.get(path), right: b.get(path), hasLeft: a.has(path), hasRight: b.has(path), same: a.has(path) && b.has(path) && JSON.stringify(a.get(path)) === JSON.stringify(b.get(path)) }));
}
