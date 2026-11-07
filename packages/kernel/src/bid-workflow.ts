import { DomainError } from './errors.ts';
import { MILESTONE_KINDS } from './procurement-file.ts';
import type { MilestoneKind } from './procurement-file.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The workflow of a procurement package (PRC-1, docs/bid-workflow.md): for each way of choosing a contractor, the ordered steps a package passes, the checklist of each step, the evidence each asks for, and the rules that move a
 * package from one step to the next. Looking at ONE package says which step it is at; looking at ONE step says which packages are in it.
 *
 * Everything here is pure. A definition is DATA: the governance rule type `PROCUREMENT_WORKFLOW` (one code per selection method, versioned and approved through the governance store) carries it, and the sequence below is only the built-in
 * default, taken from the order of the Luật Đấu thầu 22/2023/QH15 and written down with `legalStatus: UNVERIFIED`: the durations and the order are a starting value that legal and the procuring entity confirm, never a rule of the code.
 * A package that starts takes a frozen copy of the definition (the version of the rule and a hash), so a later change of the rule never moves a package already under way.
 */

export const WORKFLOW_RULE_TYPE = 'PROCUREMENT_WORKFLOW';
/** The methods of choosing a contractor, in the words of `procurement_package.method` (the same list as the plan and the national bidding network). */
export const WORKFLOW_METHODS = ['OPEN_BIDDING', 'LIMITED_BIDDING', 'DIRECT_APPOINTMENT', 'COMPETITIVE_QUOTATION', 'DIRECT_PURCHASE', 'SELF_EXECUTION', 'COMMUNITY_PARTICIPATION', 'SPECIAL_CASE'] as const;
export type WorkflowMethod = (typeof WORKFLOW_METHODS)[number];
export const isWorkflowMethod = (value: unknown): value is WorkflowMethod => typeof value === 'string' && (WORKFLOW_METHODS as readonly string[]).includes(value);

export const WORKFLOW_STATUSES = ['IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const ENTRY_KINDS = ['START', 'ADVANCE', 'RETURN', 'CORRECTION'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const EXIT_KINDS = ['ADVANCE', 'RETURN', 'CANCEL', 'COMPLETE', 'CORRECTED'] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];
export const ITEM_STATUSES = ['OPEN', 'DONE', 'WAIVED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const EXCEPTION_KINDS = ['SKIP_ITEMS', 'CORRECT_BACK'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export const EXCEPTION_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'USED'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** A scan never runs further than this many days (an empty calendar must not loop for ever). */
const MAX_SCAN_DAYS = 3 * 366;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isWorkflowDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (number: number): string => new Date(number * DAY_MS).toISOString().slice(0, 10);
export const workflowAddDays = (day: string, days: number): string => dayText(dayNumber(day) + days);
/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export const workflowDaysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Evidence kinds: an open registry, so that another lane (EGP-1 part 2: the receipt of a posting on the national network) adds its own kind without touching the definitions.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Where a piece of evidence comes from: a paper of DOC, a milestone of the package, a receipt of an outside system, or the word of a person (an attestation, always with a note). */
export const EVIDENCE_SOURCES = ['DOCUMENT', 'MILESTONE', 'EXTERNAL_RECEIPT', 'ATTESTATION'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface EvidenceKindInfo {
  code: string;
  source: EvidenceSource;
  label: string;
  /** The module that registered the kind. */
  module: string;
}

const EVIDENCE_KINDS = new Map<string, EvidenceKindInfo>();

/** Registers a kind of evidence; a code is registered once (a second registration is a defect of the lane, not a way to change a kind). */
export function registerEvidenceKind(info: EvidenceKindInfo): void {
  if (!CODE.test(info.code)) throw new Error(`workflow evidence kind: ${String(info.code)} is not a code`);
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(info.source)) throw new Error(`workflow evidence kind ${info.code}: unknown source`);
  if (info.label.trim().length < 3) throw new Error(`workflow evidence kind ${info.code}: no label`);
  if (EVIDENCE_KINDS.has(info.code)) throw new Error(`workflow evidence kind ${info.code} is already registered`);
  EVIDENCE_KINDS.set(info.code, { ...info });
}
export const isEvidenceKind = (code: unknown): code is string => typeof code === 'string' && EVIDENCE_KINDS.has(code);
export const evidenceKinds = (): EvidenceKindInfo[] => [...EVIDENCE_KINDS.values()];
export const evidenceKindOf = (code: string): EvidenceKindInfo | undefined => EVIDENCE_KINDS.get(code);

registerEvidenceKind({ code: 'DOCUMENT', source: 'DOCUMENT', label: 'Tài liệu trong kho hồ sơ', module: 'BID' });
registerEvidenceKind({ code: 'DECISION_DOCUMENT', source: 'DOCUMENT', label: 'Quyết định hoặc văn bản phê duyệt', module: 'BID' });
registerEvidenceKind({ code: 'MILESTONE', source: 'MILESTONE', label: 'Mốc của gói thầu đã ghi ngày thực tế', module: 'BID' });
registerEvidenceKind({ code: 'ATTESTATION', source: 'ATTESTATION', label: 'Xác nhận của người phụ trách (có ghi chú)', module: 'BID' });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The definition.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ChecklistItemDef {
  code: string;
  name: string;
  required: boolean;
  /** The role that answers for the item (a role code of the unit; a person is assigned from it). */
  ownerRole: string;
  /** Working days after the step is entered by which the item is due (0: the day of entry). */
  dueOffsetWorkingDays: number;
  evidenceKinds: readonly string[];
  /** An item that asks for evidence cannot be completed without at least one piece of a listed kind. */
  evidenceRequired: boolean;
  /** When set, a milestone of this kind with an actual date satisfies the item by itself (the milestone IS the evidence). */
  milestoneKind: MilestoneKind | null;
}

export interface WorkflowStepDef {
  code: string;
  name: string;
  /** 1-based position in the definition. */
  order: number;
  entryCondition: string;
  exitCondition: string;
  responsibleRole: string;
  /** Working days a package may stay in the step (the clock of the step; 0 means a step that is done the day it is entered). */
  standardWorkingDays: number;
  /** The kinds of evidence that the items of the step must show between them before the step is left (each kind at least once). */
  evidenceKinds: readonly string[];
  /** The milestone of the package that marks the step as reached on the national network or in the file (mapping of PRC-1 to BID-17 and BID-19). */
  milestoneKind: MilestoneKind | null;
  /** Maker is not approver: the person who leaves the step is none of those who completed its items. */
  makerChecker: boolean;
  checklist: readonly ChecklistItemDef[];
}

export interface WorkflowDefinition {
  method: WorkflowMethod;
  name: string;
  /** A package that has not moved for this many working days is stalled (alert PRC_PACKAGE_STALLED). */
  stalledAfterWorkingDays: number;
  /** A required item that is due within this many working days (or past) is shown and alerted. */
  checklistWarnDays: number;
  steps: readonly WorkflowStepDef[];
}

const textOf = (value: unknown, field: string, min: number, max: number): string => {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max) throw invalid(field);
  return value;
};
const codeOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !CODE.test(value)) throw invalid(field);
  return value;
};
const intOf = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
};
const boolOf = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
};
function kindsOf(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 10) throw invalid(field);
  const kinds = value.map((kind, index) => {
    if (!isEvidenceKind(kind)) throw invalid(`${field}[${index}]`);
    return kind;
  });
  if (new Set(kinds).size !== kinds.length) throw invalid(field);
  return kinds;
}
function milestoneOf(value: unknown, field: string): MilestoneKind | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(MILESTONE_KINDS as readonly string[]).includes(value)) throw invalid(field);
  return value as MilestoneKind;
}

