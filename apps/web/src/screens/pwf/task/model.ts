import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';
import { isDay, optionalText, reasonProblem } from '../model';
import type { BlockerCode, ExceptionKind, FormProblem, TaskDetail, TaskStatus } from '../model';

type Schemas = components['schemas'];

export type TaskException = TaskDetail['exceptions'][number];
export type HistoryEntry = TaskDetail['history'][number];
/** A result of a KPI of the task, as its own read (`listTaskKpiResults`) gives it. */
export type KpiResultPage = Schemas['PwfKpiResultPage'];
export type KpiResult = KpiResultPage['items'][number];
export type EvidenceRow = TaskDetail['evidence'][number];

// ---- which buttons show ---------------------------------------------------------------------------------------------------------------------------------------------

export interface Actions {
  start: boolean;
  complete: boolean;
  approve: boolean;
  return: boolean;
  resume: boolean;
  requestException: boolean;
  /** Deciding an exception is the approver's act: the server's `can_approve`. */
  decideException: boolean;
  /** Ticking a checklist item and attaching evidence are the doer's work: the server's `can_complete`. */
  work: boolean;
  assign: boolean;
}

/** What the caller may do, from the `can_*` flags of the server only; a read-only session may do none of it. */
export function actionsOf(task: TaskDetail, readOnly: boolean): Actions {
  const allow = (flag: boolean): boolean => flag && !readOnly;
  return {
    start: allow(task.can_start),
    complete: allow(task.can_complete),
    approve: allow(task.can_approve),
    return: allow(task.can_return),
    resume: allow(task.can_resume),
    requestException: allow(task.can_request_exception),
    decideException: allow(task.can_approve),
    work: allow(task.can_complete),
    assign: allow(task.can_assign),
  };
}

// ---- what blocks the completion -----------------------------------------------------------------------------------------------------------------------------------------

export interface BlockerRow {
  code: BlockerCode;
  subject: string;
  /** An approved waiver may cover it (the rule that the approver is not the doer is never covered). */
  coverable: boolean;
}

/** The blockers of the completion and what a waiver could cover, each once, in the order the server gave them. */
export function blockerRows(completion: TaskDetail['completion']): BlockerRow[] {
  const rows = new Map<string, BlockerRow>();
  for (const item of completion.blockers) rows.set(`${item.code}:${item.subject}`, { code: item.code, subject: item.subject, coverable: false });
  for (const item of completion.coverable) rows.set(`${item.code}:${item.subject}`, { code: item.code, subject: item.subject, coverable: true });
  return [...rows.values()];
}

/** The approved waivers that can be handed to the completion (`exception_id`). */
export const approvedWaivers = (task: TaskDetail): TaskException[] => task.exceptions.filter((item) => item.kind === 'WAIVE_REQUIREMENT' && item.status === 'APPROVED');

// ---- exception request ------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ExceptionForm {
  kind: ExceptionKind;
  /** The codes of what is waived, separated by commas (a waiver only). */
  items: string;
  validFrom: string;
  validTo: string;
  evidenceRef: string;
  reason: string;
}

export const EXCEPTION_KINDS: readonly ExceptionKind[] = ['WAIVE_REQUIREMENT', 'CANCEL_TASK', 'PAUSE', 'EXTERNAL_DELAY'];
export const EMPTY_EXCEPTION: ExceptionForm = { kind: 'WAIVE_REQUIREMENT', items: '', validFrom: '', validTo: '', evidenceRef: '', reason: '' };

export type ExceptionField = 'items' | 'validFrom' | 'validTo' | 'reason';
export type ExceptionProblems = Partial<Record<ExceptionField, FormProblem>>;

const needsFrom = (kind: ExceptionKind): boolean => kind === 'PAUSE' || kind === 'EXTERNAL_DELAY';
const itemsOf = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item !== '');

