import { CELLS, EDIT_PATH, PROGRESS_PATH, REGISTRATION_PATH, REVIEW_PATH, cellId, takesCtmtqg } from './model';
import type { Basis, CellKey, CellProblem, ReportDetail, ReportDraftBody } from './model';
import type { Attachment, Finding } from './detail-parts';
import { digitsOf } from './money';

/** The steps of a draft, in the order a person goes through them (DIS 3 F1 steps 3 to 7); each opens the same report. */
export const STEPS = [
  { key: 'progress', path: PROGRESS_PATH },
  { key: 'cells', path: EDIT_PATH },
  { key: 'registration', path: REGISTRATION_PATH },
  { key: 'review', path: REVIEW_PATH },
] as const;
export type StepKey = (typeof STEPS)[number]['key'];

export const stepLink = (path: string, reportId: string): string => `${path}?report=${reportId}`;

/**
 * Everything a save keeps as the report holds it: the six cells with their CTMTQG and the registration for next month, the basis and the explanation of a fall. A step changes what it shows and
 * hands in the rest unchanged, so that no step overwrites what another one entered.
 */
export function keepBody(detail: ReportDetail): ReportDraftBody {
  return {
    project_id: detail.project.id,
    period_id: detail.period.id,
    plan_version_id: detail.planVersion.id,
    report_type: detail.reportType,
    measurement_basis: detail.measurementBasis,
    funding_lines: detail.cells.map((cell) => ({
      bucket: cell.bucket,
      budget_level: cell.level,
      cumulative_vnd: cell.cumulativeVnd,
      ...(cell.ctmtqgVnd === null ? {} : { ctmtqg_subset_vnd: cell.ctmtqgVnd }),
      next_month_vnd: cell.nextMonthVnd,
      ...(cell.nextMonthCtmtqgVnd === null ? {} : { next_month_ctmtqg_subset_vnd: cell.nextMonthCtmtqgVnd }),
    })),
    ...(detail.negativeDeltaExplanation === null ? {} : { negative_delta_explanation: detail.negativeDeltaExplanation }),
  };
}

// ---- DIS-03: the volumes ----

export const PROGRESS_FIELDS = ['construction', 'acceptance', 'treasury', 'preparing'] as const;
export type ProgressField = (typeof PROGRESS_FIELDS)[number] | 'percent';
export type VolumeProblem = 'required' | 'invalid' | 'range';

export interface ProgressForm {
  construction: string;
  acceptance: string;
  treasury: string;
  preparing: string;
  percent: string;
  basis: Basis;
}

/** The form as the report stands: nothing entered yet is empty (the four amounts are required), what was entered is shown as it was kept. */
export function progressFormOf(detail: ReportDetail): ProgressForm {
  const progress = detail.progress;
  return {
    construction: progress?.constructionVnd ?? '',
    acceptance: progress?.acceptanceVnd ?? '',
    treasury: progress?.treasurySubmittedVnd ?? '',
    preparing: progress?.preparingDossierVnd ?? '',
    percent: progress?.physicalProgressPct ?? '',
    basis: detail.measurementBasis,
  };
}

const PERCENT = /^[0-9]{1,3}(?:[.,][0-9]{1,2})?$/;
/** The percent as the contract writes it: a dot for the decimals. */
const percentText = (typed: string): string => typed.trim().replace(',', '.');

/** BR-DIS-07 as the form can tell it before the server does: each amount is a whole amount of dong, the percent is between 0 and 100 with up to two decimals and may be left empty. */
export function validateProgress(form: ProgressForm): Partial<Record<ProgressField, VolumeProblem>> {
  const problems: Partial<Record<ProgressField, VolumeProblem>> = {};
  for (const field of PROGRESS_FIELDS) {
    if (form[field].trim() === '') problems[field] = 'required';
    else if (digitsOf(form[field]) === undefined) problems[field] = 'invalid';
  }
  const percent = form.percent.trim();
  if (percent !== '') {
    if (!PERCENT.test(percent)) problems.percent = 'invalid';
    else if (Number(percentText(percent)) > 100) problems.percent = 'range';
  }
  return problems;
}

