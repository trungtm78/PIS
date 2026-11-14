import type { components } from '@machvon/contracts';
import { dayProblem, optionalText, reasonProblem, textProblem, wholeProblem } from '../model';
import type { FormProblem, Schedule, ReschedulePreview, ScheduleTask, WorkflowDetail } from '../model';

type Schemas = components['schemas'];

export type RescheduleBody = Schemas['PwfRescheduleRequest'];
export type DecisionBody = Schemas['PwfDecisionInput'];
export type Change = ReschedulePreview['changes'][number];

export interface ProgressRow {
  taskCode: string;
  actualStart: string;
  actualFinish: string;
  remaining: string;
  percent: string;
}

export interface RescheduleForm {
  plannedStart: string;
  statusDate: string;
  reason: string;
  progress: ProgressRow[];
}

export const emptyProgress = (): ProgressRow => ({ taskCode: '', actualStart: '', actualFinish: '', remaining: '', percent: '' });
export const emptyForm = (): RescheduleForm => ({ plannedStart: '', statusDate: '', reason: '', progress: [] });

export const MAX_PROGRESS_ROWS = 50;
export const MAX_TASK_CODE = 40;

// ---- checks before anything is sent ------------------------------------------------------------------------------------------------------------------------------------

export type FormField = 'plannedStart' | 'statusDate' | 'reason' | 'change';
export interface RowErrors {
  taskCode?: FormProblem;
  actualStart?: FormProblem;
  actualFinish?: FormProblem;
  remaining?: FormProblem;
  percent?: FormProblem;
}
export interface FormErrors {
  fields: Partial<Record<FormField, FormProblem>>;
  rows: Record<number, RowErrors>;
}

const optionalDay = (value: string): FormProblem | undefined => (value.trim() === '' ? undefined : dayProblem(value));

function rowErrors(row: ProgressRow): RowErrors {
  const errors: RowErrors = {};
  const code = textProblem(row.taskCode, 1, MAX_TASK_CODE);
  if (code !== undefined) errors.taskCode = code;
  const start = optionalDay(row.actualStart);
  if (start !== undefined) errors.actualStart = start;
  const finish = optionalDay(row.actualFinish);
  if (finish !== undefined) errors.actualFinish = finish;
  if (row.remaining.trim() !== '') {
    const remaining = wholeProblem(row.remaining, 0, 3650);
    if (remaining !== undefined) errors.remaining = remaining;
  }
  if (row.percent.trim() !== '') {
    const percent = wholeProblem(row.percent, 0, 100);
    if (percent !== undefined) errors.percent = percent;
  }
  return errors;
}

/** A proposal changes something (the start day, or what is known of the progress), says why in at least 20 characters, and every day and number it gives is a real one. */
export function validateForm(form: RescheduleForm): FormErrors {
  const fields: FormErrors['fields'] = {};
  const planned = optionalDay(form.plannedStart);
  if (planned !== undefined) fields.plannedStart = planned;
  const status = optionalDay(form.statusDate);
  if (status !== undefined) fields.statusDate = status;
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) fields.reason = reason;
  if (form.plannedStart.trim() === '' && form.progress.length === 0) fields.change = 'pickOne';
  const rows: Record<number, RowErrors> = {};
  form.progress.forEach((row, index) => {
    const errors = rowErrors(row);
    if (Object.keys(errors).length > 0) rows[index] = errors;
  });
  return { fields, rows };
}

export const hasFormErrors = (errors: FormErrors): boolean => Object.keys(errors.fields).length > 0 || Object.keys(errors.rows).length > 0;

export function proposeBody(form: RescheduleForm): RescheduleBody {
  const planned = optionalText(form.plannedStart);
  const status = optionalText(form.statusDate);
  const progress = form.progress.map((row): NonNullable<RescheduleBody['progress']>[number] => {
    const entry: NonNullable<RescheduleBody['progress']>[number] = { task_code: row.taskCode.trim() };
    const start = optionalText(row.actualStart);
    const finish = optionalText(row.actualFinish);
    const remaining = optionalText(row.remaining);
    const percent = optionalText(row.percent);
    if (start !== undefined) entry.actual_start = start;
    if (finish !== undefined) entry.actual_finish = finish;
    if (remaining !== undefined) entry.remaining_working_days = Number(remaining);
    if (percent !== undefined) entry.percent_complete = Number(percent);
    return entry;
  });
  return {
    ...(planned === undefined ? {} : { planned_start_date: planned }),
    ...(status === undefined ? {} : { status_date: status }),
    ...(progress.length === 0 ? {} : { progress }),
    reason: form.reason.trim(),
  };
}

