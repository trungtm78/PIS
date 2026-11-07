import { DomainError } from './errors.ts';
import { paymentClockDefaults, paymentClockParams } from './ctr-reports.ts';
import { FIN_CRITERIA_CATEGORIES, FIN_CRITERIA_DEFAULTS, assertCriteriaSet } from './fin-criteria.ts';
import { KPI_HOME_DEFAULTS, RAG_EWS_DEFAULTS } from './analytics-rule-defaults.ts';
import { DIRECTIVE_POLICY_DEFAULTS, parseDirectivePolicy } from './directive.ts';
import { B1_DEFAULTS, EAC_METHODS } from './gov-b1-policy.ts';
import { WORKFLOW_DEFAULTS_AS_OF, WORKFLOW_DEFAULTS_FORMULA, WORKFLOW_DEFAULTS_SOURCE, WORKFLOW_METHODS, WORKFLOW_RULE_TYPE, defaultWorkflowParams, parseWorkflowDefinition } from './bid-workflow.ts';
import { MILESTONE_KINDS } from './procurement-file.ts';
import { MONEY_RULE_DEFAULTS, parseMoneyRuleParams } from './money-control-policy.ts';
import type { MoneyRuleType } from './money-control-policy.ts';
import { clockPolicyDefaults, clockPolicyOf, reminderPolicyDefaults, reminderPolicyOf, snoozePolicyDefaults, snoozePolicyOf } from './work-clock.ts';

/**
 * The governance rules (G0-1, G0-3 of docs/governance-roadmap-10of10.md): thresholds, definitions and policies kept as data that a tenant can version and approve, never as constants in code. This module is
 * pure: the registry of the kinds of rule (`rule_type`), the schema that checks the params of each, the built-in default params (the starting values of the research, to be confirmed with the customer and the
 * auditors), and `resolveGovernanceRule`, which picks the rule in force on a day. The database side (`governance_rule`, the port `GovernancePolicyPort`) lives in @machvon/db and is a thin reader of this.
 *
 * The registry of rule types is OPEN: the table accepts any `rule_type` that looks like `^[A-Z][A-Z0-9_]{2,63}$`, and a type is known to the platform when a `register*` function below has registered it. One file,
 * one function per domain: a lane that needs a new threshold adds a code under a type (`registerRuleDefaults`) or a type (`registerRuleType`) inside ITS function, never edits a default of another lane.
 * Every type and every built-in default carries where the numbers come from (`source`), the day they were taken (`asOf`), how they are read (`formula`) and whether they were confirmed against the legal text or
 * with the customer (`legalStatus`): `npm run governance:check` fails the build when one of them is missing.
 */

/** A rule type: upper case letters, digits and underscores, starting with a letter, 3 to 64 characters (the same pattern as the CHECK of the table `governance_rule`). */
export const RULE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
export const isRuleTypeName = (value: unknown): value is string => typeof value === 'string' && RULE_TYPE_PATTERN.test(value);

/** A module code of the spec (`ADM`, `PAY`, `HOME`): the module that owns a rule type. */
const MODULE_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

/** A rule type is any registered name; the type is a string because the registry is open. */
export type GovernanceRuleType = string;

export type GovernanceRuleStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETIRED';
export const GOVERNANCE_RULE_STATUSES: readonly GovernanceRuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];

export type RuleParams = Record<string, unknown>;

/** A rule code: upper case letters, digits and underscores, starting with a letter. */
export const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const isRuleCode = (value: unknown): value is string => typeof value === 'string' && RULE_CODE_PATTERN.test(value);

/** Whether the numbers behind a type or a default were confirmed against the legal text or with the customer. `UNVERIFIED` is shown on every screen that shows the number ("mặc định, chưa được xác nhận"). */
export type LegalStatus = 'VERIFIED' | 'UNVERIFIED';
export const LEGAL_STATUSES: readonly LegalStatus[] = ['VERIFIED', 'UNVERIFIED'];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The schema of params: a tiny closed language, enough for numbers, words, days and lists. An unknown key is refused (a typo must not become a threshold nobody reads).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Optionality = { optional?: boolean };
/** The schema is plain data (a text `pattern` is the source of a regular expression), so the admin screen can build a form from it. */
export type FieldSpec = Optionality &
  (
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

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const patterns = new Map<string, RegExp>();
const patternOf = (source: string): RegExp => {
  let found = patterns.get(source);
  if (found === undefined) {
    found = new RegExp(source);
    patterns.set(source, found);
  }
  return found;
};

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isRuleDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const bad = (path: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, path);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function check(spec: FieldSpec, value: unknown, path: string): unknown {
  switch (spec.kind) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) throw bad(path);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw bad(path);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad(path);
      return value;
    case 'text': {
      if (typeof value !== 'string') throw bad(path);
      const trimmed = value.trim();
      if (trimmed !== value || value.length > spec.max || (value.length === 0 && spec.allowEmpty !== true)) throw bad(path);
      if (spec.pattern !== undefined && !patternOf(spec.pattern).test(value)) throw bad(path);
      return value;
    }
    case 'date':
      if (!isRuleDay(value)) throw bad(path);
      return value;
    case 'time':
      if (typeof value !== 'string' || !TIME.test(value)) throw bad(path);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) throw bad(path);
      return value;
    case 'list': {
      if (!Array.isArray(value) || value.length > spec.max || value.length < (spec.min ?? 0)) throw bad(path);
      return value.map((item, index) => check(spec.of, item, `${path}[${index}]`));
    }
    case 'object': {
      if (!isRecord(value)) throw bad(path);
      return checkObject(spec.fields, value, path);
    }
  }
}

function checkObject(fields: Readonly<Record<string, FieldSpec>>, value: Record<string, unknown>, path: string): Record<string, unknown> {
  for (const key of Object.keys(value)) if (!(key in fields)) throw bad(path === '' ? key : `${path}.${key}`);
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const at = path === '' ? key : `${path}.${key}`;
    const present = value[key];
    if (present === undefined || present === null) {
      if (spec.optional === true) continue;
      throw bad(at);
    }
    out[key] = check(spec, present, at);
  }
  return out;
}

const int = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'int', min, max, optional });
const num = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'number', min, max, optional });
const bool: FieldSpec = { kind: 'boolean' };
const text = (max: number, optional = false, allowEmpty = false): FieldSpec => ({ kind: 'text', max, optional, allowEmpty });
const word = (optional = false): FieldSpec => ({ kind: 'text', max: 64, optional });
/** An upper case code such as a reason or a status (2 to 40 characters). */
const codeText = (optional = false): FieldSpec => ({ kind: 'text', max: 40, optional, pattern: '^[A-Z][A-Z0-9_]{1,39}$' });
const oneOf = (...values: readonly string[]): FieldSpec => ({ kind: 'enum', values });
const list = (of: FieldSpec, max: number, min = 0): FieldSpec => ({ kind: 'list', of, max, min });
const optionally = (spec: FieldSpec): FieldSpec => ({ ...spec, optional: true });
const shape = (fields: Record<string, FieldSpec>): FieldSpec => ({ kind: 'object', fields });
/** One whole-number value for each severity of the alert centre. */
const perSeverity = (min: number, max: number): FieldSpec => shape({ URGENT: int(min, max), ACTION: int(min, max), WATCH: int(min, max) });

const SEVERITIES = ['URGENT', 'ACTION', 'WATCH'] as const;
const SCOPES = ['SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE'] as const;

/** Judges the params of a lane with the lane's own parser: whatever the parser refuses, the registry refuses too, naming the field the parser names. */
const refineWith =
  (parse: (params: unknown) => unknown): ((params: Record<string, unknown>) => string | undefined) =>
  (params) => {
    try {
      parse(params);
      return undefined;
    } catch (failure) {
      return failure instanceof DomainError ? (failure.detail ?? 'params') : 'params';
    }
  };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The kinds of rule and their registry.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a rule type or a built-in default says about where its numbers come from; `asOf` is the day they were taken (`YYYY-MM-DD`). */
export interface Provenance {
  /** How the number is read or computed, in one sentence a reader of the screen can follow. */
  formula: string;
  /** Where the number comes from: the legal text, the research, the customer, the module that defines it. */
  source: string;
  asOf: string;
  legalStatus: LegalStatus;
}

export interface BuiltInDefault extends Provenance {
  params: RuleParams;
  /** The numbers behind this default are not confirmed against the legal text or with the customer: every screen that shows it says so (roadmap, "chưa kiểm chứng"). Always `legalStatus === 'UNVERIFIED'`. */
  unverified: boolean;
}

/** What a lane gives for a default; whatever it leaves out is taken from the type. */
export interface DefaultInput extends Partial<Provenance> {
  params: RuleParams;
}

export interface RuleTypeDefinition extends Provenance {
  type: string;
  /** The module code that owns the type (the lane that answers for its numbers). */
  ownerModule: string;
  /** The module codes of the spec the rule is mostly read by (a hint for the admin screen, not an access rule). */
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  /** A rule across fields that the closed schema cannot say; returns the offending field. */
  refine?: (params: Record<string, unknown>) => string | undefined;
  /** What applies when the tenant approved no rule of this code. A code that is not here has no default: a caller that needs it must handle `undefined`. */
  defaults: Readonly<Record<string, BuiltInDefault>>;
}

export interface RuleTypeInput extends Provenance {
  type: string;
  ownerModule: string;
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  refine?: (params: Record<string, unknown>) => string | undefined;
  defaults: Readonly<Record<string, DefaultInput>>;
}

const REGISTRY = new Map<string, { definition: Omit<RuleTypeDefinition, 'defaults'>; defaults: Record<string, BuiltInDefault> }>();

const flawOf = (message: string): Error => new Error(`governance rule registry: ${message}`);

function assertProvenance(owner: string, provenance: Partial<Provenance>, required: boolean): void {
  if (provenance.formula !== undefined && provenance.formula.trim().length < 8) throw flawOf(`${owner} has no formula`);
  if (provenance.source !== undefined && provenance.source.trim().length < 3) throw flawOf(`${owner} has no source`);
  if (provenance.asOf !== undefined && !isRuleDay(provenance.asOf)) throw flawOf(`${owner} has an as-of that is not a day`);
  if (provenance.legalStatus !== undefined && !LEGAL_STATUSES.includes(provenance.legalStatus)) throw flawOf(`${owner} has no legal status`);
  if (required && (provenance.formula === undefined || provenance.source === undefined || provenance.asOf === undefined || provenance.legalStatus === undefined)) throw flawOf(`${owner} lacks formula, source, as-of or legal status`);
}

function judge(schema: Readonly<Record<string, FieldSpec>>, refine: RuleTypeDefinition['refine'], params: unknown): RuleParams {
  if (!isRecord(params)) throw bad('params');
  const checked = checkObject(schema, params, '');
  const field = refine?.(checked);
  if (field !== undefined) throw bad(field);
  return checked;
}

function completeDefault(type: string, code: string, input: DefaultInput, definition: Omit<RuleTypeDefinition, 'defaults'>): BuiltInDefault {
  if (!isRuleCode(code)) throw flawOf(`${type} has a default whose code is not a rule code`);
  assertProvenance(`${type}/${code}`, input, false);
  try {
    judge(definition.schema, definition.refine, input.params);
  } catch (failure) {
    throw flawOf(`the built-in default ${type}/${code} does not pass its own schema (${failure instanceof DomainError ? (failure.detail ?? '?') : 'unknown'})`);
  }
  const legalStatus = input.legalStatus ?? definition.legalStatus;
  return {
    params: input.params,
    formula: input.formula ?? definition.formula,
    source: input.source ?? definition.source,
    asOf: input.asOf ?? definition.asOf,
    legalStatus,
    unverified: legalStatus === 'UNVERIFIED',
  };
}

