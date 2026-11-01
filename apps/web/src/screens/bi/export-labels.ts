import type { Translator } from '../../i18n';
import type { ExportFormat, ExportProblem, ExportReason, ExportStatus, ScheduleFormat, ScheduleProblem, ScheduleState } from './export-model';

type T = Translator['t'];

export function exportStatusLabel(t: T, status: ExportStatus): string {
  switch (status) {
    case 'QUEUED':
      return t('bi.exp.status.queued');
    case 'RUNNING':
      return t('bi.exp.status.running');
    case 'READY':
      return t('bi.exp.status.ready');
    case 'DENIED':
      return t('bi.exp.status.denied');
    case 'FAILED':
      return t('bi.exp.status.failed');
    case 'EXPIRED':
      return t('bi.exp.status.expired');
  }
}

export function formatLabel(t: T, format: ExportFormat | ScheduleFormat): string {
  switch (format) {
    case 'CSV':
      return t('bi.exp.format.csv');
    case 'XLSX':
      return t('bi.exp.format.xlsx');
    case 'PDF':
      return t('bi.exp.format.pdf');
    case 'LINK_ONLY':
      return t('bi.exp.format.link');
  }
}

export function scheduleStateLabel(t: T, state: ScheduleState): string {
  switch (state) {
    case 'ACTIVE':
      return t('bi.sch.state.active');
    case 'PAUSED':
      return t('bi.sch.state.paused');
    case 'RETIRED':
      return t('bi.sch.state.retired');
  }
}

export function exportProblemMessage(t: T, problem: ExportProblem): string {
  return problem === 'metricRequired' ? t('bi.exp.problem.metric') : t('bi.exp.problem.period');
}

export function scheduleProblemMessage(t: T, problem: ScheduleProblem): string {
  switch (problem) {
    case 'metricRequired':
      return t('bi.exp.problem.metric');
    case 'cronRequired':
      return t('bi.sch.problem.cronRequired');
    case 'cronFields':
      return t('bi.sch.problem.cronFields');
    case 'recipientsRequired':
      return t('bi.sch.problem.recipientsRequired');
    case 'recipientsInvalid':
      return t('bi.sch.problem.recipientsInvalid');
    case 'recipientsMany':
      return t('bi.sch.problem.recipientsMany');
  }
}

export function exportRefusalMessage(t: T, reason: ExportReason): string {
  switch (reason) {
    case 'rowCap':
      return t('bi.exp.refusal.rowCap');
    case 'policy':
      return t('bi.exp.refusal.policy');
    case 'scope':
      return t('bi.exp.refusal.scope');
    case 'classification':
      return t('bi.exp.refusal.classification');
    case 'noSnapshot':
      return t('bi.exp.refusal.noSnapshot');
    case 'notCertified':
      return t('bi.exp.refusal.notCertified');
    case 'dimension':
      return t('bi.exp.refusal.dimension');
    case 'expired':
      return t('bi.exp.refusal.expired');
    case 'cron':
      return t('bi.exp.refusal.cron');
    case 'recipient':
      return t('bi.exp.refusal.recipient');
    case 'invalid':
      return t('bi.exp.refusal.invalid');
    case 'general':
      return t('bi.exp.refusal.general');
  }
}
