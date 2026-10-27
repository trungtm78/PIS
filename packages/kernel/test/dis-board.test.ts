import { inDrill, isOverdue, submissionStateOf, tallyBoard } from '../src/dis-board.ts';
import type { BoardProject } from '../src/dis-board.ts';

const project = (state: BoardProject['state'], late = false): BoardProject => ({ state, late });

/** U-BQL1: 10 reporting projects, 6 submitted or accepted on time, 1 submitted late, 2 drafts, 1 not started. */
const UNIT: BoardProject[] = [...Array.from({ length: 6 }, () => project('SUBMITTED')), project('SUBMITTED', true), project('DRAFT'), project('DRAFT'), project('NOT_STARTED')];

describe('the submission progress board (ST-DIS-015, DIS 3 F4)', () => {
  it('AC-ST-DIS-015-1 / UAT-AC263: counts 10 must report, 7 submitted (1 of them late), 2 drafts, 1 not started and 3 overdue after the deadline', () => {
    expect(tallyBoard(UNIT, true)).toEqual({ mustReport: 10, submitted: 7, lateSubmitted: 1, draft: 2, notStarted: 1, overdue: 3 });
  });

  it('has nothing overdue before the deadline, whatever is still to do', () => {
    expect(tallyBoard(UNIT, false)).toEqual({ mustReport: 10, submitted: 7, lateSubmitted: 1, draft: 2, notStarted: 1, overdue: 0 });
  });

  it('every number drills to exactly the projects it counted', () => {
    for (const deadlinePassed of [true, false]) {
      const tally = tallyBoard(UNIT, deadlinePassed);
      const drilled = (drill: Parameters<typeof inDrill>[1]): number => UNIT.filter((item) => inDrill(item, drill, deadlinePassed)).length;
      expect([drilled('MUST_REPORT'), drilled('SUBMITTED'), drilled('LATE_SUBMITTED'), drilled('DRAFT'), drilled('NOT_STARTED'), drilled('OVERDUE')]).toEqual([tally.mustReport, tally.submitted, tally.lateSubmitted, tally.draft, tally.notStarted, tally.overdue]);
    }
  });

  it('reads the state of a project from the statuses of its reports: a report that came in counts even when a correction is only a draft, one that was returned or withdrawn does not', () => {
    expect(submissionStateOf([])).toBe('NOT_STARTED');
    expect(submissionStateOf(['DRAFT'])).toBe('DRAFT');
    expect(submissionStateOf(['RETURNED', 'DRAFT'])).toBe('DRAFT');
    expect(submissionStateOf(['WITHDRAWN'])).toBe('DRAFT');
    expect(submissionStateOf(['SUBMITTED'])).toBe('SUBMITTED');
    expect(submissionStateOf(['UNDER_REVIEW'])).toBe('SUBMITTED');
    expect(submissionStateOf(['ACCEPTED', 'DRAFT'])).toBe('SUBMITTED');
    expect(submissionStateOf(['SUPERSEDED', 'ACCEPTED'])).toBe('SUBMITTED');
    expect(submissionStateOf(['AMENDMENT_REQUESTED', 'DRAFT'])).toBe('SUBMITTED');
    expect(isOverdue(project('SUBMITTED', true), true)).toBe(false);
  });

  it('counts nothing for no project', () => {
    expect(tallyBoard([], true)).toEqual({ mustReport: 0, submitted: 0, lateSubmitted: 0, draft: 0, notStarted: 0, overdue: 0 });
  });
});