/** Registers a rule type; a type is registered once (a second registration of the same name is a defect of the lane, not a way to change a type). Every default must pass the schema of the type. */
export function registerRuleType(input: RuleTypeInput): void {
  if (!isRuleTypeName(input.type)) throw flawOf(`${String(input.type)} is not a rule type name`);
  if (REGISTRY.has(input.type)) throw flawOf(`${input.type} is already registered`);
  if (!MODULE_PATTERN.test(input.ownerModule) || input.modules.length === 0 || !input.modules.every((module) => MODULE_PATTERN.test(module))) throw flawOf(`${input.type} names no module that owns it`);
  assertProvenance(input.type, input, true);
  const { defaults, ...definition } = input;
  const entry = { definition, defaults: {} as Record<string, BuiltInDefault> };
  for (const [code, one] of Object.entries(defaults)) entry.defaults[code] = completeDefault(input.type, code, one, definition);
  REGISTRY.set(input.type, entry);
}

/** Adds codes (built-in defaults) under a type that is registered; a code that exists is a defect of the lane that adds it. */
export function registerRuleDefaults(type: string, defaults: Readonly<Record<string, DefaultInput>>): void {
  const entry = REGISTRY.get(type);
  if (entry === undefined) throw flawOf(`${type} is not registered (register the type before its codes)`);
  for (const [code, one] of Object.entries(defaults)) {
    if (entry.defaults[code] !== undefined) throw flawOf(`${type}/${code} already has a default`);
    entry.defaults[code] = completeDefault(type, code, one, entry.definition);
  }
}

const view = (entry: { definition: Omit<RuleTypeDefinition, 'defaults'>; defaults: Record<string, BuiltInDefault> }): RuleTypeDefinition => ({ ...entry.definition, defaults: entry.defaults });

/** Whether a type is registered with the platform (the table accepts any well-formed name; the platform only knows what a `register*` function registered). */
export const isGovernanceRuleType = (value: unknown): value is GovernanceRuleType => typeof value === 'string' && REGISTRY.has(value);

/** The registered types in the order they were registered. */
export const registeredRuleTypes = (): string[] => [...REGISTRY.keys()];

/** Every registered type with its built-in defaults, in the order they were registered. */
export const ruleTypeDefinitions = (): RuleTypeDefinition[] => [...REGISTRY.values()].map(view);

/** The definition of a type; an unknown type is 422 VALIDATION_FAILED on `rule_type`. */
export function ruleTypeOf(type: string): RuleTypeDefinition {
  const entry = REGISTRY.get(type);
  if (entry === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'rule_type');
  return view(entry);
}

/** A type as a screen or a client reads it: plain data (the schema, the provenance, the codes that have a default with theirs), no functions. */
export interface RuleTypeDescription extends Provenance {
  type: string;
  ownerModule: string;
  modules: readonly string[];
  schema: Readonly<Record<string, FieldSpec>>;
  codes: Array<Provenance & { code: string; unverified: boolean }>;
}

export function describeRuleType(type: string): RuleTypeDescription {
  const definition = ruleTypeOf(type);
  return {
    type: definition.type,
    ownerModule: definition.ownerModule,
    modules: definition.modules,
    formula: definition.formula,
    source: definition.source,
    asOf: definition.asOf,
    legalStatus: definition.legalStatus,
    schema: definition.schema,
    codes: Object.entries(definition.defaults).map(([code, one]) => ({ code, formula: one.formula, source: one.source, asOf: one.asOf, legalStatus: one.legalStatus, unverified: one.unverified })),
  };
}

const AS_OF = '2026-11-08';
const SOURCE_RESEARCH = 'Nghiên cứu của lộ trình quản trị (docs/governance-roadmap-10of10.md): giá trị khởi điểm, cần xác nhận với khách hàng và kiểm toán';
/** A fresh copy of data from another module, so that a registered default can never be changed by the lane that owns the original. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const rule = (params: RuleParams, legalStatus?: LegalStatus, provenance: Partial<Omit<Provenance, 'legalStatus'>> = {}): DefaultInput => ({ params, ...(legalStatus === undefined ? {} : { legalStatus }), ...provenance });

// -- the alert types of the sources that were there before (G0-3) ---------------------------------------------------------------------------------------------------------------------------------

export interface AlertTypeSeed {
  code: string;
  source: string;
  owner: string;
  action: string;
  consequence: string;
  hours: number;
  severity: (typeof SEVERITIES)[number];
  why: string;
}

/** The first review day of the built-in alert types; a tenant that approves its own type chooses its own. */
export const ALERT_TYPE_FIRST_REVIEW_ON = '2027-05-08';

const CORE_ALERT_TYPE_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'APPROVAL', source: 'APPROVAL', owner: 'APPROVER', action: 'Xem hồ sơ và quyết định: duyệt, trả lại hoặc từ chối kèm lý do.', consequence: 'Hồ sơ chờ bạn duyệt bị dừng ở bước này cho đến khi có quyết định.', hours: 72, severity: 'ACTION', why: 'Quyết định chậm là điểm nghẽn phổ biến nhất của quy trình duyệt.' },
  { code: 'EXPLANATION', source: 'EXPLANATION', owner: 'RESPONDENT', action: 'Trả lời yêu cầu giải trình đúng nội dung và nộp trước hạn.', consequence: 'Yêu cầu giải trình chưa được trả lời sẽ bị tính là quá hạn và báo lên người yêu cầu.', hours: 72, severity: 'ACTION', why: 'Bảo đảm yêu cầu giải trình có câu trả lời có căn cứ trong thời hạn.' },
  { code: 'EXPLANATION_CONCLUDE', source: 'EXPLANATION_CONCLUDE', owner: 'REQUESTER', action: 'Đọc giải trình và ghi kết luận (chấp nhận hoặc yêu cầu làm lại).', consequence: 'Giải trình đã nhận chưa được kết luận thì cảnh báo liên quan vẫn còn mở.', hours: 72, severity: 'ACTION', why: 'Cảnh báo chỉ đóng được khi có kết luận của người yêu cầu giải trình.' },
  { code: 'REPORT', source: 'REPORT', owner: 'REPORT_OWNER', action: 'Hoàn thiện hoặc sửa và nộp báo cáo của kỳ.', consequence: 'Báo cáo chưa nộp đúng kỳ làm số liệu của dự án thiếu hoặc chậm trên bảng điều hành.', hours: 72, severity: 'ACTION', why: 'Số liệu kỳ báo cáo là nền của bảng điều hành và báo cáo cấp trên.' },
  { code: 'OBLIGATION', source: 'OBLIGATION', owner: 'REPORT_OWNER', action: 'Lập và nộp báo cáo giám sát đánh giá đúng hạn.', consequence: 'Báo cáo giám sát đánh giá chưa nộp đúng hạn sẽ bị ghi nhận là chậm.', hours: 120, severity: 'ACTION', why: 'Nghĩa vụ báo cáo giám sát đánh giá có hạn theo quy định.' },
  { code: 'EARLY_WARNING', source: 'EARLY_WARNING', owner: 'PROJECT_OWNER', action: 'Nhận cảnh báo, tìm nguyên nhân, ghi kế hoạch khắc phục và ngày hoàn thành.', consequence: 'Cảnh báo chưa xử lý có thể làm dự án chậm so với kế hoạch giải ngân của kỳ.', hours: 24, severity: 'ACTION', why: 'Phát hiện sớm dự án chậm giải ngân để chủ đầu tư kịp điều chỉnh.' },
  { code: 'ADVANCE', source: 'ADVANCE', owner: 'CONTRACT_MANAGER', action: 'Ghi kế hoạch thu hồi tạm ứng và ngày hoàn thành thu hồi.', consequence: 'Tạm ứng chưa thu hồi đúng hạn sẽ bị nâng cấp cảnh báo lên lãnh đạo.', hours: 120, severity: 'ACTION', why: 'Tạm ứng quá hạn là rủi ro mất vốn và phải được người phụ trách hợp đồng cam kết thu hồi.' },
  { code: 'PERMIT_EXPIRED', source: 'PERMIT', owner: 'SITE_MANAGER', action: 'Gia hạn hoặc xin cấp lại giấy phép; dừng phần việc cần giấy phép nếu chưa có.', consequence: 'Giấy phép đã hết hạn: công việc cần giấy phép này có thể phải dừng cho đến khi được gia hạn.', hours: 24, severity: 'URGENT', why: 'Thi công khi giấy phép hết hạn vi phạm quy định và có thể bị đình chỉ.' },
  { code: 'PERMIT_EXPIRING', source: 'PERMIT', owner: 'SITE_MANAGER', action: 'Nộp hồ sơ gia hạn giấy phép trước ngày hết hạn.', consequence: 'Giấy phép sắp hết hạn: cần gia hạn trước ngày hết hạn để thi công không bị gián đoạn.', hours: 336, severity: 'WATCH', why: 'Báo trước để kịp gia hạn, tránh dừng thi công.' },
  { code: 'AUDIT_RECOMMENDATION_OVERDUE', source: 'AUDIT_RECOMMENDATION', owner: 'RECOMMENDATION_OWNER', action: 'Thực hiện kiến nghị và nộp bằng chứng hoàn thành hoặc đề nghị gia hạn có lý do.', consequence: 'Kiến nghị quá hạn thực hiện sẽ tiếp tục bị đưa vào theo dõi của cơ quan kiểm toán.', hours: 168, severity: 'ACTION', why: 'Kiến nghị kiểm toán phải được thực hiện đúng hạn và chứng minh được.' },
  { code: 'AUDIT_RECOMMENDATION_ESCALATED', source: 'AUDIT_RECOMMENDATION', owner: 'UNIT_LEADER', action: 'Chỉ đạo đơn vị báo cáo kết quả xử lý kiến nghị quá hạn.', consequence: 'Kiến nghị quá hạn đã được nâng lên lãnh đạo: đơn vị cần báo cáo kết quả xử lý ngay.', hours: 48, severity: 'URGENT', why: 'Kiến nghị quá hạn kéo dài cần lãnh đạo can thiệp.' },
  { code: 'ISSUE_SLA_BREACH', source: 'ISSUE', owner: 'ISSUE_OWNER', action: 'Xử lý vấn đề hoặc ghi lý do và kế hoạch giải quyết mới.', consequence: 'Vấn đề vượt thời hạn xử lý sẽ tiếp tục được chuyển lên cấp cao hơn.', hours: 48, severity: 'ACTION', why: 'Vướng mắc kéo dài là nguyên nhân chính làm chậm giải ngân.' },
  { code: 'ISSUE_SLA_BREACH_L3', source: 'ISSUE', owner: 'TASK_FORCE', action: 'Tổ công tác họp và quyết định hướng giải quyết, ghi người chịu trách nhiệm và ngày.', consequence: 'Vấn đề đã lên cấp 3 (tổ công tác): cần xử lý ngay để không ảnh hưởng tiến độ dự án.', hours: 24, severity: 'URGENT', why: 'Cấp cuối của chuỗi leo thang vướng mắc, không còn cấp nào khác nhận thay.' },
  { code: 'SITE_DIARY', source: 'SITE_DIARY', owner: 'SITE_SUPERVISOR', action: 'Bổ sung nhật ký công trường của các ngày còn thiếu.', consequence: 'Thiếu nhật ký công trường thì hồ sơ chất lượng không đủ căn cứ để nghiệm thu.', hours: 168, severity: 'WATCH', why: 'Nhật ký công trường là căn cứ nghiệm thu và truy trách nhiệm chất lượng.' },
  { code: 'GUARANTEE', source: 'GUARANTEE', owner: 'CONTRACT_MANAGER', action: 'Yêu cầu nhà thầu gia hạn hoặc thay bảo lãnh trước ngày hết hạn.', consequence: 'Bảo lãnh hết hạn mà chưa được thay thế thì hợp đồng không còn được bảo đảm.', hours: 168, severity: 'WATCH', why: 'Bảo lãnh là khoản bảo đảm tiền cho chủ đầu tư; hết hạn là mất bảo đảm.' },
];

