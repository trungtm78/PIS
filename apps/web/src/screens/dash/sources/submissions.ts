import type { SubmissionRow } from '../db';
import { plainText } from './assemble';
import { dayOf } from './tasks';
import type { SystemTaskUnit } from './tasks';

/**
 * The submissions bundle of the dashboard (what waits on the desk of the leader: the papers that wait for a decision, and the explanations a unit still owes) from what
 * the system holds. Nothing here asks the server: `system-submissions.ts` reads, this file turns what was read into the rows.
 *
 * The engine of the template tells the two kinds by one name: a row called 'Giải trình' is an explanation, any other row is a paper that waits. It draws every
 * explanation as an overdue one ("late by N days"), so an explanation is a row only once its deadline has passed.
 */
export interface SystemExplanation {
  /** REQUESTED, RESPONDED, ACCEPTED, RETURNED, OVERDUE or CANCELLED. */
  status: string;
  project: { id: string; code: string | null; name: string | null } | null;
  unit: { id: string; name: string | null } | null;
  question: string | null;
  /** The moment the answer is due. */
  due_at: string | null;
}
export interface SystemApprovalTask {
  /** Pending, Decided, Reassigned, Cancelled or Expired. */
  status: string;
  business_type: string; step_name: string | null;
  /** The moment the decision is due: the workflow sets it on every task, from the time its step allows. */
  due_at: string | null;
  /** The moment the record was sent, or else the moment the task was made. */
  received_at: string | null;
  /** The unit the workflow runs for. */
  unit_id: string | null;
  resource: { type: string; id: string } | null;
  /** What the owning module says of the record, when it says anything (most kinds of record say nothing). */
  subject_name: string | null; project_code: string | null; unit_code: string | null;
}
export interface SystemSubmissionProject { id: string; code: string; name: string | null; investor_unit_id: string | null }

/** What `system-submissions.ts` reads. */
export interface SubmissionsRead {
  /** The day the screen is read (ISO). */
  today: string;
  explanations: readonly SystemExplanation[];
  approvals: readonly SystemApprovalTask[];
  projects: readonly SystemSubmissionProject[];
  units: readonly SystemTaskUnit[];
}
export interface SubmissionsInput extends SubmissionsRead {
  /** The codes of the units and of the projects of the capital tables in use, as the tables write them (`plainText`): a row that names another one is left out. */
  knownUnitCodes: ReadonlySet<string>;
  knownProjectCodes: ReadonlySet<string>;
}
export interface SubmissionsResult {
  /** The rows, when the system holds enough to draw the page that reads them. */
  rows?: SubmissionRow[];
  /** Why the bundle stays on the template. Empty when `rows` is given. */
  reasons: string[];
}

/** What the bundle needs before it replaces the template's: the page of the decisions that wait draws both kinds, and a queue of one or two rows is not a queue. */
export const SUBMISSIONS_FLOOR = { rows: 3, ofEachKind: 1 } as const;

export const EXPLANATION = 'Giải trình';
export const PAPER = 'Tờ trình chờ duyệt';
/**
 * The statuses of a request whose answer is still owed: asked, sent back for a better answer, or marked overdue (the server moves an asked or returned request to
 * OVERDUE once its moment has passed, so the overdue ones are mostly under that status). An answer that waits for its review is not owed.
 */
export const OWED = new Set(['OVERDUE', 'REQUESTED', 'RETURNED']);
/** The response of a person to their score is decided through the same tasks and is personal: it is not a paper of the province. */
const PERSONAL = new Set(['score.response']);
const PAPER_NAME: Readonly<Record<string, string>> = {
  'report.accept': 'Tiếp nhận báo cáo', 'plan.publish': 'Ban hành kế hoạch vốn', 'payment.approve': 'Phê duyệt đề nghị thanh toán', 'contract.change': 'Phê duyệt điều chỉnh hợp đồng',
  'period.reopen': 'Mở lại kỳ báo cáo', 'document.review': 'Thẩm định hồ sơ', 'fnd.figures.accept': 'Tiếp nhận số liệu nguồn vốn', 'ind.entry.accept': 'Tiếp nhận số liệu chỉ tiêu',
};
const OTHER_PAPER = 'Hồ sơ chờ duyệt';
const VIETNAM_OFFSET = 7 * 3_600_000;
const DAY = 86_400_000;

/** The calendar day of Viet Nam a moment falls on (the system keeps moments in UTC); a plain day is itself; anything else is absent. */
export function vietnamDayOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= 10) return dayOf(value);
  const moment = Date.parse(value);
  return Number.isNaN(moment) ? null : new Date(moment + VIETNAM_OFFSET).toISOString().slice(0, 10);
}