/**
 * Reads the params of a `PROCUREMENT_WORKFLOW` rule (snake_case, as the governance store keeps them) into a definition, checking what a closed schema cannot say: the codes of steps are unique, the codes of the items of one step are
 * unique, every kind of evidence is registered, an item that asks for evidence names a kind and an item that is satisfied by a milestone names a milestone. The first fault is 422 `VALIDATION_FAILED` naming the field.
 */
export function parseWorkflowDefinition(params: unknown, code?: string): WorkflowDefinition {
  if (!isRecord(params)) throw invalid('params');
  const method = params.method;
  if (!isWorkflowMethod(method)) throw invalid('method');
  if (code !== undefined && code !== method) throw invalid('method');
  const rawSteps = params.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > 40) throw invalid('steps');
  const seen = new Set<string>();
  const steps = rawSteps.map((raw, index): WorkflowStepDef => {
    const at = (key: string): string => `steps[${index}].${key}`;
    if (!isRecord(raw)) throw invalid(`steps[${index}]`);
    const stepCode = codeOf(raw.code, at('code'));
    if (seen.has(stepCode)) throw invalid(at('code'));
    seen.add(stepCode);
    const rawItems = raw.checklist;
    if (!Array.isArray(rawItems) || rawItems.length > 30) throw invalid(at('checklist'));
    const itemCodes = new Set<string>();
    const checklist = rawItems.map((rawItem, position): ChecklistItemDef => {
      const item = (key: string): string => `steps[${index}].checklist[${position}].${key}`;
      if (!isRecord(rawItem)) throw invalid(`steps[${index}].checklist[${position}]`);
      const itemCode = codeOf(rawItem.code, item('code'));
      if (itemCodes.has(itemCode)) throw invalid(item('code'));
      itemCodes.add(itemCode);
      const evidence = kindsOf(rawItem.evidence_kinds, item('evidence_kinds'));
      const evidenceRequired = boolOf(rawItem.evidence_required, item('evidence_required'));
      const milestoneKind = milestoneOf(rawItem.milestone_kind, item('milestone_kind'));
      if (evidenceRequired && evidence.length === 0 && milestoneKind === null) throw invalid(item('evidence_kinds'));
      return {
        code: itemCode,
        name: textOf(rawItem.name, item('name'), 3, 200),
        required: boolOf(rawItem.required, item('required')),
        ownerRole: codeOf(rawItem.owner_role, item('owner_role')),
        dueOffsetWorkingDays: intOf(rawItem.due_offset_working_days, item('due_offset_working_days'), 0, 365),
        evidenceKinds: evidence,
        evidenceRequired,
        milestoneKind,
      };
    });
    return {
      code: stepCode,
      name: textOf(raw.name, at('name'), 3, 200),
      order: index + 1,
      entryCondition: textOf(raw.entry_condition, at('entry_condition'), 3, 500),
      exitCondition: textOf(raw.exit_condition, at('exit_condition'), 3, 500),
      responsibleRole: codeOf(raw.responsible_role, at('responsible_role')),
      standardWorkingDays: intOf(raw.standard_working_days, at('standard_working_days'), 0, 365),
      evidenceKinds: kindsOf(raw.evidence_kinds, at('evidence_kinds')),
      milestoneKind: milestoneOf(raw.milestone_kind, at('milestone_kind')),
      makerChecker: boolOf(raw.maker_checker, at('maker_checker')),
      checklist,
    };
  });
  return {
    method,
    name: textOf(params.name, 'name', 3, 200),
    stalledAfterWorkingDays: intOf(params.stalled_after_working_days, 'stalled_after_working_days', 1, 365),
    checklistWarnDays: intOf(params.checklist_warn_days, 'checklist_warn_days', 0, 30),
    steps,
  };
}

/** The definition as the params of a rule (the inverse of `parseWorkflowDefinition`): what the governance store keeps and what a package freezes. */
export function workflowParamsOf(definition: WorkflowDefinition): Record<string, unknown> {
  return {
    method: definition.method,
    name: definition.name,
    stalled_after_working_days: definition.stalledAfterWorkingDays,
    checklist_warn_days: definition.checklistWarnDays,
    steps: definition.steps.map((step) => ({
      code: step.code,
      name: step.name,
      entry_condition: step.entryCondition,
      exit_condition: step.exitCondition,
      responsible_role: step.responsibleRole,
      standard_working_days: step.standardWorkingDays,
      evidence_kinds: [...step.evidenceKinds],
      ...(step.milestoneKind === null ? {} : { milestone_kind: step.milestoneKind }),
      maker_checker: step.makerChecker,
      checklist: step.checklist.map((item) => ({
        code: item.code,
        name: item.name,
        required: item.required,
        owner_role: item.ownerRole,
        due_offset_working_days: item.dueOffsetWorkingDays,
        evidence_kinds: [...item.evidenceKinds],
        evidence_required: item.evidenceRequired,
        ...(item.milestoneKind === null ? {} : { milestone_kind: item.milestoneKind }),
      })),
    })),
  };
}