export function validateException(form: ExceptionForm): ExceptionProblems {
  const problems: ExceptionProblems = {};
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  if (form.kind === 'WAIVE_REQUIREMENT' && itemsOf(form.items).length === 0) problems.items = 'required';
  const from = form.validFrom.trim();
  if (from === '' ? needsFrom(form.kind) : !isDay(from)) problems.validFrom = from === '' ? 'required' : 'invalidDay';
  const to = form.validTo.trim();
  if (to !== '' && (!isDay(to) || (isDay(from) && to < from))) problems.validTo = 'invalidDay';
  return problems;
}

export function exceptionBody(form: ExceptionForm): Schemas['PwfExceptionRequest'] {
  const body: Schemas['PwfExceptionRequest'] = { kind: form.kind, reason: form.reason.trim() };
  if (form.kind === 'WAIVE_REQUIREMENT') body.items = itemsOf(form.items);
  if (form.validFrom.trim() !== '') body.valid_from = form.validFrom.trim();
  if (form.validTo.trim() !== '') body.valid_to = form.validTo.trim();
  const reference = optionalText(form.evidenceRef);
  if (reference !== undefined) body.evidence_ref = reference;
  return body;
}

// ---- evidence ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EvidenceForm {
  evidenceKind: string;
  itemCode: string;
  documentId: string;
  legalDocType: string;
  formTemplateCode: string;
  externalRef: string;
  note: string;
}

export const EMPTY_EVIDENCE: EvidenceForm = { evidenceKind: '', itemCode: '', documentId: '', legalDocType: '', formTemplateCode: '', externalRef: '', note: '' };

export type EvidenceField = 'evidenceKind' | 'documentId' | 'externalRef';
export type EvidenceProblems = Partial<Record<EvidenceField, FormProblem>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A kind, and either a document of the register or a link to one that lives elsewhere. */
export function validateEvidence(form: EvidenceForm): EvidenceProblems {
  const problems: EvidenceProblems = {};
  if (form.evidenceKind.trim() === '') problems.evidenceKind = 'required';
  const document = form.documentId.trim();
  if (document !== '' && !UUID.test(document)) problems.documentId = 'pickOne';
  else if (document === '' && form.externalRef.trim() === '') problems.externalRef = 'pickOne';
  return problems;
}

export function evidenceBody(form: EvidenceForm): Schemas['PwfEvidenceInput'] {
  const body: Schemas['PwfEvidenceInput'] = { evidence_kind: form.evidenceKind.trim() };
  const fields: Array<[keyof Schemas['PwfEvidenceInput'], string]> = [
    ['item_code', form.itemCode],
    ['document_id', form.documentId],
    ['legal_doc_type', form.legalDocType],
    ['form_template_code', form.formTemplateCode],
    ['external_ref', form.externalRef],
    ['note', form.note],
  ];
  for (const [name, value] of fields) {
    const text = optionalText(value);
    if (text !== undefined) body[name] = text;
  }
  return body;
}

// ---- the bodies of the other commands -------------------------------------------------------------------------------------------------------------------------------------

export const startBody = (earlyStartReason: string | undefined): Schemas['PwfTaskStart'] => {
  const reason = earlyStartReason === undefined ? undefined : optionalText(earlyStartReason);
  return reason === undefined ? {} : { early_start_reason: reason };
};

export interface CompleteForm {
  actualFinish: string;
  exceptionId: string;
  note: string;
}

export function completeBody(form: CompleteForm): Schemas['PwfTaskComplete'] {
  const body: Schemas['PwfTaskComplete'] = {};
  if (form.actualFinish.trim() !== '') body.actual_finish = form.actualFinish.trim();
  if (form.exceptionId !== '') body.exception_id = form.exceptionId;
  const note = optionalText(form.note);
  if (note !== undefined) body.note = note;
  return body;
}