/** The alert types as built-in defaults of `ALERT_TYPE`: what a lane gives for its own alerts (`registerRuleDefaults('ALERT_TYPE', alertTypeDefaults([...]))`). */
export function alertTypeDefaults(seeds: readonly AlertTypeSeed[], provenance: Partial<Omit<Provenance, 'legalStatus'>> = {}): Record<string, DefaultInput> {
  return Object.fromEntries(
    seeds.map((seed) => [
      seed.code,
      rule(
        {
          source: seed.source,
          owner: seed.owner,
          expected_action: seed.action,
          consequence: seed.consequence,
          response_hours: seed.hours,
          default_severity: seed.severity,
          reason_to_exist: seed.why,
          review_on: ALERT_TYPE_FIRST_REVIEW_ON,
          enabled: true,
        },
        'VERIFIED',
        provenance,
      ),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// One function per domain. Each registers the types of its lane and the codes the lane adds under types of other lanes; each is idempotent, and the order below is the order they run in.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const done = new Set<string>();
const once = (name: string, run: () => void): void => {
  if (done.has(name)) return;
  done.add(name);
  run();
};

const SOURCE_ALERT_CENTRE = 'Sổ loại cảnh báo (G0-3 của lộ trình quản trị): mỗi loại có chủ sở hữu, hành động mong đợi, hậu quả, thời hạn đáp ứng, lý do tồn tại và ngày xét lại';
const SOURCE_KPI = 'Từ điển chỉ tiêu (G0-4 của lộ trình quản trị): một định nghĩa cho mỗi chỉ tiêu';

/** The generic kinds of rule (lane A1): the alert types, the gates, the calendar, the notification policy, the advance ceiling, the red flags, the definitions of the indicators and the lines of the traffic lights. */
export const registerCoreRules = (): void =>
  once('core', () => {
    registerRuleType({
      type: 'ALERT_TYPE',
      ownerModule: 'ADM',
      modules: ['NOT', 'HOME', 'ADM'],
      formula: 'Một loại cảnh báo nói ai phải làm (owner), làm gì (expected_action), không làm thì sao (consequence), phải đáp ứng trong bao nhiêu giờ (response_hours) và khi nào xét lại (review_on)',
      source: SOURCE_ALERT_CENTRE,
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        source: word(),
        owner: word(),
        expected_action: text(500, true, true),
        consequence: text(500),
        response_hours: int(1, 8760),
        default_severity: oneOf(...SEVERITIES),
        reason_to_exist: text(500),
        review_on: { kind: 'date' },
        enabled: bool,
      },
      // A type with no expected action can only be watched (G0-3).
      refine: (params) => ((params.expected_action === undefined || params.expected_action === '') && params.default_severity !== 'WATCH' ? 'default_severity' : undefined),
      defaults: alertTypeDefaults(CORE_ALERT_TYPE_SEEDS),
    });

    registerRuleType({
      type: 'RAG_THRESHOLDS',
      ownerModule: 'BI',
      modules: ['BI', 'HOME'],
      formula: 'Xanh khi giá trị ở phía tốt hơn ngưỡng xanh, vàng khi nằm giữa ngưỡng xanh và ngưỡng vàng, đỏ ở phía còn lại; chưa đủ phần trăm dữ liệu (min_coverage_pct) thì không xếp màu',
      source: SOURCE_RESEARCH,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { direction: oneOf('HIGHER_IS_BETTER', 'LOWER_IS_BETTER'), green: num(-1_000_000, 1_000_000), amber: num(-1_000_000, 1_000_000), min_coverage_pct: int(0, 100), weight: int(0, 100, true) },
      // The green line is on the better side of the amber line, whichever way "better" runs.
      refine: (params) => {
        const [green, amber] = [params.green as number, params.amber as number];
        return (params.direction === 'HIGHER_IS_BETTER' ? green > amber : green < amber) ? undefined : 'green';
      },
      // 0,95 / 0,85 are the starting values of the research (CPI, SPI, ratio of disbursement to plan), to be confirmed with the customer and the auditors.
      defaults: {
        DISBURSEMENT_RATIO: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
        CPI: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
        SPI: rule({ direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 80 }),
      },
    });

    registerRuleType({
      type: 'GATE_CRITERIA',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'ADM'],
      formula: 'Một dự án chỉ sang giai đoạn kế khi mọi tiêu chí bắt buộc có bằng chứng; ngoại lệ cần số người duyệt ghi trong quy tắc',
      source: 'Cổng giai đoạn (G1-1 của lộ trình quản trị): bộ tiêu chí mặc định tối thiểu, mỗi đơn vị bổ sung tiêu chí của mình',
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        from_stage: word(),
        to_stage: word(),
        exception_allowed: bool,
        exception_approvers: int(1, 3),
        criteria: list(shape({ code: word(), label: text(200), mandatory: bool, evidence: oneOf('DOCUMENT', 'APPROVAL', 'DATA_CHECK', 'ATTESTATION') }), 40),
      },
      defaults: {
        DEFAULT: rule({
          from_stage: 'ANY',
          to_stage: 'NEXT',
          exception_allowed: true,
          exception_approvers: 2,
          criteria: [{ code: 'RECORD_COMPLETE', label: 'Hồ sơ của giai đoạn đã đủ', mandatory: true, evidence: 'DOCUMENT' }],
        }),
      },
    });

    registerRuleType({
      type: 'KPI_DEFINITION',
      ownerModule: 'BI',
      modules: ['BI', 'HOME'],
      formula: 'Chỉ tiêu = tử số / mẫu số trong kỳ đã nêu, trừ các khoản loại trừ, làm tròn theo số chữ số thập phân, trễ tối đa allowed_lag_days ngày so với ngày chốt',
      source: SOURCE_KPI,
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        name: text(120),
        formula: text(500),
        source: text(200),
        unit: oneOf('PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO'),
        owner: word(),
        decimals: int(0, 4),
        refresh_hours: int(1, 744),
        // G0-4: one definition per indicator (the numerator, the denominator, what is left out, the period, how late the figure may be, and the RAG line it is read against).
        numerator: text(300, true),
        denominator: text(300, true),
        exclusions: optionally(list(text(200), 10)),
        period: { kind: 'enum', values: ['YEAR_TO_DATE', 'AS_OF_NOW', 'WEEK', 'MONTH', 'QUARTER'], optional: true },
        allowed_lag_days: int(0, 90, true),
        rag_code: word(true),
      },
      defaults: {
        DISBURSEMENT_RATE: rule({ name: 'Tỷ lệ giải ngân', formula: 'Giá trị đã giải ngân lũy kế / kế hoạch vốn của năm', source: 'Phân hệ giải ngân (DIS), số đã chốt', unit: 'PERCENT', owner: 'CAPITAL_PLANNER', decimals: 1, refresh_hours: 24 }, undefined, {
          formula: 'Giá trị đã giải ngân lũy kế chia cho kế hoạch vốn của năm',
          source: 'Phân hệ giải ngân (DIS), số đã chốt',
        }),
        PHYSICAL_PROGRESS: rule({ name: 'Tiến độ vật lý', formula: 'Khối lượng đã nghiệm thu / khối lượng theo hợp đồng', source: 'Biên bản nghiệm thu (CTR), số đã chốt', unit: 'PERCENT', owner: 'PROJECT_OWNER', decimals: 1, refresh_hours: 24 }, undefined, {
          formula: 'Khối lượng đã nghiệm thu chia cho khối lượng theo hợp đồng',
          source: 'Biên bản nghiệm thu (CTR), số đã chốt',
        }),
      },
    });

    registerRuleType({
      type: 'NOTIFICATION_POLICY',
      ownerModule: 'NOT',
      modules: ['NOT', 'IAM'],
      formula: 'Không đẩy thông báo trong giờ yên lặng (từ quiet_from đến quiet_to) trừ khi quá hạn khẩn; tin gộp gửi lúc digest_at; tối đa max_push_per_day tin đẩy mỗi ngày',
      source: SOURCE_RESEARCH,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { quiet_from: { kind: 'time' }, quiet_to: { kind: 'time' }, overdue_urgent_bypasses_quiet: bool, digest_at: { kind: 'time' }, max_push_per_day: int(0, 100), group_same_root: bool },
      defaults: { DEFAULT: rule({ quiet_from: '21:00', quiet_to: '06:30', overdue_urgent_bypasses_quiet: true, digest_at: '07:30', max_push_per_day: 8, group_same_root: true }) },
    });

    registerRuleType({
      type: 'ADVANCE_POLICY',
      ownerModule: 'PAY',
      modules: ['PAY', 'CTR'],
      formula: 'Tạm ứng không quá max_pct_of_contract % giá trị hợp đồng; thu hồi bắt đầu khi thanh toán đạt recovery_starts_at_pct % và xong khi đạt fully_recovered_at_pct %; quá hạn sau overdue_after_days ngày',
      source: 'Trần và đường cong thu hồi tạm ứng: giá trị khởi điểm của nghiên cứu (lộ trình ghi chưa kiểm chứng), phải đối chiếu văn bản pháp luật hiện hành trước khi khách hàng dựa vào',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { max_pct_of_contract: num(0, 100), recovery_starts_at_pct: num(0, 100), fully_recovered_at_pct: num(0, 100), overdue_after_days: int(0, 365) },
      refine: (params) => ((params.recovery_starts_at_pct as number) > (params.fully_recovered_at_pct as number) ? 'recovery_starts_at_pct' : undefined),
      defaults: { DEFAULT: rule({ max_pct_of_contract: 20, recovery_starts_at_pct: 20, fully_recovered_at_pct: 80, overdue_after_days: 30 }) },
    });

    registerRuleType({
      type: 'RED_FLAG_RULE',
      ownerModule: 'AUD',
      modules: ['BID', 'CTR', 'AUD'],
      formula: 'Một dấu hiệu đáng ngờ là tín hiệu để kiểm toán xem xét, không phải kết luận; trọng số (1 đến 5) chỉ dùng để sắp thứ tự danh sách',
      source: 'Bộ chỉ báo OCP của G4-3 (lane GOV-10 thêm mười hai chỉ báo dưới mã riêng) và nghiên cứu của lộ trình quản trị',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { indicator: text(200), threshold: num(0, 1_000_000_000, true), window_days: int(1, 3650, true), weight: int(1, 5), enabled: bool },
      defaults: {
        SINGLE_BIDDER: rule({ indicator: 'Chỉ có một nhà thầu nộp hồ sơ dự thầu', weight: 3, enabled: true }),
        SHORT_TENDER_PERIOD: rule({ indicator: 'Thời gian chuẩn bị hồ sơ dự thầu ngắn hơn mức tối thiểu', threshold: 10, weight: 2, enabled: true }),
      },
    });

    registerRuleType({
      type: 'WORKING_CALENDAR',
      ownerModule: 'ADM',
      modules: ['ADM', 'NOT'],
      formula: 'Ngày làm việc là ngày không thuộc weekend_days và không nằm trong holidays (trừ special_workdays), từ day_starts đến day_ends; Chủ nhật là 0',
      source: 'Lịch nghỉ lễ do Nhà nước công bố mỗi năm: đơn vị duyệt thành quy tắc (mặc định không có ngày nghỉ lễ nên một năm thiếu lịch hiện ra thay vì bị đoán)',
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
      schema: {
        weekend_days: list({ kind: 'int', min: 0, max: 6 }, 7),
        holidays: list({ kind: 'date' }, 120),
        special_workdays: list({ kind: 'date' }, 60),
        day_starts: { kind: 'time' },
        day_ends: { kind: 'time' },
      },
      defaults: { DEFAULT: rule({ weekend_days: [0, 6], holidays: [], special_workdays: [], day_starts: '08:00', day_ends: '17:00' }) },
    });
  });

const CLOCK_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'CLOCK',
    source: 'CLOCK',
    owner: 'ITEM_OWNER',
    action: 'Làm việc mà đồng hồ giờ làm việc đang đếm và ghi kết quả, hoặc xin tạm dừng đồng hồ có lý do.',
    consequence: 'Thời hạn của việc này tính theo giờ làm việc; quá hạn sẽ bị ghi nhận là chậm và báo lên cấp trên.',
    hours: 48,
    severity: 'ACTION',
    why: 'Việc có đồng hồ riêng (nghĩa vụ đăng tải, thời hiệu, hạn phản hồi) phải được đếm theo giờ làm việc và nhắc đúng lúc.',
  },
];

