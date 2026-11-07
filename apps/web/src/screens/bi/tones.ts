import type { Tone } from '../../ui';
import type { MetricStatus } from './bi-model';
import type { DashboardStatus } from './dashboard-model';
import type { ExportStatus, ScheduleState } from './export-model';
import type { RunStatus } from './query-log-model';

/** The tone of the pill of a metric state: the state is always written next to it. */
const METRIC_TONES: Readonly<Record<MetricStatus, Tone>> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'info',
  CERTIFIED: 'success',
  SUPERSEDED: 'neutral',
  RETIRED: 'neutral',
};
const DASHBOARD_TONES: Readonly<Record<DashboardStatus, Tone>> = { DRAFT: 'neutral', PUBLISHED: 'success', ARCHIVED: 'neutral' };
const EXPORT_TONES: Readonly<Record<ExportStatus, Tone>> = { QUEUED: 'info', RUNNING: 'info', READY: 'success', DENIED: 'danger', FAILED: 'danger', EXPIRED: 'neutral' };
const SCHEDULE_TONES: Readonly<Record<ScheduleState, Tone>> = { ACTIVE: 'success', PAUSED: 'warning', RETIRED: 'neutral' };
const RUN_TONES: Readonly<Record<RunStatus, Tone>> = { QUEUED: 'info', RUNNING: 'info', COMPLETED: 'success', DENIED: 'danger', FAILED: 'danger', TIMEOUT: 'warning', CANCELLED: 'neutral' };
/** A publication request: waiting is shown as information (it is not a fault), decided as done, withdrawn as over. */
const REQUEST_TONES: Readonly<Record<string, Tone>> = { PENDING: 'info', DECIDED: 'success', WITHDRAWN: 'neutral' };

export const metricStatusTone = (status: MetricStatus): Tone => METRIC_TONES[status];
export const dashboardStatusTone = (status: DashboardStatus): Tone => DASHBOARD_TONES[status];
export const exportStatusTone = (status: ExportStatus): Tone => EXPORT_TONES[status];
export const scheduleStateTone = (status: ScheduleState): Tone => SCHEDULE_TONES[status];
export const runStatusTone = (status: RunStatus): Tone => RUN_TONES[status];
export const requestStatusTone = (status: string): Tone => REQUEST_TONES[status] ?? 'neutral';