/** A stable text of a definition (keys in a fixed order), the thing a hash is taken of when a package freezes it. */
export function canonicalWorkflowText(definition: WorkflowDefinition): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    return value;
  };
  return JSON.stringify(sort(workflowParamsOf(definition)));
}

export const stepOf = (definition: WorkflowDefinition, code: string): WorkflowStepDef | undefined => definition.steps.find((step) => step.code === code);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The built-in default definitions: the sequence of the Luật Đấu thầu 22/2023/QH15, UNVERIFIED.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const WORKFLOW_DEFAULTS_AS_OF = '2026-11-08';
export const WORKFLOW_DEFAULTS_SOURCE = 'Trình tự các bước của Luật Đấu thầu 22/2023/QH15 và văn bản hướng dẫn; số ngày chuẩn là giá trị khởi điểm do người làm hệ thống đặt, chưa đối chiếu văn bản gốc, đơn vị và pháp chế xác nhận trước khi dựa vào';
export const WORKFLOW_DEFAULTS_FORMULA =
  'Một gói đi qua các bước theo thứ tự; chỉ sang bước kế khi mọi mục bắt buộc của bước đã xong và đủ bằng chứng (hoặc có ngoại lệ được người khác duyệt); hạn của bước = ngày vào bước cộng số ngày làm việc chuẩn trên lịch làm việc';

interface ItemSeed {
  code: string;
  name: string;
  required?: boolean;
  role?: string;
  due?: number;
  evidence?: readonly string[];
  needsEvidence?: boolean;
  milestone?: MilestoneKind;
}
interface StepSeed {
  name: string;
  entry: string;
  exit: string;
  role: string;
  days: number;
  evidence?: readonly string[];
  milestone?: MilestoneKind;
  maker?: boolean;
  items: readonly ItemSeed[];
}