/** The clocks of the alert centre (lane A2: G2-1, G2-2, G2-4; packages/kernel/src/work-clock.ts): snooze, the two clocks and their pause, the cadence of reminders. The code that applies to everybody is `DEFAULT`. */
export const registerWorkClockRules = (): void =>
  once('work-clock', () => {
    registerCoreRules();
    const source = 'G2-1, G2-2, G2-4 của lộ trình quản trị và docs/work-clocks.md: giá trị khởi điểm, cần chốt với khách hàng và kiểm toán';
    const reasons = list(codeText(), 20, 1);
    registerRuleType({
      type: 'SNOOZE_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: 'Một việc chỉ được nhắc lại sau tối đa max_days_by_severity[mức] ngày, không quá max_consecutive lần liên tiếp, phải chọn một lý do; việc Khẩn không bao giờ hoãn được',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { reasons, note_required_for: optionally(list(codeText(), 20, 1)), max_days_by_severity: perSeverity(0, 90), max_consecutive: int(1, 10), final_notifies_next_level: optionally(bool) },
      refine: refineWith(snoozePolicyOf),
      defaults: { DEFAULT: rule(plain({ ...snoozePolicyDefaults() })) },
    });
    registerRuleType({
      type: 'CLOCK_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: 'Hạn nhận việc và hạn xử lý đếm theo giờ làm việc kể từ lúc việc phát sinh, theo mức nghiêm trọng; đồng hồ tạm dừng tối đa max_pause_days ngày và phải có lý do',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        claim_within_working_hours: perSeverity(1, 720),
        resolve_within_working_hours: perSeverity(1, 2400),
        no_progress_after_working_hours: perSeverity(1, 720),
        max_pause_days: int(1, 365),
        pause_reasons: list(codeText(), 20, 1),
      },
      refine: refineWith(clockPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...clockPolicyDefaults() })) },
    });
    registerRuleType({
      type: 'REMINDER_POLICY',
      ownerModule: 'HOME',
      modules: ['HOME', 'NOT'],
      formula: 'Việc đang mở được nhắc mỗi every_working_hours[mức] giờ làm việc, tối đa max_per_item[mức] lần; hết số lần nhắc thì việc leo thang thay vì nhắc mãi',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { every_working_hours: perSeverity(1, 720), max_per_item: perSeverity(1, 500) },
      refine: refineWith(reminderPolicyOf),
      defaults: { DEFAULT: rule(plain({ ...reminderPolicyDefaults() })) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(CLOCK_ALERT_SEEDS, { source: 'Đồng hồ của trung tâm cảnh báo (lane A2, G2-2): nguồn CLOCK' }));
  });

/** The alert of the baseline lane (B1, G1-3): a milestone or the end of a project that was moved as many times as the rule `BASELINE_DEVIATION` says goes to the auditors (the table `project_governance_alert`, screen PRJ-26). */
const BASELINE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'RESCHEDULE_COUNT',
    source: 'PROJECT_GOVERNANCE',
    owner: 'AUDITOR',
    action: 'Xem nguyên nhân và lịch từng lần dời (PRJ-26), hỏi ban quản lý dự án và ghi chú xác nhận.',
    consequence: 'Đường cơ sở bị sửa nhiều lần mà không ai xem lại: kiểm toán theo dõi muộn.',
    hours: 168,
    severity: 'ACTION',
    why: 'Một mốc hoặc ngày kết thúc dự án bị dời nhiều lần là dấu hiệu kế hoạch không còn là cam kết; kiểm toán cần biết và hỏi nguyên nhân.',
  },
];

/** The baseline, the estimate at completion and the stages that may not be paid (lane B1: G1-2, G1-3, G1-4; packages/kernel/src/gov-b1-policy.ts). */
export const registerBaselineRules = (): void =>
  once('baseline', () => {
    registerCoreRules();
    const source = 'G1-2, G1-3, G1-4 của lộ trình quản trị (mục 2): giá trị khởi điểm của nghiên cứu, cần xác nhận với khách hàng và kiểm toán';
    const deviation = B1_DEFAULTS.BASELINE_DEVIATION;
    const evm = B1_DEFAULTS.EVM_POLICY;
    const precondition = B1_DEFAULTS.DISBURSEMENT_PRECONDITION;
    registerRuleType({
      type: 'BASELINE_DEVIATION',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'AUD'],
      formula: 'Cần thẩm định lại khi tổng mức đầu tư lệch khỏi đường cơ sở v0 quá cost_pct % hoặc ngày hoàn thành lệch quá slip_days ngày; một mốc dời quá reschedule_alert_count lần thì báo kiểm toán',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { cost_pct: num(0, 1000), slip_days: int(0, 3650), reschedule_alert_count: int(1, 50) },
      defaults: { DEFAULT: rule({ cost_pct: deviation.costPct, slip_days: deviation.slipDays, reschedule_alert_count: deviation.rescheduleAlertCount }) },
    });
    registerRuleType({
      type: 'EVM_POLICY',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'BI'],
      formula: 'Dự báo chi phí hoàn thành (EAC) theo eac_method; CPI và SPI từ amber_below trở lên là xanh, thấp hơn là vàng, thấp hơn red_below là đỏ',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { eac_method: oneOf(...EAC_METHODS), amber_below: num(0, 2), red_below: num(0, 2) },
      refine: (params) => ((params.red_below as number) > (params.amber_below as number) ? 'red_below' : undefined),
      defaults: { DEFAULT: rule({ eac_method: evm.eacMethod, amber_below: evm.amberBelow, red_below: evm.redBelow }) },
    });
    registerRuleType({
      type: 'DISBURSEMENT_PRECONDITION',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'PAY', 'DIS'],
      formula: 'Dự án đang ở một trong các giai đoạn unlisted_statuses thì chưa nằm trong danh mục dự án đầu tư nên không được thanh toán; không có kế hoạch vốn đã duyệt trên hệ thống thì bị từ chối',
      source: 'Nghị định 85/2025/NĐ-CP Điều 53 (danh mục dự án đầu tư): số liệu chưa kiểm chứng với văn bản gốc, cần xác nhận trước khi khách hàng dựa vào',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { unlisted_statuses: list(codeText(), 20), require_approved_plan: bool },
      defaults: { DEFAULT: rule({ unlisted_statuses: [...precondition.unlistedStatuses], require_approved_plan: precondition.requireApprovedPlan }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(BASELINE_ALERT_SEEDS, { source: 'Đường cơ sở và số lần dời mốc (lane B1, G1-3): cảnh báo gửi kiểm toán của nguồn PROJECT_GOVERNANCE' }));
  });

const AMOUNT_PATTERN = '^(0|[1-9][0-9]{0,23})$';
const PERCENT_PATTERN = '^(0|[1-9][0-9]{0,2})(\\.[0-9]{1,2})?$';
const amountText: FieldSpec = { kind: 'text', max: 24, pattern: AMOUNT_PATTERN };
const percentText: FieldSpec = { kind: 'text', max: 6, pattern: PERCENT_PATTERN };

const MONEY_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  {
    code: 'EAC_EXCEEDS_TMDT',
    source: 'MONEY_CONTROL',
    owner: 'PROJECT_OWNER',
    action: 'Xem dự báo chi phí hoàn thành, tìm nguyên nhân và đề nghị điều chỉnh tổng mức đầu tư hoặc cắt giảm phạm vi.',
    consequence: 'Dự báo chi phí hoàn thành vượt tổng mức đầu tư đã duyệt: dự án cần điều chỉnh quyết định đầu tư trước khi ký thêm hợp đồng hoặc lệnh thay đổi.',
    hours: 48,
    severity: 'URGENT',
    why: 'Vượt tổng mức đầu tư mà không điều chỉnh là vi phạm kiểm soát vốn và làm các hợp đồng sau đó thiếu nguồn.',
  },
  {
    code: 'RESERVE_BELOW_RISK_EV',
    source: 'MONEY_CONTROL',
    owner: 'PROJECT_OWNER',
    action: 'Rà soát sổ rủi ro, bổ sung dự phòng hoặc giảm rủi ro để dự phòng còn lại đủ che giá trị kỳ vọng.',
    consequence: 'Dự phòng còn lại thấp hơn giá trị kỳ vọng của các rủi ro đang mở: một rủi ro xảy ra sẽ phải xin điều chỉnh thay vì rút dự phòng.',
    hours: 120,
    severity: 'ACTION',
    why: 'Dự phòng phải che được các rủi ro đã biết, nếu không mọi biến động đều thành xin điều chỉnh.',
  },
  {
    code: 'ADVANCE_EXCEEDS_REMAINING',
    source: 'MONEY_CONTROL',
    owner: 'CONTRACT_MANAGER',
    action: 'Lập kế hoạch thu hồi tạm ứng với nhà thầu: giảm trừ vào kỳ thanh toán gần nhất hoặc yêu cầu hoàn trả.',
    consequence: 'Dư nợ tạm ứng lớn hơn giá trị còn lại phải thanh toán: không kỳ thanh toán nào còn đủ để thu hồi, và thanh toán cuối sẽ bị chặn.',
    hours: 48,
    severity: 'URGENT',
    why: 'Tạm ứng không còn đủ giá trị thanh toán để thu hồi là rủi ro mất vốn thực sự.',
  },
];

/** The control of the money (lane B2: G1-6, G1-7, G1-11; packages/kernel/src/money-control-policy.ts). The params keep the names and the string numbers of that module (amounts in whole VND, percents with two decimals). */
export const registerMoneyRules = (): void =>
  once('money', () => {
    registerCoreRules();
    const source = 'CTR F05 và G1-6, G1-7, G1-11 của lộ trình quản trị: giá trị khởi điểm của nghiên cứu; số của pháp luật (trần tạm ứng của Nghị định 254/2025) không nằm ở đây mà là quy tắc chủ đang chờ xác nhận';
    const money = <K extends MoneyRuleType>(type: K): RuleParams => plain(MONEY_RULE_DEFAULTS[type]) as unknown as RuleParams;
    registerRuleType({
      type: 'CHANGE_ORDER_TIER',
      ownerModule: 'CTR',
      modules: ['CTR', 'PRJ', 'ADM'],
      formula: 'Lệnh thay đổi thuộc bậc 1 hoặc 2 khi cả giá trị của lần đổi (maxAmountVnd) và tổng biến động lũy kế so với giá gốc (maxCumulativePct) còn trong bậc; vượt bậc 2 là bậc 3; từ projectAdjustmentPct % buộc kiểm tra điều chỉnh dự án',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        bands: list(shape({ tier: optionally(int(1, 2)), maxAmountVnd: amountText, maxCumulativePct: percentText }), 2, 2),
        projectAdjustmentPct: percentText,
        requireReserveCover: bool,
      },
      refine: refineWith((params) => parseMoneyRuleParams('CHANGE_ORDER_TIER', params)),
      defaults: { DEFAULT: rule(money('CHANGE_ORDER_TIER')) },
    });
    registerRuleType({
      type: 'RESERVE_POLICY',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'CAP'],
      formula: 'Báo khi số dư dự phòng thấp hơn coverAlertBelowPct % giá trị kỳ vọng của các rủi ro đang mở',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { coverAlertBelowPct: percentText },
      refine: refineWith((params) => parseMoneyRuleParams('RESERVE_POLICY', params)),
      defaults: { DEFAULT: rule(money('RESERVE_POLICY')) },
    });
    registerRuleType({
      type: 'CONTRACT_AVC',
      ownerModule: 'CAP',
      modules: ['CAP', 'CTR', 'PRJ'],
      formula: 'Báo khi dự báo chi phí hoàn thành (EAC) vượt tổng mức đầu tư đã duyệt quá eacAlertAbovePct %',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { eacAlertAbovePct: percentText },
      refine: refineWith((params) => parseMoneyRuleParams('CONTRACT_AVC', params)),
      defaults: { DEFAULT: rule(money('CONTRACT_AVC')) },
    });
    registerRuleType({
      type: 'ADVANCE_RECOVERY',
      ownerModule: 'PAY',
      modules: ['PAY', 'CTR'],
      formula: 'Thanh toán cuối bị từ chối khi hợp đồng còn dư nợ tạm ứng sau lần thu hồi của đề nghị đó, trừ phần chênh làm tròn không quá toleranceVnd đồng',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { finalPaymentRequiresFullRecovery: bool, toleranceVnd: amountText },
      refine: refineWith((params) => parseMoneyRuleParams('ADVANCE_RECOVERY', params)),
      defaults: { DEFAULT: rule(money('ADVANCE_RECOVERY')) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(MONEY_ALERT_SEEDS, { source: 'Kiểm soát tiền (lane B2): ba cảnh báo của trung tâm cảnh báo, nguồn MONEY_CONTROL' }));
  });