/** A rejection says why in at least 20 characters; an approval may carry a note and, when it does, the note is not empty text. */
export function decisionProblem(decision: DecisionBody['decision'], note: string): FormProblem | undefined {
  if (decision === 'REJECT') return reasonProblem(note);
  return note.trim() === '' ? undefined : textProblem(note, 1, 2000);
}

export function decisionBody(decision: DecisionBody['decision'], note: string): DecisionBody {
  const text = optionalText(note);
  return { decision, ...(text === undefined ? {} : { note: text }) };
}

// ---- reading a proposal ------------------------------------------------------------------------------------------------------------------------------------------------------

/** One row of the table of changes: the days before and after (from the schedule in force and the proposed one), the shift in working days and the baseline variance after the move. */
export interface ChangeRow {
  code: string;
  name: string;
  beforeStart: string | null;
  beforeFinish: string | null;
  afterStart: string | null;
  afterFinish: string | null;
  startShift: number | null;
  finishShift: number | null;
  floatChange: number | null;
  becameCritical: boolean;
  becameNonCritical: boolean;
  stateChanged: boolean;
  /** Working days of the finish after the move against the finish of the FIRST baseline (positive is late); null when there is no baseline or no date. */
  baselineFinishVariance: number | null;
  baselineStartVariance: number | null;
  calendarMissingYear: number | null;
}

const byCode = (tasks: readonly ScheduleTask[] | undefined): ReadonlyMap<string, ScheduleTask> => new Map((tasks ?? []).map((task) => [task.task_code, task]));

export function changeRows(preview: ReschedulePreview, before: Pick<Schedule, 'tasks'> | undefined): ChangeRow[] {
  const was = byCode(before?.tasks);
  const now = byCode(preview.schedule.tasks);
  return preview.changes.map((change): ChangeRow => {
    const after = now.get(change.task_code);
    const earlier = was.get(change.task_code);
    return {
      code: change.task_code,
      name: after?.name ?? earlier?.name ?? change.task_code,
      beforeStart: earlier?.start ?? null,
      beforeFinish: earlier?.finish ?? null,
      afterStart: after?.start ?? null,
      afterFinish: after?.finish ?? null,
      startShift: change.start_shift_days,
      finishShift: change.finish_shift_days,
      floatChange: change.float_change,
      becameCritical: change.became_critical,
      becameNonCritical: change.became_non_critical,
      stateChanged: change.state_changed,
      baselineFinishVariance: after?.finish_variance_days ?? null,
      baselineStartVariance: after?.start_variance_days ?? null,
      calendarMissingYear: after?.state === 'CALENDAR_UNAVAILABLE' ? after.missing_year : null,
    };
  });
}

export interface ChangeSummary {
  total: number;
  becameCritical: number;
  becameNonCritical: number;
  slipped: number;
  gained: number;
}

/** How many tasks move later, move earlier, join or leave the critical path. */
export function summarizeChanges(preview: ReschedulePreview): ChangeSummary {
  return {
    total: preview.changes.length,
    becameCritical: preview.changes.filter((change) => change.became_critical).length,
    becameNonCritical: preview.changes.filter((change) => change.became_non_critical).length,
    slipped: preview.changes.filter((change) => (change.finish_shift_days ?? 0) > 0).length,
    gained: preview.changes.filter((change) => (change.finish_shift_days ?? 0) < 0).length,
  };
}

/** A signed number of working days ("+3", "−2", "0"); a shift that cannot be counted is a dash. */
export function shiftText(value: number | null): string {
  if (value === null) return '–';
  if (value > 0) return `+${value}`;
  return value < 0 ? `−${Math.abs(value)}` : '0';
}

/** What an address names about a proposal: the id and the version of the schedule it was computed on, which is the If-Match of the decision. */
export interface HeldProposal {
  id: string;
  baseVersion: number;
  preview?: ReschedulePreview;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function heldFromAddress(params: Pick<URLSearchParams, 'get'>): HeldProposal | undefined {
  const id = params.get('proposal');
  if (id === null || !UUID.test(id)) return undefined;
  const version = Number(params.get('v') ?? '');
  return { id, baseVersion: Number.isInteger(version) && version > 0 ? version : 1 };
}

/** The proposal that waits on the workflow, when the address names none: who decides opens the screen from the menu and finds it (its details are then read from the server). */
export function heldFromWorkflow(workflow: Pick<WorkflowDetail, 'pending_reschedule'>): HeldProposal | undefined {
  const pending = workflow.pending_reschedule;
  return pending === undefined || pending === null ? undefined : { id: pending.proposal_id, baseVersion: pending.base_version };
}

export const heldFromPreview = (preview: ReschedulePreview): HeldProposal => ({ id: preview.proposal_id, baseVersion: preview.base_version, preview });

export const isOpenProposal = (held: HeldProposal): boolean => held.preview === undefined || held.preview.status === 'PROPOSED';