const CATALOGUE: Readonly<Record<string, StepSeed>> = {
  PLAN_SELECTION: {
    name: 'Lập kế hoạch lựa chọn nhà thầu',
    entry: 'Dự án có quyết định đầu tư và gói thầu nằm trong kế hoạch lựa chọn nhà thầu',
    exit: 'Kế hoạch lựa chọn nhà thầu được phê duyệt có quyết định',
    role: 'PROCUREMENT_OFFICER',
    days: 10,
    evidence: ['DECISION_DOCUMENT'],
    maker: true,
    items: [
      { code: 'PLAN_DRAFTED', name: 'Dự thảo kế hoạch lựa chọn nhà thầu và phần công việc của gói', due: 5, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'PLAN_APPROVED', name: 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu', due: 10, evidence: ['DECISION_DOCUMENT'], needsEvidence: true },
    ],
  },
  DOC_PREPARE: {
    name: 'Lập hồ sơ mời thầu / hồ sơ yêu cầu',
    entry: 'Kế hoạch lựa chọn nhà thầu đã được phê duyệt',
    exit: 'Hồ sơ đã lập đủ nội dung, có tiêu chí đánh giá',
    role: 'PROCUREMENT_OFFICER',
    days: 15,
    evidence: ['DOCUMENT'],
    items: [
      { code: 'DOC_DRAFTED', name: 'Dự thảo hồ sơ mời thầu / hồ sơ yêu cầu', due: 12, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'CRITERIA_SET', name: 'Tiêu chí đánh giá và dự toán gói thầu đã chốt', due: 15, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'TECHNICAL_SPEC', name: 'Yêu cầu kỹ thuật được bộ phận chuyên môn xác nhận', required: false, role: 'TECHNICAL_LEAD', due: 10, evidence: ['ATTESTATION'] },
    ],
  },
  DOC_APPRAISE: {
    name: 'Thẩm định hồ sơ mời thầu',
    entry: 'Hồ sơ mời thầu đã lập đủ',
    exit: 'Có báo cáo thẩm định của đơn vị thẩm định',
    role: 'APPRAISER',
    days: 20,
    evidence: ['DOCUMENT'],
    maker: true,
    items: [
      { code: 'APPRAISAL_REQUEST', name: 'Văn bản đề nghị thẩm định gửi đơn vị thẩm định', role: 'PROCUREMENT_OFFICER', due: 1, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'APPRAISAL_REPORT', name: 'Báo cáo thẩm định hồ sơ mời thầu', role: 'APPRAISER', due: 20, evidence: ['DOCUMENT'], needsEvidence: true },
    ],
  },
  DOC_APPROVE: {
    name: 'Phê duyệt hồ sơ mời thầu',
    entry: 'Có báo cáo thẩm định hồ sơ mời thầu',
    exit: 'Quyết định phê duyệt hồ sơ mời thầu',
    role: 'DECISION_AUTHORITY',
    days: 10,
    evidence: ['DECISION_DOCUMENT'],
    maker: true,
    items: [{ code: 'DOC_APPROVAL_DECISION', name: 'Quyết định phê duyệt hồ sơ mời thầu', role: 'DECISION_AUTHORITY', due: 10, evidence: ['DECISION_DOCUMENT'], needsEvidence: true }],
  },
  SHORTLIST: {
    name: 'Phê duyệt danh sách nhà thầu được mời',
    entry: 'Hồ sơ mời thầu đã được phê duyệt (đấu thầu hạn chế)',
    exit: 'Danh sách nhà thầu được mời tham gia được phê duyệt',
    role: 'DECISION_AUTHORITY',
    days: 7,
    evidence: ['DECISION_DOCUMENT'],
    maker: true,
    items: [{ code: 'SHORTLIST_DECISION', name: 'Quyết định phê duyệt danh sách nhà thầu được mời', role: 'DECISION_AUTHORITY', due: 7, evidence: ['DECISION_DOCUMENT'], needsEvidence: true }],
  },
  NOTICE_POST: {
    name: 'Đăng tải thông báo mời thầu',
    entry: 'Hồ sơ mời thầu đã được phê duyệt',
    exit: 'Thông báo mời thầu đã đăng trên hệ thống mạng đấu thầu quốc gia, có biên nhận hoặc ngày đăng',
    role: 'PROCUREMENT_OFFICER',
    days: 3,
    evidence: ['MILESTONE'],
    milestone: 'INVITATION_PUBLISHED',
    items: [{ code: 'NOTICE_POSTED', name: 'Đăng thông báo mời thầu lên hệ thống mạng đấu thầu quốc gia', due: 3, evidence: ['MILESTONE', 'DOCUMENT'], needsEvidence: true, milestone: 'INVITATION_PUBLISHED' }],
  },
  DOC_ISSUE: {
    name: 'Phát hành hồ sơ mời thầu',
    entry: 'Thông báo mời thầu đã đăng (hoặc thư mời đã gửi)',
    exit: 'Hồ sơ đã phát hành, hết thời gian chuẩn bị hồ sơ dự thầu',
    role: 'PROCUREMENT_OFFICER',
    days: 20,
    items: [
      { code: 'DOC_ISSUED', name: 'Phát hành hồ sơ cho nhà thầu, ghi danh sách nhận hồ sơ', due: 1, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'PREP_PERIOD_ELAPSED', name: 'Hết thời gian chuẩn bị hồ sơ dự thầu theo hồ sơ mời thầu', due: 20, evidence: ['ATTESTATION'], needsEvidence: true },
    ],
  },
  CLARIFY: {
    name: 'Làm rõ hồ sơ mời thầu',
    entry: 'Hồ sơ mời thầu đã phát hành',
    exit: 'Mọi yêu cầu làm rõ đã được trả lời trước hạn làm rõ',
    role: 'PROCUREMENT_OFFICER',
    days: 3,
    milestone: 'CLARIFICATION_DEADLINE',
    items: [{ code: 'CLARIFICATIONS_ANSWERED', name: 'Trả lời mọi yêu cầu làm rõ của nhà thầu và gửi cho tất cả nhà thầu nhận hồ sơ', required: false, due: 3, evidence: ['DOCUMENT', 'ATTESTATION'] }],
  },
  BID_CLOSING: {
    name: 'Đóng thầu',
    entry: 'Hết thời gian chuẩn bị hồ sơ dự thầu',
    exit: 'Đã đóng thầu đúng thời điểm trong hồ sơ mời thầu, biên bản tiếp nhận hồ sơ dự thầu',
    role: 'PROCUREMENT_OFFICER',
    days: 1,
    evidence: ['MILESTONE'],
    milestone: 'BID_CLOSING',
    items: [{ code: 'BID_CLOSED', name: 'Đóng thầu và lập biên bản tiếp nhận hồ sơ dự thầu', due: 1, evidence: ['MILESTONE', 'DOCUMENT'], needsEvidence: true, milestone: 'BID_CLOSING' }],
  },
  BID_OPENING: {
    name: 'Mở thầu',
    entry: 'Đã đóng thầu',
    exit: 'Biên bản mở thầu có đại diện các nhà thầu',
    role: 'EVALUATION_TEAM',
    days: 1,
    evidence: ['MILESTONE'],
    milestone: 'BID_OPENING',
    items: [{ code: 'BID_OPENED', name: 'Mở thầu công khai và lập biên bản mở thầu', role: 'EVALUATION_TEAM', due: 1, evidence: ['MILESTONE', 'DOCUMENT'], needsEvidence: true, milestone: 'BID_OPENING' }],
  },
  EVALUATE: {
    name: 'Đánh giá hồ sơ dự thầu',
    entry: 'Đã mở thầu (hoặc đã nhận hồ sơ đề xuất)',
    exit: 'Có báo cáo đánh giá được tổ chuyên gia ký',
    role: 'EVALUATION_TEAM',
    days: 45,
    evidence: ['DOCUMENT'],
    milestone: 'EVALUATION_DONE',
    maker: true,
    items: [
      { code: 'CONFLICT_DECLARED', name: 'Thành viên tổ chuyên gia đã khai báo không có xung đột lợi ích', role: 'EVALUATION_TEAM', due: 2, evidence: ['ATTESTATION'], needsEvidence: true },
      { code: 'EVALUATION_REPORT', name: 'Báo cáo đánh giá hồ sơ dự thầu', role: 'EVALUATION_TEAM', due: 45, evidence: ['DOCUMENT', 'MILESTONE'], needsEvidence: true, milestone: 'EVALUATION_DONE' },
    ],
  },
  RESULT_APPRAISE: {
    name: 'Thẩm định kết quả lựa chọn nhà thầu',
    entry: 'Có báo cáo đánh giá hồ sơ dự thầu',
    exit: 'Có báo cáo thẩm định kết quả lựa chọn nhà thầu',
    role: 'APPRAISER',
    days: 20,
    evidence: ['DOCUMENT'],
    maker: true,
    items: [{ code: 'RESULT_APPRAISAL_REPORT', name: 'Báo cáo thẩm định kết quả lựa chọn nhà thầu', role: 'APPRAISER', due: 20, evidence: ['DOCUMENT'], needsEvidence: true }],
  },
  RESULT_APPROVE: {
    name: 'Phê duyệt kết quả lựa chọn nhà thầu',
    entry: 'Có báo cáo thẩm định kết quả',
    exit: 'Quyết định phê duyệt kết quả lựa chọn nhà thầu',
    role: 'DECISION_AUTHORITY',
    days: 10,
    evidence: ['DECISION_DOCUMENT'],
    milestone: 'RESULT_APPROVED',
    maker: true,
    items: [{ code: 'RESULT_DECISION', name: 'Quyết định phê duyệt kết quả lựa chọn nhà thầu', role: 'DECISION_AUTHORITY', due: 10, evidence: ['DECISION_DOCUMENT', 'MILESTONE'], needsEvidence: true, milestone: 'RESULT_APPROVED' }],
  },
  RESULT_POST: {
    name: 'Đăng tải kết quả lựa chọn nhà thầu',
    entry: 'Kết quả lựa chọn nhà thầu đã được phê duyệt',
    exit: 'Kết quả đã đăng trên hệ thống mạng đấu thầu quốc gia và gửi thông báo cho nhà thầu',
    role: 'PROCUREMENT_OFFICER',
    days: 5,
    evidence: ['MILESTONE'],
    milestone: 'RESULT_PUBLISHED',
    items: [
      { code: 'RESULT_POSTED', name: 'Đăng kết quả lựa chọn nhà thầu lên hệ thống mạng đấu thầu quốc gia', due: 5, evidence: ['MILESTONE', 'DOCUMENT'], needsEvidence: true, milestone: 'RESULT_PUBLISHED' },
      { code: 'CONTRACTORS_NOTIFIED', name: 'Gửi thông báo kết quả cho các nhà thầu tham dự', due: 5, evidence: ['DOCUMENT'], needsEvidence: true },
    ],
  },
  NEGOTIATE: {
    name: 'Thương thảo, hoàn thiện hợp đồng',
    entry: 'Có kết quả lựa chọn nhà thầu',
    exit: 'Biên bản thương thảo và dự thảo hợp đồng đã hoàn thiện',
    role: 'PROCUREMENT_OFFICER',
    days: 15,
    evidence: ['DOCUMENT'],
    items: [
      { code: 'NEGOTIATION_MINUTES', name: 'Biên bản thương thảo hợp đồng', due: 12, evidence: ['DOCUMENT'], needsEvidence: true },
      { code: 'CONTRACT_DRAFT_FINAL', name: 'Dự thảo hợp đồng hoàn thiện', due: 15, evidence: ['DOCUMENT'], needsEvidence: true },
    ],
  },
  CONTRACT_SIGN: {
    name: 'Ký hợp đồng',
    entry: 'Hợp đồng đã hoàn thiện',
    exit: 'Hợp đồng đã ký, chuyển sang quản lý hợp đồng',
    role: 'DECISION_AUTHORITY',
    days: 10,
    evidence: ['MILESTONE'],
    milestone: 'CONTRACT_SIGNED',
    maker: true,
    items: [{ code: 'CONTRACT_SIGNED_COPY', name: 'Hợp đồng đã ký của hai bên', role: 'DECISION_AUTHORITY', due: 10, evidence: ['DOCUMENT', 'MILESTONE'], needsEvidence: true, milestone: 'CONTRACT_SIGNED' }],
  },
  PERFORMANCE_GUARANTEE: {
    name: 'Bảo đảm thực hiện hợp đồng',
    entry: 'Hợp đồng đã ký',
    exit: 'Nhà thầu đã nộp bảo đảm thực hiện hợp đồng hợp lệ',
    role: 'CONTRACT_MANAGER',
    days: 10,
    evidence: ['DOCUMENT'],
    items: [{ code: 'GUARANTEE_RECEIVED', name: 'Bảo đảm thực hiện hợp đồng của nhà thầu đã được kiểm tra', role: 'CONTRACT_MANAGER', due: 10, evidence: ['DOCUMENT'], needsEvidence: true }],
  },
  TASK_ASSIGN: {
    name: 'Giao nhiệm vụ tự thực hiện',
    entry: 'Phương án và dự toán đã được phê duyệt',
    exit: 'Có quyết định giao nhiệm vụ cho đơn vị tự thực hiện',
    role: 'DECISION_AUTHORITY',
    days: 5,
    evidence: ['DECISION_DOCUMENT'],
    maker: true,
    items: [{ code: 'ASSIGNMENT_DECISION', name: 'Quyết định giao nhiệm vụ thực hiện gói thầu', role: 'DECISION_AUTHORITY', due: 5, evidence: ['DECISION_DOCUMENT'], needsEvidence: true }],
  },
  COMMUNITY_AGREEMENT: {
    name: 'Thỏa thuận với cộng đồng thực hiện',
    entry: 'Phương án đã được phê duyệt (gói thầu có cộng đồng tham gia)',
    exit: 'Có biên bản thỏa thuận với cộng đồng dân cư hoặc tổ chức đại diện',
    role: 'PROCUREMENT_OFFICER',
    days: 10,
    evidence: ['DOCUMENT'],
    items: [{ code: 'COMMUNITY_MINUTES', name: 'Biên bản thỏa thuận với cộng đồng', due: 10, evidence: ['DOCUMENT'], needsEvidence: true }],
  },
  SPECIAL_DECISION: {
    name: 'Quyết định áp dụng trường hợp đặc biệt',
    entry: 'Hồ sơ đề nghị áp dụng trường hợp đặc biệt đã lập',
    exit: 'Có quyết định của cấp có thẩm quyền về trường hợp đặc biệt',
    role: 'DECISION_AUTHORITY',
    days: 10,
    evidence: ['DECISION_DOCUMENT'],
    maker: true,
    items: [{ code: 'SPECIAL_CASE_DECISION', name: 'Quyết định áp dụng trường hợp đặc biệt', role: 'DECISION_AUTHORITY', due: 10, evidence: ['DECISION_DOCUMENT'], needsEvidence: true }],
  },
};

const METHOD_NAMES: Readonly<Record<WorkflowMethod, string>> = {
  OPEN_BIDDING: 'Quy trình đấu thầu rộng rãi',
  LIMITED_BIDDING: 'Quy trình đấu thầu hạn chế',
  DIRECT_APPOINTMENT: 'Quy trình chỉ định thầu',
  COMPETITIVE_QUOTATION: 'Quy trình chào hàng cạnh tranh',
  DIRECT_PURCHASE: 'Quy trình mua sắm trực tiếp',
  SELF_EXECUTION: 'Quy trình tự thực hiện',
  COMMUNITY_PARTICIPATION: 'Quy trình có cộng đồng tham gia thực hiện',
  SPECIAL_CASE: 'Quy trình trường hợp đặc biệt',
};

const METHOD_STEPS: Readonly<Record<WorkflowMethod, readonly string[]>> = {
  OPEN_BIDDING: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPRAISE', 'DOC_APPROVE', 'NOTICE_POST', 'DOC_ISSUE', 'CLARIFY', 'BID_CLOSING', 'BID_OPENING', 'EVALUATE', 'RESULT_APPRAISE', 'RESULT_APPROVE', 'RESULT_POST', 'NEGOTIATE', 'CONTRACT_SIGN', 'PERFORMANCE_GUARANTEE'],
  LIMITED_BIDDING: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPRAISE', 'DOC_APPROVE', 'SHORTLIST', 'DOC_ISSUE', 'CLARIFY', 'BID_CLOSING', 'BID_OPENING', 'EVALUATE', 'RESULT_APPRAISE', 'RESULT_APPROVE', 'RESULT_POST', 'NEGOTIATE', 'CONTRACT_SIGN', 'PERFORMANCE_GUARANTEE'],
  DIRECT_APPOINTMENT: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'DOC_ISSUE', 'EVALUATE', 'NEGOTIATE', 'RESULT_APPROVE', 'RESULT_POST', 'CONTRACT_SIGN', 'PERFORMANCE_GUARANTEE'],
  COMPETITIVE_QUOTATION: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'NOTICE_POST', 'DOC_ISSUE', 'BID_CLOSING', 'EVALUATE', 'RESULT_APPROVE', 'RESULT_POST', 'NEGOTIATE', 'CONTRACT_SIGN', 'PERFORMANCE_GUARANTEE'],
  DIRECT_PURCHASE: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'EVALUATE', 'NEGOTIATE', 'RESULT_APPROVE', 'CONTRACT_SIGN'],
  SELF_EXECUTION: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'TASK_ASSIGN'],
  COMMUNITY_PARTICIPATION: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'COMMUNITY_AGREEMENT', 'CONTRACT_SIGN'],
  SPECIAL_CASE: ['PLAN_SELECTION', 'DOC_PREPARE', 'DOC_APPROVE', 'SPECIAL_DECISION', 'CONTRACT_SIGN'],
};