const ANALYTICS_SOURCE = 'Từ điển chỉ tiêu và điểm cảnh báo sớm (G0-4, G3-2 của lộ trình quản trị): giá trị khởi điểm của nghiên cứu, cần xác nhận với khách hàng và kiểm toán';

/** The indicators of the command centre and the factors of the early-warning score (lane C: G0-4, G3-2; packages/kernel/src/analytics-rule-defaults.ts) added under `KPI_DEFINITION` and `RAG_THRESHOLDS`. */
export const registerAnalyticsRules = (): void =>
  once('analytics', () => {
    registerCoreRules();
    const status = (unverified: boolean): LegalStatus => (unverified ? 'UNVERIFIED' : 'VERIFIED');
    registerRuleDefaults(
      'KPI_DEFINITION',
      Object.fromEntries(
        Object.entries(KPI_HOME_DEFAULTS).map(([code, one]) => [
          code,
          rule(plain(one.params), status(one.unverified), { formula: String(one.params.formula ?? ''), source: String(one.params.source ?? ANALYTICS_SOURCE), asOf: AS_OF }),
        ]),
      ),
    );
    registerRuleDefaults(
      'RAG_THRESHOLDS',
      Object.fromEntries(
        Object.entries(RAG_EWS_DEFAULTS).map(([code, one]) => {
          const direction = one.params.direction === 'HIGHER_IS_BETTER' ? 'cao hơn' : 'thấp hơn';
          const weight = typeof one.params.weight === 'number' ? ` với trọng số ${one.params.weight}` : '';
          return [
            code,
            rule(plain(one.params), status(one.unverified), {
              formula: `Giá trị ${direction} ${String(one.params.green)} là xanh, ${direction} ${String(one.params.amber)} là vàng, còn lại là đỏ${weight}; điểm cảnh báo sớm chạy từ 0 (không có gì sai) đến 100`,
              source: ANALYTICS_SOURCE,
              asOf: AS_OF,
            }),
          ];
        }),
      ),
    );
  });

const SOD_CONFLICT = (action_a: string, action_b: string, scope: (typeof SCOPES)[number], exception_max_days: number): Record<string, unknown> => ({ action_a, action_b, scope, severity: 'BLOCK', exception_max_days });

const INTEGRITY_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'SOD_EXCEPTION_EXPIRING', source: 'SOD_EXCEPTION', owner: 'ADM_ADMINISTRATOR', action: 'Xem ngoại lệ tách bạch nhiệm vụ sắp hết hạn: gia hạn có lý do hoặc để hết hạn và phân việc lại.', consequence: 'Ngoại lệ hết hạn thì người giữ cả hai nhiệm vụ bị chặn ở lần thao tác kế tiếp.', hours: 120, severity: 'ACTION', why: 'Ngoại lệ tách bạch nhiệm vụ phải có hạn và người chịu trách nhiệm, không kéo dài ngầm.' },
  { code: 'SOD_EXCEPTION_USED', source: 'SOD_EXCEPTION', owner: 'AUDITOR', action: 'Xem hồ sơ đã đi qua ngoại lệ tách bạch nhiệm vụ và ghi nhận xét.', consequence: 'Hồ sơ đi qua ngoại lệ mà không ai xem lại thì ngoại lệ mất tác dụng kiểm soát.', hours: 336, severity: 'WATCH', why: 'Kiểm toán cần biết mỗi lần ngoại lệ được dùng.' },
  { code: 'PAYMENT_INTEGRITY_BLOCKED', source: 'PAYMENT_INTEGRITY', owner: 'PAYMENT_APPROVER', action: 'Xem các phát hiện và sửa đề nghị thanh toán hoặc xin ngoại lệ có lý do.', consequence: 'Đề nghị thanh toán bị chặn không gửi đi được cho đến khi hết phát hiện chặn hoặc có ngoại lệ được duyệt.', hours: 72, severity: 'ACTION', why: 'Chặn trùng lặp, vượt hợp đồng, vượt kế hoạch và vượt giá trị nghiệm thu trước khi tiền đi ra.' },
  { code: 'PAYMENT_INTEGRITY_SIGNAL', source: 'PAYMENT_INTEGRITY', owner: 'PAYMENT_APPROVER', action: 'Xem tín hiệu bất thường của đề nghị thanh toán và ghi nhận xét trước khi duyệt.', consequence: 'Tín hiệu bất thường không được xem xét sẽ còn nguyên trong hồ sơ cho kiểm toán.', hours: 168, severity: 'WATCH', why: 'Tín hiệu là căn cứ để người duyệt hỏi lại, không phải kết luận.' },
  { code: 'DISBURSEMENT_EXCEPTION_EXPIRING', source: 'DISBURSEMENT_EXCEPTION', owner: 'CONTRACT_MANAGER', action: 'Xử lý nguyên nhân vượt trần hoặc xin gia hạn ngoại lệ giải ngân có lý do.', consequence: 'Ngoại lệ giải ngân hết hạn thì thanh toán vượt trần bị chặn trở lại.', hours: 168, severity: 'WATCH', why: 'Ngoại lệ vượt trần giải ngân phải có hạn.' },
  { code: 'TREASURY_RECON_ITEM_OVERDUE', source: 'TREASURY_RECON', owner: 'RECON_ITEM_OWNER', action: 'Giải trình hoặc xử lý chênh lệch đối chiếu Kho bạc và ghi kết quả.', consequence: 'Chỉ tiêu liên quan vẫn bị đánh dấu và một vướng mắc được mở ở phân hệ ISS.', hours: 72, severity: 'ACTION', why: 'Chênh lệch với Kho bạc không có người xử lý là chỗ số liệu giải ngân mất tin cậy.' },
  { code: 'CROSS_TOTAL_MISMATCH', source: 'CROSS_TOTAL', owner: 'DIS_DATA_STEWARD', action: 'Sửa chiều đang lệch (đơn vị, nguồn vốn hoặc dự án) rồi chạy lại đối chiếu tổng chéo.', consequence: 'Chỉ tiêu không được công bố cho đến khi ba tổng khớp nhau.', hours: 48, severity: 'ACTION', why: 'Ba cách cộng cùng một số liệu giải ngân phải ra cùng một tổng trước khi công bố.' },
];

/**
 * Integrity of the money and of the duties (lane D: G4-1, G4-2, G4-4, G4-5): the matrix of conflicting duties, the checks of a payment request, the reconciliation with the Treasury. The shapes follow the plans of
 * lane D (docs/gov-d-*.md); the lane adjusts them here when its code settles. Every number is a starting value that says so on the screen.
 */
