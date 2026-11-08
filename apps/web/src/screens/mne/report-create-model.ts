import { PREPARE_REPORT_PERMISSION } from './types';
import type { ReportView } from './types';

/**
 * The rules of the two forms that write a report outside the filing calendar: a report made by hand from a form, a period and a frozen snapshot (createMneReport), and the correction of an issued report
 * (correctMneReport, a new revision with a reason). They repeat what the server judges so that the person is told before sending; the server stays the authority.
 */

export const PERIOD_LABEL_MAX = 20;
export const CORRECTION_MIN = 10;
export const CORRECTION_MAX = 2000;
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

export interface CreateValues {
  formId: string;
  reportYear: string;
  periodLabel: string;
  unitId: string;
  /** Empty for a report of a unit; a project for a project report. */
  projectId: string;
  /** Empty to attach a snapshot later (the report cannot be handed in without one). */
  snapshotId: string;
}

export const EMPTY_CREATE: CreateValues = { formId: '', reportYear: '', periodLabel: '', unitId: '', projectId: '', snapshotId: '' };

export type CreateField = 'formId' | 'reportYear' | 'periodLabel' | 'unitId';
export type CreateProblem = 'required' | 'yearInvalid' | 'periodLong';

/** What is wrong with the form: a form, a unit and a period are needed, the year is a whole year, the label of the period is at most twenty characters. */
export function createProblems(values: CreateValues): Partial<Record<CreateField, CreateProblem>> {
  const found: Partial<Record<CreateField, CreateProblem>> = {};
  if (values.formId === '') found.formId = 'required';
  if (values.unitId === '') found.unitId = 'required';
  const year = Number(values.reportYear);
  if (values.reportYear.trim() === '') found.reportYear = 'required';
  else if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) found.reportYear = 'yearInvalid';
  const label = values.periodLabel.trim();
  if (label === '') found.periodLabel = 'required';
  else if (label.length > PERIOD_LABEL_MAX) found.periodLabel = 'periodLong';
  return found;
}

/** The body of createMneReport from a form that has no problem; the project and the snapshot are left out when none is chosen. */
export function createBody(values: CreateValues): Record<string, string | number> {
  return {
    form_id: values.formId,
    report_year: Number(values.reportYear),
    period_label: values.periodLabel.trim(),
    scope_unit_id: values.unitId,
    ...(values.projectId === '' ? {} : { project_id: values.projectId }),
    ...(values.snapshotId === '' ? {} : { snapshot_id: values.snapshotId }),
  };
}

export type CorrectionProblem = 'short' | 'long';

/** The reason of a correction is ten characters at least once trimmed, and two thousand at most. */
export function correctionProblem(reason: string): CorrectionProblem | undefined {
  if (reason.trim().length < CORRECTION_MIN) return 'short';
  return reason.length > CORRECTION_MAX ? 'long' : undefined;
}

export function correctionBody(reason: string, snapshotId: string): Record<string, string> {
  return { correction_reason: reason.trim(), ...(snapshotId === '' ? {} : { snapshot_id: snapshotId }) };
}

/** Whether a correction can be made: the report was issued and not recalled, the person prepares reports, the system is not read-only. The server judges the state again (409 REPORT_STATE_INVALID). */
export function mayCorrect(report: Pick<ReportView, 'status' | 'recalledAt'>, permissions: readonly string[] | undefined, frozen: boolean): boolean {
  const issued = report.status === 'ISSUED' || report.status === 'EXPORTED' || report.status === 'SUBMITTED_EXTERNAL';
  return issued && report.recalledAt === null && !frozen && (permissions === undefined || permissions.includes(PREPARE_REPORT_PERMISSION));
}

/** Whether the person may make a report by hand. */
export const mayCreate = (permissions: readonly string[] | undefined, frozen: boolean): boolean => !frozen && (permissions === undefined || permissions.includes(PREPARE_REPORT_PERMISSION));

/** The id of the resource a command made or moved, from its answer; empty when the answer carries none. */
export function resourceIdOf(raw: unknown): string {
  return typeof raw === 'object' && raw !== null && typeof (raw as { resource_id?: unknown }).resource_id === 'string' ? (raw as { resource_id: string }).resource_id : '';
}