/** The default stalled threshold and the checklist warning, in working days: starting values, configurable per method. */
export const WORKFLOW_DEFAULT_STALLED_DAYS = 10;
export const WORKFLOW_DEFAULT_CHECKLIST_WARN_DAYS = 2;

const itemOf = (seed: ItemSeed): ChecklistItemDef => ({
  code: seed.code,
  name: seed.name,
  required: seed.required ?? true,
  ownerRole: seed.role ?? 'PROCUREMENT_OFFICER',
  dueOffsetWorkingDays: seed.due ?? 0,
  evidenceKinds: seed.evidence ?? [],
  evidenceRequired: seed.needsEvidence ?? false,
  milestoneKind: seed.milestone ?? null,
});

/** The built-in definition of a method: the order of the law, every number a starting value (legal status UNVERIFIED on the rule that carries it). */
export function defaultWorkflowDefinition(method: WorkflowMethod): WorkflowDefinition {
  const codes = METHOD_STEPS[method];
  return {
    method,
    name: METHOD_NAMES[method],
    stalledAfterWorkingDays: WORKFLOW_DEFAULT_STALLED_DAYS,
    checklistWarnDays: WORKFLOW_DEFAULT_CHECKLIST_WARN_DAYS,
    steps: codes.map((code, index): WorkflowStepDef => {
      const seed = CATALOGUE[code] as StepSeed;
      return {
        code,
        name: seed.name,
        order: index + 1,
        entryCondition: seed.entry,
        exitCondition: seed.exit,
        responsibleRole: seed.role,
        standardWorkingDays: seed.days,
        evidenceKinds: seed.evidence ?? [],
        milestoneKind: seed.milestone ?? null,
        makerChecker: seed.maker ?? false,
        checklist: seed.items.map(itemOf),
      };
    }),
  };
}