/** The save of the volumes: the four amounts, the percent when given and the basis, with everything else as it stands. */
export function progressBody(detail: ReportDetail, form: ProgressForm): ReportDraftBody {
  const percent = form.percent.trim();
  return {
    ...keepBody(detail),
    measurement_basis: form.basis,
    construction_vnd: digitsOf(form.construction) ?? '0',
    acceptance_vnd: digitsOf(form.acceptance) ?? '0',
    treasury_submitted_vnd: digitsOf(form.treasury) ?? '0',
    preparing_dossier_vnd: digitsOf(form.preparing) ?? '0',
    ...(percent === '' ? {} : { physical_progress_pct: percentText(percent) }),
  };
}

// ---- DIS-05: the registration for next month ----

export interface RegistrationEntry {
  nextMonth: string;
  ctmtqg: string;
}

export interface RegistrationForm {
  cells: Record<string, RegistrationEntry>;
}

export const registrationFieldId = (cell: CellKey, field: 'nextMonth' | 'ctmtqg'): string => `${cellId(cell)}.${field}`;

export function registrationFormOf(detail: ReportDetail): RegistrationForm {
  const cells: Record<string, RegistrationEntry> = {};
  for (const key of CELLS) {
    const found = detail.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level);
    cells[cellId(key)] = { nextMonth: found?.nextMonthVnd ?? '0', ctmtqg: found?.nextMonthCtmtqgVnd ?? '' };
  }
  return { cells };
}

/** A registration is a whole amount, and the CTMTQG inside it is a whole amount that is not more than the registration and exists only in the year plan and the carried-over plan. */
export function validateRegistration(form: RegistrationForm): Record<string, CellProblem> {
  const problems: Record<string, CellProblem> = {};
  for (const key of CELLS) {
    const entry = form.cells[cellId(key)] ?? { nextMonth: '', ctmtqg: '' };
    const amount = entry.nextMonth.trim() === '' ? undefined : digitsOf(entry.nextMonth);
    if (entry.nextMonth.trim() === '') problems[registrationFieldId(key, 'nextMonth')] = 'required';
    else if (amount === undefined) problems[registrationFieldId(key, 'nextMonth')] = 'invalid';
    if (entry.ctmtqg.trim() === '') continue;
    const subset = digitsOf(entry.ctmtqg);
    if (!takesCtmtqg(key.bucket)) problems[registrationFieldId(key, 'ctmtqg')] = 'notAllowed';
    else if (subset === undefined) problems[registrationFieldId(key, 'ctmtqg')] = 'invalid';
    else if (amount !== undefined && BigInt(subset) > BigInt(amount)) problems[registrationFieldId(key, 'ctmtqg')] = 'exceeds';
  }
  return problems;
}

/** What the registration adds up to as it is typed; the CTMTQG is inside it and is given apart. */
export function registrationTotals(form: RegistrationForm): { nextMonthVnd: string; ctmtqgVnd: string } {
  let total = 0n;
  let ctmtqg = 0n;
  for (const key of CELLS) {
    const entry = form.cells[cellId(key)];
    total += BigInt(digitsOf(entry?.nextMonth ?? '') ?? '0');
    ctmtqg += BigInt(digitsOf(entry?.ctmtqg ?? '') ?? '0');
  }
  return { nextMonthVnd: total.toString(), ctmtqgVnd: ctmtqg.toString() };
}