export const registerIntegrityRules = (): void =>
  once('integrity', () => {
    registerCoreRules();
    const source = 'G4-1, G4-2, G4-4, G4-5 của lộ trình quản trị: giá trị khởi điểm của nghiên cứu, cần xác nhận với khách hàng và kiểm toán';
    registerRuleType({
      type: 'SOD_MATRIX',
      ownerModule: 'ADM',
      modules: ['ADM', 'CTR', 'PAY', 'BID'],
      formula: 'Một người không được giữ cả hai việc của một cặp trong cùng phạm vi (cùng bản ghi, dự án, hợp đồng hoặc gói thầu); cặp BLOCK chặn, cặp WARN chỉ cảnh báo; ngoại lệ tối đa exception_max_days ngày và cần exception_approvers người duyệt',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        conflicts: list(shape({ action_a: word(), action_b: word(), scope: oneOf(...SCOPES), severity: oneOf('BLOCK', 'WARN'), exception_max_days: int(0, 90) }), 60),
        exception_approvers: int(1, 3),
      },
      defaults: {
        DEFAULT: rule({
          exception_approvers: 2,
          conflicts: [
            SOD_CONFLICT('contract.draft', 'contract.approve', 'SAME_CONTRACT', 14),
            SOD_CONFLICT('measurement.record', 'measurement.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('acceptance.record', 'acceptance.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('payment.request', 'payment.verify', 'SAME_RECORD', 14),
            SOD_CONFLICT('payment.request', 'payment.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('advance.request', 'advance.approve', 'SAME_RECORD', 14),
            SOD_CONFLICT('bid.evaluate', 'bid.award', 'SAME_PACKAGE', 0),
            SOD_CONFLICT('bid.evaluate', 'bid.sign_off', 'SAME_PACKAGE', 0),
            // Lane D (G4-1): the chain across the steps of one contract is watched, not stopped: whoever approved the work and then checks the payment of the same contract is shown to the auditor (WARN).
            { ...SOD_CONFLICT('acceptance.approve', 'payment.verify', 'SAME_CONTRACT', 14), severity: 'WARN' },
            { ...SOD_CONFLICT('measurement.approve', 'payment.request', 'SAME_CONTRACT', 14), severity: 'WARN' },
            { ...SOD_CONFLICT('contract.approve', 'payment.approve', 'SAME_CONTRACT', 14), severity: 'WARN' },
          ],
        }),
      },
    });
    registerRuleType({
      type: 'PAYMENT_INTEGRITY',
      ownerModule: 'PAY',
      modules: ['PAY', 'AUD', 'CTR'],
      formula:
        'Chặn khi đề nghị trùng số, nhà cung cấp và số tiền, hoặc vượt trần hợp đồng, kế hoạch hay giá trị nghiệm thu; báo tín hiệu khi khớp từ signal_min_matches thuộc tính, đơn giá lệch quá ngưỡng (hợp đồng hoặc z-score vững so với tối thiểu peer_min đơn giá cùng loại) hoặc khối lượng lệch nhật ký công trường quá tolerance_pct %',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        duplicate: shape({ block_attrs: list(oneOf('NUMBER', 'SUPPLIER', 'AMOUNT', 'DATE'), 4, 1), signal_min_matches: int(1, 5), lookback_days: int(1, 3650) }),
        unit_price: shape({ contract_tolerance_pct: num(0, 1000), peer_min: int(2, 1000), robust_z: num(0, 20) }),
        diary: shape({ tolerance_pct: num(0, 1000), min_diary_days_ratio: num(0, 1) }),
        ceilings: shape({ plan: oneOf('BLOCK', 'WARN'), contract: oneOf('BLOCK', 'WARN'), accepted: oneOf('BLOCK', 'WARN') }),
        exception_max_days: int(0, 90),
      },
      defaults: {
        DEFAULT: rule({
          duplicate: { block_attrs: ['NUMBER', 'SUPPLIER', 'AMOUNT'], signal_min_matches: 3, lookback_days: 365 },
          unit_price: { contract_tolerance_pct: 15, peer_min: 5, robust_z: 3.5 },
          diary: { tolerance_pct: 10, min_diary_days_ratio: 0.5 },
          ceilings: { plan: 'BLOCK', contract: 'BLOCK', accepted: 'BLOCK' },
          exception_max_days: 30,
        }),
      },
    });
    registerRuleType({
      type: 'RECONCILIATION_POLICY',
      ownerModule: 'PAY',
      modules: ['PAY', 'DIS'],
      formula: 'Chênh lệch giữa sổ và sao kê Kho bạc lớn hơn hẳn threshold_vnd đồng (hoặc threshold_pct % khi có) thì mở một mục đối chiếu, hạn xử lý due_days ngày làm việc; không có sao kê sau partial_after_days ngày thì lượt đối chiếu là một phần, không bao giờ là không lệch',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { threshold_vnd: int(0, 1_000_000_000_000), threshold_pct: num(0, 100, true), due_days: int(1, 60), partial_after_days: int(0, 30) },
      defaults: { DEFAULT: rule({ threshold_vnd: 1_000_000, due_days: 3, partial_after_days: 1 }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(INTEGRITY_ALERT_SEEDS, { source: 'Tính toàn vẹn của tiền và nhiệm vụ (lane D, G4-1, G4-2, G4-4, G4-5): các loại cảnh báo đề xuất của lane' }));
  });

export const CONTRACT_HEALTH_INDICATORS = ['AWARD_PRICE_VARIANCE_PCT', 'CHANGE_GROWTH_PCT', 'PAID_VS_ACCEPTED_PCT', 'ADVANCE_OPEN_PCT', 'DELAY_DAYS'] as const;

/** The health of a contract and the concentration of the portfolio (lane CA: CA-1, CA-3). */
export const registerContractRules = (): void =>
  once('contract', () => {
    registerCoreRules();
    const source = 'CA-1, CA-3 của kế hoạch phân tích hợp đồng: giá trị khởi điểm của nghiên cứu (chỉ số HHI theo ngưỡng tập trung của hướng dẫn sáp nhập Hoa Kỳ 2023: 1.000 và 1.800), cần xác nhận với khách hàng và kiểm toán';
    registerRuleType({
      type: 'CONTRACT_HEALTH_RAG',
      ownerModule: 'CTR',
      modules: ['CTR', 'BI', 'HOME'],
      formula: 'Điểm sức khỏe hợp đồng = tổng trọng số của các chỉ báo nằm ngoài vạch xanh (nửa trọng số khi ở vùng vàng, cả trọng số khi ở vùng đỏ), từ 0 đến 100; xanh khi không quá score_green_at_most, vàng khi không quá score_amber_at_most, còn lại đỏ; thiếu dữ liệu dưới min_coverage_pct thì không xếp màu',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        factors: list(shape({ indicator: oneOf(...CONTRACT_HEALTH_INDICATORS), direction: oneOf('HIGHER_IS_BETTER', 'LOWER_IS_BETTER'), green: num(-1_000_000, 1_000_000), amber: num(-1_000_000, 1_000_000), weight: int(1, 100) }), 12, 1),
        score_green_at_most: num(0, 100),
        score_amber_at_most: num(0, 100),
        min_coverage_pct: int(0, 100),
      },
      refine: (params) => {
        const factors = params.factors as Array<{ indicator: string; direction: string; green: number; amber: number; weight: number }>;
        if (new Set(factors.map((factor) => factor.indicator)).size !== factors.length) return 'factors';
        if (factors.some((factor) => (factor.direction === 'HIGHER_IS_BETTER' ? factor.green <= factor.amber : factor.green >= factor.amber))) return 'factors';
        if (factors.reduce((sum, factor) => sum + factor.weight, 0) !== 100) return 'factors';
        return (params.score_green_at_most as number) < (params.score_amber_at_most as number) ? undefined : 'score_green_at_most';
      },
      defaults: {
        DEFAULT: rule({
          factors: [
            { indicator: 'AWARD_PRICE_VARIANCE_PCT', direction: 'LOWER_IS_BETTER', green: 0, amber: 2, weight: 20 },
            { indicator: 'CHANGE_GROWTH_PCT', direction: 'LOWER_IS_BETTER', green: 5, amber: 10, weight: 20 },
            { indicator: 'PAID_VS_ACCEPTED_PCT', direction: 'LOWER_IS_BETTER', green: 100, amber: 110, weight: 20 },
            { indicator: 'ADVANCE_OPEN_PCT', direction: 'LOWER_IS_BETTER', green: 20, amber: 40, weight: 20 },
            { indicator: 'DELAY_DAYS', direction: 'LOWER_IS_BETTER', green: 0, amber: 30, weight: 20 },
          ],
          score_green_at_most: 25,
          score_amber_at_most: 45,
          min_coverage_pct: 60,
        }),
      },
    });
    registerRuleType({
      type: 'CONTRACT_CONCENTRATION',
      ownerModule: 'CTR',
      modules: ['CTR', 'BI', 'AUD'],
      formula: 'Tỷ trọng của top_n nhà thầu lớn nhất và chỉ số HHI (tổng bình phương tỷ trọng phần trăm, 0 đến 10.000) tính trên basis, giá trị liên danh chia theo tỷ lệ góp của từng bên; vàng từ ngưỡng amber, đỏ từ ngưỡng red; dưới min_contracts hợp đồng thì không xếp màu',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        basis: oneOf('CONTRACT_VALUE', 'CONTRACT_COUNT'),
        top_n: int(1, 20),
        top_share_amber_pct: num(0, 100),
        top_share_red_pct: num(0, 100),
        hhi_amber: int(0, 10_000),
        hhi_red: int(0, 10_000),
        single_bidder_amber_pct: num(0, 100),
        single_bidder_red_pct: num(0, 100),
        min_contracts: int(1, 1000),
      },
      refine: (params) => {
        if ((params.top_share_amber_pct as number) > (params.top_share_red_pct as number)) return 'top_share_amber_pct';
        if ((params.hhi_amber as number) > (params.hhi_red as number)) return 'hhi_amber';
        return (params.single_bidder_amber_pct as number) > (params.single_bidder_red_pct as number) ? 'single_bidder_amber_pct' : undefined;
      },
      defaults: {
        DEFAULT: rule({ basis: 'CONTRACT_VALUE', top_n: 5, top_share_amber_pct: 50, top_share_red_pct: 70, hhi_amber: 1000, hhi_red: 1800, single_bidder_amber_pct: 20, single_bidder_red_pct: 40, min_contracts: 10 }),
      },
    });
    registerRuleType({
      type: 'CONTRACT_PAYMENT_CLOCK',
      ownerModule: 'CTR',
      modules: ['CTR', 'PAY', 'BI'],
      formula: 'Một hợp đồng đúng đồng hồ thanh toán khi đề nghị chậm nhất của nó không quá acceptance_to_request_days ngày kể từ lúc nghiệm thu được duyệt và không quá request_to_treasury_days ngày từ lúc đề nghị đến lúc gửi Kho bạc (ngày lịch); hợp đồng chưa có đề nghị nào thì không được tính là đúng hạn',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { acceptance_to_request_days: int(1, 365), request_to_treasury_days: int(1, 365) },
      refine: refineWith(paymentClockParams),
      defaults: { DEFAULT: rule({ ...paymentClockDefaults() }) },
    });
  });

const INTEGRATION_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'CONNECTOR_STALE', source: 'CONNECTOR', owner: 'INTEGRATION_ADMINISTRATOR', action: 'Kiểm tra bộ kết nối, lấy lại tệp hoặc số liệu mới nhất và ghi nguyên nhân.', consequence: 'Số liệu lấy từ nguồn bên ngoài cũ hơn mức cho phép và chỉ tiêu dựa vào đó phải ghi rõ là chưa cập nhật.', hours: 24, severity: 'ACTION', why: 'Số liệu đến từ ngoài hệ thống phải cho biết nó mới đến đâu.' },
  { code: 'EGP_POSTING_DUE', source: 'EGP_POSTING', owner: 'PROCUREMENT_OFFICER', action: 'Đăng tải thông tin lên hệ thống mạng đấu thầu quốc gia và nộp biên nhận.', consequence: 'Nghĩa vụ đăng tải sắp đến hạn: quá hạn sẽ bị ghi nhận là vi phạm quy định công khai thông tin.', hours: 48, severity: 'ACTION', why: 'Công khai thông tin đấu thầu đúng hạn là nghĩa vụ của chủ đầu tư.' },
  { code: 'EGP_POSTING_OVERDUE', source: 'EGP_POSTING', owner: 'PROCUREMENT_OFFICER', action: 'Đăng tải ngay thông tin còn thiếu và ghi lý do chậm.', consequence: 'Nghĩa vụ đăng tải đã quá hạn: đơn vị đang vi phạm quy định công khai thông tin đấu thầu.', hours: 24, severity: 'URGENT', why: 'Đăng tải chậm là vi phạm đã xảy ra và phải được xử lý ngay.' },
];

const POSTING_UNITS = ['WORKING_DAYS', 'CALENDAR_DAYS', 'MONTHS'] as const;
const POSTING_STARTS = ['DECISION_APPROVED', 'RESULT_ISSUED', 'CONTRACT_SIGNED', 'CONTRACT_COMPLETED', 'EVENT_OCCURRED', 'CONTRACTOR_NOTIFIED'] as const;

/** The data that arrives from outside and the duties of posting to the national procurement network (lane INT, EGP: EGP-1, EGP-2). */
export const registerIntegrationRules = (): void =>
  once('integration', () => {
    registerCoreRules();
    const source = 'EGP-1, EGP-2 và phụ thuộc bên ngoài của kế hoạch: giá trị khởi điểm, cần xác nhận với đơn vị vận hành hệ thống và văn bản pháp luật (Luật Đấu thầu 22/2023/QH15 và văn bản hướng dẫn)';
    registerRuleType({
      type: 'CONNECTOR_FRESHNESS',
      ownerModule: 'INT',
      modules: ['INT', 'ADM', 'HOME'],
      formula: 'Số liệu của bộ kết nối cũ hơn warn_after_hours giờ thì cảnh báo, cũ hơn max_age_hours giờ thì coi là cũ (stale_severity) và, khi figures_blocked_when_stale, chỉ tiêu dựa vào đó không được công bố như số mới',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { max_age_hours: int(1, 8760), warn_after_hours: int(1, 8760), stale_severity: oneOf(...SEVERITIES), figures_blocked_when_stale: bool },
      refine: (params) => ((params.warn_after_hours as number) > (params.max_age_hours as number) ? 'warn_after_hours' : undefined),
      defaults: {
        DEFAULT: rule({ max_age_hours: 168, warn_after_hours: 96, stale_severity: 'ACTION', figures_blocked_when_stale: false }),
        TREASURY_STATEMENT: rule({ max_age_hours: 72, warn_after_hours: 36, stale_severity: 'ACTION', figures_blocked_when_stale: true }, undefined, { formula: 'Sao kê Kho bạc cũ hơn 36 giờ thì cảnh báo, cũ hơn 72 giờ (qua cuối tuần) thì coi là cũ và số giải ngân không được công bố như số mới' }),
        EGP_FILE: rule({ max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false }, undefined, { formula: 'Tệp từ hệ thống mạng đấu thầu quốc gia cũ hơn 120 giờ thì cảnh báo, cũ hơn 168 giờ thì coi là cũ' }),
      },
    });
    registerRuleType({
      type: 'EGP_POSTING_DEADLINES',
      ownerModule: 'BID',
      modules: ['BID', 'CTR', 'HOME'],
      formula: 'Hạn đăng tải = ngày bắt đầu (starts_on) cộng due_in đơn vị due_unit (ngày làm việc theo lịch làm việc, ngày dương lịch hoặc tháng); nhắc trước remind_before_days ngày',
      source,
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { obligation: text(200), due_in: int(1, 3650), due_unit: oneOf(...POSTING_UNITS), starts_on: oneOf(...POSTING_STARTS), remind_before_days: int(0, 365), legal_basis: text(300) },
      defaults: {
        PLAN: rule({ obligation: 'Đăng kế hoạch lựa chọn nhà thầu', due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'DECISION_APPROVED', remind_before_days: 2, legal_basis: 'Chưa kiểm chứng: số ngày khởi điểm, EGP-2 đối chiếu với Luật Đấu thầu 22/2023/QH15 và Nghị định hướng dẫn' }),
        NOTICE: rule({ obligation: 'Đăng thông báo mời thầu', due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'DECISION_APPROVED', remind_before_days: 2, legal_basis: 'Chưa kiểm chứng: số ngày khởi điểm, EGP-2 đối chiếu với Luật Đấu thầu 22/2023/QH15 và Nghị định hướng dẫn' }),
        RESULT: rule({ obligation: 'Đăng kết quả lựa chọn nhà thầu', due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'RESULT_ISSUED', remind_before_days: 2, legal_basis: 'Chưa kiểm chứng: số ngày khởi điểm, EGP-2 đối chiếu với Luật Đấu thầu 22/2023/QH15 và Nghị định hướng dẫn' }),
        CONTRACT_INFO: rule({ obligation: 'Đăng thông tin hợp đồng', due_in: 5, due_unit: 'WORKING_DAYS', starts_on: 'CONTRACT_SIGNED', remind_before_days: 2, legal_basis: 'Chưa kiểm chứng: số ngày khởi điểm, EGP-2 đối chiếu với Luật Đấu thầu 22/2023/QH15 và Nghị định hướng dẫn' }),
        CONTRACTOR_PERFORMANCE: rule({ obligation: 'Đăng kết quả đánh giá nhà thầu', due_in: 6, due_unit: 'MONTHS', starts_on: 'CONTRACT_COMPLETED', remind_before_days: 14, legal_basis: 'Kế hoạch EGP-2: 6 tháng; chưa kiểm chứng với văn bản gốc' }),
        VIOLATION: rule({ obligation: 'Đăng thông tin nhà thầu vi phạm', due_in: 7, due_unit: 'WORKING_DAYS', starts_on: 'EVENT_OCCURRED', remind_before_days: 2, legal_basis: 'Kế hoạch EGP-2: 7 ngày làm việc; chưa kiểm chứng với văn bản gốc' }),
        REPUTATION_EVENT: rule({ obligation: 'Đăng sự kiện uy tín dự thầu của nhà thầu', due_in: 7, due_unit: 'WORKING_DAYS', starts_on: 'EVENT_OCCURRED', remind_before_days: 2, legal_basis: 'NĐ 214/2025/NĐ-CP Điều 20.1-2 (7 ngày làm việc), đã đọc từ bản PDF, chưa đối chiếu Công báo' }),
        CONTRACTOR_RESPONSE: rule({ obligation: 'Nhà thầu phản hồi đánh giá', due_in: 20, due_unit: 'CALENDAR_DAYS', starts_on: 'CONTRACTOR_NOTIFIED', remind_before_days: 5, legal_basis: 'Kế hoạch EGP-2: 20 ngày; chưa rõ ngày làm việc hay ngày dương lịch, chưa kiểm chứng với văn bản gốc' }),
      },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(INTEGRATION_ALERT_SEEDS, { source: 'Tích hợp ngoài (EGP-1, EGP-2): các loại cảnh báo của nghĩa vụ đăng tải và độ mới của số liệu' }));
  });

const DIRECTIVE_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'DIRECTIVE_DUE', source: 'DIRECTIVE', owner: 'DIRECTIVE_ASSIGNEE', action: 'Báo cáo tiến độ thực hiện chỉ đạo hoặc đề nghị gia hạn có lý do trước ngày đến hạn.', consequence: 'Chỉ đạo sắp đến hạn: nếu không có báo cáo tiến độ hoặc đề nghị gia hạn có lý do, chỉ đạo sẽ bị tính là quá hạn và báo lên lãnh đạo đơn vị.', hours: 48, severity: 'ACTION', why: 'Chỉ đạo của giao ban phải được theo dõi đến khi hoàn thành, nhắc trước hạn để kịp xử lý.' },
  { code: 'DIRECTIVE_OVERDUE', source: 'DIRECTIVE', owner: 'DIRECTIVE_ASSIGNEE', action: 'Báo cáo kết quả hoặc đề nghị gia hạn có lý do và ghi ngày hoàn thành mới.', consequence: 'Chỉ đạo quá hạn được đưa vào báo cáo kỳ sau là chưa hoàn thành; quá hạn 7 ngày sẽ báo lên lãnh đạo đơn vị.', hours: 72, severity: 'ACTION', why: 'Chỉ đạo quá hạn phải có người chịu trách nhiệm và hạn mới, không để trôi.' },
  { code: 'DIRECTIVE_ESCALATED', source: 'DIRECTIVE', owner: 'UNIT_LEADER', action: 'Chỉ đạo đơn vị báo cáo kết quả hoặc xin gia hạn có lý do ngay.', consequence: 'Chỉ đạo quá hạn từ 7 ngày đã được nâng lên lãnh đạo đơn vị: cần báo cáo kết quả hoặc xin gia hạn có lý do ngay.', hours: 24, severity: 'URGENT', why: 'Chỉ đạo quá hạn kéo dài cần lãnh đạo đơn vị can thiệp.' },
];