export const defaultWorkflowParams = (method: WorkflowMethod): Record<string, unknown> => workflowParamsOf(defaultWorkflowDefinition(method));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Working days.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The day on which `days` working days, counted from `from`, have passed (the day of entry is day 0): `from` itself for 0, else the day on which the count of working days after `from` reaches `days`.
 * A year without a published calendar gives `undefined` (a deadline is never guessed with a weekly pattern, as in the clocks of the alert centre).
 */
export function addWorkingDays(calendars: WorkCalendarSource | undefined, from: string, days: number): string | undefined {
  if (!isWorkflowDay(from) || !Number.isInteger(days) || days < 0) throw invalid('days');
  if (days === 0) return from;
  if (calendars === undefined) return undefined;
  let counted = 0;
  const start = dayNumber(from);
  for (let offset = 1; offset <= MAX_SCAN_DAYS; offset += 1) {
    const day = dayText(start + offset);
    const calendar = calendars.forYear(Number(day.slice(0, 4)));
    if (calendar === undefined) return undefined;
    if (!isWorkingDay(calendar, day)) continue;
    counted += 1;
    if (counted === days) return day;
  }
  return undefined;
}

/** The working days that lie after `from` up to and including `to` (0 when `to` is not later); `undefined` when a year in between has no calendar. */
export function workingDaysBetween(calendars: WorkCalendarSource | undefined, from: string, to: string): number | undefined {
  if (!isWorkflowDay(from) || !isWorkflowDay(to)) throw invalid('days');
  if (dayNumber(to) <= dayNumber(from)) return 0;
  if (calendars === undefined) return undefined;
  if (dayNumber(to) - dayNumber(from) > MAX_SCAN_DAYS) return undefined;
  let counted = 0;
  for (let number = dayNumber(from) + 1; number <= dayNumber(to); number += 1) {
    const day = dayText(number);
    const calendar = calendars.forYear(Number(day.slice(0, 4)));
    if (calendar === undefined) return undefined;
    if (isWorkingDay(calendar, day)) counted += 1;
  }
  return counted;
}

export interface DaysInStep {
  calendarDays: number;
  /** Null when the working calendar of a year in between is not published (the number is then not guessed). */
  workingDays: number | null;
}

