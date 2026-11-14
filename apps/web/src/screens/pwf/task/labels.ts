import type { Translator } from '../../../i18n';
import { historyName } from '../codes';
import type { HistoryEntry, KpiResult, TaskException } from './model';

type T = Translator['t'];

export function exceptionStatusWord(t: T, status: TaskException['status']): string {
  switch (status) {
    case 'REQUESTED':
      return t('pwf.task.exception.status.requested');
    case 'APPROVED':
      return t('pwf.task.exception.status.approved');
    case 'REJECTED':
      return t('pwf.task.exception.status.rejected');
    case 'USED':
      return t('pwf.task.exception.status.used');
  }
}

/** What happened, in words; a kind this screen has no word for is shown as its code (the log is the server's). */
export function historyWord(t: T, kind: HistoryEntry['kind']): string {
  switch (kind) {
    case 'START':
      return t('pwf.task.history.start.word');
    case 'COMPLETE_REQUESTED':
      return t('pwf.task.history.completeRequested.word');
    case 'COMPLETED':
      return t('pwf.task.history.completed.word');
    case 'APPROVED':
      return t('pwf.task.history.approved.word');
    case 'RETURNED':
      return t('pwf.task.history.returned.word');
    case 'PAUSE_APPROVED':
      return t('pwf.task.history.pauseApproved.word');
    case 'RESUMED':
      return t('pwf.task.history.resumed.word');
    case 'CANCELLED':
      return t('pwf.task.history.cancelled.word');
    default:
      return historyName(t, kind);
  }
}

export function kpiStateWord(t: T, state: KpiResult['state']): string {
  switch (state) {
    case 'OK':
      return t('pwf.task.kpi.state.ok');
    case 'NOT_APPLICABLE':
      return t('pwf.task.kpi.state.notApplicable');
    case 'EXCLUDED':
      return t('pwf.task.kpi.state.excluded');
    case 'MISSING_FACT':
      return t('pwf.task.kpi.state.missingFact');
  }
}

export function kpiFormula(t: T, operation: KpiResult['operation']): string {
  switch (operation) {
    case 'DAYS_DEVIATION':
      return t('pwf.task.kpi.formula.daysDeviation');
    case 'ON_TIME_RATE':
      return t('pwf.task.kpi.formula.onTimeRate');
    case 'AMOUNT_VARIANCE_PCT':
      return t('pwf.task.kpi.formula.amountVariance');
    case 'RETURN_COUNT':
      return t('pwf.task.kpi.formula.returnCount');
    case 'EVIDENCE_COMPLETENESS':
      return t('pwf.task.kpi.formula.evidenceCompleteness');
    case 'RESCHEDULE_COUNT':
      return t('pwf.task.kpi.formula.rescheduleCount');
  }
}
