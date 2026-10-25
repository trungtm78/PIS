import { DomainError } from './errors.ts';

/**
 * The inspections of work on a contract (ST-QMS-004, QMS 3.2, BR-QMS-04 and BR-QMS-05): a contractor or the supervisor asks for an inspection of a kind of work, the supervisor
 * schedules it and records its result against a checklist. The regime that applies (the rule QMS_REGIME in force on the day of the request) decides the checklist and the roles that
 * will sign the acceptance minutes; both are copied onto the inspection when it is requested and never change after it, whatever the rule data does later.
 */
export const INSPECTION_TYPES = ['MATERIAL_ENTRY', 'CONCEALED_WORK', 'CONSTRUCTION_STAGE', 'PART_ACCEPTANCE', 'COMPLETION', 'SAFETY', 'OTHER'] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];

export const INSPECTION_STATUSES = ['REQUESTED', 'SCHEDULED', 'RESULT_RECORDED', 'CANCELLED'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const INSPECTION_RESULTS = ['PASS', 'FAIL', 'CONDITIONAL'] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

/** The roles that sign acceptance minutes (QMS 5, `qms_signature.signer_role`). */
export const SIGNER_ROLES = ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const INSPECTION_COMMANDS = ['schedule', 'record', 'cancel'] as const;
export type InspectionCommand = (typeof INSPECTION_COMMANDS)[number];

const TRANSITIONS: Readonly<Record<InspectionCommand, { from: readonly InspectionStatus[]; to: InspectionStatus }>> = {
  schedule: { from: ['REQUESTED'], to: 'SCHEDULED' },
  record: { from: ['SCHEDULED'], to: 'RESULT_RECORDED' },
  cancel: { from: ['REQUESTED', 'SCHEDULED'], to: 'CANCELLED' },
};

/** 409 `INSPECTION_STATE_INVALID` (with the status) unless the command applies to the status; otherwise the status the command leads to. */
export function assertInspectionTransition(command: InspectionCommand, status: InspectionStatus): InspectionStatus {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(status)) throw new DomainError('INSPECTION_STATE_INVALID', 409, 'status', { extensions: { inspection_status: status } });
  return rule.to;
}

/** One item of a checklist of the regime: the code the answer names, and what is checked. */
export interface ChecklistItem {
  code: string;
  label: string;
}

/**
 * The regime of quality management in force on a day, as the rule data states it (rule type QMS_REGIME): the roles that sign the minutes of a work or a stage, the roles that sign the
 * minutes of the completion, and the checklist of each kind of inspection.
 */
export interface RegimeRule {
  requiredRoles: SignerRole[];
  completionRequiredRoles: SignerRole[];
  checklists: Partial<Record<InspectionType, ChecklistItem[]>>;
}

/** The roles that must sign the minutes of an inspection of this type: the completion has its own list when the regime states one. */
export const requiredRolesFor = (regime: RegimeRule, type: InspectionType): SignerRole[] => [...(type === 'COMPLETION' ? regime.completionRequiredRoles : regime.requiredRoles)];

/** The checklist that an inspection of this type is judged by under the regime. */
export const checklistFor = (regime: RegimeRule, type: InspectionType): ChecklistItem[] => (regime.checklists[type] ?? []).map((item) => ({ ...item }));

export const CHECKLIST_OUTCOMES = ['PASS', 'FAIL', 'NA'] as const;
export type ChecklistOutcome = (typeof CHECKLIST_OUTCOMES)[number];

export interface ChecklistAnswer {
  code: string;
  outcome: ChecklistOutcome;
  note?: string | undefined;
}

export const MAX_CHECKLIST_NOTE = 2000;

const incomplete = (reason: string, extensions: Record<string, unknown> = {}): DomainError =>
  new DomainError('CHECKLIST_INCOMPLETE', 422, 'checklist', { extensions: { reason, ...extensions } });

/**
 * The checklist answered against the template the inspection was given (422 `CHECKLIST_INCOMPLETE` otherwise): every item of the template is answered exactly once and nothing else is
 * answered; a PASS has no failed item; a FAIL has at least one; a CONDITIONAL has at least one, and each failed item says in a note what the condition is. Returns the answers in the order
 * of the template, with the label of each item.
 */
export function assertChecklist(template: readonly ChecklistItem[], answers: readonly unknown[], result: InspectionResult): Array<ChecklistItem & { outcome: ChecklistOutcome; note?: string }> {
  const byCode = new Map<string, ChecklistAnswer>();
  for (const raw of answers) {
    const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const code = typeof row.code === 'string' ? row.code : '';
    const outcome = CHECKLIST_OUTCOMES.find((candidate) => candidate === row.outcome);
    const note = typeof row.note === 'string' ? row.note.trim() : undefined;
    if (code === '' || outcome === undefined || (note !== undefined && note.length > MAX_CHECKLIST_NOTE)) throw incomplete('ANSWER_INVALID');
    if (byCode.has(code)) throw incomplete('ANSWER_DUPLICATED', { code });
    byCode.set(code, { code, outcome, note: note === '' ? undefined : note });
  }
  const known = new Set(template.map((item) => item.code));
  const unknown = [...byCode.keys()].filter((code) => !known.has(code));
  if (unknown.length > 0) throw incomplete('ANSWER_UNKNOWN', { codes: unknown });
  const missing = template.filter((item) => !byCode.has(item.code)).map((item) => item.code);
  if (missing.length > 0) throw incomplete('ITEMS_MISSING', { codes: missing });
  const answered = template.map((item) => ({ ...item, ...(byCode.get(item.code) as ChecklistAnswer) }));
  const failed = answered.filter((item) => item.outcome === 'FAIL');
  if (result === 'PASS' && failed.length > 0) throw incomplete('RESULT_CONTRADICTS', { codes: failed.map((item) => item.code) });
  if (result !== 'PASS' && failed.length === 0) throw incomplete('RESULT_CONTRADICTS');
  if (result === 'CONDITIONAL') {
    const unexplained = failed.filter((item) => item.note === undefined).map((item) => item.code);
    if (unexplained.length > 0) throw incomplete('CONDITION_UNSTATED', { codes: unexplained });
  }
  return answered.map((item) => ({ code: item.code, label: item.label, outcome: item.outcome, ...(item.note === undefined ? {} : { note: item.note }) }));
}
