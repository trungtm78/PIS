/**
 * The submission progress board (ST-DIS-015, DIS 3 F4, DIS-15): for a reporting period, how many of the projects that must report have handed a report in, have only a draft, or have not started, and
 * how many are overdue. A project's state is read from the statuses of its reports of the period; lateness is the one that was stored when the report was submitted (BR-DIS-07), never recomputed.
 */
export const SUBMITTED_STATUSES: readonly string[] = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'SUPERSEDED', 'AMENDMENT_REQUESTED'];

export const SUBMISSION_STATES = ['SUBMITTED', 'DRAFT', 'NOT_STARTED'] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** The numbers a board row shows, and the names a number drills to: `MUST_REPORT` is all of them. */
export const DRILL_STATES = ['MUST_REPORT', 'SUBMITTED', 'LATE_SUBMITTED', 'DRAFT', 'NOT_STARTED', 'OVERDUE'] as const;
export type DrillState = (typeof DRILL_STATES)[number];

/**
 * A project handed a report in when any of its reports of the period was sent and not taken back or returned (accepted, superseded by an accepted one, under review, or asked to be amended after
 * being accepted); with reports and none of them handed in (a draft, one that was returned, one that was withdrawn) it has a draft; with no report it has not started.
 */
export function submissionStateOf(statuses: readonly string[]): SubmissionState {
  if (statuses.some((status) => SUBMITTED_STATUSES.includes(status))) return 'SUBMITTED';
  return statuses.length > 0 ? 'DRAFT' : 'NOT_STARTED';
}

export interface BoardProject {
  state: SubmissionState;
  /** The stored lateness of the first report that was handed in; false for a project that has not handed one in. */
  late: boolean;
}

/** A project is overdue when the deadline of the period has passed and nothing was handed in. A report that came in after the deadline is counted as submitted, and as late. */
export const isOverdue = (project: BoardProject, deadlinePassed: boolean): boolean => deadlinePassed && project.state !== 'SUBMITTED';

export interface BoardTally {
  mustReport: number;
  submitted: number;
  /** Of the submitted, the ones that came in after the deadline. */
  lateSubmitted: number;
  draft: number;
  notStarted: number;
  overdue: number;
}

export function tallyBoard(projects: readonly BoardProject[], deadlinePassed: boolean): BoardTally {
  const count = (test: (project: BoardProject) => boolean): number => projects.filter(test).length;
  return {
    mustReport: projects.length,
    submitted: count((project) => project.state === 'SUBMITTED'),
    lateSubmitted: count((project) => project.state === 'SUBMITTED' && project.late),
    draft: count((project) => project.state === 'DRAFT'),
    notStarted: count((project) => project.state === 'NOT_STARTED'),
    overdue: count((project) => isOverdue(project, deadlinePassed)),
  };
}

/** Whether a project is one of those a number of the board counts: what a drill shows is exactly what the number counted. */
export function inDrill(project: BoardProject, drill: DrillState, deadlinePassed: boolean): boolean {
  switch (drill) {
    case 'MUST_REPORT':
      return true;
    case 'SUBMITTED':
      return project.state === 'SUBMITTED';
    case 'LATE_SUBMITTED':
      return project.state === 'SUBMITTED' && project.late;
    case 'DRAFT':
      return project.state === 'DRAFT';
    case 'NOT_STARTED':
      return project.state === 'NOT_STARTED';
    case 'OVERDUE':
      return isOverdue(project, deadlinePassed);
  }
}