/** The save of the registration: the next-month amounts of the six cells, with the cumulative cells as the report holds them. */
export function registrationBody(detail: ReportDetail, form: RegistrationForm): ReportDraftBody {
  const kept = keepBody(detail);
  return {
    ...kept,
    funding_lines: kept.funding_lines.map((line) => {
      const entry = form.cells[`${line.bucket}:${line.budget_level}`] ?? { nextMonth: '0', ctmtqg: '' };
      const subset = entry.ctmtqg.trim() === '' ? undefined : digitsOf(entry.ctmtqg);
      return {
        bucket: line.bucket,
        budget_level: line.budget_level,
        cumulative_vnd: line.cumulative_vnd,
        ...(line.ctmtqg_subset_vnd === undefined ? {} : { ctmtqg_subset_vnd: line.ctmtqg_subset_vnd }),
        next_month_vnd: digitsOf(entry.nextMonth) ?? '0',
        ...(subset === undefined ? {} : { next_month_ctmtqg_subset_vnd: subset }),
      };
    }),
  };
}

/** What a cell can still disburse of what the plan allocated to it; below zero when more was reported than allocated. */
export const remainingOf = (allocatedVnd: string, cumulativeVnd: string): string => (BigInt(allocatedVnd) - BigInt(cumulativeVnd)).toString();

/** The month the registration is for: the one after the month the period ends in. */
export function nextMonthOf(endDate: string): { year: number; month: number } | undefined {
  const matched = /^(\d{4})-(\d{2})-\d{2}$/.exec(endDate);
  if (matched === null) return undefined;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

// ---- DIS-06: the notes, the files and the review ----

export const NOTE_FIELDS = ['results', 'causes', 'solutions', 'proposals'] as const;
export type NoteField = (typeof NOTE_FIELDS)[number];
export const NOTE_MAX_CHARS = 4000;

export type NotesForm = Record<NoteField, string>;

export function notesFormOf(detail: ReportDetail): NotesForm {
  return { results: detail.narrative?.results ?? '', causes: detail.narrative?.causes ?? '', solutions: detail.narrative?.solutions ?? '', proposals: detail.narrative?.proposals ?? '' };
}

export const validateNotes = (form: NotesForm): Partial<Record<NoteField, 'tooLong'>> =>
  Object.fromEntries(NOTE_FIELDS.filter((field) => form[field].trim().length > NOTE_MAX_CHARS).map((field) => [field, 'tooLong' as const]));

/** The save of the notes: the whole narrative (a section left empty is left out; the issues it speaks about stay as they were named), and an empty one takes the narrative away. */
export function notesBody(detail: ReportDetail, form: NotesForm): ReportDraftBody {
  const sections = Object.fromEntries(NOTE_FIELDS.flatMap((field) => (form[field].trim() === '' ? [] : [[field, form[field].trim()] as const])));
  const issues = detail.narrative?.linkedIssueIds ?? [];
  return { ...keepBody(detail), narrative: Object.keys(sections).length === 0 && issues.length === 0 ? {} : { ...sections, ...(issues.length === 0 ? {} : { linked_issue_ids: issues }) } };
}

/** The save of the files: the whole list in the order it is shown. */
export function attachmentsBody(detail: ReportDetail, files: readonly Attachment[]): ReportDraftBody {
  return { ...keepBody(detail), attachments: files.map((file) => ({ file_object_id: file.fileObjectId, file_sha256: file.fileSha256, file_name: file.fileName })) };
}

const FUNDING_LINE = /^funding_lines\[(\d)\]\.(\w+)$/;

/** The cell a finding is about, when its field names one. */
export function cellOfFinding(finding: Finding): CellKey | undefined {
  const matched = FUNDING_LINE.exec(finding.field);
  return matched === null ? undefined : CELLS[Number(matched[1])];
}

/** The step where a finding is put right; none for what no step of the draft can change (the period, the plan version, the state of the report). */
export function stepOfFinding(finding: Finding): string | undefined {
  if (finding.field.startsWith('progress')) return PROGRESS_PATH;
  const matched = FUNDING_LINE.exec(finding.field);
  if (matched !== null) return matched[2]?.startsWith('next_month') ? REGISTRATION_PATH : EDIT_PATH;
  if (finding.field === 'funding_lines') return finding.code === 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT' ? REGISTRATION_PATH : EDIT_PATH;
  return finding.field === 'negative_delta_explanation' ? EDIT_PATH : undefined;
}