/** How long a package has been in a step on `today`: calendar days always, working days when the calendar is published. */
export function daysInStep(calendars: WorkCalendarSource | undefined, enteredOn: string, today: string): DaysInStep {
  const calendarDays = Math.max(0, workflowDaysBetween(enteredOn, today));
  const working = workingDaysBetween(calendars, enteredOn, today);
  return { calendarDays, workingDays: working === undefined ? null : working };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The state of a package under its definition, and the guards that move it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ItemState {
  code: string;
  required: boolean;
  status: ItemStatus;
  completedBy: string | null;
  /** The kinds of the evidence attached (a milestone with an actual date counts as `MILESTONE`). */
  evidenceKinds: readonly string[];
  dueOn: string | null;
}

export interface VisitState {
  stepCode: string;
  enteredOn: string;
  dueOn: string | null;
  items: readonly ItemState[];
}

export interface StepGuardContext {
  /** Who leaves the step. */
  actor: string;
  /** An approved exception covers the open required items and the missing evidence of this step (never the maker-checker rule). */
  exceptionApproved: boolean;
}

export const BLOCKER_CODES = ['WORKFLOW_NOT_ACTIVE', 'REQUIRED_ITEM_OPEN', 'STEP_EVIDENCE_MISSING', 'MAKER_IS_APPROVER'] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface Blocker {
  code: BlockerCode;
  /** The item or the kind of evidence the blocker is about. */
  subject: string | null;
}

export interface AdvanceAssessment {
  ok: boolean;
  blockers: Blocker[];
  /** The step the package enters; null when the step is the last one (the workflow completes). */
  next: WorkflowStepDef | null;
  /** The blockers an approved exception would cover (the open required items and the missing evidence). */
  coverable: Blocker[];
}

const COVERABLE: readonly BlockerCode[] = ['REQUIRED_ITEM_OPEN', 'STEP_EVIDENCE_MISSING'];

/**
 * Whether a package may leave its current step (BR: "cannot enter a step before the required items of the previous step are done"): the workflow is under way (not on hold, not ended), every required item is done or
 * waived, the evidence of the step (each kind at least once between its items) is there, and, when the step is `makerChecker`, the person who leaves it is none of those who completed its items. An approved exception covers the
 * first two sorts of blocker only; the maker-checker rule and a workflow that is not active are never covered.
 */
export function assessAdvance(definition: WorkflowDefinition, status: WorkflowStatus, visit: VisitState, context: StepGuardContext): AdvanceAssessment {
  const step = stepOf(definition, visit.stepCode);
  if (step === undefined) throw invalid('step');
  const blockers: Blocker[] = [];
  if (status !== 'IN_PROGRESS') blockers.push({ code: 'WORKFLOW_NOT_ACTIVE', subject: status });
  for (const item of visit.items) if (item.required && item.status === 'OPEN') blockers.push({ code: 'REQUIRED_ITEM_OPEN', subject: item.code });
  const shown = new Set<string>();
  for (const item of visit.items) if (item.status === 'DONE') for (const kind of item.evidenceKinds) shown.add(kind);
  for (const kind of step.evidenceKinds) if (!shown.has(kind)) blockers.push({ code: 'STEP_EVIDENCE_MISSING', subject: kind });
  if (step.makerChecker && visit.items.some((item) => item.status === 'DONE' && item.completedBy !== null && item.completedBy.toLowerCase() === context.actor.toLowerCase())) blockers.push({ code: 'MAKER_IS_APPROVER', subject: null });
  const coverable = blockers.filter((blocker) => COVERABLE.includes(blocker.code));
  const remaining = context.exceptionApproved ? blockers.filter((blocker) => !COVERABLE.includes(blocker.code)) : blockers;
  const next = definition.steps[step.order] ?? null;
  return { ok: remaining.length === 0, blockers: remaining, next, coverable };
}

/** The step a return goes back to: earlier than the current one, a step of the definition; 422 `VALIDATION_FAILED` otherwise. */
export function assertReturnTarget(definition: WorkflowDefinition, current: string, target: string): WorkflowStepDef {
  const from = stepOf(definition, current);
  const to = stepOf(definition, target);
  if (from === undefined) throw invalid('step');
  if (to === undefined || to.order >= from.order) throw invalid('to_step');
  return to;
}

/** The ways a person can say why: a reason is words, trimmed, at least 5 and at most 500 characters. */
export function assertReason(reason: unknown, field = 'reason'): string {
  return textOf(typeof reason === 'string' ? reason.trim() : reason, field, 5, 500);
}

/** The person who decides an exception is not the person who asked for it (maker is not approver). */
export function assertExceptionDecider(requestedBy: string, decider: string): void {
  if (requestedBy.toLowerCase() === decider.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Progress, blocked reasons, due dates.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WorkflowProgress {
  stepsTotal: number;
  /** Steps left behind: those before the current one (all of them when the workflow is complete). */
  stepsDone: number;
  currentOrder: number | null;
  itemsRequired: number;
  itemsRequiredDone: number;
  /** 0..100, whole number: the standard days of the steps done, plus the share of the required items done in the current step times its standard days, over the standard days of the whole definition (each step weighs at least 1 day). */
  percent: number;
}

const weightOf = (step: WorkflowStepDef): number => Math.max(1, step.standardWorkingDays);

export function progressOf(definition: WorkflowDefinition, status: WorkflowStatus, visit: VisitState | null): WorkflowProgress {
  const total = definition.steps.reduce((sum, step) => sum + weightOf(step), 0);
  if (status === 'COMPLETED') return { stepsTotal: definition.steps.length, stepsDone: definition.steps.length, currentOrder: null, itemsRequired: 0, itemsRequiredDone: 0, percent: 100 };
  const step = visit === null ? undefined : stepOf(definition, visit.stepCode);
  if (visit === null || step === undefined) return { stepsTotal: definition.steps.length, stepsDone: 0, currentOrder: null, itemsRequired: 0, itemsRequiredDone: 0, percent: 0 };
  const done = definition.steps.filter((one) => one.order < step.order).reduce((sum, one) => sum + weightOf(one), 0);
  const required = visit.items.filter((item) => item.required);
  const requiredDone = required.filter((item) => item.status !== 'OPEN').length;
  const fraction = required.length === 0 ? 0 : requiredDone / required.length;
  const percent = Math.floor(((done + fraction * weightOf(step)) / total) * 100 + 0.5);
  return { stepsTotal: definition.steps.length, stepsDone: step.order - 1, currentOrder: step.order, itemsRequired: required.length, itemsRequiredDone: requiredDone, percent: Math.min(99, percent) };
}

export const BLOCKED_REASONS = ['ON_HOLD', 'REQUIRED_ITEMS_OPEN', 'EVIDENCE_MISSING', 'EXCEPTION_PENDING', 'STEP_OVERDUE', 'NO_OWNER', 'CALENDAR_UNAVAILABLE'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export interface BlockedInput {
  status: WorkflowStatus;
  holdReason: string | null;
  visit: VisitState | null;
  dueOn: string | null;
  today: string;
  ownerId: string | null;
  exceptionPending: boolean;
  /** The step's due day could not be counted because a year has no published calendar. */
  calendarUnavailable: boolean;
  definition: WorkflowDefinition;
}

export interface BlockedFinding {
  reason: BlockedReason;
  /** A number the screen shows next to the reason (open required items, days late). */
  count: number | null;
  detail: string | null;
}

/** Why a package is not moving, in the order a person reads it: all reasons that apply, none for a package that is simply on its way. */
export function blockedReasons(input: BlockedInput): BlockedFinding[] {
  if (input.status === 'COMPLETED' || input.status === 'CANCELLED') return [];
  const found: BlockedFinding[] = [];
  if (input.status === 'ON_HOLD') found.push({ reason: 'ON_HOLD', count: null, detail: input.holdReason });
  if (input.ownerId === null) found.push({ reason: 'NO_OWNER', count: null, detail: null });
  if (input.visit !== null) {
    const open = input.visit.items.filter((item) => item.required && item.status === 'OPEN').length;
    if (open > 0) found.push({ reason: 'REQUIRED_ITEMS_OPEN', count: open, detail: null });
    const step = stepOf(input.definition, input.visit.stepCode);
    if (step !== undefined) {
      const shown = new Set<string>();
      for (const item of input.visit.items) if (item.status === 'DONE') for (const kind of item.evidenceKinds) shown.add(kind);
      const missing = step.evidenceKinds.filter((kind) => !shown.has(kind));
      if (missing.length > 0 && open === 0) found.push({ reason: 'EVIDENCE_MISSING', count: missing.length, detail: missing[0] ?? null });
    }
  }
  if (input.exceptionPending) found.push({ reason: 'EXCEPTION_PENDING', count: null, detail: null });
  if (input.dueOn !== null && input.status === 'IN_PROGRESS' && input.today > input.dueOn) found.push({ reason: 'STEP_OVERDUE', count: workflowDaysBetween(input.dueOn, input.today), detail: input.dueOn });
  if (input.calendarUnavailable) found.push({ reason: 'CALENDAR_UNAVAILABLE', count: null, detail: null });
  return found;
}

/** The countdown of a step: days left (negative when late) and the absolute day, null when the due day is not known. */
export function countdownOf(dueOn: string | null, today: string): { daysLeft: number; dueOn: string } | null {
  if (dueOn === null) return null;
  return { daysLeft: workflowDaysBetween(today, dueOn), dueOn };
}

/** Whether a package has not moved for `stalledAfterWorkingDays` working days (its last activity counted on the working calendar); `undefined` when that cannot be counted. */
export function isStalled(calendars: WorkCalendarSource | undefined, lastActivityOn: string, today: string, stalledAfterWorkingDays: number): boolean | undefined {
  const spent = workingDaysBetween(calendars, lastActivityOn, today);
  return spent === undefined ? undefined : spent >= stalledAfterWorkingDays;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Statistics: the median days a step takes and the packages that are stuck.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The median of numbers (the mean of the two in the middle when there is an even number); null for none. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface StepVisitFact {
  packageId: string;
  method: string;
  stepCode: string;
  enteredOn: string;
  /** Null while the package is still in the step. */
  exitedOn: string | null;
  exitKind: ExitKind | null;
  /** Standard working days of the step in the frozen definition the package runs under. */
  standardWorkingDays: number;
  workingDays: number | null;
  calendarDays: number;
}

export interface StepStatistic {
  method: string;
  stepCode: string;
  /** Visits that ended by moving on (ADVANCE or COMPLETE) inside the period. */
  completedVisits: number;
  /** The days those visits took: working days when every visit has them, else calendar days (`basis` says which). */
  medianDays: number | null;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  /** Share of completed visits finished within the standard working days, 0..1 with four decimals; null when none. */
  onTimeShare: number | null;
  /** Packages in the step now. */
  openVisits: number;
  /** Open visits older than the standard (working days where known, else calendar days). */
  overStandard: number;
}

/**
 * The statistics of each step of each method from the visits of the packages (the data of the bottleneck panel and of the KPI register): for the visits that ended by moving on in `[from, to]`, the median days and the share on time
 * (days spent at most the standard); for the visits still open on `asOf`, how many are older than the standard. A visit that was returned, cancelled or corrected is not a completed step and is left out of the median.
 */
export function stepStatistics(visits: readonly StepVisitFact[], range: { from: string; to: string }): StepStatistic[] {
  const groups = new Map<string, StepVisitFact[]>();
  for (const visit of visits) {
    const key = `${visit.method}\u0000${visit.stepCode}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [visit]);
    else group.push(visit);
  }
  const result: StepStatistic[] = [];
  for (const [key, group] of groups) {
    const [method, stepCode] = key.split('\u0000') as [string, string];
    const done = group.filter((visit) => visit.exitedOn !== null && (visit.exitKind === 'ADVANCE' || visit.exitKind === 'COMPLETE') && visit.exitedOn >= range.from && visit.exitedOn <= range.to);
    const working = done.length > 0 && done.every((visit) => visit.workingDays !== null);
    const days = done.map((visit) => (working ? (visit.workingDays as number) : visit.calendarDays));
    const onTime = done.filter((visit) => (working ? (visit.workingDays as number) : visit.calendarDays) <= visit.standardWorkingDays).length;
    const open = group.filter((visit) => visit.exitedOn === null);
    const over = open.filter((visit) => (visit.workingDays !== null ? visit.workingDays : visit.calendarDays) > visit.standardWorkingDays).length;
    result.push({
      method,
      stepCode,
      completedVisits: done.length,
      medianDays: medianOf(days),
      basis: working || done.length === 0 ? 'WORKING_DAYS' : 'CALENDAR_DAYS',
      onTimeShare: done.length === 0 ? null : Math.round((onTime / done.length) * 10_000) / 10_000,
      openVisits: open.length,
      overStandard: over,
    });
  }
  return result.sort((left, right) => left.method.localeCompare(right.method) || left.stepCode.localeCompare(right.stepCode));
}

export interface StuckPackage {
  packageId: string;
  stepCode: string;
  days: number;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
}

/** The packages that have been in their step longest, longest first (the "gói kẹt lâu nhất" list); `limit` of them. */
export function stuckPackages(visits: readonly StepVisitFact[], limit: number): StuckPackage[] {
  return visits
    .filter((visit) => visit.exitedOn === null)
    .map((visit): StuckPackage => (visit.workingDays !== null ? { packageId: visit.packageId, stepCode: visit.stepCode, days: visit.workingDays, basis: 'WORKING_DAYS' } : { packageId: visit.packageId, stepCode: visit.stepCode, days: visit.calendarDays, basis: 'CALENDAR_DAYS' }))
    .sort((left, right) => right.days - left.days || left.packageId.localeCompare(right.packageId))
    .slice(0, limit);
}

/** The KPIs of PRC-1 for the KPI register: their codes, formulas and units (the register reads these; they are defined once). */
export const WORKFLOW_KPIS = [
  { code: 'PRC_STEP_ON_TIME_SHARE', unit: 'PERCENT', formula: 'Số lần rời bước đúng hạn / số lần rời bước trong kỳ, mỗi bước của mỗi hình thức; đúng hạn là số ngày làm việc ở bước không vượt số ngày chuẩn của bước' },
  { code: 'PRC_STEP_MEDIAN_DAYS', unit: 'DAYS', formula: 'Trung vị số ngày làm việc ở bước của các lần rời bước trong kỳ (ngày dương lịch khi lịch làm việc chưa công bố)' },
] as const;
