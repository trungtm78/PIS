import type { ReschedulePreview, Schedule, WorkflowDetail } from '../../model';
import { AS_OF, OTHER, schedulePreview, scheduleTask, uuid, workflowDetail } from '../../test/fixtures';

export const REASON = 'Dời ngày bắt đầu vì chờ quyết định giao kế hoạch vốn';
export const PROPOSAL_ID = uuid(7001);

/** The workflow whose schedule is at version 3 (the If-Match of a proposal). */
export const workflow = (over: Partial<WorkflowDetail> = {}) => workflowDetail({ schedule_version: 3, ...over });

export const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  workflow_id: uuid(800),
  schedule_version: 3,
  planned_start_date: '2026-12-01',
  published_at: '2026-11-01T03:00:00.000Z',
  project_start: '2026-12-01',
  project_finish: '2027-02-12',
  critical_path: ['T1', 'T2'],
  longest_path: ['T1', 'T2'],
  calendar_versions: [{ year: 2026, version: 1 }],
  tasks: [scheduleTask('T1', { name: 'Việc T1', start: '2026-12-01', finish: '2026-12-10' }), scheduleTask('T2', { name: 'Việc T2', start: '2026-12-11', finish: '2027-02-12', start_variance_days: 0, finish_variance_days: 0 })],
  excluded_tasks: [],
  findings: [],
  result_hash: 'c'.repeat(64),
  as_of: AS_OF,
  ...over,
});

export const preview = (over: Partial<ReschedulePreview> = {}): ReschedulePreview => ({
  proposal_id: PROPOSAL_ID,
  status: 'PROPOSED',
  base_version: 3,
  schedule: schedulePreview({
    project_finish: '2027-02-26',
    tasks: [
      scheduleTask('T1', { name: 'Việc T1', start: '2027-01-04', finish: '2027-01-15', start_variance_days: 3, finish_variance_days: 5 }),
      scheduleTask('T2', { name: 'Việc T2', start: '2027-01-18', finish: '2027-02-26', critical: false, finish_variance_days: 10 }),
    ],
  }),
  changes: [
    { task_code: 'T1', start_shift_days: 5, finish_shift_days: 5, float_change: -2, became_critical: true, became_non_critical: false, state_changed: false },
    { task_code: 'T2', start_shift_days: 5, finish_shift_days: 10, float_change: 3, became_critical: false, became_non_critical: true, state_changed: false },
  ],
  project_finish_shift_days: 10,
  input_hash: 'a'.repeat(64),
  result_hash: 'b'.repeat(64),
  reason: REASON,
  proposed_by: OTHER,
  version: 1,
  as_of: AS_OF,
  ...over,
});
