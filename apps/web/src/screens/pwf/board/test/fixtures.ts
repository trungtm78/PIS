import type { DeadlineBoard, DeadlineCalendar, MilestoneList, Workload } from '../../model';
import { AS_OF, ME, PROJECT_ID, band, uuid } from '../../test/fixtures';

/** One row of the board: task `n` of the project, red by default. */
export const row = (n: number, over: Partial<DeadlineBoard['items'][number]> = {}): DeadlineBoard['items'][number] => ({
  task_id: uuid(1000 + n),
  task_code: `T${n}`,
  name: `Công việc ${n}`,
  project_id: PROJECT_ID,
  project_code: 'DA-001',
  project_name: 'Dự án thử',
  phase_code: 'PREPARATION',
  kind: 'TASK',
  status: 'IN_PROGRESS',
  due_date: '2026-12-10',
  band: band('RED'),
  critical: false,
  assignee: { membership_id: ME, display_name: 'Nguyễn Văn An' },
  ...over,
});

export const calendarBody = (over: Partial<DeadlineCalendar> = {}): DeadlineCalendar => ({
  month: '2026-12',
  days: [
    {
      date: '2026-12-10',
      total: 3,
      counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 1, RED: 2, UNKNOWN: 0 },
      tasks: [
        { task_id: uuid(1002), task_code: 'T2', name: 'Công việc 2', project_id: PROJECT_ID, project_code: 'DA-001', band: 'RED' },
        { task_id: uuid(1003), task_code: 'T3', name: 'Công việc 3', project_id: PROJECT_ID, project_code: 'DA-001', band: 'YELLOW' },
      ],
    },
  ],
  shown: 2,
  total: 3,
  truncated: false,
  as_of: AS_OF,
  ...over,
});

const milestone = (n: number, over: Partial<MilestoneList['items'][number]>): MilestoneList['items'][number] => ({
  task_id: uuid(1100 + n),
  milestone_id: null,
  task_code: `M${n}`,
  name: `Mốc ${n}`,
  project_id: PROJECT_ID,
  project_code: 'DA-001',
  planned_date: '2026-12-01',
  baseline_date: '2026-11-28',
  forecast_slip_days: 0,
  at_risk: false,
  band: band('GREEN'),
  ...over,
});

export const milestoneBody = (over: Partial<MilestoneList> = {}): MilestoneList => ({
  from: '2026-11-12',
  to: '2026-12-12',
  items: [milestone(1, { forecast_slip_days: 3, at_risk: true, band: band('YELLOW') }), milestone(2, { forecast_slip_days: -1 }), milestone(3, { forecast_slip_days: 0 })],
  total: 3,
  as_of: AS_OF,
  ...over,
});

export const workloadBody = (over: Partial<Workload> = {}): Workload => ({
  weeks: ['2026-12-07', '2026-12-14'],
  people: [
    { membership_id: ME, display_name: 'Nguyễn Văn An', open_tasks: 2, weekly_planned_working_days: [1.5, 2] },
    { membership_id: uuid(62), display_name: 'Trần Thị Bình', open_tasks: 3, weekly_planned_working_days: [3, 2.5] },
  ],
  display_only: true,
  as_of: AS_OF,
  ...over,
});