/** The directives of the steering meetings (lane DIR-1; packages/kernel/src/directive.ts): reminder days, escalation, extensions, evidence to close. */
export const registerDirectiveRules = (): void =>
  once('directive', () => {
    registerCoreRules();
    registerRuleType({
      type: 'DIRECTIVE_POLICY',
      ownerModule: 'DIR',
      modules: ['DIR', 'HOME'],
      formula: 'Nhắc người nhận vào các ngày reminder_days_before trước hạn; quá hạn escalate_after_overdue_days ngày thì khẩn và báo lên lãnh đạo đơn vị; được gia hạn tối đa max_extensions lần, mỗi lần tối đa max_extension_days ngày; đóng chỉ đạo cần bằng chứng khi close_requires_evidence',
      source: 'DIR-1 của lộ trình quản trị (chỉ đạo giao ban, yêu cầu CN.03 và QT.02): giá trị khởi điểm của nghiên cứu, cần xác nhận với khách hàng và kiểm toán',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { reminder_days_before: list(int(0, 60), 8, 1), escalate_after_overdue_days: int(1, 90), max_extensions: int(0, 20), max_extension_days: int(1, 365), close_requires_evidence: bool },
      refine: refineWith(parseDirectivePolicy),
      defaults: { DEFAULT: rule({ reminder_days_before: [...DIRECTIVE_POLICY_DEFAULTS.reminderDaysBefore], escalate_after_overdue_days: DIRECTIVE_POLICY_DEFAULTS.escalateAfterOverdueDays, max_extensions: DIRECTIVE_POLICY_DEFAULTS.maxExtensions, max_extension_days: DIRECTIVE_POLICY_DEFAULTS.maxExtensionDays, close_requires_evidence: DIRECTIVE_POLICY_DEFAULTS.closeRequiresEvidence }) },
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(DIRECTIVE_ALERT_SEEDS, { source: 'Chỉ đạo giao ban (lane DIR-1): ba loại cảnh báo của nguồn DIRECTIVE' }));
  });

/** The model of the money of an enterprise and the checks at the moment of entry (lane FND, IND: FND-1, IND-1). */
export const registerEnterpriseRules = (): void =>
  once('enterprise', () => {
    registerCoreRules();
    registerRuleType({
      type: 'FUNDING_TAXONOMY',
      ownerModule: 'FND',
      modules: ['FND', 'DIS', 'BI'],
      formula: 'Gói công giữ nguồn vốn hiện có; gói doanh nghiệp chia vốn thành các nhóm của categories và, khi total_rule là SUM_EQUALS_TOTAL, tổng các nhóm phải bằng tổng nguồn vốn',
      source: 'FND-1 của kế hoạch: đặc tả nghĩa số liệu doanh nghiệp (R15) chưa được duyệt nên phân loại này là giá trị khởi điểm',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        package_kind: oneOf('PUBLIC', 'ENTERPRISE'),
        categories: list(shape({ code: codeText(), label: text(120), kind: oneOf('EXISTING_FUND_SOURCE', 'EQUITY', 'DEBT', 'OTHER') }), 12, 1),
        total_rule: oneOf('SUM_EQUALS_TOTAL', 'NONE'),
      },
      defaults: {
        PUBLIC: rule({ package_kind: 'PUBLIC', categories: [{ code: 'FUND_SOURCE_VERSION', label: 'Nguồn vốn theo phiên bản nguồn vốn hiện có', kind: 'EXISTING_FUND_SOURCE' }], total_rule: 'NONE' }, undefined, {
          formula: 'Gói công giữ nguyên các nguồn vốn theo phiên bản nguồn vốn hiện có; không đổi nghĩa số liệu đã công bố',
        }),
        ENTERPRISE: rule(
          {
            package_kind: 'ENTERPRISE',
            categories: [
              { code: 'EQUITY', label: 'Vốn chủ sở hữu', kind: 'EQUITY' },
              { code: 'DEBT', label: 'Vốn vay', kind: 'DEBT' },
              { code: 'OTHER', label: 'Khác', kind: 'OTHER' },
            ],
            total_rule: 'SUM_EQUALS_TOTAL',
          },
          undefined,
          { formula: 'Vốn doanh nghiệp gồm vốn chủ sở hữu, vốn vay và khác; tổng ba nhóm phải bằng tổng nguồn vốn' },
        ),
      },
    });
    registerRuleType({
      type: 'DATA_ENTRY_RULE',
      ownerModule: 'IND',
      modules: ['IND', 'DIS', 'ADM'],
      formula: 'Kiểm ngay khi nhập: lũy kế không quá tổng mức, các phần cộng lại bằng tổng (sai số tối đa tolerance), kỳ đã chốt không sửa, trường bắt buộc phải có; BLOCK chặn lưu, WARN chỉ cảnh báo',
      source: 'IND-1 của kế hoạch: từ điển chỉ tiêu của khách hàng chưa có nên bốn kiểm tra này là giá trị khởi điểm',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        check: oneOf('CUMULATIVE_NOT_ABOVE_TOTAL', 'PARTS_EQUAL_TOTAL', 'PERIOD_LOCKED_AFTER_CLOSE', 'FIELD_REQUIRED'),
        severity: oneOf('BLOCK', 'WARN'),
        fields: list(word(), 12, 1),
        total_field: word(true),
        tolerance: num(0, 1_000_000, true),
        message: text(300),
      },
      defaults: {
        CUMULATIVE_NOT_ABOVE_TOTAL: rule({ check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', message: 'Số lũy kế không được lớn hơn tổng mức.' }),
        EQUITY_PLUS_DEBT_EQUALS_TOTAL: rule({ check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0, message: 'Vốn chủ sở hữu cộng vốn vay phải bằng tổng nguồn vốn.' }),
        CLOSED_PERIOD_LOCKED: rule({ check: 'PERIOD_LOCKED_AFTER_CLOSE', severity: 'BLOCK', fields: ['REPORTING_PERIOD'], message: 'Kỳ đã chốt không sửa được; cần mở lại kỳ có người duyệt.' }),
        MANDATORY_FIELDS: rule({ check: 'FIELD_REQUIRED', severity: 'BLOCK', fields: ['MANDATORY_FIELDS'], message: 'Trường bắt buộc phải có giá trị.' }),
      },
    });
  });

/** The weights of the non-financial benefits of an investment appraisal (lane FIN-1, AI.06): one set of criteria for each category (safety, compliance, maintenance), approved by someone other than who proposed it. */
export const registerFinanceRules = (): void =>
  once('finance', () => {
    registerCoreRules();
    registerRuleType({
      type: 'FIN_CRITERIA',
      ownerModule: 'PRJ',
      modules: ['PRJ', 'ADM'],
      formula: 'Điểm có trọng số = Σ (trọng số(i) × điểm(i)) / 100 với điểm từ 1 đến 5; trọng số của một nhóm cộng lại đúng 100%; chỉ số = điểm có trọng số / 5 × 100%',
      source: 'Thẩm định hiệu quả đầu tư, yêu cầu AI.06 của khách hàng: tiêu chí phi tài chính của dự án an toàn, tuân thủ và bảo trì; bộ khởi điểm chưa được khách hàng xác nhận',
      asOf: AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: {
        criteria: list(
          shape({
            key: { kind: 'text', max: 40, pattern: '^[a-z][a-z0-9_]{1,39}$' },
            label: text(160),
            weight_pct: { kind: 'text', max: 6, pattern: '^(0|[1-9][0-9]?|100)(\\.[0-9]{1,2})?$' },
          }),
          15,
          2,
        ),
      },
      // The weights add up to exactly 100 and the keys are unique: the same judgement the appraisal makes when it scores.
      refine: (params) => {
        try {
          const criteria = (params['criteria'] as Array<{ key: string; label: string; weight_pct: string }>).map((one) => ({ key: one.key, label: one.label, weightPct: one.weight_pct }));
          assertCriteriaSet({ category: 'SAFETY', criteria });
          return undefined;
        } catch (failure) {
          return failure instanceof DomainError ? (failure.detail ?? 'criteria') : 'criteria';
        }
      },
      defaults: Object.fromEntries(
        FIN_CRITERIA_CATEGORIES.map((category) => [
          category,
          rule({ criteria: FIN_CRITERIA_DEFAULTS[category].criteria.map((one) => ({ key: one.key, label: one.label, weight_pct: one.weightPct })) }, 'UNVERIFIED', {
            formula: 'Bộ tiêu chí khởi điểm của nhóm ' + category + ': trọng số cộng lại đúng 100%, điểm từ 1 đến 5, mỗi điểm có bằng chứng',
          }),
        ]),
      ),
    });
  });

const PROCUREMENT_WORKFLOW_ALERT_SEEDS: readonly AlertTypeSeed[] = [
  { code: 'PRC_STEP_OVERDUE', source: 'PROCUREMENT_WORKFLOW', owner: 'PACKAGE_OWNER', action: 'Hoàn tất các mục còn mở của bước và chuyển bước, hoặc ghi lý do chậm và xin ngoại lệ có người duyệt.', consequence: 'Gói thầu ở lại bước quá số ngày chuẩn: các bước sau và ngày ký hợp đồng bị đẩy lùi, dự án có thể chậm giải ngân.', hours: 48, severity: 'ACTION', why: 'Mỗi bước của quy trình lựa chọn nhà thầu có thời hạn chuẩn; quá hạn là dấu hiệu sớm của chậm tiến độ lựa chọn nhà thầu.' },
  { code: 'PRC_CHECKLIST_DUE', source: 'PROCUREMENT_WORKFLOW', owner: 'CHECKLIST_OWNER', action: 'Hoàn tất mục bắt buộc của danh mục kiểm và đính kèm bằng chứng trước hạn.', consequence: 'Mục bắt buộc chưa xong chặn không cho gói thầu sang bước sau; quá hạn sẽ làm bước bị trễ.', hours: 24, severity: 'ACTION', why: 'Mục bắt buộc là điều kiện để rời bước; nhắc sát hạn để không chặn cả gói.' },
  { code: 'PRC_PACKAGE_STALLED', source: 'PROCUREMENT_WORKFLOW', owner: 'PACKAGE_OWNER', action: 'Xem gói thầu đang vướng ở đâu, ghi lý do tạm dừng hoặc thúc đẩy bước hiện tại.', consequence: 'Gói thầu đứng yên quá số ngày làm việc cho phép mà không có ai ghi nhận: tiến độ thực tế không còn được theo dõi.', hours: 72, severity: 'WATCH', why: 'Gói thầu không có biến động nào trong nhiều ngày thường là gói bị bỏ quên.' },
  { code: 'PRC_NO_OWNER', source: 'PROCUREMENT_WORKFLOW', owner: 'PROCUREMENT_MANAGER', action: 'Phân công người phụ trách cho gói thầu.', consequence: 'Gói thầu không có người phụ trách thì không ai nhận cảnh báo của bước và mục danh mục kiểm, gói sẽ trôi.', hours: 24, severity: 'ACTION', why: 'Mỗi gói thầu đang chạy quy trình phải có một người chịu trách nhiệm.' },
];

/** The workflow of a procurement package (lane PRC-1; packages/kernel/src/bid-workflow.ts): one code per selection method, the steps with their checklists, durations and evidence, and the four alerts of the monitoring. */
export const registerProcurementWorkflowRules = (): void =>
  once('procurement-workflow', () => {
    registerCoreRules();
    const evidenceList = list(codeText(), 10);
    const item = shape({ code: codeText(), name: text(200), required: bool, owner_role: codeText(), due_offset_working_days: int(0, 365), evidence_kinds: evidenceList, evidence_required: bool, milestone_kind: optionally(oneOf(...MILESTONE_KINDS)) });
    const step = shape({
      code: codeText(),
      name: text(200),
      entry_condition: text(500),
      exit_condition: text(500),
      responsible_role: codeText(),
      standard_working_days: int(0, 365),
      evidence_kinds: evidenceList,
      milestone_kind: optionally(oneOf(...MILESTONE_KINDS)),
      maker_checker: bool,
      checklist: list(item, 30),
    });
    registerRuleType({
      type: WORKFLOW_RULE_TYPE,
      ownerModule: 'BID',
      modules: ['BID', 'HOME', 'ADM'],
      formula: WORKFLOW_DEFAULTS_FORMULA,
      source: WORKFLOW_DEFAULTS_SOURCE,
      asOf: WORKFLOW_DEFAULTS_AS_OF,
      legalStatus: 'UNVERIFIED',
      schema: { method: oneOf(...WORKFLOW_METHODS), name: text(200), stalled_after_working_days: int(1, 365), checklist_warn_days: int(0, 30), steps: list(step, 40, 1) },
      refine: refineWith((params) => parseWorkflowDefinition(params)),
      defaults: Object.fromEntries(WORKFLOW_METHODS.map((method) => [method, rule(defaultWorkflowParams(method), 'UNVERIFIED')])),
    });
    registerRuleDefaults('ALERT_TYPE', alertTypeDefaults(PROCUREMENT_WORKFLOW_ALERT_SEEDS, { source: 'Theo dõi quy trình lựa chọn nhà thầu (PRC-1): bốn loại cảnh báo của nguồn PROCUREMENT_WORKFLOW' }));
  });

/** Runs every registration in order (each is idempotent): the platform calls this once when the module loads, and a test or a script may call it again. */
export function registerAllGovernanceRules(): void {
  registerCoreRules();
  registerWorkClockRules();
  registerBaselineRules();
  registerMoneyRules();
  registerAnalyticsRules();
  registerIntegrityRules();
  registerContractRules();
  registerIntegrationRules();
  registerDirectiveRules();
  registerEnterpriseRules();
  registerFinanceRules();
  registerProcurementWorkflowRules();
}

registerAllGovernanceRules();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Validation and defaults.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Checks the params of a rule of `type` and returns them in the shape the schema fixes (known keys only, in schema order). Anything else is 422 GOVERNANCE_RULE_PARAMS_INVALID naming the first
 * field (never its value).
 */
export function validateRuleParams(type: string, params: unknown): RuleParams {
  const definition = ruleTypeOf(type);
  return judge(definition.schema, definition.refine, params);
}

/** The built-in default of a code, or undefined when the type has none for it. */
export function builtInDefault(type: string, code: string): BuiltInDefault | undefined {
  return ruleTypeOf(type).defaults[code];
}

/** The codes that have a built-in default, in the order they were declared. */
export function builtInCodes(type: string): string[] {
  return Object.keys(ruleTypeOf(type).defaults);
}

/** Where the numbers of a code come from: its default's provenance, else that of its type; undefined for a type nobody registered. */
export function provenanceOf(type: string, code: string): Provenance | undefined {
  const entry = REGISTRY.get(type);
  if (entry === undefined) return undefined;
  const one = entry.defaults[code];
  const from = one ?? entry.definition;
  return { formula: from.formula, source: from.source, asOf: from.asOf, legalStatus: from.legalStatus };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One version of a rule as the database keeps it; the resolver needs only these members. `effectiveTo` is the first day the version no longer applies (null: no end yet). */
export interface GovernanceRuleVersion {
  id: string;
  type: string;
  code: string;
  version: number;
  status: GovernanceRuleStatus;
  params: RuleParams;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The organization unit the rule is an override for; null for the rule of the whole tenant. */
  unitId: string | null;
}

export interface ResolvedGovernanceRule {
  type: string;
  code: string;
  params: RuleParams;
  /** The version of the rule that decided (0 for the built-in default): stored on the decisions that used it. */
  version: number;
  source: 'RULE' | 'DEFAULT';
  /** The row that decided, null for a default. */
  ruleId: string | null;
  /** The unit an override was made for, null when the rule of the whole tenant (or the default) decided. */
  unitId: string | null;
  /** The numbers are a starting value nobody confirmed: show it (only a default can be unverified). */
  unverified: boolean;
  /** Formula, source, as-of and legal status of the numbers (those of the built-in default, or of the type when a tenant rule decided); null for a type nobody registered. */
  provenance: Provenance | null;
}

export interface ResolveOptions {
  /** The unit of the thing that is decided and the units above it, nearest first: an override for a nearer unit wins over one for a farther unit, and both win over the rule of the whole tenant. */
  unitChain?: readonly string[];
}

const covers = (candidate: GovernanceRuleVersion, day: string): boolean => candidate.effectiveFrom <= day && (candidate.effectiveTo === null || day < candidate.effectiveTo);

/**
 * The rule in force for `code` of `type` on the business day `asOf` (`YYYY-MM-DD`): an APPROVED or RETIRED version whose period covers the day (a retired version still answers for the days it was in
 * force, so a past decision is read with what governed it), the nearest unit override first, then the newest version; with none, the built-in default; with no default either, undefined. A draft or a
 * submitted version never governs anything.
 */
export function resolveGovernanceRule(rules: readonly GovernanceRuleVersion[], type: string, code: string, asOf: string, options: ResolveOptions = {}): ResolvedGovernanceRule | undefined {
  if (!isRuleDay(asOf)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const chain = options.unitChain ?? [];
  const specificity = (candidate: GovernanceRuleVersion): number => {
    if (candidate.unitId === null) return chain.length;
    const at = chain.indexOf(candidate.unitId);
    return at;
  };
  const found = rules
    .filter((candidate) => candidate.type === type && candidate.code === code && (candidate.status === 'APPROVED' || candidate.status === 'RETIRED') && covers(candidate, asOf) && specificity(candidate) >= 0)
    .sort((left, right) => specificity(left) - specificity(right) || right.version - left.version || right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
  const provenance = provenanceOf(type, code) ?? null;
  if (found !== undefined) return { type, code, params: found.params, version: found.version, source: 'RULE', ruleId: found.id, unitId: found.unitId, unverified: false, provenance };
  const fallback = REGISTRY.get(type)?.defaults[code];
  if (fallback === undefined) return undefined;
  return { type, code, params: fallback.params, version: 0, source: 'DEFAULT', ruleId: null, unitId: null, unverified: fallback.unverified, provenance };
}

/** The built-in default as a resolved rule (what a caller reads before the port exists, and what a screen shows as "mặc định"); undefined when there is none. */
export const defaultGovernanceRule = (type: string, code: string): ResolvedGovernanceRule | undefined => resolveGovernanceRule([], type, code, '2000-01-01');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The life of a version (maker is not checker).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type GovernanceRuleMove = 'SUBMIT' | 'APPROVE' | 'RETIRE' | 'WITHDRAW';

const MOVES: Readonly<Record<GovernanceRuleMove, { from: readonly GovernanceRuleStatus[]; to: GovernanceRuleStatus }>> = {
  SUBMIT: { from: ['DRAFT'], to: 'SUBMITTED' },
  WITHDRAW: { from: ['SUBMITTED'], to: 'DRAFT' },
  APPROVE: { from: ['SUBMITTED'], to: 'APPROVED' },
  // A version that was never approved is retired too (it is discarded and never governed anything); an approved one stops governing and the built-in default (or the version before) answers again.
  RETIRE: { from: ['DRAFT', 'SUBMITTED', 'APPROVED'], to: 'RETIRED' },
};

/**
 * The status after a move, or 409 GOVERNANCE_RULE_STATE_INVALID when the version is not where the move starts. Approving by the person who wrote the version (the maker) or who submitted it is 403
 * SELF_APPROVAL_DENIED: the checker is a third pair of eyes.
 */
export function nextRuleStatus(current: GovernanceRuleStatus, move: GovernanceRuleMove, input: { actor: string; maker: string; submitter: string | null }): GovernanceRuleStatus {
  const step = MOVES[move];
  if (!step.from.includes(current)) throw new DomainError('GOVERNANCE_RULE_STATE_INVALID', 409, 'status');
  if (move === 'APPROVE' && (input.actor === input.maker || input.actor === input.submitter)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return step.to;
}

/** The days of a version: a period that ends is after it begins, and both are days. */
export function assertRulePeriod(effectiveFrom: string, effectiveTo: string | null): void {
  if (!isRuleDay(effectiveFrom)) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
  if (effectiveTo !== null && (!isRuleDay(effectiveTo) || effectiveTo <= effectiveFrom)) throw new DomainError('VALIDATION_FAILED', 422, 'effective_to');
}

/** The fields that differ between two versions of params, for the diff screen: `before`/`after` are undefined where a key is absent. */
export function diffRuleParams(before: RuleParams, after: RuleParams): Array<{ path: string; before: unknown; after: unknown }> {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (isRecord(left) && isRecord(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key], right[key], path === '' ? key : `${path}.${key}`);
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ path, before: left, after: right });
  };
  walk(before, after, '');
  return changes;
}
