export const PERIOD_ID = '00000000-0000-4000-8000-0000000000e1';
export const UNIT_ID = '00000000-0000-4000-8000-0000000000e2';
export const OTHER_UNIT_ID = '00000000-0000-4000-8000-0000000000e3';

export const counts = (over: Record<string, number> = {}): Record<string, number> => ({ must_report: 10, submitted: 7, submitted_late: 1, draft: 2, not_started: 1, overdue: 3, ...over });

export const projectRow = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  project: { id: `00000000-0000-4000-8000-00000000${code.slice(-4).padStart(4, '0')}`, code, name: `Dự án ${code}` },
  unit: { id: UNIT_ID, code: 'U-BQL1', name: 'Ban quản lý 1' },
  state: 'DRAFT',
  is_late: false,
  overdue: true,
  report: { id: `00000000-0000-4000-8000-0000000b${code.slice(-4).padStart(4, '0')}`, status: 'DRAFT', submitted_at: null },
  ...over,
});

/** The board of U-BQL1 (10 projects: 6 on time, 1 late, 2 drafts, 1 not started) next to a unit with nothing to do. */
export const boardRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  period: { id: PERIOD_ID, code: '2027-M09', period_type: 'MONTH', start_date: '2027-09-01', end_date: '2027-09-30', deadline_at: '2027-10-05T10:00:00.000Z' },
  deadline_passed: true,
  as_of: '2027-10-15T03:00:00.000Z',
  total: counts({ must_report: 12, submitted: 9, draft: 2, not_started: 1, overdue: 3 }),
  units: [
    { unit: { id: UNIT_ID, code: 'U-BQL1', name: 'Ban quản lý 1' }, ...counts() },
    { unit: { id: OTHER_UNIT_ID, code: 'U-BQL2', name: 'Ban quản lý 2' }, ...counts({ must_report: 2, submitted: 2, submitted_late: 0, draft: 0, not_started: 0, overdue: 0 }) },
  ],
  ...over,
});

/** The answer for a query: with a state it carries the projects given for that state. */
export const answerWith =
  (projects: Record<string, Array<Record<string, unknown>>>, next: Record<string, string | null> = {}) =>
  (query: Record<string, unknown>): unknown =>
    query.state === undefined ? boardRecord() : { ...boardRecord(), state: query.state, projects: query.cursor === undefined ? (projects[String(query.state)] ?? []) : [], next_cursor: query.cursor === undefined ? (next[String(query.state)] ?? null) : null };