/**
 * The working days a deadline lies behind a day, as the engine of the template counts them: the days from Monday to Friday from the deadline up to the day before. 0
 * when the deadline has not passed, and also when only a weekend lies between (a deadline of Saturday read on Monday).
 */
export function workingDaysLate(deadline: string, today: string): number {
  const from = Date.parse(`${deadline}T00:00:00Z`), to = Date.parse(`${today}T00:00:00Z`);
  let late = 0;
  for (let day = from; day < to; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) late += 1;
  }
  return late;
}

const named = (label: string, name: string | null | undefined): string => plainText(name === null || name === undefined ? label : `${label}: ${name}`);

/** The submissions bundle from the system, or the reasons the system does not hold enough for it. */
export function submissionsFromSystem(input: SubmissionsInput): SubmissionsResult {
  const today = dayOf(input.today);
  if (today === null) return { reasons: ['the day the screen is read is not a day'] };
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const unitCodeById = new Map(input.units.map((unit) => [unit.id, plainText(unit.code)]));
  const knownUnit = (code: string | undefined | null): string | undefined => (code !== undefined && code !== null && input.knownUnitCodes.has(code) ? code : undefined);

  const papers: SubmissionRow[] = [];
  for (const task of input.approvals) {
    if (task.status !== 'Pending' || PERSONAL.has(task.business_type)) continue;
    // A task without the day it is due cannot be placed in the queue, and no deadline is made up for it.
    const han = vietnamDayOf(task.due_at);
    if (han === null) continue;
    const record = task.resource !== null && task.resource.type === 'project' ? projectById.get(task.resource.id) : undefined;
    const projectCode = task.project_code ?? record?.code ?? null;
    const project = projectCode === null ? null : plainText(projectCode);
    if (project !== null && !input.knownProjectCodes.has(project)) continue;
    const unit = knownUnit(task.unit_code === null ? (task.unit_id === null ? undefined : unitCodeById.get(task.unit_id)) : plainText(task.unit_code));
    if (unit === undefined) continue;
    papers.push({
      ma: `A${papers.length + 1}`, loai: PAPER, noi_dung: named(PAPER_NAME[task.business_type] ?? OTHER_PAPER, task.subject_name ?? record?.name ?? task.step_name),
      don_vi: unit, du_an: project, ngay_nhan: vietnamDayOf(task.received_at), han,
    });
  }

  const explanations: SubmissionRow[] = [];
  for (const request of input.explanations) {
    if (!OWED.has(request.status)) continue;
    const han = vietnamDayOf(request.due_at);
    if (han === null || workingDaysLate(han, today) < 1) continue;
    const record = request.project === null ? undefined : projectById.get(request.project.id);
    const projectCode = request.project === null ? null : (request.project.code ?? record?.code ?? null);
    const project = projectCode === null ? null : plainText(projectCode);
    // A request about a project names its project: one whose project the tables do not have is left out, as is one whose unit they do not have.
    if (request.project !== null && (project === null || !input.knownProjectCodes.has(project))) continue;
    // The unit the explanation is about: the unit the request names, or for a request about a project the investor of the project. That is not necessarily the unit of
    // the person who was asked (`requested_from_membership_id`): the register of members is not read here.
    const unit = knownUnit(request.unit !== null ? unitCodeById.get(request.unit.id) : record?.investor_unit_id === null || record === undefined ? undefined : unitCodeById.get(record.investor_unit_id));
    if (unit === undefined) continue;
    explanations.push({
      ma: `E${explanations.length + 1}`, loai: EXPLANATION, noi_dung: named(EXPLANATION, request.project?.name ?? record?.name ?? request.unit?.name ?? request.question),
      don_vi: unit, du_an: project, ngay_nhan: null, han,
    });
  }

  const reasons: string[] = [];
  const total = papers.length + explanations.length;
  if (total < SUBMISSIONS_FLOOR.rows) reasons.push(`${total} papers and explanations wait (at least ${SUBMISSIONS_FLOOR.rows} are needed)`);
  if (papers.length < SUBMISSIONS_FLOOR.ofEachKind) reasons.push('no paper of a unit of the tables waits for a decision');
  if (explanations.length < SUBMISSIONS_FLOOR.ofEachKind) reasons.push('no explanation of a unit of the tables is owed past its deadline');
  return reasons.length > 0 ? { reasons } : { rows: [...papers, ...explanations], reasons: [] };
}