export function decisionBody(decision: 'APPROVE' | 'REJECT', note: string | undefined): Schemas['PwfDecisionInput'] {
  const text = note === undefined ? undefined : optionalText(note);
  return text === undefined ? { decision } : { decision, note: text };
}

export const returnBody = (reason: string): Schemas['PwfReturnInput'] => ({ reason: reason.trim() });

// ---- presentation helpers ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function statusTone(status: TaskStatus): Tone {
  switch (status) {
    case 'IN_PROGRESS':
      return 'info';
    case 'AWAITING_APPROVAL':
      return 'warning';
    case 'DONE':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    case 'NOT_STARTED':
    case 'ON_HOLD':
      return 'neutral';
  }
}

export interface HistoryGroup {
  /** The day in Vietnam time. */
  date: string;
  entries: HistoryEntry[];
}

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const vietnamDay = (at: string): string => new Date(Date.parse(at) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** The history by the day it happened in Vietnam time: newest day first, newest entry first. */
export function historyGroups(history: readonly HistoryEntry[]): HistoryGroup[] {
  const days = new Map<string, HistoryEntry[]>();
  for (const entry of [...history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const day = vietnamDay(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return [...days.entries()].map(([date, entries]) => ({ date, entries })).sort((a, b) => b.date.localeCompare(a.date));
}


/** The facts of a task a KPI reads, in the order a person reads them (the days first, then the counts and the amounts). A key that is not here has no label and stays in the full data only. */
export const KPI_FACT_KEYS = [
  'baselineDueFirst',
  'baselineDueCurrent',
  'actualStart',
  'actualFinish',
  'asOf',
  'status',
  'priority',
  'plannedWorkingDays',
  'returnCount',
  'rescheduleCount',
  'requiredEvidence',
  'providedEvidence',
  'estimateVnd',
  'actualVnd',
  'cancelApproved',
  'excusals',
  'unit',
  'against',
  'graceDays',
  'calendars',
] as const;
export type KpiFactKey = (typeof KPI_FACT_KEYS)[number];

/** One fact behind a KPI result, named by a key the screen has a label for; the value is as the server stored it. */
export interface KpiInputRow {
  key: KpiFactKey;
  value: unknown;
}

const plainRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * The inputs of a KPI result as the facts a person reads (lane fix11): the facts of the task the operation read (`facts`), the day they were read on (`as_of`), how the operation counts (`params`) and the calendars
 * behind the working days. The envelope the server keeps for a recomputation (the operation, the scale, the colour rule) and any key the screen has no label for are NOT rows: they are in the full data, which the
 * screen shows on demand. Rows come in the order of [KPI_FACT_KEYS], one per key.
 */
export function kpiInputRows(inputs: Record<string, unknown>): KpiInputRow[] {
  const facts = plainRecord(inputs.facts);
  const params = plainRecord(inputs.params);
  const found = new Map<string, unknown>();
  // A result kept before the envelope existed holds its facts at the top: a key the screen has a label for is read from there as well.
  for (const [key, value] of Object.entries(inputs)) if (key !== 'calendars' && (KPI_FACT_KEYS as readonly string[]).includes(key)) found.set(key, value);
  for (const [key, value] of Object.entries(facts)) found.set(key, value);
  for (const [key, value] of Object.entries(params)) if (!found.has(key)) found.set(key, value);
  if (!found.has('asOf') && inputs.as_of !== undefined) found.set('asOf', inputs.as_of);
  if (Array.isArray(inputs.calendars) && inputs.calendars.length > 0) found.set('calendars', inputs.calendars);
  return KPI_FACT_KEYS.filter((key) => found.has(key)).map((key) => ({ key, value: found.get(key) }));
}

/** The whole of the inputs as the server stored them, for the reader who checks a recomputation: indented, keys in a stable order. */
export function kpiInputsJson(inputs: Record<string, unknown>): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, ordered((value as Record<string, unknown>)[key])]));
    return value;
  };
  return JSON.stringify(ordered(inputs), null, 2);
}
